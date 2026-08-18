import assert from "node:assert/strict";
import test from "node:test";

import { Entry, Manifest, ProjectList, Week, WeekRequirement, WeekRequirements } from "../model.js";
import { BALANCE_ACCUMULATION_START, EntryStore } from "../store.js";
import { TimeContext } from "../utils.js";

/**
 * Builds a minimal shared project inventory for time-entry tests.
 *
 * @returns {ProjectList}
 */
function makeProjects() {
    return ProjectList.fromRaw({
        schema_version: 2,
        generated_at: "2026-08-16T10:00:00Z",
        projects: [
            {
                key: "work",
                name: "Work",
                color: "#315e9d",
                billable: true,
                archived: false,
                external_refs: [],
                sections: [
                    {
                        key: "internal",
                        name: "Internal",
                        color: "#637087",
                        billable: false,
                        archived: false,
                        external_refs: [],
                    },
                ],
            },
        ],
    });
}

/**
 * Builds one valid persisted time-entry row.
 *
 * @param {number} id Stable numeric entry id.
 * @param {string} start ISO timestamp with offset.
 * @param {string} end ISO timestamp with offset.
 * @param {boolean} billable Persisted billable state.
 * @param {string | null} [sectionKey] Optional section identity.
 * @returns {import("../model.js").EntryRaw}
 */
function rawEntry(id, start, end, billable, sectionKey = null) {
    return {
        id,
        start,
        end,
        duration_seconds: Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000),
        description: `Entry ${id}`,
        project_key: "work",
        section_key: sectionKey,
        billable,
        is_running: false,
        updated_at: "2026-08-16T10:00:00Z",
    };
}

test("Entry and Week models keep derived values synchronized with edits and serialization", () => {
    const context = new TimeContext("Europe/Berlin");
    const entry = new Entry(rawEntry(2, "2026-08-10T10:00:00+02:00", "2026-08-10T11:00:00+02:00", true));
    assert.equal(entry.durationSeconds, 3600);
    assert.equal(entry.getWeekStart(context), "2026-08-10");
    assert.equal(entry.getWeekStart(context), "2026-08-10");

    entry.applyDetails({
        projectKey: "work",
        sectionKey: "internal",
        description: "Updated description",
        billable: false,
        updatedAt: "2026-08-16T11:00:00Z",
    });
    entry.setAssignmentSearchText("Work / Internal");
    assert.match(entry.searchHaystack, /work \/ internal updated description/);
    entry.applyTimes(
        new Date("2026-08-10T06:00:00Z").getTime(),
        new Date("2026-08-10T07:30:00Z").getTime(),
        context,
    );
    assert.equal(entry.durationSeconds, 5400);
    assert.equal(entry.toRaw().start, "2026-08-10T08:00:00+02:00");

    const invalid = new Entry(/** @type {any} */ ({ id: 99, start: "invalid", project_key: null, section_key: null }));
    assert.equal(invalid.getWeekStart(context), null);

    const week = new Week("2026-08-10");
    week.addEntry(entry);
    week.addEntry(new Entry(rawEntry(1, "2026-08-10T07:00:00+02:00", "2026-08-10T07:15:00+02:00", true)));
    week.sortEntries();
    assert.deepEqual(week.entries.map((row) => row.id), [1, 2]);
    assert.equal(week.getEntryById(2), entry);
    assert.equal(week.getEntryById(404), null);
    assert.equal(week.removeEntryById(404), false);
    assert.equal(week.removeEntryById(1), true);
    const serialized = week.serialize("2026-08-16T12:00:00Z", "Europe/Berlin");
    assert.equal(serialized.entries, 1);
    assert.equal(serialized.payload.schema_version, 2);
    assert.match(serialized.content, /Updated description/);
});

