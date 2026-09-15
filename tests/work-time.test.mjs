import assert from "node:assert/strict";
import test from "node:test";
import { EmployerAccount, WorkTimeConfig, workDate } from "../work-time.js";
import { WeekRequirements, ProjectList } from "../model.js";
import { EntryStore } from "../store.js";
import { TimeContext } from "../utils.js";

/**
 * Creates a detached account fixture with configurable start and project ownership.
 * @param {string} [id] Employer/project key.
 * @param {string} [start] Inclusive tracking start.
 * @returns {import("../work-time.js").EmployerRaw} Valid account draft.
 */
function account(id = "a", start = "2025-09-01") {
    return WorkTimeConfig.newEmployer(id, id.toUpperCase(), start, [id]);
}

/**
 * Wraps employer fixtures in the persisted schema.
 * @param {import("../work-time.js").EmployerRaw[]} employers Account drafts.
 * @returns {WorkTimeConfig} Validated config.
 */
function config(...employers) {
    return new WorkTimeConfig({ schema_version: 3, generated_at: "", employers });
}

/**
 * Creates a billable time-entry fixture with explicit offset timestamps.
 * @param {number} id Entry ID.
 * @param {string} start Inclusive timestamp.
 * @param {string} end Exclusive timestamp.
 * @param {string} [project] Owning project key.
 * @param {boolean} [billable] Whether work counts toward overtime.
 * @returns {import("../model.js").EntryRaw} Entry fixture.
 */
function entry(id, start, end, project = "a", billable = true) {
    return { id, start, end, project_key: project, section_key: null, billable, description: `Task ${id}`, is_running: false };
}

/**
 * Creates a diary index with a minimal shared project inventory.
 * @returns {EntryStore} Empty test store.
 */
function makeStore() {
    const store = new EntryStore(new TimeContext("Europe/Berlin"));
    store.setProjectList(ProjectList.fromRaw({ schema_version: 2, projects: ["a", "b", "other"].map((key) => ({
        key, name: key, color: "#315e9d", billable: true, archived: false, external_refs: [], sections: [],
    })) }));
    return store;
}

test("daily requirements resolve effective schedules across a midweek change without prorating vacation", () => {
    const raw = account("a", "2025-01-01");
    raw.schedules.push({ effective_from: "2025-07-01", hours: [6, 6, 6, 6, 6, 0, 0] });
    raw.vacation_allowances = { 2025: 30 };
    const employer = new EmployerAccount(raw);
    assert.equal(employer.scheduledHours("2025-06-30"), 8);
    assert.equal(employer.scheduledHours("2025-07-01"), 6);
    assert.equal(config(raw).requiredHours("2025-06-30", "2025-07-06"), 32);
    assert.equal(employer.vacationBalance("2025-12-31").balance, 30);
    assert.equal(employer.scheduledHours("2024-12-31"), 0);
});

test("half-day statuses are exclusive, proportional and reversible without touching recorded work", () => {
    const raw = account();
    raw.vacation_allowances = { 2025: 30 };
    raw.days = [{ date: "2025-09-01", halves: ["pto", "work"], comment: "Morning" }];
    let employer = new EmployerAccount(raw);
    assert.equal(employer.requiredHours("2025-09-01"), 4);
    assert.equal(employer.vacationBalance("2025-09-01").balance, 29.5);
    raw.days[0].halves = ["pto", "sick"];
    employer = new EmployerAccount(raw);
    assert.equal(employer.requiredHours("2025-09-01"), 0);
    assert.equal(employer.vacationUsed("2025-09-01"), 0.5);
    raw.days[0].halves = ["sick", "sick"];
    employer = new EmployerAccount(raw);
    assert.equal(employer.vacationBalance("2025-09-01").balance, 30);
    raw.schedules[0].hours[0] = 6;
    raw.days[0].halves = ["work", "pto"];
    assert.equal(new EmployerAccount(raw).requiredHours("2025-09-01"), 3);
    const detached = employer.day("2025-09-01");
    detached.halves[0] = "work";
    assert.equal(employer.day("2025-09-01").halves[0], "sick");
});

