import { cloneJson, isoWeekInfo, isoWeekStart, jsonStringifySorted, utf8ByteLength } from "./utils.js";

/**
 * @typedef {Object} EntryRaw
 * @property {number} id
 * @property {string} start
 * @property {string | null} [end]
 * @property {string | null} [project]
 * @property {number | null} [project_id]
 * @property {string | null} [description]
 * @property {string | null} [client]
 * @property {boolean | null} [billable]
 * @property {boolean | null} [is_running]
 * @property {number | null} [duration_seconds]
 * @property {string | null} [updated_at]
 */

/**
 * @typedef {Object} ProjectRaw
 * @property {string} name
 * @property {string} color
 * @property {boolean} billable
 * @property {boolean} archived
 */

/**
 * @typedef {Object} ProjectsFileRaw
 * @property {string} [generated_at]
 * @property {number} [schema_version]
 * @property {ProjectRaw[]} [projects]
 */

/**
 * @typedef {Object} WeekRequirementRaw
 * @property {string} week_start
 * @property {number} required_hours
 * @property {string} [comment]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} WeekRequirementsFileRaw
 * @property {string} [generated_at]
 * @property {number} [schema_version]
 * @property {number} [default_required_hours]
 * @property {WeekRequirementRaw[]} [weeks]
 */

/**
 * @typedef {Object} ManifestChunk
 * @property {number} year
 * @property {number} week
 * @property {string} path
 * @property {string} sha
 * @property {number | null} entries
 * @property {number | null} size
 */

/**
 * @typedef {Object} ManifestFileRaw
 * @property {ManifestChunk[]} [chunks]
 * @property {string} [timezone]
 * @property {string} [generated_at]
 */

export const DEFAULT_WEEK_REQUIRED_HOURS = 40;

/**
 * Normalizes required-hours values to a bounded two-decimal number.
 * Keeps persisted weekly requirement values deterministic.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeRequiredHours(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.max(0, Math.min(168, parsed));
    return Math.round(clamped * 100) / 100;
}

/**
 * Represents a time entry with derived metadata.
 * Wraps the raw entry payload with computed fields for fast access.
 */
export class Entry {
    /**
     * Creates an Entry from the raw payload and computes derived fields.
     * Defines the data shape used by the store.
     * @param {EntryRaw} raw
     */
    constructor(raw) {
        this.raw = cloneJson(raw || {});
        this.weekStart = null;
        this.searchHaystack = "";
        this.updateDerived();
    }

    /**
     * Recomputes cached fields such as duration and search text.
     * Defines the data shape used by the store.
     * @returns {void}
     */
    updateDerived() {
        const start = new Date(this.raw.start);
        const end = this.raw.end ? new Date(this.raw.end) : null;

        let durationSeconds = null;
        if (typeof this.raw.duration_seconds === "number" && Number.isFinite(this.raw.duration_seconds)) {
            durationSeconds = this.raw.duration_seconds;
        } else if (end instanceof Date && !Number.isNaN(end.getTime())) {
            durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);
        }

        this.id = Number(this.raw.id);
        this.startDate = start;
        this.endDate = end;
        this.durationSeconds = durationSeconds;
        this.project = this.raw.project || "";
        this.description = this.raw.description || "";
        this.billable = this.raw.billable === true ? true : this.raw.billable === false ? false : null;
        this.searchHaystack = [this.project, this.description, this.raw.client || ""]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
    }

    /**
     * Returns the ISO week start for the entry, caching the result.
     * Defines the data shape used by the store.
     * @param {import("./utils.js").TimeContext} timeContext
     * @returns {string | null}
     */
    getWeekStart(timeContext) {
        if (this.weekStart) {
            return this.weekStart;
        }
        if (!(this.startDate instanceof Date) || Number.isNaN(this.startDate.getTime())) {
            return null;
        }
        const dayStr = timeContext.formatDate(this.startDate);
        this.weekStart = isoWeekStart(dayStr);
        return this.weekStart;
    }

    /**
     * Sets a known week start on the entry to avoid recomputation.
     * Defines the data shape used by the store.
     * @param {string} weekStart
     * @returns {void}
     */
    setWeekStart(weekStart) {
        this.weekStart = weekStart;
    }

    /**
     * Returns a deep-cloned raw payload for safe editing.
     * Defines the data shape used by the store.
     * @returns {EntryRaw}
     */
    toRaw() {
        return cloneJson(this.raw);
    }

    /**
     * Applies edited metadata fields and refreshes derived fields.
     * Defines the data shape used by the store.
     * @param {{project: string, description: string, billable: boolean | null, updatedAt: string}} details
     * @returns {void}
     */
    applyDetails(details) {
        this.raw.project = details.project;
        this.raw.description = details.description;
        this.raw.billable = details.billable;
        this.raw.updated_at = details.updatedAt;
        this.updateDerived();
    }

    /**
     * Updates the entry start/end times and duration using timezone-aware formatting.
     * Defines the data shape used by the store.
     * @param {number} startMs
     * @param {number} endMs
     * @param {import("./utils.js").TimeContext} timeContext
     * @returns {void}
     */
    applyTimes(startMs, endMs, timeContext) {
        const start = new Date(startMs);
        const end = new Date(endMs);
        this.raw.start = timeContext.formatIsoWithOffset(start);
        this.raw.end = timeContext.formatIsoWithOffset(end);
        this.raw.is_running = false;
        this.raw.duration_seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
        this.raw.updated_at = this.raw.updated_at || timeContext.formatIsoWithOffset(new Date());
        this.weekStart = null;
        this.updateDerived();
    }
}

