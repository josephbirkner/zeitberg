import {
    addIsoDays,
    chunkKey,
    cloneJson,
    gitBlobSha1,
    hhmmToMinutes,
    isoWeekInfo,
    isoWeekStart,
    isoWeekdayIndex,
    utcNowIso,
} from "./utils.js";
import { Entry, Manifest, ProjectList, TodoList, Week, WeekRequirements } from "./model.js";

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
export const BALANCE_ACCUMULATION_START = "2025-09-01";

/**
 * @typedef {Object} TodoDetails
 * @description Editable TODO fields accepted by TodoStore create/update operations.
 * @property {string} content
 * @property {string} [description]
 * @property {string | null} [projectKey]
 * @property {string | null} [sectionKey]
 * @property {string[]} [labels]
 * @property {number} [priority]
 * @property {import("./model.js").TodoDueRaw | null} [due]
 * @property {import("./model.js").RecurrenceRaw | null} [recurrence]
 */

/**
 * Stores the TODO document and provides validated mutations for TodoView.
 * Project/section keys are resolved through EntryStore, making its ProjectList the single inventory for TODOs and time entries.
 */
export class TodoStore {
    /**
     * Initializes an empty TODO document backed by the shared project store.
     * @param {EntryStore} projectStore
     */
    constructor(projectStore) {
        this.projectStore = projectStore;
        this.todoList = TodoList.createEmpty();
    }

    /**
     * Replaces the currently loaded TODO document after loading, restoring a draft, or applying undo/redo.
     * @param {TodoList | null} todoList
     * @returns {void}
     */
    setTodoList(todoList) {
        const next = todoList instanceof TodoList ? todoList : TodoList.createEmpty();
        for (const todo of next.list()) {
            if (!this.projectStore.resolveAssignment(todo.projectKey, todo.sectionKey)) {
                throw new Error(`TODO ${todo.id} references unknown assignment ${todo.projectKey || "(none)"}/${todo.sectionKey || "(none)"}.`);
            }
        }
        this.todoList = next;
    }

    /**
     * Resets all TODO state without changing the shared project inventory.
     * @returns {void}
     */
    clear() {
        this.todoList = TodoList.createEmpty();
    }

    /**
     * Returns the complete TODO document model.
     * @returns {TodoList}
     */
    getTodoList() {
        return this.todoList;
    }

    /**
     * Returns a copy of all TODO models for filtering and rendering.
     * @returns {import("./model.js").Todo[]}
     */
    getTodos() {
        return this.todoList.list();
    }

    /**
     * Finds one TODO by its stable local or imported identifier.
     * @param {string} id
     * @returns {import("./model.js").Todo | null}
     */
    getTodoById(id) {
        return this.todoList.getTodoById(id);
    }

    /**
     * Returns detached raw rows used as editor snapshots and durable browser drafts.
     * @returns {import("./model.js").TodoRaw[]}
     */
    snapshotRaw() {
        return this.todoList.snapshotRaw();
    }

    /**
     * Rebuilds models from a raw snapshot while retaining or replacing document metadata.
     * @param {import("./model.js").TodoRaw[]} todosRaw
     * @param {string} [generatedAt]
     * @returns {void}
     */
    applySnapshot(todosRaw, generatedAt = this.todoList.generated_at) {
        this.setTodoList(TodoList.fromRaw({
            generated_at: generatedAt,
            schema_version: 3,
            todos: Array.isArray(todosRaw) ? todosRaw : [],
        }));
    }

    /**
     * Validates and returns the due occurrence together with its optional recurrence rule.
     * Keeping this invariant in TodoStore protects callers other than the modal editor from creating an unadvanceable series.
     * @param {TodoDetails} details
     * @returns {{due: import("./model.js").TodoDueRaw | null, recurrence: import("./model.js").RecurrenceRaw | null}}
     */
    normalizeSchedule(details) {
        const due = details?.due || null;
        const recurrence = details?.recurrence || null;
        if (recurrence && !due) {
            throw new Error("A recurring TODO needs a due date.");
        }
        return { due, recurrence };
    }