test("time off in lieu retains requirements without crediting work, spending vacation or double-debiting overtime", () => {
    const raw = account();
    raw.opening_overtime_hours = 16;
    raw.vacation_allowances = { 2025: 30 };
    raw.days = [{ date: "2025-09-01", halves: ["flex", "pto"], comment: "Half a day off in lieu" }];
    const store = makeStore();
    store.setWeekRequirements(WeekRequirements.fromRaw(config(raw).toObject()));
    const employer = store.getWeekRequirements().accounting.getEmployer("a");
    assert.equal(employer.requiredHours("2025-09-01"), 4);
    assert.equal(employer.vacationUsed("2025-09-01"), 0.5);
    assert.equal(store.getAccountBillableSeconds("2025-09-01", "2025-09-01"), 0);
    assert.equal(store.getEmployerBalance("a", "2025-09-01"), 12 * 3600);
    const saved = WeekRequirements.fromRaw(JSON.parse(store.getWeekRequirements().toJson()));
    assert.deepEqual(saved.accounting.getEmployer("a").day("2025-09-01").halves, ["flex", "pto"]);

    raw.days[0].halves = ["flex", "flex"];
    store.setWeekRequirements(WeekRequirements.fromRaw(config(raw).toObject()));
    assert.equal(store.getEmployerBalance("a", "2025-09-01"), 8 * 3600);
    assert.equal(store.getWeekRequirements().accounting.getEmployer("a").vacationUsed("2025-09-01"), 0);
    // Incidental work still counts on a day marked off; the annotation never rewrites entries.
    store.applyWeekSnapshot("2025-09-01", [entry(1, "2025-09-01T08:00:00+02:00", "2025-09-01T09:00:00+02:00")]);
    assert.equal(store.getEmployerBalance("a", "2025-09-01"), 9 * 3600);
    raw.days[0].halves = ["work", "flex"];
    assert.equal(new EmployerAccount(raw).requiredHours("2025-09-01"), 8);
    raw.days[0].halves = ["sick", "flex"];
    assert.equal(new EmployerAccount(raw).requiredHours("2025-09-01"), 4);
    raw.days[0].halves = ["holiday", "flex"];
    assert.equal(new EmployerAccount(raw).requiredHours("2025-09-01"), 4);
    raw.schedules[0].hours[0] = 6;
    assert.equal(new EmployerAccount(raw).requiredHours("2025-09-01"), 3);
    raw.days.push({ date: "2025-09-07", halves: ["flex", "flex"], comment: "Sunday" });
    assert.equal(new EmployerAccount(raw).requiredHours("2025-09-07"), 0);
});

test("negative vacation carryover remains a debit against the next annual allowance", () => {
    const raw = account();
    raw.vacation_allowances = { 2025: 1, 2026: 30 };
    raw.days = ["2025-09-01", "2025-09-02", "2025-09-03", "2025-09-04"].map((date) => ({
        date, halves: ["flex", "pto"], comment: "Half vacation, half time off in lieu",
    }));
    const employer = new EmployerAccount(raw);
    assert.equal(employer.vacationBalance("2025-12-31").balance, -1);
    assert.equal(employer.vacationBalance("2026-01-01").balance, 29);
    assert.equal(employer.requiredHours("2025-09-01"), 4);
    assert.equal(employer.opening_vacation_days, 0);
});