/**
 * Represents a week containing entries.
 * Stores entries in the ISO week that begins on the provided Monday.
 */
export class Week {
    /**
     * Initializes the week metadata based on a week start date.
     * Defines the data shape used by the store.
     * @param {string} weekStart
     */
    constructor(weekStart) {
        this.weekStart = weekStart;
        const info = isoWeekInfo(weekStart);
        this.isoYear = info.isoYear;
        this.isoWeek = info.week;
        this.entries = [];
    }

    /**
     * Adds an Entry to the week without sorting.
     * Defines the data shape used by the store.
     * @param {Entry} entry
     * @returns {void}
     */
    addEntry(entry) {
        this.entries.push(entry);
    }

    /**
     * Finds an Entry by id within the week.
     * Defines the data shape used by the store.
     * @param {number} entryId
     * @returns {Entry | null}
     */
    getEntryById(entryId) {
        for (const entry of this.entries) {
            if (entry.id === entryId) {
                return entry;
            }
        }
        return null;
    }

    /**
     * Removes an Entry by id and returns true when removed.
     * Defines the data shape used by the store.
     * @param {number} entryId
     * @returns {boolean}
     */
    removeEntryById(entryId) {
        const idx = this.entries.findIndex((entry) => entry.id === entryId);
        if (idx < 0) return false;
        this.entries.splice(idx, 1);
        return true;
    }

    /**
     * Sorts entries by start time, then id for stability.
     * Defines the data shape used by the store.
     * @returns {void}
     */
    sortEntries() {
        this.entries.sort((a, b) => {
            const startA = a.startDate instanceof Date ? a.startDate.getTime() : 0;
            const startB = b.startDate instanceof Date ? b.startDate.getTime() : 0;
            if (startA !== startB) return startA - startB;
            return (a.id || 0) - (b.id || 0);
        });
    }

    /**
     * Returns sorted raw payloads for serialization.
     * Defines the data shape used by the store.
     * @returns {EntryRaw[]}
     */
    snapshotRawEntries() {
        const raws = this.entries.map((entry) => entry.toRaw());
        raws.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")) || (a.id || 0) - (b.id || 0));
        return raws;
    }

    /**
     * Serializes the week into its JSON file payload.
     * Defines the data shape used by the store.
     * @param {string} nowIso
     * @param {string} timezone
     * @returns {{payload: Object, content: string, size: number, entries: number}}
     */
    serialize(nowIso, timezone) {
        const payload = {
            entries: this.snapshotRawEntries(),
            generated_at: nowIso,
            schema_version: 1,
            timezone,
            week: this.isoWeek,
            year: this.isoYear,
        };
        const content = jsonStringifySorted(payload);
        return { payload, content, size: utf8ByteLength(content), entries: payload.entries.length };
    }
}

/**
 * Represents a single project definition from projects.json.
 * Used to assign colors and defaults to time entries.
 */
export class Project {
    /**
     * Normalizes raw project fields into a consistent shape.
     * Defines the data shape used by the store.
     * @param {ProjectRaw} raw
     */
    constructor(raw) {
        const name = typeof raw?.name === "string" ? raw.name.trim() : "";
        this.name = name;
        this.color = typeof raw?.color === "string" ? raw.color.trim() : "";
        this.billable = raw?.billable === true;
        this.archived = raw?.archived === true;
    }