    /**
     * Resolves and validates an optional configured project/section assignment.
     * A section may only exist beneath its owning project; unknown keys are rejected before a TODO snapshot is changed.
     * @param {string | null | undefined} projectKey
     * @param {string | null | undefined} sectionKey
     * @returns {{projectKey: string | null, sectionKey: string | null}}
     */
    normalizeAssignment(projectKey, sectionKey) {
        const normalizedProjectKey = typeof projectKey === "string" && projectKey.trim() ? projectKey.trim() : null;
        const normalizedSectionKey = typeof sectionKey === "string" && sectionKey.trim() ? sectionKey.trim() : null;
        const assignment = this.projectStore.resolveAssignment(normalizedProjectKey, normalizedSectionKey);
        if (!assignment) {
            const label = [normalizedProjectKey, normalizedSectionKey].filter(Boolean).join("/") || "(none)";
            throw new Error(`Unknown project assignment: ${label}`);
        }
        return { projectKey: normalizedProjectKey, sectionKey: normalizedSectionKey };
    }

    /**
     * Generates a collision-resistant local id without depending on a server round-trip.
     * @returns {string}
     */
    reserveTodoId() {
        let suffix = "";
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            suffix = crypto.randomUUID();
        } else {
            suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        }
        let candidate = `local:${suffix}`;
        while (this.todoList.getTodoById(candidate)) {
            candidate = `local:${suffix}-${Math.random().toString(36).slice(2)}`;
        }
        return candidate;
    }

    /**
     * Creates and inserts a new TODO using only validated editable fields.
     * @param {TodoDetails} details
     * @param {string} [nowIso]
     * @returns {import("./model.js").Todo}
     */
    createTodo(details, nowIso = utcNowIso()) {
        const content = String(details?.content || "").trim();
        if (!content) throw new Error("A TODO needs a title.");
        const assignment = this.normalizeAssignment(details?.projectKey, details?.sectionKey);
        const schedule = this.normalizeSchedule(details);
        const maxOrder = this.getTodos().reduce((max, todo) => Math.max(max, todo.order), 0);
        const raw = {
            id: this.reserveTodoId(),
            content,
            description: String(details?.description || ""),
            project_key: assignment.projectKey,
            section_key: assignment.sectionKey,
            parent_id: null,
            labels: Array.isArray(details?.labels) ? details.labels : [],
            priority: Number(details?.priority || 1),
            due: schedule.due,
            recurrence: schedule.recurrence,
            completion_history: [],
            deadline: null,
            completed_at: null,
            created_at: nowIso,
            updated_at: nowIso,
            archived: false,
            order: maxOrder + 1,
            source: null,
        };
        const next = this.snapshotRaw();
        next.push(raw);
        this.applySnapshot(next);
        const created = this.getTodoById(raw.id);
        if (!created) throw new Error("Failed to create TODO.");
        return created;
    }

    /**
     * Updates editable fields while preserving parent links, provenance, and untouched imported metadata.
     * @param {string} id
     * @param {TodoDetails} details
     * @param {string} [nowIso]
     * @returns {import("./model.js").Todo}
     */
    updateTodo(id, details, nowIso = utcNowIso()) {
        const current = this.getTodoById(id);
        if (!current) throw new Error("TODO not found.");
        const content = String(details?.content || "").trim();
        if (!content) throw new Error("A TODO needs a title.");
        const assignment = this.normalizeAssignment(details?.projectKey, details?.sectionKey);
        const schedule = this.normalizeSchedule(details);
        const next = this.snapshotRaw();
        const index = next.findIndex((todo) => todo.id === current.id);
        if (index < 0) throw new Error("TODO not found.");
        next[index] = {
            ...next[index],
            content,
            description: String(details?.description || ""),
            project_key: assignment.projectKey,
            section_key: assignment.sectionKey,
            labels: Array.isArray(details?.labels) ? details.labels : [],
            priority: Number(details?.priority || 1),
            due: schedule.due,
            recurrence: schedule.recurrence,
            updated_at: nowIso,
        };
        this.applySnapshot(next);
        const updated = this.getTodoById(current.id);
        if (!updated) throw new Error("Failed to update TODO.");
        return updated;
    }

    /**
     * Replaces persistence provenance after an external system assigns an identity to a TODO.
     * The operation intentionally leaves the user-facing `updated_at` timestamp untouched: creating an issue link is save metadata, not a content edit.
     * @param {string} id Stable zeitplural TODO id.
     * @param {import("./model.js").TodoSourceRaw | null} source Normalized external source metadata.
     * @returns {import("./model.js").Todo}
     */
    setTodoSource(id, source) {
        const current = this.getTodoById(id);
        if (!current) throw new Error("TODO not found.");
        const next = this.snapshotRaw();
        const index = next.findIndex((todo) => todo.id === current.id);
        if (index < 0) throw new Error("TODO not found.");
        next[index] = { ...next[index], source: source ? cloneJson(source) : null };
        this.applySnapshot(next);
        const updated = this.getTodoById(current.id);
        if (!updated) throw new Error("Failed to attach TODO source metadata.");
        return updated;
    }

    /**
     * Toggles completion for a one-off task or completes the current occurrence of a recurring series.
     * A recurring completion is appended to `completion_history`, advances `due` beyond the completion instant, and leaves the series open.
     * Snapshot-based callers therefore receive the entire mutation as one undoable action.
     * @param {string} id
     * @param {string} [nowIso]
     * @returns {import("./model.js").Todo}
     */
    toggleTodoCompleted(id, nowIso = utcNowIso()) {
        const current = this.getTodoById(id);
        if (!current) throw new Error("TODO not found.");
        const next = this.snapshotRaw();
        const index = next.findIndex((todo) => todo.id === current.id);
        if (index < 0) throw new Error("TODO not found.");

        if (current.isCompleted()) {
            next[index] = {
                ...next[index],
                completed_at: null,
                updated_at: nowIso,
            };
        } else if (current.recurrence) {
            if (!current.due) {
                throw new Error("Cannot complete a recurring TODO without a due date.");
            }
            const nextDue = current.recurrence.nextDue(current.due, nowIso, this.projectStore.timeContext);
            if (!nextDue) {
                throw new Error(`Cannot advance unsupported recurrence: ${current.recurrence.describe()}`);
            }
            next[index] = {
                ...next[index],
                due: nextDue,
                completion_history: [
                    ...current.completion_history,
                    {
                        completed_at: nowIso,
                        scheduled_for: current.due.date,
                    },
                ],
                completed_at: null,
                updated_at: nowIso,
            };
        } else {
            next[index] = {
                ...next[index],
                completed_at: nowIso,
                updated_at: nowIso,
            };
        }
        this.applySnapshot(next);
        const updated = this.getTodoById(current.id);
        if (!updated) throw new Error("Failed to update TODO.");
        return updated;
    }

    /**
     * Removes one TODO from the document; TodoView snapshots make the operation undoable until and after saving.
     * @param {string} id
     * @returns {boolean}
     */
    deleteTodo(id) {
        const current = this.getTodoById(id);
        if (!current) return false;
        const next = this.snapshotRaw().filter((todo) => todo.id !== current.id);
        this.applySnapshot(next);
        return true;
    }

    /**
     * Stamps the document generation time and returns deterministic data/todos.json content.
     * @param {string} [nowIso]
     * @returns {string}
     */
    serialize(nowIso = utcNowIso()) {
        this.applySnapshot(this.snapshotRaw(), nowIso);
        return this.todoList.toJson();
    }
}

