import { addIsoDays, cloneJson, isoWeekdayIndex, jsonStringifySorted } from "./utils.js";

/** @typedef {"work" | "pto" | "sick" | "holiday" | "flex"} LeaveStatus */
/** @typedef {{effective_from: string, hours: number[]}} WorkScheduleRaw */
/** @typedef {{date: string, halves: LeaveStatus[], comment: string}} WorkDayRaw */
/** @typedef {{date: string, days: number, comment: string}} VacationAdjustmentRaw */
/** @typedef {{date: string, days: number, status: "taken" | "planned", half: "fullDay" | "firstHalf" | "secondHalf", comment: string}} VacationBooking */
/**
 * @typedef {Object} EmployerRaw
 * @property {string} id Stable account key, independent of the display name.
 * @property {string} name Display name.
 * @property {string[]} project_keys Existing projects attributed exclusively to this employer.
 * @property {string} active_from Inclusive employment start.
 * @property {string | null} active_until Inclusive employment end, or null for ongoing employment.
 * @property {string} tracking_start Inclusive accounting start.
 * @property {number} opening_overtime_hours Balance immediately before tracking_start.
 * @property {number} opening_vacation_days Carry-in balance, excluding explicit annual allowances.
 * @property {WorkScheduleRaw[]} schedules Effective-dated Monday–Sunday hour patterns.
 * @property {Record<string, number>} vacation_allowances Explicit calendar-year allowances; never prorated.
 * @property {VacationAdjustmentRaw[]} vacation_adjustments Signed, dated corrections.
 * @property {WorkDayRaw[]} days Sparse half-day annotations and comments.
 */
/** @typedef {{schema_version: number, generated_at: string, employers: EmployerRaw[]}} WorkTimeRaw */

/**
 * Validates a real ISO calendar date without accepting JavaScript's overflowing dates.
 * @param {unknown} value Candidate date.
 * @param {string} label Context included in errors.
 * @returns {string} Validated calendar date.
 */
export function workDate(value, label = "Date") {
    if (typeof value !== "string" || !/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${label} must be a date between 1900 and 2199.`);
    }
    const parsed = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`${label} is not a valid date.`);
    }
    return value;
}

/**
 * Rejects nonnumeric or out-of-range persisted accounting values instead of silently coercing them.
 * @param {unknown} value Numeric value.
 * @param {string} label Error context.
 * @param {number} [minimum] Inclusive lower bound.
 * @param {number} [maximum] Inclusive upper bound.
 * @returns {number} Validated number.
 */
function quantity(value, label, minimum = -1e6, maximum = 1e6) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be a number between ${minimum} and ${maximum}.`);
    }
    return value;
}

/**
 * Models one employer's schedule, leave and vacation independently of other employers.
 * Calculations use calendar dates, not elapsed milliseconds, so DST cannot change required hours.
 */