test("annual vacation planning splits taken and future PTO while preserving negative carryover", () => {
    const raw = account();
    raw.vacation_allowances = { 2025: 1, 2026: 30, 2027: 30 };
    raw.days = [
        { date: "2025-09-01", halves: ["pto", "pto"], comment: "" },
        { date: "2025-09-02", halves: ["pto", "pto"], comment: "" },
        { date: "2026-09-15", halves: ["pto", "pto"], comment: "Today counts as taken" },
        { date: "2026-10-01", halves: ["work", "pto"], comment: "Future half day" },
        { date: "2026-10-03", halves: ["pto", "pto"], comment: "Unscheduled Saturday costs nothing" },
        { date: "2026-12-25", halves: ["holiday", "holiday"], comment: "Not PTO" },
        { date: "2027-01-04", halves: ["pto", "pto"], comment: "Different year" },
    ];
    raw.vacation_adjustments = [{ date: "2026-12-01", days: 2, comment: "Additional allowance" }];
    const employer = new EmployerAccount(raw);
    assert.deepEqual(employer.vacationYearSummary(2026, "2026-09-15"), {
        year: 2026, taken: 1, planned: 0.5, unplanned: 29.5, carryover: -1, allowance: 30, adjustments: 2, missingYears: [],
        bookings: [
            { date: "2026-09-15", days: 1, status: "taken", half: "fullDay", comment: "Today counts as taken" },
            { date: "2026-10-01", days: 0.5, status: "planned", half: "secondHalf", comment: "Future half day" },
        ],
    });
    const later = employer.vacationYearSummary(2026, "2026-10-01");
    assert.equal(later.taken, 1.5);
    assert.equal(later.planned, 0);
    assert.equal(later.unplanned, 29.5);
    raw.days.push({ date: "2026-10-02", halves: ["pto", "pto"], comment: "New booking" });
    const booked = new EmployerAccount(raw).vacationYearSummary(2026, "2026-09-15");
    assert.equal(booked.planned, 1.5);
    assert.equal(booked.unplanned, 28.5);
    assert.equal(booked.taken, 1);
    assert.equal(booked.carryover + booked.allowance + booked.adjustments, booked.taken + booked.planned + booked.unplanned);
    assert.equal(booked.bookings.reduce((sum, day) => sum + day.days, 0), booked.taken + booked.planned);
    booked.bookings[0].comment = "Detached";
    assert.notEqual(employer.day("2026-09-15").comment, "Detached");
    raw.days.push({ date: "2026-11-02", halves: ["pto", "flex"], comment: "First half PTO" });
    assert.equal(new EmployerAccount(raw).vacationYearSummary(2026, "2026-09-15").bookings.at(-1).half, "firstHalf");
    assert.throws(() => employer.vacationYearSummary(2026.5, "2026-09-15"), /year/i);
    assert.throws(() => employer.vacationYearSummary(2026, "2026-02-30"), /date/i);
});

test("annual vacation summaries respect tracking, employment boundaries, and unknown allowances", () => {
    const raw = account();
    raw.opening_vacation_days = 2;
    raw.vacation_allowances = { 2025: 10 };
    raw.active_until = "2026-03-31";
    raw.days = [
        { date: "2025-08-29", halves: ["pto", "pto"], comment: "Before employment" },
        { date: "2026-03-31", halves: ["pto", "pto"], comment: "Last day" },
        { date: "2026-04-01", halves: ["pto", "pto"], comment: "Outside employment" },
    ];
    const employer = new EmployerAccount(raw);
    assert.equal(employer.vacationYearSummary(2024, "2026-01-01").unplanned, 0);
    assert.equal(employer.vacationYearSummary(2025, "2026-01-01").carryover, 2);
    assert.equal(employer.vacationYearSummary(2025, "2026-01-01").taken, 0);
    const summary = employer.vacationYearSummary(2026, "2026-01-01");
    assert.equal(summary.carryover, 12);
    assert.equal(summary.planned, 1);
    assert.equal(summary.unplanned, 11);
    assert.deepEqual(summary.missingYears, [2026]);
});

test("a full-week vacation charges only scheduled workdays, including an employer-specific Saturday", () => {
    const raw = account();
    raw.days = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ date: `2025-09-0${day}`, halves: ["pto", "pto"], comment: "Away" }));
    const employer = new EmployerAccount(raw);
    assert.equal(employer.vacationBalance("2025-09-07").used, 5);
    assert.equal(employer.vacationUsed("2025-09-06"), 0);
    assert.equal(employer.requiredHours("2025-09-06"), 0);
    raw.schedules[0].hours[5] = 4;
    assert.equal(new EmployerAccount(raw).vacationUsed("2025-09-06"), 1);
    raw.days[0].halves = ["holiday", "holiday"];
    assert.equal(new EmployerAccount(raw).vacationUsed("2025-09-01"), 0);
});