/**
 * Stores entries as Week objects and provides fast indexes.
 * Centralizes all derived data structures used by the views.
 */
export class EntryStore {
    /**
     * Initializes the store with a timezone-aware TimeContext.
     * Supports derived data and serialization steps.
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
        this.projectList = null;
        this.weekRequirements = WeekRequirements.createDefault();
    }

    /**
     * Updates the TimeContext used for date math.
     * Supports derived data and serialization steps.
     * @param {import("./utils.js").TimeContext} timeContext
     * @returns {void}
     */
    setTimeContext(timeContext) {
        this.timeContext = timeContext;
    }

    /**
     * Clears entry data and caches, optionally preserving side-config models.
     * Supports derived data and serialization steps.
     * @param {{keepProjects?: boolean, keepWeekRequirements?: boolean}} [options]
     * @returns {void}
     */
    clear(options = {}) {
        this.weeks.clear();
        this.entriesById.clear();
        this.weekSegmentsCache.clear();
        this.longEntryIds.clear();
        this.latestWeekStart = null;
        this.nextEntryId = 1;
        this.manifest = null;
        if (!options.keepProjects) {
            this.projectList = null;
        }
        if (!options.keepWeekRequirements) {
            this.weekRequirements = WeekRequirements.createDefault();
        }
    }

    /**
     * Sets the current manifest for later serialization.
     * Supports derived data and serialization steps.
     * @param {Manifest | null} manifest
     * @returns {void}
     */
    setManifest(manifest) {
        this.manifest = manifest;
    }