    /**
     * Returns a JSON-ready project object.
     * Defines the data shape used by the store.
     * @returns {ProjectRaw}
     */
    toRaw() {
        return {
            name: this.name,
            color: this.color,
            billable: this.billable,
            archived: this.archived,
        };
    }
}

/**
 * Represents the projects.json payload with validation and serialization.
 * Provides lookup helpers and consistent ordering.
 */
export class ProjectList {
    /**
     * Creates a project list with metadata.
     * Defines the data shape used by the store.
     * @param {Project[]} projects
     * @param {string} generatedAt
     */
    constructor(projects, generatedAt) {
        this.projects = projects;
        this.generated_at = generatedAt;
        this.schema_version = 1;
    }

    /**
     * Builds a ProjectList from raw JSON data.
     * Defines the data shape used by the store.
     * @param {ProjectsFileRaw} raw
     * @returns {ProjectList}
     */
    static fromRaw(raw) {
        const list = [];
        const seen = new Set();
        const projects = Array.isArray(raw?.projects) ? raw.projects : [];

        for (const item of projects) {
            if (!item || typeof item !== "object") continue;
            const name = typeof item.name === "string" ? item.name.trim() : "";
            if (!name || seen.has(name.toLowerCase())) continue;
            const rawColor = typeof item.color === "string" ? item.color.trim() : "";
            const color = /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "";
            list.push(
                new Project({
                    name,
                    color,
                    billable: item.billable === true,
                    archived: item.archived === true,
                }),
            );
            seen.add(name.toLowerCase());
        }

        list.sort((a, b) => a.name.localeCompare(b.name));
        const generatedAt = typeof raw?.generated_at === "string" ? raw.generated_at : "";
        return new ProjectList(list, generatedAt);
    }

    /**
     * Returns a project by name or null when missing.
     * Defines the data shape used by the store.
     * @param {string} name
     * @returns {Project | null}
     */
    getProjectByName(name) {
        const key = String(name || "");
        if (!key) return null;
        return this.projects.find((project) => project.name === key) || null;
    }

    /**
     * Returns a shallow copy of the project array.
     * Defines the data shape used by the store.
     * @returns {Project[]}
     */
    list() {
        return this.projects.slice();
    }

    /**
     * Returns a JSON-serializable payload object.
     * Defines the data shape used by the store.
     * @returns {ProjectsFileRaw}
     */
    toObject() {
        return {
            generated_at: this.generated_at,
            projects: this.projects.map((project) => project.toRaw()),
            schema_version: this.schema_version,
        };
    }

    /**
     * Returns stable JSON output for projects.json.
     * Defines the data shape used by the store.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}

/**
 * Represents a single week-specific required-hours override.
 * Associates one ISO week start (Monday) with hours and an optional note.
 */
export class WeekRequirement {
    /**
     * Normalizes a raw week override payload into a strict object.
     * Ensures week keys are Monday-based and hours are bounded.
     * @param {WeekRequirementRaw} raw
     * @param {number} defaultRequiredHours
     */
    constructor(raw, defaultRequiredHours) {
        const weekStartRaw = typeof raw?.week_start === "string" ? raw.week_start.trim() : "";
        const weekStartNormalized = weekStartRaw && /^\d{4}-\d{2}-\d{2}$/.test(weekStartRaw) ? isoWeekStart(weekStartRaw) : "";
        this.week_start = weekStartNormalized || "";
        this.required_hours = normalizeRequiredHours(raw?.required_hours, defaultRequiredHours);
        this.comment = typeof raw?.comment === "string" ? raw.comment.trim() : "";
        this.updated_at = typeof raw?.updated_at === "string" ? raw.updated_at : "";
    }

    /**
     * Returns true when the requirement has a valid Monday week key.
     * Used while parsing persisted configuration files.
     * @returns {boolean}
     */
    isValid() {
        return Boolean(this.week_start);
    }

