import { addIsoDays, chunkKey, gitBlobSha1, hhmmToMinutes, isoWeekInfo, isoWeekStart, utcNowIso } from "./utils.js";
import { Entry, Manifest, Week } from "./model.js";

/**
 * @typedef {Object} WeekFile
 * @property {string} weekStart
 * @property {number} year
 * @property {number} week
 * @property {string} path
 * @property {string} sha
 * @property {number} size
 * @property {number} entries
 * @property {Object} payload
 * @property {string} content
 */

/**
 * @typedef {Object} WeekBounds
 * @property {number} startMs
 * @property {number} endMs
 */

/**
 * @typedef {Object} WeekScheduleNode
 * @property {number} id
 * @property {number} startMs
 * @property {number} endMs
 * @property {boolean} editable
 * @property {Object | null} raw
 */

/**
 * @typedef {Object} WeekSchedule
 * @property {WeekBounds} bounds
 * @property {WeekScheduleNode[]} nodes
 */

/**
 * @typedef {Object} Segment
 * @property {string} key
 * @property {string} day
 * @property {import("./model.js").Entry} entry
 * @property {number} startMinutes
 * @property {number} endMinutes
 */

const LONG_ENTRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stores entries as Week objects and provides fast indexes.
 */
export class EntryStore {
    /**
     * @param {import("./utils.js").TimeContext} timeContext
     */
    constructor(timeContext) {
        this.timeContext = timeContext;
        this.weeks = new Map();
        this.entriesById = new Map();
        this.weekSegmentsCache = new Map();
        this.longEntryIds = new Set();
        this.latestWeekStart = null;
        this.nextEntryId = 1;
        this.manifest = null;
    }

    /**
     * @param {import("./utils.js").TimeContext} timeContext
     * @returns {void}
     */
    setTimeContext(timeContext) {
        this.timeContext = timeContext;
    }

    /**
     * @returns {void}
     */
    clear() {
        this.weeks.clear();
        this.entriesById.clear();
        this.weekSegmentsCache.clear();
        this.longEntryIds.clear();
        this.latestWeekStart = null;
        this.nextEntryId = 1;
        this.manifest = null;
    }

    /**
     * @param {Manifest | null} manifest
     * @returns {void}
     */
    setManifest(manifest) {
        this.manifest = manifest;
    }

    /**
     * @returns {Manifest | null}
     */
    getManifest() {
        return this.manifest;
    }

    /**
     * @returns {import("./model.js").ManifestChunk[]}
     */
    getChunks() {
        return this.manifest ? this.manifest.chunks : [];
    }

    /**
     * @param {string} weekStart
     * @returns {Week | null}
     */
    getWeek(weekStart) {
        return this.weeks.get(weekStart) || null;
    }

    /**
     * @returns {import("./model.js").Entry[]}
     */
    getAllEntries() {
        return Array.from(this.entriesById.values());
    }

    /**
     * @param {number} entryId
     * @returns {import("./model.js").Entry | null}
     */
    getEntryById(entryId) {
        return this.entriesById.get(entryId) || null;
    }

    /**
     * @returns {string | null}
     */
    getLatestWeekStart() {
        return this.latestWeekStart;
    }

    /**
     * @returns {number}
     */
    reserveEntryId() {
        const id = this.nextEntryId;
        this.nextEntryId += 1;
        return id;
    }

    /**
     * @returns {void}
     */
    recomputeNextEntryId() {
        let maxId = 0;
        for (const entry of this.entriesById.values()) {
            const id = Number(entry?.id);
            if (Number.isFinite(id) && id > maxId) maxId = id;
        }
        this.nextEntryId = maxId + 1;
    }

    /**
     * @param {import("./model.js").Entry} entry
     * @returns {void}
     */
    updateLongEntryIndex(entry) {
        if (!entry || !(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) {
            this.longEntryIds.delete(entry?.id);
            return;
        }
        const startMs = entry.startDate instanceof Date ? entry.startDate.getTime() : NaN;
        const endMs = entry.endDate.getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            this.longEntryIds.delete(entry.id);
            return;
        }
        const span = endMs - startMs;
        if (span > LONG_ENTRY_MS) {
            this.longEntryIds.add(entry.id);
        } else {
            this.longEntryIds.delete(entry.id);
        }
    }