    /**
     * Returns the manifest if it has been loaded.
     * Supports derived data and serialization steps.
     * @returns {Manifest | null}
     */
    getManifest() {
        return this.manifest;
    }

    /**
     * Stores the shared project taxonomy and refreshes entry search labels.
     * Recomputing the label cache also makes project/section renames immediately searchable without rewriting historical entries.
     * @param {ProjectList | null} projectList
     * @returns {void}
     */
    setProjectList(projectList) {
        this.projectList = projectList;
        for (const entry of this.entriesById.values()) {
            this.updateEntryAssignmentSearchText(entry);
        }
    }

    /**
     * Returns the project list payload.
     * Supports derived data and serialization steps.
     * @returns {ProjectList | null}
     */
    getProjectList() {
        return this.projectList;
    }

    /**
     * Returns a copy of projects for UI consumption.
     * Supports derived data and serialization steps.
     * @returns {import("./model.js").Project[]}
     */
    getProjects() {
        return this.projectList ? this.projectList.list() : [];
    }

    /**
     * Looks up a project by its immutable stable key.
     * @param {string | null | undefined} key
     * @returns {import("./model.js").Project | null}
     */
    getProjectByKey(key) {
        return this.projectList ? this.projectList.getProjectByKey(key) : null;
    }

    /**
     * Finds a project by its editable display name for combobox input only.
     * Persisted entry and TODO identities always use keys returned by the matched model.
     * @param {string} name
     * @returns {import("./model.js").Project | null}
     */
    findProjectByName(name) {
        return this.projectList ? this.projectList.findProjectByName(name) : null;
    }

    /**
     * Returns the shared flat project/section choices used by every assignment combobox.
     * Views receive copies from ProjectList, so they may filter archived choices without mutating the taxonomy.
     * @returns {import("./model.js").AssignmentOption[]}
     */
    getAssignmentOptions() {
        return this.projectList ? this.projectList.listAssignmentOptions() : [];
    }

    /**
     * Converts an exact project/section combobox label back into stable persisted keys.
     * Empty input intentionally resolves to no project; arbitrary or ambiguous text returns null for validation.
     * @param {string | null | undefined} label
     * @returns {{projectKey: string | null, sectionKey: string | null} | null}
     */
    findAssignmentByLabel(label) {
        if (this.projectList) return this.projectList.findAssignmentByLabel(label);
        return String(label || "").trim() ? null : { projectKey: null, sectionKey: null };
    }

    /**
     * Resolves a configured assignment into its project, section, label, color, and effective billable state.
     * Returns null for unknown key pairs and a neutral assignment for an intentional no-project entry.
     * @param {string | null | undefined} projectKey
     * @param {string | null | undefined} sectionKey
     * @returns {import("./model.js").ResolvedAssignment | null}
     */
    resolveAssignment(projectKey, sectionKey) {
        if (this.projectList) return this.projectList.resolveAssignment(projectKey, sectionKey);
        if (!projectKey && !sectionKey) {
            return { project: null, section: null, label: "", color: "", billable: null, archived: false };
        }
        return null;
    }

    /**
     * Returns a concise display label for a valid assignment, or an explicit missing-reference marker for corrupt data.
     * @param {string | null | undefined} projectKey
     * @param {string | null | undefined} sectionKey
     * @returns {string}
     */
    getAssignmentLabel(projectKey, sectionKey) {
        const assignment = this.resolveAssignment(projectKey, sectionKey);
        if (assignment) return assignment.label;
        return `[Missing: ${[projectKey, sectionKey].filter(Boolean).join("/")}]`;
    }

    /**
     * Returns the effective configured color for an assignment, including section overrides.
     * @param {string | null | undefined} projectKey
     * @param {string | null | undefined} sectionKey
     * @returns {string}
     */
    getAssignmentColor(projectKey, sectionKey) {
        return this.resolveAssignment(projectKey, sectionKey)?.color || "";
    }

    /**
     * Returns the effective configured billable state for a new or edited assignment.
     * Existing entry snapshots retain their persisted billable value until their assignment is changed explicitly.
     * @param {string | null | undefined} projectKey
     * @param {string | null | undefined} sectionKey
     * @returns {boolean | null}
     */
    getAssignmentBillable(projectKey, sectionKey) {
        return this.resolveAssignment(projectKey, sectionKey)?.billable ?? null;
    }