export class EmployerAccount {
    /**
     * Validates and detaches a persisted account, building sparse day and schedule indexes.
     * @param {EmployerRaw} raw Untrusted account record.
     */
    constructor(raw) {
        if (!raw || typeof raw !== "object") throw new Error("An employer account must be an object.");
        this.id = String(raw.id || "").trim();
        this.name = String(raw.name || "").trim();
        if (!this.id || !this.name) throw new Error("Employer ID and name are required.");
        this.active_from = workDate(raw.active_from, "Employment start");
        this.active_until = raw.active_until ? workDate(raw.active_until, "Employment end") : null;
        if (this.active_until && this.active_until < this.active_from) throw new Error("Employment end precedes its start.");
        this.tracking_start = workDate(raw.tracking_start, "Tracking start");
        if (this.tracking_start < this.active_from || (this.active_until && this.tracking_start > this.active_until)) {
            throw new Error("Tracking must start within the employment period.");
        }
        this.opening_overtime_hours = quantity(raw.opening_overtime_hours, "Opening overtime");
        this.opening_vacation_days = quantity(raw.opening_vacation_days, "Opening vacation");
        if (!Array.isArray(raw.project_keys) || raw.project_keys.some((key) => typeof key !== "string" || !key.trim())) {
            throw new Error("Employer project keys must be nonempty strings.");
        }
        this.project_keys = [...new Set(raw.project_keys)].sort();
        if (this.project_keys.length !== raw.project_keys.length) throw new Error("Duplicate employer project assignment.");
        if (!Array.isArray(raw.schedules) || !raw.schedules.length) throw new Error("At least one work schedule is required.");
        this.schedules = raw.schedules.map((schedule) => {
            const effective_from = workDate(schedule.effective_from, "Schedule start");
            if (!Array.isArray(schedule.hours) || schedule.hours.length !== 7) throw new Error("A schedule needs seven weekday hours.");
            return { effective_from, hours: schedule.hours.map((hours) => quantity(hours, "Scheduled hours", 0, 24)) };
        }).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
        if (this.schedules[0].effective_from > this.active_from) throw new Error("The first schedule must cover the employment start.");
        if (new Set(this.schedules.map((row) => row.effective_from)).size !== this.schedules.length) throw new Error("Duplicate schedule start date.");
        /** @type {Record<string, number>} */
        this.vacation_allowances = {};
        if (!raw.vacation_allowances || typeof raw.vacation_allowances !== "object" || Array.isArray(raw.vacation_allowances)) {
            throw new Error("Vacation allowances must be a calendar-year mapping.");
        }
        for (const [year, days] of Object.entries(raw.vacation_allowances)) {
            if (!/^(19|20|21)\d{2}$/.test(year)) throw new Error("Invalid vacation allowance year.");
            this.vacation_allowances[year] = quantity(days, "Vacation allowance", 0, 366);
        }
        if (!Array.isArray(raw.vacation_adjustments) || !Array.isArray(raw.days)) throw new Error("Account adjustments and days must be arrays.");
        this.vacation_adjustments = raw.vacation_adjustments.map((row) => ({
            date: workDate(row.date, "Vacation adjustment date"),
            days: quantity(row.days, "Vacation adjustment"),
            comment: String(row.comment || ""),
        })).sort((a, b) => a.date.localeCompare(b.date));
        this.days = raw.days.map((row) => {
            if ("required_hours" in row || "scheduled_hours" in row) throw new Error("Manual daily hour overrides are not supported.");
            const date = workDate(row.date, "Leave date");
            if (!Array.isArray(row.halves) || row.halves.length !== 2 || row.halves.some((status) => !["work", "pto", "sick", "holiday", "flex"].includes(status))) {
                throw new Error("Each day needs exactly two valid half-day statuses.");
            }
            return { date, halves: row.halves.slice(), comment: String(row.comment || "") };
        }).sort((a, b) => a.date.localeCompare(b.date));
        if (new Set(this.days.map((row) => row.date)).size !== this.days.length) throw new Error("Duplicate leave date in employer account.");
        this.daysByDate = new Map(this.days.map((day) => [day.date, day]));
    }

    /**
     * Tests employment membership; archived accounts still apply to their historical dates.
     * @param {string} date Calendar date.
     * @returns {boolean} Whether the date lies within the inclusive employment period.
     */
    isActive(date) {
        return date >= this.active_from && (!this.active_until || date <= this.active_until);
    }

    /**
     * Resolves the last schedule effective on a date; later changes never reinterpret earlier patterns.
     * @param {string} date Calendar date.
     * @returns {number} Scheduled hours before leave adjustments.
     */
    scheduledHours(date) {
        if (!this.isActive(date)) return 0;
        let schedule = this.schedules[0];
        for (const candidate of this.schedules) {
            if (candidate.effective_from > date) break;
            schedule = candidate;
        }
        return schedule.hours[isoWeekdayIndex(date)];
    }

    /**
     * Returns a detached day so dialog drafts cannot mutate the loaded document.
     * @param {string} date Calendar date.
     * @returns {WorkDayRaw} Stored annotation or two regular-work halves.
     */
    day(date) {
        return cloneJson(this.daysByDate.get(date) || { date, halves: ["work", "work"], comment: "" });
    }

    /**
     * Derives required hours solely from the schedule and the two non-stacking half-day statuses.
     * Time off in lieu (flex) retains its requirement: missing work reduces overtime naturally.
     * It neither credits worked hours nor adds a second, explicit deduction to the balance.
     * @param {string} date Calendar date.
     * @returns {number} Required hours after leave adjustments.
     */
    requiredHours(date) {
        return this.scheduledHours(date) * this.day(date).halves.filter((status) => status === "work" || status === "flex").length / 2;
    }