test("vacation carries across years with explicit allowances, adjustments and historical corrections", () => {
    const raw = account();
    raw.opening_vacation_days = 5;
    raw.vacation_allowances = { 2025: 30, 2026: 28 };
    raw.vacation_adjustments = [{ date: "2025-09-01", days: -2, comment: "Correction" }];
    raw.days = [{ date: "2025-09-01", halves: ["pto", "work"], comment: "" }];
    let employer = new EmployerAccount(raw);
    assert.equal(employer.vacationBalance("2025-12-31").balance, 32.5);
    assert.equal(employer.vacationBalance("2026-01-01").balance, 60.5);
    assert.deepEqual(employer.vacationBalance("2027-01-01").missingYears, [2027]);
    raw.days[0].halves = ["sick", "work"];
    employer = new EmployerAccount(raw);
    assert.equal(employer.vacationBalance("2026-01-01").balance, 61);
    assert.equal(employer.vacationBalance("2025-08-31").balance, 0);
    raw.active_until = "2025-12-31";
    assert.equal(new EmployerAccount(raw).vacationBalance("2026-09-01").balance, 33);
});

test("accounts reject duplicate assignments, impossible dates and invalid schedules/statuses", () => {
    assert.throws(() => workDate("2025-02-29"), /valid date/);
    assert.throws(() => workDate("bad"), /date between/);
    assert.equal(workDate("2024-02-29"), "2024-02-29");
    assert.throws(() => config(account(), account()), /Duplicate employer/);
    const other = account("b");
    other.project_keys = ["a"];
    assert.throws(() => config(account(), other), /multiple employers/);
    assert.throws(() => config(account()).validateProjects([]), /Unknown employer project/);
    config(account()).validateProjects(["a"]);
    for (const mutate of [
        (raw) => { raw.name = ""; },
        (raw) => { raw.active_until = "2025-01-01"; },
        (raw) => { raw.tracking_start = "2025-08-01"; },
        (raw) => { raw.project_keys = ["a", "a"]; },
        (raw) => { raw.opening_overtime_hours = NaN; },
        (raw) => { raw.schedules = []; },
        (raw) => { raw.schedules[0].hours = [8]; },
        (raw) => { raw.schedules[0].hours[0] = 25; },
        (raw) => { raw.schedules[0].effective_from = "2025-09-02"; },
        (raw) => { raw.schedules.push(structuredClone(raw.schedules[0])); },
        (raw) => { raw.vacation_allowances = { nope: 2 }; },
        (raw) => { raw.days = [{ date: "2025-09-01", halves: ["other", "pto"] }]; },
        (raw) => { raw.days = [1, 2].map(() => ({ date: "2025-09-01", halves: ["pto", "pto"] })); },
    ]) {
        const raw = account();
        mutate(raw);
        assert.throws(() => new EmployerAccount(raw));
    }
    assert.throws(() => new WorkTimeConfig({ schema_version: 2, employers: [] }), /schema_version 3/);
    assert.throws(() => WeekRequirements.fromRaw({ schema_version: 99 }), /Unsupported/);
});

test("version-three serialization round-trips accounts and disallows daily/weekly hour overrides", () => {
    const raw = config(account()).toObject();
    const requirements = WeekRequirements.fromRaw(raw);
    assert.equal(requirements.schema_version, 3);
    assert.deepEqual(JSON.parse(requirements.toJson()), raw);
    assert.throws(() => requirements.withUpdatedWeek("2025-09-01", 12, "", ""), /not manual/);
    assert.equal(requirements.getRequiredHours("2025-09-01"), 40);
    assert.equal(requirements.getComment("2025-09-01"), "");
    assert.deepEqual(requirements.listWeeks(), []);
    assert.equal(config(account()).activeEmployers("2025-08-25").length, 0);
    assert.equal(config(account()).activeEmployers("2025-09-01").length, 1);
    assert.equal(config(account()).getEmployer("missing"), null);
});