    /**
     * Updates one entry's derived human-readable assignment search text.
     * Unknown assignments fail early during loading instead of silently rendering as a different project.
     * @param {import("./model.js").Entry} entry
     * @returns {void}
     */
    updateEntryAssignmentSearchText(entry) {
        const assignment = this.resolveAssignment(entry.projectKey, entry.sectionKey);
        if (!assignment) {
            throw new Error(`Entry ${entry.id} references unknown assignment ${entry.projectKey || "(none)"}/${entry.sectionKey || "(none)"}.`);
        }
        entry.setAssignmentSearchText(assignment.label);
    }

    /**
     * Stores week-level required-hours settings.
     * Supports derived data and serialization steps.
     * @param {WeekRequirements | null} weekRequirements
     * @returns {void}
     */
    setWeekRequirements(weekRequirements) {
        this.weekRequirements = weekRequirements instanceof WeekRequirements ? weekRequirements : WeekRequirements.createDefault();
    }

    /**
     * Returns week-level required-hours settings.
     * Supports derived data and serialization steps.
     * @returns {WeekRequirements}
     */
    getWeekRequirements() {
        return this.weekRequirements;
    }

    /**
     * Returns required hours for a given week.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @returns {number}
     */
    getWeekRequiredHours(weekStart) {
        return this.weekRequirements.getRequiredHours(weekStart);
    }

    /**
     * Returns the optional week comment for a week.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @returns {string}
     */
    getWeekComment(weekStart) {
        return this.weekRequirements.getComment(weekStart);
    }

    /**
     * Applies a week requirement update and stores the new model.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @param {number} requiredHours
     * @param {string} comment
     * @param {string} updatedAt
     * @returns {WeekRequirements}
     */
    updateWeekRequirement(weekStart, requiredHours, comment, updatedAt) {
        const next = this.weekRequirements.withUpdatedWeek(weekStart, requiredHours, comment, updatedAt);
        this.weekRequirements = next;
        return next;
    }

    /**
     * Returns the manifest chunk list or an empty array.
     * Supports derived data and serialization steps.
     * @returns {import("./model.js").ManifestChunk[]}
     */
    getChunks() {
        return this.manifest ? this.manifest.chunks : [];
    }

    /**
     * Returns a week object by weekStart key.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @returns {Week | null}
     */
    getWeek(weekStart) {
        return this.weeks.get(weekStart) || null;
    }

    /**
     * Returns all entries currently loaded into the store.
     * Supports derived data and serialization steps.
     * @returns {import("./model.js").Entry[]}
     */
    getAllEntries() {
        return Array.from(this.entriesById.values());
    }

    /**
     * Looks up an entry by id.
     * Supports derived data and serialization steps.
     * @param {number} entryId
     * @returns {import("./model.js").Entry | null}
     */
    getEntryById(entryId) {
        return this.entriesById.get(entryId) || null;
    }

    /**
     * Returns the most recent weekStart seen in loaded data.
     * Supports derived data and serialization steps.
     * @returns {string | null}
     */
    getLatestWeekStart() {
        return this.latestWeekStart;
    }

    /**
     * Reserves and returns a new unique entry id.
     * Supports derived data and serialization steps.
     * @returns {number}
     */
    reserveEntryId() {
        const id = this.nextEntryId;
        this.nextEntryId += 1;
        return id;
    }

    /**
     * Recomputes the next id based on existing entries.
     * Supports derived data and serialization steps.
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
     * Updates the long-entry index used for cross-week lookups.
     * Supports derived data and serialization steps.
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
     * Ensures the entry has a cached weekStart value.
     * Supports derived data and serialization steps.
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
     * Replaces all entries for a week and updates indexes.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @param {import("./model.js").Entry[]} entries
     * @returns {void}
     */
    setWeekEntries(weekStart, entries) {
        const week = new Week(weekStart);
        for (const entry of entries) {
            entry.setWeekStart(weekStart);
            this.updateEntryAssignmentSearchText(entry);
            week.addEntry(entry);
            this.entriesById.set(entry.id, entry);
            this.updateLongEntryIndex(entry);
        }
        week.sortEntries();
        this.weeks.set(weekStart, week);
    }