test("weekly requirements normalize overrides and serialize immutable updates", () => {
    const invalid = new WeekRequirement(
        { week_start: "bad", required_hours: 999, comment: " invalid " },
        40,
    );
    assert.equal(invalid.isValid(), false);

    const requirements = WeekRequirements.fromRaw({
        schema_version: 2,
        generated_at: "2026-08-01T00:00:00Z",
        default_required_hours: 40,
        weeks: [
            { week_start: "2026-08-12", required_hours: 32, comment: "Vacation" },
            { week_start: "2026-08-10", required_hours: 30, comment: "Latest duplicate" },
            null,
            { week_start: "invalid", required_hours: 12 },
        ],
    });
    assert.equal(requirements.getRequiredHours("2026-08-10"), 30);
    assert.equal(requirements.getComment("2026-08-10"), "Latest duplicate");
    assert.equal(requirements.getRequiredHours("2026-08-17"), 40);
    assert.equal(requirements.getComment("2026-08-17"), "");

    const updated = requirements.withUpdatedWeek("2026-08-17", 20, "Sick", "2026-08-17T12:00:00Z");
    assert.equal(updated.getRequiredHours("2026-08-17"), 20);
    assert.equal(updated.listWeeks().length, 2);
    assert.equal(JSON.parse(updated.toJson()).schema_version, 2);
    const removed = updated.withUpdatedWeek("2026-08-17", 40, "", "2026-08-18T12:00:00Z");
    assert.equal(removed.getWeek("2026-08-17"), null);
    assert.equal(removed.withUpdatedWeek("", 10, "", ""), removed);
    assert.equal(WeekRequirements.fromRaw(null).default_required_hours, 40);
});