test("employer attribution counts only billable projects and respects start dates, midnight and today's cutoff", () => {
    const store = makeStore();
    const a = account();
    a.tracking_start = "2025-09-02";
    a.opening_overtime_hours = 10;
    a.days = [{ date: "2025-09-02", halves: ["pto", "pto"], comment: "" }];
    const b = account("b");
    b.schedules[0].hours = [4, 4, 4, 4, 4, 0, 0];
    b.active_until = "2025-09-02";
    store.setWeekRequirements(WeekRequirements.fromRaw(config(a, b).toObject()));
    store.applyWeekSnapshot("2025-09-01", [
        entry(1, "2025-09-01T23:00:00+02:00", "2025-09-02T01:00:00+02:00"),
        entry(2, "2025-09-02T08:00:00+02:00", "2025-09-02T09:00:00+02:00"),
        entry(3, "2025-09-02T09:00:00+02:00", "2025-09-02T12:00:00+02:00", "b"),
        entry(4, "2025-09-02T12:00:00+02:00", "2025-09-02T13:00:00+02:00", "a", false),
        entry(5, "2025-09-03T12:00:00+02:00", "2025-09-03T13:00:00+02:00", "b"),
        entry(6, "2025-09-03T14:00:00+02:00", "2025-09-03T15:00:00+02:00", "other"),
    ]);
    assert.equal(store.getAccountBillableSeconds("2025-09-01", "2025-09-03", "a"), 7200);
    assert.equal(store.getAccountBillableSeconds("2025-09-01", "2025-09-03", "b"), 10800);
    assert.equal(store.getEmployerBalance("a", "2025-09-02"), 12 * 3600);
    assert.equal(store.getEmployerBalance("b", "2025-09-02"), -5 * 3600);
    assert.equal(store.getWeekBillableSecondsThroughDate("2025-09-01", "2025-09-02"), 5 * 3600);
    assert.equal(store.getRequiredHoursThroughDate("2025-09-01", "2025-09-02"), 8);
    assert.equal(store.getWeekBalanceSeconds("2025-09-01", "2025-09-02"), -3 * 3600);
    assert.equal(store.getAccumulatedBalanceSeconds("2025-09-01", "2025-09-02"), 7 * 3600);
    assert.equal(store.getWeekBalanceSeconds("2025-09-08", "2025-09-02"), 0);
    assert.equal(store.getEmployerBalance("missing", "2025-09-02"), 0);
    assert.equal(store.getEmployerBalance("a", "2025-09-01"), 0);
    assert.equal(store.getAccumulatedBalanceSeconds("2025-08-25", "2025-09-02"), 0);
});

test("billable durations remain real elapsed hours across DST and week overflow", () => {
    const store = makeStore();
    const raw = account("a", "2025-01-01");
    store.setWeekRequirements(WeekRequirements.fromRaw(config(raw).toObject()));
    store.applyWeekSnapshot("2025-10-20", [entry(1, "2025-10-26T01:00:00+02:00", "2025-10-26T04:00:00+01:00")]);
    assert.equal(store.getAccountBillableSeconds("2025-10-26", "2025-10-26"), 4 * 3600);
    store.applyWeekSnapshot("2025-03-24", [entry(2, "2025-03-30T01:00:00+01:00", "2025-03-30T04:00:00+02:00")]);
    assert.equal(store.getAccountBillableSeconds("2025-03-30", "2025-03-30"), 2 * 3600);
    store.applyWeekSnapshot("2025-09-01", [entry(3, "2025-09-07T23:00:00+02:00", "2025-09-08T02:00:00+02:00")]);
    assert.equal(store.getAccountBillableSeconds("2025-09-07", "2025-09-08"), 3 * 3600);
});