    /**
     * @param {import("./model.js").Entry} entry
     * @returns {string | null}
     */
    ensureEntryWeekStart(entry) {
        if (!entry) return null;
        if (entry.weekStart) return entry.weekStart;
        const startDate = entry.startDate;
        if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) return null;
        const dayStr = this.timeContext.formatDate(startDate);
        const weekStart = isoWeekStart(dayStr);
        entry.setWeekStart(weekStart);
        return weekStart;
    }

    /**
     * @param {string} weekStart
     * @param {import("./model.js").Entry[]} entries
     * @returns {void}
     */
    setWeekEntries(weekStart, entries) {
        const week = new Week(weekStart);
        for (const entry of entries) {
            entry.setWeekStart(weekStart);
            week.addEntry(entry);
            this.entriesById.set(entry.id, entry);
            this.updateLongEntryIndex(entry);
        }
        week.sortEntries();
        this.weeks.set(weekStart, week);
    }

    /**
     * @param {string} weekStart
     * @returns {void}
     */
    removeWeek(weekStart) {
        const week = this.weeks.get(weekStart);
        if (!week) return;
        for (const entry of week.entries) {
            this.entriesById.delete(entry.id);
            this.longEntryIds.delete(entry.id);
        }
        this.weeks.delete(weekStart);
    }

    /**
     * @param {string} weekStart
     * @param {import("./model.js").EntryRaw[]} rawEntries
     * @returns {void}
     */
    applyWeekSnapshot(weekStart, rawEntries) {
        this.removeWeek(weekStart);
        const entries = [];
        for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
            if (!raw || typeof raw !== "object") continue;
            const id = Number(raw.id);
            if (!Number.isFinite(id)) continue;
            const entry = new Entry(raw);
            entries.push(entry);
        }
        this.setWeekEntries(weekStart, entries);
        this.invalidateWeekSegmentsCache(weekStart);
        this.recomputeLatestWeekStart();
    }

    /**
     * @param {string} weekStart
     * @returns {import("./model.js").EntryRaw[]}
     */
    snapshotWeekRaw(weekStart) {
        const week = this.weeks.get(weekStart);
        if (!week) return [];
        return week.snapshotRawEntries();
    }

    /**
     * @returns {void}
     */
    recomputeLatestWeekStart() {
        let latest = null;
        for (const weekStart of this.weeks.keys()) {
            if (!latest || weekStart > latest) {
                latest = weekStart;
            }
        }
        this.latestWeekStart = latest;
    }

    /**
     * @param {string} weekStart
     * @returns {void}
     */
    invalidateWeekSegmentsCache(weekStart) {
        if (!weekStart) return;
        this.weekSegmentsCache.delete(weekStart);
        this.weekSegmentsCache.delete(addIsoDays(weekStart, 7));
    }

    /**
     * @param {import("./model.js").Entry} entry
     * @param {number} startMs
     * @param {number} endMs
     * @returns {boolean}
     */
    entryIntersectsRange(entry, startMs, endMs) {
        if (!entry || !(entry.startDate instanceof Date) || !(entry.endDate instanceof Date)) return false;
        const s = entry.startDate.getTime();
        const e = entry.endDate.getTime();
        if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
        return e > startMs && s < endMs;
    }

    /**
     * @param {string} weekStart
     * @param {WeekBounds} bounds
     * @returns {{windowStartMs: number, windowEndMs: number, entries: import("./model.js").Entry[]}}
     */
    collectEntriesForWeekWindow(weekStart, bounds) {
        if (!bounds) throw new Error("Invalid week bounds");
        const windowStartMs = bounds.startMs - 7 * 24 * 60 * 60 * 1000;
        const windowEndMs = bounds.endMs + 7 * 24 * 60 * 60 * 1000;

        const prevWeek = addIsoDays(weekStart, -7);
        const nextWeek = addIsoDays(weekStart, 7);
        const candidates = new Set();

        for (const ws of [prevWeek, weekStart, nextWeek]) {
            const week = this.weeks.get(ws);
            if (!week) continue;
            for (const entry of week.entries) {
                candidates.add(entry.id);
            }
        }
        for (const id of this.longEntryIds) {
            candidates.add(id);
        }

        const entries = [];
        for (const id of candidates) {
            const entry = this.entriesById.get(id);
            if (!entry) continue;
            if (this.entryIntersectsRange(entry, windowStartMs, windowEndMs)) entries.push(entry);
        }

        return { windowStartMs, windowEndMs, entries };
    }

    /**
     * @param {Entry[]} entries
     * @param {string} weekStart
     * @returns {Map<string, Segment[]>}
     */
    buildSegmentsIndexForWeek(entries, weekStart) {
        const index = new Map();
        if (!weekStart) return index;
        const weekEnd = addIsoDays(weekStart, 7);
        const now = new Date();

        for (const entry of entries) {
            if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) continue;
            const start = entry.startDate;
            const end = entry.endDate instanceof Date && !Number.isNaN(entry.endDate.getTime()) ? entry.endDate : entry.raw.is_running ? now : null;
            if (!end) continue;
            if (end.getTime() < start.getTime()) continue;

            const startDay = this.timeContext.formatDate(start);
            const endDay = this.timeContext.formatDate(end);
            if (endDay < weekStart || startDay >= weekEnd) continue;

            const startMin = hhmmToMinutes(this.timeContext.formatTime(start));
            const endMin = hhmmToMinutes(this.timeContext.formatTime(end));
            if (startMin === null || endMin === null) continue;

            let day = startDay;
            for (let iter = 0; iter < 14; iter++) {
                if (day >= weekEnd) break;
                const segStart = day === startDay ? startMin : 0;
                const segEnd = day === endDay ? endMin : 1440;
                if (day >= weekStart && segEnd > segStart) {
                    const key = `${entry.id}@${day}`;
                    const seg = { key, day, entry, startMinutes: segStart, endMinutes: segEnd };
                    const bucket = index.get(day);
                    if (bucket) bucket.push(seg);
                    else index.set(day, [seg]);
                }

                if (day === endDay) break;
                day = addIsoDays(day, 1);
            }
        }

        return index;
    }

    /**
     * @param {string} weekStart
     * @returns {Map<string, Segment[]>}
     */
    getWeekSegmentsIndex(weekStart) {
        if (!weekStart) return new Map();
        const cached = this.weekSegmentsCache.get(weekStart);
        if (cached) return cached;
        const bounds = this.timeContext.weekBoundsMs(weekStart);
        if (!bounds) return new Map();
        const { entries } = this.collectEntriesForWeekWindow(weekStart, bounds);
        const index = this.buildSegmentsIndexForWeek(entries, weekStart);
        this.weekSegmentsCache.set(weekStart, index);
        return index;
    }

    /**
     * @param {string} weekStart
     * @returns {WeekSchedule}
     */
    buildWeekSchedule(weekStart) {
        const bounds = this.timeContext.weekBoundsMs(weekStart);
        if (!bounds) throw new Error("Invalid week bounds");

        const { entries } = this.collectEntriesForWeekWindow(weekStart, bounds);
        const nodes = [];
        for (const entry of entries) {
            const startMs = entry.startDate.getTime();
            const endMs = entry.endDate.getTime();
            const editable = entry.weekStart === weekStart;
            nodes.push({
                id: entry.id,
                startMs,
                endMs,
                editable,
                raw: editable ? entry.toRaw() : null,
            });
        }

        nodes.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
        return { bounds, nodes };
    }

    /**
     * @param {string[]} weekStarts
     * @param {string} [nowIso]
     * @returns {WeekFile[]}
     */
    serializeWeeks(weekStarts, nowIso = utcNowIso()) {
        const timezone = this.manifest?.timezone || this.timeContext.timeZone;
        const files = [];
        for (const weekStart of weekStarts) {
            const week = this.weeks.get(weekStart) || new Week(weekStart);
            const { payload, content, size, entries } = week.serialize(nowIso, timezone);
            const sha = gitBlobSha1(content);
            const info = isoWeekInfo(weekStart);
            const path = `data/entries/${info.isoYear}/${String(info.week).padStart(2, "0")}.json`;
            files.push({
                weekStart,
                year: info.isoYear,
                week: info.week,
                path,
                sha,
                size,
                entries,
                payload,
                content,
            });
        }
        return files;
    }

    /**
     * @param {WeekFile[]} weekFiles
     * @param {string} [nowIso]
     * @returns {Manifest}
     */
    buildManifest(weekFiles, nowIso = utcNowIso()) {
        const timezone = this.manifest?.timezone || this.timeContext.timeZone;
        const byKey = new Map();
        const baseChunks = this.manifest ? this.manifest.chunks : [];
        for (const chunk of baseChunks) {
            byKey.set(chunkKey(chunk.year, chunk.week), { ...chunk });
        }

        for (const file of weekFiles) {
            if (!file) continue;
            byKey.set(chunkKey(file.year, file.week), {
                entries: file.entries,
                path: file.path,
                sha: file.sha,
                size: file.size,
                week: file.week,
                year: file.year,
            });
        }

        return Manifest.fromChunks(Array.from(byKey.values()), timezone, nowIso);
    }
}