    /**
     * Calculates vacation consumption; contextual annotations on zero-hour dates cost nothing.
     * @param {string} date Calendar date.
     * @returns {number} Zero, half or one vacation day.
     */
    vacationUsed(date) {
        return this.scheduledHours(date) > 0 ? this.day(date).halves.filter((status) => status === "pto").length / 2 : 0;
    }

    /**
     * Recomputes carryover from explicit annual allowances and dated deductions, including historical corrections.
     * Missing annual allowances remain visible to the caller instead of being copied or prorated.
     * @param {string} throughDate Inclusive balance date.
     * @returns {{balance: number, used: number, allowances: number, adjustments: number, missingYears: number[]}} Vacation ledger summary.
     */
    vacationBalance(throughDate) {
        if (throughDate < this.tracking_start) return { balance: 0, used: 0, allowances: 0, adjustments: 0, missingYears: [] };
        const end = this.active_until && this.active_until < throughDate ? this.active_until : throughDate;
        let allowances = 0;
        const missingYears = [];
        for (let year = Number(this.tracking_start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) {
            if (Object.prototype.hasOwnProperty.call(this.vacation_allowances, String(year))) allowances += this.vacation_allowances[year];
            else missingYears.push(year);
        }
        const used = this.days.filter((day) => day.date >= this.tracking_start && day.date <= end)
            .reduce((total, day) => total + this.vacationUsed(day.date), 0);
        const adjustments = this.vacation_adjustments.filter((row) => row.date >= this.tracking_start && row.date <= end)
            .reduce((total, row) => total + row.days, 0);
        return { balance: this.opening_vacation_days + allowances + adjustments - used, used, allowances, adjustments, missingYears };
    }

    /**
     * Splits a calendar year's vacation into taken, booked future, and still-unplanned days.
     * The year-end ledger supplies the remaining balance, retaining negative carryover and dated adjustments.
     * Only scheduled employment days consume vacation; today's PTO is taken and later dates are planned.
     * @param {number} year Calendar year whose bookings and allowance are being summarized.
     * @param {string} today Inclusive cutoff for taken leave in the workspace timezone.
     * @returns {{year: number, taken: number, planned: number, unplanned: number, carryover: number, allowance: number, adjustments: number, missingYears: number[], bookings: VacationBooking[]}} Annual planning summary and the chronological bookings contributing to it.
     */
    vacationYearSummary(year, today) {
        if (!Number.isInteger(year) || year < 1900 || year > 2199) throw new Error("Invalid vacation summary year.");
        workDate(today, "Vacation cutoff");
        const start = `${year}-01-01`;
        const end = `${year}-12-31`;
        const ledger = this.vacationBalance(end);
        const opening = this.vacationBalance(addIsoDays(start, -1));
        let taken = 0;
        let planned = 0;
        /** @type {VacationBooking[]} */
        const bookings = [];
        for (const day of this.days) {
            if (day.date < start || day.date > end || day.date < this.tracking_start) continue;
            const days = this.vacationUsed(day.date);
            if (!days) continue;
            const status = day.date <= today ? "taken" : "planned";
            if (status === "taken") taken += days;
            else planned += days;
            bookings.push({
                date: day.date, days, status, comment: day.comment,
                half: days === 1 ? "fullDay" : day.halves[0] === "pto" ? "firstHalf" : "secondHalf",
            });
        }
        const startsThisYear = this.tracking_start >= start && this.tracking_start <= end;
        return {
            year, taken, planned, unplanned: ledger.balance,
            carryover: startsThisYear ? this.opening_vacation_days : opening.balance,
            allowance: ledger.allowances - opening.allowances,
            adjustments: ledger.adjustments - opening.adjustments,
            missingYears: ledger.missingYears,
            bookings,
        };
    }

    /**
     * Produces a detached JSON record for immutable updates and shared local/Git serialization.
     * @returns {EmployerRaw} Persistable employer account.
     */
    toRaw() {
        return cloneJson({
            id: this.id, name: this.name, project_keys: this.project_keys,
            active_from: this.active_from, active_until: this.active_until, tracking_start: this.tracking_start,
            opening_overtime_hours: this.opening_overtime_hours, opening_vacation_days: this.opening_vacation_days,
            schedules: this.schedules, vacation_allowances: this.vacation_allowances,
            vacation_adjustments: this.vacation_adjustments, days: this.days,
        });
    }
}

/**
 * Owns all personal employer accounts in one workspace's version-three requirements document.
 * Project ownership is exclusive; archived employers remain present for historical accounting.
 */
export class WorkTimeConfig {
    /**
     * Validates a versioned document and rejects duplicate IDs or project assignments.
     * @param {WorkTimeRaw} raw Persisted or draft document.
     */
    constructor(raw) {
        if (!raw || raw.schema_version !== 3 || !Array.isArray(raw.employers)) throw new Error("Work requirements must use schema_version 3 and an employers array.");
        this.generated_at = String(raw.generated_at || "");
        this.employers = raw.employers.map((account) => new EmployerAccount(account));
        const ids = new Set();
        const projects = new Set();
        for (const employer of this.employers) {
            if (ids.has(employer.id)) throw new Error("Duplicate employer ID.");
            ids.add(employer.id);
            for (const key of employer.project_keys) {
                if (projects.has(key)) throw new Error(`Project ${key} is assigned to multiple employers.`);
                projects.add(key);
            }
        }
    }