    /**
     * Removes a week and clears its entries from indexes.
     * Supports derived data and serialization steps.
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
     * Applies a raw snapshot of entries to rebuild a week.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @param {import("./model.js").EntryRaw[]} rawEntries
     * @returns {void}
     */
    applyWeekSnapshot(weekStart, rawEntries) {
        this.removeWeek(weekStart);
        const entries = [];
        for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
            if (!raw || typeof raw !== "object") continue;
            if (!("project_key" in raw) || !("section_key" in raw)) {
                throw new Error(`Week ${weekStart} contains an entry without valid project_key/section_key fields.`);
            }
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
     * Returns raw entries for a week, sorted for serialization.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @returns {import("./model.js").EntryRaw[]}
     */
    snapshotWeekRaw(weekStart) {
        const week = this.weeks.get(weekStart);
        if (!week) return [];
        return week.snapshotRawEntries();
    }

    /**
     * Recomputes the latest weekStart from all loaded weeks.
     * Supports derived data and serialization steps.
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
     * Clears cached segment data for a week and its overflow week.
     * Supports derived data and serialization steps.
     * @param {string} weekStart
     * @returns {void}
     */
    invalidateWeekSegmentsCache(weekStart) {
        if (!weekStart) return;
        this.weekSegmentsCache.delete(weekStart);
        this.weekSegmentsCache.delete(addIsoDays(weekStart, 7));
    }

    /**
     * Returns true if an entry intersects a time range in ms.
     * Supports derived data and serialization steps.
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
     * Collects entries for a week plus surrounding overflow window.
     * Supports derived data and serialization steps.
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
     * Builds a per-day segment index used for week rendering.
     * Supports derived data and serialization steps.
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
     * Returns the cached or computed segment index for a week.
     * Supports derived data and serialization steps.
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
     * Returns all tracked seconds that fall within a displayed week.
     * Summing the clipped day segments counts overnight entries on the correct days and includes both billable and non-billable work.
     * @param {string} weekStart
     * @returns {number}
     */
    getWeekTrackedSeconds(weekStart) {
        if (!weekStart) return 0;
        const segments = this.getWeekSegmentsIndex(weekStart);
        let trackedSeconds = 0;
        for (const list of segments.values()) {
            for (const segment of list) {
                trackedSeconds += Math.max(0, Math.round((segment.endMinutes - segment.startMinutes) * 60));
            }
        }
        return trackedSeconds;
    }

    /**
     * Returns billable seconds for a week from segmented data.
     * Only billable entries are counted toward week balance.
     * @param {string} weekStart
     * @returns {number}
     */
    getWeekBillableSeconds(weekStart) {
        if (!weekStart) return 0;
        const segments = this.getWeekSegmentsIndex(weekStart);
        let billableSeconds = 0;
        for (const list of segments.values()) {
            for (const seg of list) {
                if (seg.entry?.billable !== true) continue;
                const seconds = Math.max(0, Math.round((seg.endMinutes - seg.startMinutes) * 60));
                billableSeconds += seconds;
            }
        }
        return billableSeconds;
    }

    /**
     * Returns billable seconds assigned to one displayed calendar day.
     * The week segment index clips entries at midnight, so overnight entries contribute only their visible portion to each day.
     * @param {string} weekStart
     * @param {string} day
     * @returns {number}
     */
    getDayBillableSeconds(weekStart, day) {
        if (!weekStart || !day) return 0;
        const segments = this.getWeekSegmentsIndex(weekStart).get(day) || [];
        let billableSeconds = 0;
        for (const seg of segments) {
            if (seg.entry?.billable !== true) continue;
            billableSeconds += Math.max(0, Math.round((seg.endMinutes - seg.startMinutes) * 60));
        }
        return billableSeconds;
    }

    /**
     * Returns billable seconds for a week, limited to the supplied calendar day.
     * Past weeks use their complete total, the current week includes Monday through the reference day, and future weeks return zero.
     * @param {string} weekStart
     * @param {string} throughDate
     * @returns {number}
     */
    getWeekBillableSecondsThroughDate(weekStart, throughDate) {
        if (!weekStart || !throughDate) return 0;
        const throughWeekStart = isoWeekStart(throughDate);
        if (weekStart < throughWeekStart) return this.getWeekBillableSeconds(weekStart);
        if (weekStart > throughWeekStart) return 0;

        const segments = this.getWeekSegmentsIndex(weekStart);
        let billableSeconds = 0;
        for (const [day, list] of segments.entries()) {
            if (day > throughDate) continue;
            for (const seg of list) {
                if (seg.entry?.billable !== true) continue;
                billableSeconds += Math.max(0, Math.round((seg.endMinutes - seg.startMinutes) * 60));
            }
        }
        return billableSeconds;
    }

    /**
     * Returns the portion of a weekly requirement due through a reference day.
     * Requirements are distributed evenly across Monday through Friday because the model stores one target for the whole week.
     * @param {string} weekStart
     * @param {string} throughDate
     * @returns {number}
     */
    getRequiredHoursThroughDate(weekStart, throughDate) {
        if (!weekStart || !throughDate) return 0;
        const requiredHours = this.getWeekRequiredHours(weekStart);
        const throughWeekStart = isoWeekStart(throughDate);
        if (weekStart < throughWeekStart) return requiredHours;
        if (weekStart > throughWeekStart) return 0;
        const elapsedWorkdays = Math.min(5, isoWeekdayIndex(throughDate) + 1);
        return (requiredHours * elapsedWorkdays) / 5;
    }

    /**
     * Computes week delta in seconds through a reference day.
     * Past weeks use their full requirement, while the current week only deducts the evenly distributed target due so far.
     * @param {string} weekStart
     * @param {string} [throughDate]
     * @returns {number}
     */
    getWeekBalanceSeconds(weekStart, throughDate = this.timeContext.formatDate(new Date())) {
        if (!weekStart) return 0;
        const requiredHours = this.getRequiredHoursThroughDate(weekStart, throughDate);
        const requiredSeconds = Math.round(requiredHours * 3600);
        const billableSeconds = this.getWeekBillableSecondsThroughDate(weekStart, throughDate);
        return billableSeconds - requiredSeconds;
    }

    /**
     * Returns known week starts from data plus week-requirement overrides.
     * Supports derived data and serialization steps.
     * @returns {string[]}
     */
    getKnownWeekStarts() {
        const seen = new Set();
        for (const weekStart of this.weeks.keys()) {
            seen.add(weekStart);
        }
        for (const row of this.weekRequirements.listWeeks()) {
            if (row?.week_start) {
                seen.add(row.week_start);
            }
        }
        return Array.from(seen).sort((a, b) => a.localeCompare(b));
    }

    /**
     * Computes accumulated balance up to a week using one consistent reference day.
     * This prevents the current week from deducting its complete target before those workdays have elapsed.
     * @param {string} weekStart
     * @param {string} [throughDate]
     * @returns {number}
     */
    getAccumulatedBalanceSeconds(weekStart, throughDate = this.timeContext.formatDate(new Date())) {
        if (!weekStart) return 0;
        const startWeek = isoWeekStart(BALANCE_ACCUMULATION_START);
        if (weekStart < startWeek) return 0;
        let total = 0;
        let cursor = startWeek;
        for (let i = 0; i < 2000 && cursor <= weekStart; i += 1) {
            total += this.getWeekBalanceSeconds(cursor, throughDate);
            cursor = addIsoDays(cursor, 7);
        }
        return total;
    }

    /**
     * Builds a schedule of editable and overflow entries for the week.
     * Supports derived data and serialization steps.
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
     * Serializes selected weeks into file payloads with blob shas.
     * Supports derived data and serialization steps.
     * @param {string[]} weekStarts
     * @param {string} [nowIso]
     * @param {string} [entriesDirectory] Workspace-relative directory that owns normalized week chunks.
     * @returns {WeekFile[]}
     */
    serializeWeeks(weekStarts, nowIso = utcNowIso(), entriesDirectory = "data/entries") {
        const timezone = this.manifest?.timezone || this.timeContext.timeZone;
        const normalizedDirectory = String(entriesDirectory || "").replace(/\/+$/, "");
        if (!normalizedDirectory) throw new Error("Missing workspace entries directory.");
        const files = [];
        for (const weekStart of weekStarts) {
            const week = this.weeks.get(weekStart) || new Week(weekStart);
            const { payload, content, size, entries } = week.serialize(nowIso, timezone);
            const sha = gitBlobSha1(content);
            const info = isoWeekInfo(weekStart);
            const path = `${normalizedDirectory}/${info.isoYear}/${String(info.week).padStart(2, "0")}.json`;
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
     * Builds an updated manifest from new week file metadata.
     * Supports derived data and serialization steps.
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