    /**
     * Returns a JSON-ready override payload.
     * Used while serializing week-requirements.json.
     * @returns {WeekRequirementRaw}
     */
    toRaw() {
        return {
            week_start: this.week_start,
            required_hours: this.required_hours,
            comment: this.comment,
            ...(this.updated_at ? { updated_at: this.updated_at } : {}),
        };
    }
}

/**
 * Represents the week-requirements.json payload.
 * Stores default hours plus per-week required-hours/comment overrides.
 */
export class WeekRequirements {
    /**
     * Initializes week requirements with sorted overrides.
     * Provides lookup and immutable update helpers for the store.
     * @param {number} defaultRequiredHours
     * @param {WeekRequirement[]} weeks
     * @param {string} generatedAt
     */
    constructor(defaultRequiredHours, weeks, generatedAt) {
        this.default_required_hours = normalizeRequiredHours(defaultRequiredHours, DEFAULT_WEEK_REQUIRED_HOURS);
        this.generated_at = generatedAt;
        this.schema_version = 1;
        this.weeks = weeks
            .filter((week) => week instanceof WeekRequirement && week.isValid())
            .slice()
            .sort((a, b) => a.week_start.localeCompare(b.week_start));
        this.weeksByStart = new Map();
        for (const week of this.weeks) {
            this.weeksByStart.set(week.week_start, week);
        }
    }

    /**
     * Creates a default configuration with no overrides.
     * Used when week-requirements.json does not exist yet.
     * @param {string} [generatedAt]
     * @returns {WeekRequirements}
     */
    static createDefault(generatedAt = "") {
        return new WeekRequirements(DEFAULT_WEEK_REQUIRED_HOURS, [], generatedAt);
    }

    /**
     * Parses week-requirements.json into a validated model.
     * Drops invalid rows and keeps only one override per week.
     * @param {unknown} raw
     * @returns {WeekRequirements}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object") {
            return WeekRequirements.createDefault();
        }

        const rawObj = /** @type {WeekRequirementsFileRaw} */ (raw);
        const defaultRequiredHours = normalizeRequiredHours(rawObj.default_required_hours, DEFAULT_WEEK_REQUIRED_HOURS);
        const weeksRaw = Array.isArray(rawObj.weeks) ? rawObj.weeks : [];
        const byWeek = new Map();
        for (const item of weeksRaw) {
            if (!item || typeof item !== "object") continue;
            const normalized = new WeekRequirement(item, defaultRequiredHours);
            if (!normalized.isValid()) continue;
            byWeek.set(normalized.week_start, normalized);
        }

        const generatedAt = typeof rawObj.generated_at === "string" ? rawObj.generated_at : "";
        const weeks = Array.from(byWeek.values()).sort((a, b) => a.week_start.localeCompare(b.week_start));
        return new WeekRequirements(defaultRequiredHours, weeks, generatedAt);
    }

    /**
     * Returns the override object for a week when present.
     * Used by the week UI to display required-hours metadata.
     * @param {string} weekStart
     * @returns {WeekRequirement | null}
     */
    getWeek(weekStart) {
        const key = String(weekStart || "");
        return this.weeksByStart.get(key) || null;
    }

    /**
     * Returns required hours for a week, falling back to default.
     * Used for week-level under/over-time calculations.
     * @param {string} weekStart
     * @returns {number}
     */
    getRequiredHours(weekStart) {
        const week = this.getWeek(weekStart);
        return week ? week.required_hours : this.default_required_hours;
    }

    /**
     * Returns the optional week comment for a week.
     * Used for labels such as vacation/sick annotations.
     * @param {string} weekStart
     * @returns {string}
     */
    getComment(weekStart) {
        const week = this.getWeek(weekStart);
        return week ? week.comment : "";
    }

    /**
     * Applies one week override and returns a new immutable model.
     * Removes the override when it matches defaults and has no comment.
     * @param {string} weekStart
     * @param {number} requiredHours
     * @param {string} comment
     * @param {string} updatedAt
     * @returns {WeekRequirements}
     */
    withUpdatedWeek(weekStart, requiredHours, comment, updatedAt) {
        const key = String(weekStart || "").trim();
        if (!key) return this;

        const normalizedWeekStart = /^\d{4}-\d{2}-\d{2}$/.test(key) ? isoWeekStart(key) : "";
        if (!normalizedWeekStart) return this;

        const normalizedHours = normalizeRequiredHours(requiredHours, this.default_required_hours);
        const normalizedComment = String(comment || "").trim();
        const byWeek = new Map(this.weeksByStart);

        const shouldRemove = normalizedHours === this.default_required_hours && !normalizedComment;
        if (shouldRemove) {
            byWeek.delete(normalizedWeekStart);
        } else {
            const next = new WeekRequirement(
                {
                    week_start: normalizedWeekStart,
                    required_hours: normalizedHours,
                    comment: normalizedComment,
                    updated_at: String(updatedAt || ""),
                },
                this.default_required_hours,
            );
            byWeek.set(normalizedWeekStart, next);
        }

        const weeks = Array.from(byWeek.values()).sort((a, b) => a.week_start.localeCompare(b.week_start));
        return new WeekRequirements(this.default_required_hours, weeks, String(updatedAt || this.generated_at || ""));
    }