test("EntryStore indexes weeks, clips overflow, and computes billable overtime deterministically", () => {
    const context = new TimeContext("Europe/Berlin");
    const store = new EntryStore(context);
    const projects = makeProjects();
    store.setProjectList(projects);
    store.setManifest(
        Manifest.fromChunks(
            [
                {
                    entries: 1,
                    path: "data/entries/2025/36.json",
                    sha: "0123456789abcdef0123456789abcdef01234567",
                    size: 100,
                    week: 36,
                    year: 2025,
                },
            ],
            "Europe/Berlin",
            "2025-09-01T00:00:00Z",
        ),
    );
    store.setWeekRequirements(
        WeekRequirements.createDefault().withUpdatedWeek("2025-09-01", 8, "First week", "2025-09-01T00:00:00Z"),
    );

    store.applyWeekSnapshot("2025-09-01", [
        rawEntry(10, "2025-09-01T08:00:00+02:00", "2025-09-01T12:00:00+02:00", true),
        rawEntry(11, "2025-09-01T23:00:00+02:00", "2025-09-02T01:00:00+02:00", true),
        rawEntry(12, "2025-09-02T09:00:00+02:00", "2025-09-02T10:00:00+02:00", false, "internal"),
    ]);
    store.applyWeekSnapshot("2025-09-08", [
        rawEntry(20, "2025-09-08T08:00:00+02:00", "2025-09-08T10:00:00+02:00", true),
    ]);

    assert.equal(store.getProjectList(), projects);
    assert.equal(store.getProjects().length, 1);
    assert.equal(store.getProjectByKey("work")?.name, "Work");
    assert.equal(store.findProjectByName("work")?.key, "work");
    assert.equal(store.getAssignmentOptions().length, 2);
    assert.deepEqual(store.findAssignmentByLabel("Work / Internal"), { projectKey: "work", sectionKey: "internal" });
    assert.equal(store.getAssignmentLabel("work", null), "Work");
    assert.match(store.getAssignmentLabel("missing", null), /Missing/);
    assert.equal(store.getAssignmentColor("work", "internal"), "#637087");
    assert.equal(store.getAssignmentBillable("work", "internal"), false);

    assert.equal(store.getManifest()?.total_entries, 1);
    assert.equal(store.getChunks().length, 1);
    assert.equal(store.getWeek("2025-09-01")?.entries.length, 3);
    assert.equal(store.getAllEntries().length, 4);
    assert.equal(store.getEntryById(11)?.description, "Entry 11");
    assert.equal(store.getLatestWeekStart(), "2025-09-08");
    store.recomputeNextEntryId();
    assert.equal(store.reserveEntryId(), 21);
    assert.equal(store.snapshotWeekRaw("2025-09-01")[0].id, 10);
    assert.deepEqual(store.snapshotWeekRaw("1999-01-04"), []);

    const segments = store.getWeekSegmentsIndex("2025-09-01");
    assert.equal(segments.get("2025-09-01")?.length, 2);
    assert.equal(segments.get("2025-09-02")?.length, 2);
    assert.equal(store.getWeekSegmentsIndex("2025-09-01"), segments);
    assert.equal(store.getWeekTrackedSeconds("2025-09-01"), 7 * 3600);
    assert.equal(store.getWeekBillableSeconds("2025-09-01"), 6 * 3600);
    assert.equal(store.getDayBillableSeconds("2025-09-01", "2025-09-01"), 5 * 3600);
    assert.equal(store.getWeekBillableSecondsThroughDate("2025-09-01", "2025-09-01"), 5 * 3600);
    assert.equal(store.getWeekBillableSecondsThroughDate("2025-09-01", "2025-09-20"), 6 * 3600);
    assert.equal(store.getWeekBillableSecondsThroughDate("2025-09-08", "2025-09-01"), 0);
    assert.equal(store.getRequiredHoursThroughDate("2025-09-01", "2025-09-01"), 1.6);
    assert.equal(store.getWeekBalanceSeconds("2025-09-01", "2025-09-07"), -2 * 3600);
    assert.equal(store.getAccumulatedBalanceSeconds("2025-08-25", "2025-09-07"), 0);
    assert.equal(BALANCE_ACCUMULATION_START, "2025-09-01");
    assert.deepEqual(store.getKnownWeekStarts(), ["2025-09-01", "2025-09-08"]);

    const schedule = store.buildWeekSchedule("2025-09-01");
    assert.equal(schedule.nodes.length, 3);
    assert.equal(schedule.nodes.every((node) => node.editable), true);
    const weekFiles = store.serializeWeeks(["2025-09-01", "2025-09-15"], "2025-09-20T10:00:00Z");
    assert.deepEqual(weekFiles.map((file) => file.path), ["data/entries/2025/36.json", "data/entries/2025/38.json"]);
    assert.throws(() => store.serializeWeeks([], "", ""), /Missing workspace entries directory/);
    const nextManifest = store.buildManifest(weekFiles, "2025-09-20T10:00:00Z");
    assert.equal(nextManifest.total_chunks, 2);

    store.updateWeekRequirement("2025-09-08", 24, "Short week", "2025-09-08T00:00:00Z");
    assert.equal(store.getWeekRequiredHours("2025-09-08"), 24);
    assert.equal(store.getWeekComment("2025-09-08"), "Short week");
    assert.equal(store.getWeekRequirements().listWeeks().length, 2);

    const entry = store.getEntryById(10);
    assert.ok(entry);
    assert.equal(store.ensureEntryWeekStart(entry), "2025-09-01");
    assert.equal(store.entryIntersectsRange(entry, entry.startDate.getTime(), entry.endDate.getTime()), true);
    assert.equal(store.entryIntersectsRange(entry, entry.endDate.getTime(), entry.endDate.getTime() + 1), false);
    store.invalidateWeekSegmentsCache("2025-09-01");
    assert.notEqual(store.getWeekSegmentsIndex("2025-09-01"), segments);

    store.removeWeek("2025-09-08");
    store.recomputeLatestWeekStart();
    assert.equal(store.getLatestWeekStart(), "2025-09-01");
    store.removeWeek("missing");
    assert.throws(
        () => store.applyWeekSnapshot("2025-09-08", [/** @type {any} */ ({ id: 99, start: "2025-09-08T08:00:00+02:00" })]),
        /without valid project_key/,
    );

    store.clear({ keepProjects: true, keepWeekRequirements: true });
    assert.equal(store.getAllEntries().length, 0);
    assert.equal(store.getProjectList(), projects);
    assert.equal(store.getWeekRequiredHours("2025-09-08"), 24);
    store.clear();
    assert.equal(store.getProjectList(), null);
    assert.equal(store.getWeekRequiredHours("2025-09-08"), 40);
});