    /**
     * Creates a new personal account with a forty-hour weekday schedule and no invented vacation allowance.
     * @param {string} id Stable account key.
     * @param {string} name Display name.
     * @param {string} start Inclusive employment/tracking start.
     * @param {string[]} [projects] Assigned project keys.
     * @returns {EmployerRaw} Editable account draft.
     */
    static newEmployer(id, name, start, projects = []) {
        return {
            id, name, project_keys: projects.slice(), active_from: start, active_until: null, tracking_start: start,
            opening_overtime_hours: 0, opening_vacation_days: 0,
            schedules: [{ effective_from: start, hours: [8, 8, 8, 8, 8, 0, 0] }],
            vacation_allowances: {}, vacation_adjustments: [], days: [],
        };
    }

    /**
     * Finds one account by stable ID.
     * @param {string} id Account key.
     * @returns {EmployerAccount | null} Matching account.
     */
    getEmployer(id) {
        return this.employers.find((employer) => employer.id === id) || null;
    }

    /**
     * Lists accounts employed at any point in a displayed week, including historical accounts.
     * @param {string} weekStart Monday date.
     * @returns {EmployerAccount[]} Active accounts in document order.
     */
    activeEmployers(weekStart) {
        const end = addIsoDays(weekStart, 6);
        return this.employers.filter((employer) => employer.active_from <= end && (!employer.active_until || employer.active_until >= weekStart));
    }

    /**
     * Sums schedule-derived daily requirements, clipped to each account's tracking period.
     * @param {string} from Inclusive calendar start.
     * @param {string} through Inclusive cutoff.
     * @param {string} [employerId] Optional account filter; omission sums all employers.
     * @returns {number} Required work hours.
     */
    requiredHours(from, through, employerId = "") {
        let hours = 0;
        for (const employer of this.employers) {
            if (employerId && employer.id !== employerId) continue;
            for (let day = from < employer.tracking_start ? employer.tracking_start : from; day <= through; day = addIsoDays(day, 1)) {
                hours += employer.requiredHours(day);
            }
        }
        return hours;
    }

    /**
     * Ensures all configured project keys still belong to the workspace's shared project inventory.
     * @param {string[]} projectKeys Existing project keys, including archived projects.
     * @returns {void}
     */
    validateProjects(projectKeys) {
        const known = new Set(projectKeys);
        for (const employer of this.employers) {
            for (const key of employer.project_keys) if (!known.has(key)) throw new Error(`Unknown employer project: ${key}.`);
        }
    }

    /**
     * Serializes employer accounts and their dated schedules, leave and balances.
     * @returns {WorkTimeRaw} Detached JSON payload.
     */
    toObject() {
        return { schema_version: 3, generated_at: this.generated_at, employers: this.employers.map((account) => account.toRaw()) };
    }

    /**
     * Uses the same deterministic serializer for every provider.
     * @returns {string} JSON document.
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}
