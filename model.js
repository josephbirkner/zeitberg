import { cloneJson, isoWeekInfo, isoWeekStart, jsonStringifySorted, utf8ByteLength } from "./utils.js";

/**
 * @typedef {Object} EntryRaw
 * @property {number} id
 * @property {string} start
 * @property {string | null} [end]
 * @property {string | null} [project]
 * @property {string | null} [description]
 * @property {string | null} [client]
 * @property {string[] | null} [tags]
 * @property {boolean | null} [billable]
 * @property {boolean | null} [is_running]
 * @property {number | null} [duration_seconds]
 * @property {string | null} [updated_at]
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
 * Represents a time entry with derived metadata.
 */
export class Entry {
    /**
     * @param {EntryRaw} raw
     */
    constructor(raw) {
        this.raw = cloneJson(raw || {});
        this.weekStart = null;
        this.searchHaystack = "";
        this.updateDerived();
    }

    /**
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
        this.tags = Array.isArray(this.raw.tags) ? this.raw.tags : [];
        this.billable = this.raw.billable === true ? true : this.raw.billable === false ? false : null;
        this.searchHaystack = [this.project, this.description, this.raw.client || "", this.tags.join(" ")]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
    }

    /**
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
     * @param {string} weekStart
     * @returns {void}
     */
    setWeekStart(weekStart) {
        this.weekStart = weekStart;
    }

    /**
     * @returns {EntryRaw}
     */
    toRaw() {
        return cloneJson(this.raw);
    }

    /**
     * @param {{project: string, description: string, tags: string[], billable: boolean, updatedAt: string}} details
     * @returns {void}
     */
    applyDetails(details) {
        this.raw.project = details.project;
        this.raw.description = details.description;
        this.raw.tags = details.tags;
        this.raw.billable = details.billable;
        this.raw.updated_at = details.updatedAt;
        this.updateDerived();
    }

    /**
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
        if (!Array.isArray(this.raw.tags)) {
            this.raw.tags = [];
        }
        this.raw.updated_at = this.raw.updated_at || timeContext.formatIsoWithOffset(new Date());
        this.weekStart = null;
        this.updateDerived();
    }
}

/**
 * Represents a week containing entries.
 */
export class Week {
    /**
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
     * @param {Entry} entry
     * @returns {void}
     */
    addEntry(entry) {
        this.entries.push(entry);
    }

    /**
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
     * @returns {EntryRaw[]}
     */
    snapshotRawEntries() {
        const raws = this.entries.map((entry) => entry.toRaw());
        raws.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")) || (a.id || 0) - (b.id || 0));
        return raws;
    }

    /**
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
 * Represents the entries manifest.
 */
export class Manifest {
    /**
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
     * @param {unknown} raw
     * @returns {Manifest}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object") {
            throw new Error("entries-manifest.json must be a JSON object");
        }

        const chunksRaw = Array.isArray(raw.chunks) ? raw.chunks : [];
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

        const timezone = typeof raw.timezone === "string" ? raw.timezone : "Europe/Berlin";
        const generatedAt = typeof raw.generated_at === "string" ? raw.generated_at : "";
        return new Manifest(chunks, timezone, generatedAt, totalEntries);
    }

    /**
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
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}