    /**
     * Returns sorted week overrides for iteration or rendering.
     * Used by the store when computing accumulated balances.
     * @returns {WeekRequirement[]}
     */
    listWeeks() {
        return this.weeks.slice();
    }

    /**
     * Returns a JSON-ready object for serialization.
     * Used to persist week requirements through the save pipeline.
     * @returns {WeekRequirementsFileRaw}
     */
    toObject() {
        return {
            generated_at: this.generated_at,
            schema_version: this.schema_version,
            default_required_hours: this.default_required_hours,
            weeks: this.weeks.map((week) => week.toRaw()),
        };
    }

    /**
     * Returns stable JSON output for week-requirements.json.
     * Used by both GitHub and local save modes.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}

/**
 * Represents the entries manifest.
 * Stores week file metadata for loading and validation.
 */
export class Manifest {
    /**
     * Initializes a manifest with chunk metadata and totals.
     * Defines the data shape used by the store.
     * @param {ManifestChunk[]} chunks
     * @param {string} timezone
     * @param {string} generatedAt
     * @param {number} totalEntries
     */
    constructor(chunks, timezone, generatedAt, totalEntries) {
        this.chunks = chunks;
        this.timezone = timezone;
        this.generated_at = generatedAt;
        this.schema_version = 1;
        this.total_chunks = chunks.length;
        this.total_entries = totalEntries;
    }

    /**
     * Parses a raw manifest JSON object and validates its entries.
     * Defines the data shape used by the store.
     * @param {unknown} raw
     * @returns {Manifest}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object") {
            throw new Error("entries-manifest.json must be a JSON object");
        }

        const rawObj = /** @type {ManifestFileRaw} */ (raw);
        const chunksRaw = Array.isArray(rawObj.chunks) ? rawObj.chunks : [];
        const chunks = [];
        for (const c of chunksRaw) {
            if (!c || typeof c !== "object") continue;
            const year = Number(c.year);
            const week = Number(c.week);
            const sha = typeof c.sha === "string" ? c.sha : "";
            const size = Number(c.size);
            const path = typeof c.path === "string" ? c.path : "";
            const entries = typeof c.entries === "number" && Number.isFinite(c.entries) && c.entries >= 0 ? c.entries : null;

            if (!Number.isFinite(year) || year < 1970 || year > 9999) continue;
            if (!Number.isFinite(week) || week < 1 || week > 53) continue;
            if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
            if (!path.startsWith("data/entries/")) continue;

            chunks.push({
                entries,
                path,
                sha,
                size: Number.isFinite(size) && size >= 0 ? size : null,
                week,
                year,
            });
        }

        chunks.sort((a, b) => a.year - b.year || a.week - b.week);

        let totalEntries = 0;
        for (const c of chunks) {
            if (typeof c.entries === "number" && Number.isFinite(c.entries)) {
                totalEntries += c.entries;
            }
        }

        const timezone = typeof rawObj.timezone === "string" ? rawObj.timezone : "Europe/Berlin";
        const generatedAt = typeof rawObj.generated_at === "string" ? rawObj.generated_at : "";
        return new Manifest(chunks, timezone, generatedAt, totalEntries);
    }

    /**
     * Builds a manifest from the provided chunk list.
     * Defines the data shape used by the store.
     * @param {ManifestChunk[]} chunks
     * @param {string} timezone
     * @param {string} generatedAt
     * @returns {Manifest}
     */
    static fromChunks(chunks, timezone, generatedAt) {
        const list = chunks.slice().sort((a, b) => a.year - b.year || a.week - b.week);
        let totalEntries = 0;
        for (const chunk of list) {
            if (typeof chunk.entries === "number" && Number.isFinite(chunk.entries)) {
                totalEntries += chunk.entries;
            }
        }
        return new Manifest(list, timezone, generatedAt, totalEntries);
    }

    /**
     * Returns a JSON-ready object for serialization.
     * Defines the data shape used by the store.
     * @returns {Object}
     */
    toObject() {
        return {
            chunks: this.chunks,
            generated_at: this.generated_at,
            schema_version: this.schema_version,
            timezone: this.timezone,
            total_chunks: this.total_chunks,
            total_entries: this.total_entries,
        };
    }

    /**
     * Returns stable JSON output for entries-manifest.json.
     * Defines the data shape used by the store.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}
