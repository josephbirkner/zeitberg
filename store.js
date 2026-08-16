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
import {
    Entry,
    ExpenseDocument,
    ExpenseManifest,
    Manifest,
    ProjectList,
    TodoList,
    Week,
    WeekRequirements,
} from "./model.js";

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
        /** @type {Set<string>} */
        this.loadedGitHubRepositories = new Set();
        /** @type {Set<string>} */
        this.remoteTodoIds = new Set();
        /** @type {Map<string, import("./model.js").GitHubTodoOverlayRaw>} */
        this.githubOverlaysByIdentity = new Map();
        /** @type {Map<string, Object>} */
        this.githubIssueBases = new Map();
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
        this.githubOverlaysByIdentity = new Map(
            next.github_overlays.map((overlay) => [
                TodoStore.githubIdentity(overlay.repository, overlay.issue_number),
                cloneJson(overlay),
            ]),
        );
        this.rebuildRemoteTodoIds();
    }

    /**
     * Resets all TODO state without changing the shared project inventory.
     * @returns {void}
     */
    clear() {
        this.todoList = TodoList.createEmpty();
        this.loadedGitHubRepositories.clear();
        this.remoteTodoIds.clear();
        this.githubOverlaysByIdentity.clear();
        this.githubIssueBases.clear();
    }

    /**
     * Builds the stable runtime/cache identity for one GitHub issue task.
     * @param {string} repository Valid owner/repository binding.
     * @param {number | string} issueNumber Positive issue number.
     * @returns {string}
     */
    static githubIdentity(repository, issueNumber) {
        return `${String(repository || "").trim()}#${Number(issueNumber)}`;
    }

    /**
     * Recomputes which runtime TODOs are GitHub-owned after an undo, draft restore, or model replacement.
     * A legacy mirrored row is considered remote only after its repository has actually loaded, keeping local/offline workspaces backwards compatible.
     * @returns {void}
     */
    rebuildRemoteTodoIds() {
        this.remoteTodoIds = new Set(
            this.todoList
                .list()
                .filter(
                    (todo) =>
                        String(todo.source?.provider || "").toLowerCase() === "github" &&
                        Boolean(todo.source?.project_id) &&
                        this.loadedGitHubRepositories.has(String(todo.source?.project_id)),
                )
                .map((todo) => todo.id),
        );
    }

    /**
     * Reports whether one runtime TODO is owned by a loaded GitHub issue collection and must therefore not be mirrored into todos.json.
     * @param {import("./model.js").Todo | import("./model.js").TodoRaw} todo Runtime model or raw row.
     * @returns {boolean}
     */
    isGitHubOwnedTodo(todo) {
        return this.remoteTodoIds.has(String(todo?.id || ""));
    }

    /**
     * Extracts only Zeitplural-specific scheduling fields from one issue-backed runtime TODO.
     * @param {import("./model.js").Todo | import("./model.js").TodoRaw} todo GitHub-backed task.
     * @returns {import("./model.js").GitHubTodoOverlayRaw}
     */
    overlayFromTodo(todo) {
        const raw = typeof todo?.toRaw === "function" ? todo.toRaw() : todo;
        const source = raw?.source;
        const repository = String(source?.project_id || "").trim();
        const issueNumber = Number(source?.id);
        const assignment = this.projectStore.resolveAssignment(raw?.project_key, raw?.section_key);
        const expectedSectionLabel = assignment?.section?.getExternalReference("github-label")?.id || null;
        const sectionBindingChanged = String(source?.section_id || "") !== String(expectedSectionLabel || "");
        return TodoList.normalizeGitHubOverlay({
            repository,
            issue_number: issueNumber,
            parent_id: raw?.parent_id || null,
            due: raw?.due || null,
            recurrence: raw?.recurrence || null,
            completion_history: raw?.completion_history || [],
            deadline: raw?.deadline || null,
            priority: raw?.priority || 1,
            order: raw?.order || 0,
            ...(sectionBindingChanged ? { section_key_override: raw?.section_key || null } : {}),
        });
    }

    /**
     * Reports whether an overlay differs from fields derivable directly from its GitHub issue.
     * Omitting all-default overlays keeps todos.json proportional to actual Zeitplural-only metadata instead of to the total upstream issue count.
     * @param {import("./model.js").GitHubTodoOverlayRaw} overlay Normalized overlay candidate.
     * @returns {boolean}
     */
    hasMeaningfulGitHubOverlay(overlay) {
        return Boolean(
            overlay.parent_id ||
                overlay.due ||
                overlay.recurrence ||
                overlay.completion_history.length ||
                overlay.deadline ||
                overlay.priority !== 1 ||
                overlay.order !== overlay.issue_number ||
                Object.prototype.hasOwnProperty.call(overlay, "section_key_override")
        );
    }

    /**
     * Applies a compact local overlay to an upstream-owned raw task without replacing any GitHub title, body, label, or state field.
     * @param {import("./model.js").TodoRaw} todoRaw Fresh upstream task row.
     * @param {import("./model.js").GitHubTodoOverlayRaw | null} overlay Optional scheduling overlay.
     * @returns {import("./model.js").TodoRaw}
     */
    applyGitHubOverlay(todoRaw, overlay) {
        if (!overlay) return cloneJson(todoRaw);
        return {
            ...cloneJson(todoRaw),
            parent_id: overlay.parent_id,
            due: cloneJson(overlay.due),
            recurrence: cloneJson(overlay.recurrence),
            completion_history: cloneJson(overlay.completion_history),
            deadline: cloneJson(overlay.deadline),
            priority: overlay.priority,
            order: overlay.order,
            ...(Object.prototype.hasOwnProperty.call(overlay, "section_key_override")
                ? { section_key: overlay.section_key_override || null }
                : {}),
        };
    }

    /**
     * Replaces one repository's legacy/memory issue rows with a freshly fetched complete issue collection.
     * Legacy schema-v3 mirrors contribute only overlay fields; all upstream-owned fields come from the fetched issue payload.
     * @param {string} repository GitHub owner/repository binding.
     * @param {import("./model.js").TodoRaw[]} remoteTodos Fresh normalized issue tasks.
     * @param {Map<string, Object>} issueBases Runtime identity to upstream concurrency metadata.
     * @returns {void}
     */
    replaceGitHubTodos(repository, remoteTodos, issueBases) {
        const normalizedRepository = String(repository || "").trim();
        const current = this.snapshotRaw();
        const legacyByIssue = new Map();
        const retained = [];
        for (const raw of current) {
            const source = raw.source;
            const isRepositoryIssue =
                String(source?.provider || "").toLowerCase() === "github" &&
                String(source?.project_id || "") === normalizedRepository;
            if (!isRepositoryIssue) {
                retained.push(raw);
                continue;
            }
            const issueNumber = Number(source?.id);
            if (Number.isSafeInteger(issueNumber) && issueNumber > 0) {
                legacyByIssue.set(issueNumber, this.overlayFromTodo(raw));
            }
        }

        const normalizedRemote = [];
        const liveIdentities = new Set();
        const liveTodoIds = new Set();
        for (const remoteRaw of remoteTodos) {
            const issueNumber = Number(remoteRaw?.source?.id);
            const identity = TodoStore.githubIdentity(normalizedRepository, issueNumber);
            liveIdentities.add(identity);
            const overlay = this.githubOverlaysByIdentity.get(identity) || legacyByIssue.get(issueNumber) || null;
            if (overlay) this.githubOverlaysByIdentity.set(identity, cloneJson(overlay));
            normalizedRemote.push(this.applyGitHubOverlay(remoteRaw, overlay));
            liveTodoIds.add(remoteRaw.id);
        }
        for (const todoId of [...this.githubIssueBases.keys()]) {
            if (todoId.startsWith(`github:${normalizedRepository}#`) && !liveTodoIds.has(todoId)) {
                this.githubIssueBases.delete(todoId);
            }
        }
        for (const identity of [...this.githubOverlaysByIdentity.keys()]) {
            if (identity.startsWith(`${normalizedRepository}#`) && !liveIdentities.has(identity)) {
                this.githubOverlaysByIdentity.delete(identity);
            }
        }
        this.loadedGitHubRepositories.add(normalizedRepository);
        this.todoList = TodoList.fromRaw({
            generated_at: this.todoList.generated_at,
            github_overlays: [...this.githubOverlaysByIdentity.values()],
            schema_version: 4,
            todos: [...retained, ...normalizedRemote],
        });
        this.rebuildRemoteTodoIds();
        for (const [id, base] of issueBases) this.githubIssueBases.set(id, cloneJson(base));
    }

    /**
     * Returns the last fetched upstream metadata used to detect remote edits made after a local draft began.
     * @param {string} todoId Stable runtime issue-task id.
     * @returns {Object | null}
     */
    getGitHubIssueBase(todoId) {
        return this.githubIssueBases.get(String(todoId || "")) || null;
    }

    /**
     * Updates one issue's concurrency baseline after a successful create, refresh, or patch.
     * @param {string} todoId Stable runtime issue-task id.
     * @param {Object} base Fresh upstream metadata.
     * @returns {void}
     */
    setGitHubIssueBase(todoId, base) {
        this.githubIssueBases.set(String(todoId || ""), cloneJson(base));
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
     * Captures runtime rows plus compact overlay metadata so a failed multi-document project migration can be rolled back exactly.
     * @returns {{todos: import("./model.js").TodoRaw[], generatedAt: string, githubOverlays: import("./model.js").GitHubTodoOverlayRaw[], loadedGitHubRepositories: string[], githubIssueBases: Array<[string, Object]>}}
     */
    snapshotDocumentState() {
        return {
            todos: this.snapshotRaw(),
            generatedAt: this.todoList.generated_at,
            githubOverlays: [...this.githubOverlaysByIdentity.values()].map((overlay) => cloneJson(overlay)),
            loadedGitHubRepositories: [...this.loadedGitHubRepositories],
            githubIssueBases: [...this.githubIssueBases].map(([id, base]) => [id, cloneJson(base)]),
        };
    }

    /**
     * Restores a document snapshot captured before an atomic project-binding migration.
     * @param {{todos: import("./model.js").TodoRaw[], generatedAt: string, githubOverlays: import("./model.js").GitHubTodoOverlayRaw[], loadedGitHubRepositories?: string[], githubIssueBases?: Array<[string, Object]>}} state Prior state.
     * @returns {void}
     */
    restoreDocumentState(state) {
        this.githubOverlaysByIdentity = new Map(
            (state.githubOverlays || []).map((overlay) => [
                TodoStore.githubIdentity(overlay.repository, overlay.issue_number),
                cloneJson(overlay),
            ]),
        );
        this.loadedGitHubRepositories = new Set(state.loadedGitHubRepositories || []);
        this.githubIssueBases = new Map(
            (state.githubIssueBases || []).map(([id, base]) => [String(id), cloneJson(base)]),
        );
        this.applySnapshot(state.todos || [], state.generatedAt || "");
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
            github_overlays: [...this.githubOverlaysByIdentity.values()],
            schema_version: 4,
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
        const id = this.reserveTodoId();
        const repository = assignment.projectKey
            ? this.projectStore.resolveAssignment(assignment.projectKey, assignment.sectionKey)?.project?.getExternalReference("github")?.id || null
            : null;
        const sectionLabel = assignment.sectionKey
            ? this.projectStore.resolveAssignment(assignment.projectKey, assignment.sectionKey)?.section?.getExternalReference("github-label")?.id || null
            : null;
        const raw = {
            id,
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
            source: repository
                ? {
                      provider: "github-pending",
                      id,
                      project_id: repository,
                      section_id: sectionLabel,
                  }
                : null,
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
        const resolvedAssignment = this.projectStore.resolveAssignment(assignment.projectKey, assignment.sectionKey);
        const currentProvider = String(current.source?.provider || "").toLowerCase();
        const assignedRepository = resolvedAssignment?.project?.getExternalReference("github")?.id || null;
        if (currentProvider === "github" && assignedRepository !== current.source?.project_id) {
            throw new Error("A linked GitHub issue cannot be moved to a different repository-backed project.");
        }
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
        if (currentProvider === "github-pending") {
            next[index].source = assignedRepository
                ? {
                      provider: "github-pending",
                      id: current.source?.id || current.id,
                      project_id: assignedRepository,
                      section_id: resolvedAssignment?.section?.getExternalReference("github-label")?.id || null,
                  }
                : null;
        }
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
     * Replaces a newly created pending task with the stable GitHub issue identity returned by the provider.
     * Its local scheduling fields become an overlay, while fresh upstream fields remain authoritative.
     * @param {string} pendingId Existing local task id.
     * @param {import("./model.js").TodoRaw} remoteRaw Fresh normalized task built from the created issue response.
     * @param {Object} issueBase Upstream concurrency metadata.
     * @returns {import("./model.js").Todo}
     */
    promoteTodoToGitHub(pendingId, remoteRaw, issueBase) {
        const pending = this.getTodoById(pendingId);
        if (!pending) throw new Error("Pending TODO not found.");
        const overlay = this.overlayFromTodo({
            ...pending.toRaw(),
            source: remoteRaw.source,
        });
        const identity = TodoStore.githubIdentity(overlay.repository, overlay.issue_number);
        this.githubOverlaysByIdentity.set(identity, overlay);
        this.loadedGitHubRepositories.add(overlay.repository);
        const next = this.snapshotRaw().filter((todo) => todo.id !== pending.id);
        next.push(this.applyGitHubOverlay(remoteRaw, overlay));
        this.applySnapshot(next);
        this.remoteTodoIds.add(remoteRaw.id);
        this.setGitHubIssueBase(remoteRaw.id, issueBase);
        const promoted = this.getTodoById(remoteRaw.id);
        if (!promoted) throw new Error("Failed to promote TODO to a GitHub issue.");
        return promoted;
    }

    /**
     * Marks existing local tasks in a newly bound project for explicit publication on the next TODO save.
     * Already linked tasks and provider imports are left untouched.
     * @param {string} projectKey Project being connected.
     * @param {string} repository GitHub owner/repository binding.
     * @param {(todo: import("./model.js").Todo) => boolean} [isPublishable] Optional policy gate for tasks that must never be exposed through the target issue tracker.
     * @returns {number} Number of tasks marked pending.
     */
    markProjectTodosForGitHub(projectKey, repository, isPublishable = () => true) {
        const next = this.snapshotRaw();
        let changed = 0;
        for (const raw of next) {
            if (raw.project_key !== projectKey || raw.source) continue;
            const todo = this.getTodoById(raw.id);
            if (!todo || !isPublishable(todo)) continue;
            const assignment = this.projectStore.resolveAssignment(raw.project_key, raw.section_key);
            raw.source = {
                provider: "github-pending",
                id: raw.id,
                project_id: repository,
                section_id: assignment?.section?.getExternalReference("github-label")?.id || null,
            };
            changed += 1;
        }
        if (changed) this.applySnapshot(next);
        return changed;
    }

    /**
     * Reconciles unpublished task provenance with the currently configured project repository and section label.
     * Removing a binding returns pending tasks to ordinary local ownership; renaming a section label updates only metadata used by the eventual issue creation.
     * @returns {number} Number of pending records whose source metadata changed.
     */
    refreshPendingGitHubBindings() {
        const next = this.snapshotRaw();
        let changed = 0;
        for (const raw of next) {
            if (String(raw.source?.provider || "").toLowerCase() !== "github-pending") continue;
            const assignment = this.projectStore.resolveAssignment(raw.project_key, raw.section_key);
            const repository = assignment?.project?.getExternalReference("github")?.id || "";
            const source = repository
                ? {
                      provider: "github-pending",
                      id: raw.source?.id || raw.id,
                      project_id: repository,
                      section_id: assignment?.section?.getExternalReference("github-label")?.id || null,
                  }
                : null;
            if (JSON.stringify(raw.source) === JSON.stringify(source)) continue;
            raw.source = source;
            changed += 1;
        }
        if (changed) this.applySnapshot(next);
        return changed;
    }

    /**
     * Rebuilds compact overlays for loaded issue tasks after project section-label configuration changes.
     * A temporary section override makes the intended label migration survive reloads until the next manual TODO save updates GitHub and removes the override again.
     * @returns {boolean} Whether persisted overlay metadata changed.
     */
    refreshGitHubTaskOverlays() {
        const before = JSON.stringify(
            [...this.githubOverlaysByIdentity.entries()].sort((left, right) => left[0].localeCompare(right[0])),
        );
        for (const todo of this.getTodos()) {
            if (!this.remoteTodoIds.has(todo.id)) continue;
            const overlay = this.overlayFromTodo(todo);
            const identity = TodoStore.githubIdentity(overlay.repository, overlay.issue_number);
            if (this.hasMeaningfulGitHubOverlay(overlay)) this.githubOverlaysByIdentity.set(identity, overlay);
            else this.githubOverlaysByIdentity.delete(identity);
        }
        const after = JSON.stringify(
            [...this.githubOverlaysByIdentity.entries()].sort((left, right) => left[0].localeCompare(right[0])),
        );
        return before !== after;
    }

    /**
     * Materializes every linked or unpublished issue task in a detached project as an ordinary JSON-backed task.
     * The repository argument prevents a repository replacement from altering unrelated provenance that happens to share the same local project.
     * @param {string} projectKey Detached project key.
     * @param {string} [repository] Previous GitHub owner/repository binding.
     * @returns {number} Number of retained local copies.
     */
    materializeGitHubProjectTodos(projectKey, repository = "") {
        const next = this.snapshotRaw();
        let changed = 0;
        for (const raw of next) {
            const provider = String(raw.source?.provider || "").toLowerCase();
            const matchesRepository = !repository || raw.source?.project_id === repository;
            if (raw.project_key !== projectKey || !matchesRepository || (provider !== "github" && provider !== "github-pending")) {
                continue;
            }
            const issueNumber = Number(raw.source?.id);
            if (provider === "github" && Number.isSafeInteger(issueNumber) && issueNumber > 0) {
                const identity = TodoStore.githubIdentity(raw.source?.project_id || "", issueNumber);
                this.githubOverlaysByIdentity.delete(identity);
                this.githubIssueBases.delete(raw.id);
            }
            raw.source = null;
            changed += 1;
        }
        if (changed) this.applySnapshot(next);
        if (repository) this.loadedGitHubRepositories.delete(repository);
        this.rebuildRemoteTodoIds();
        return changed;
    }

    /**
     * Removes issue-owned tasks from a detached project while leaving upstream issues untouched.
     * Unpublished pending tasks have no upstream counterpart and are therefore retained as ordinary local tasks even when the remove choice is selected.
     * @param {string} projectKey Detached project key.
     * @param {string} [repository] Previous GitHub owner/repository binding.
     * @returns {number} Number of runtime tasks removed.
     */
    removeGitHubProjectTodos(projectKey, repository = "") {
        const before = this.snapshotRaw();
        const next = [];
        let removed = 0;
        let changed = false;
        for (const raw of before) {
            const provider = String(raw.source?.provider || "").toLowerCase();
            const matchesRepository = !repository || raw.source?.project_id === repository;
            const matchesProject = raw.project_key === projectKey && matchesRepository;
            if (matchesProject && provider === "github") {
                const issueNumber = Number(raw.source?.id);
                if (Number.isSafeInteger(issueNumber) && issueNumber > 0) {
                    const identity = TodoStore.githubIdentity(raw.source?.project_id || "", issueNumber);
                    this.githubOverlaysByIdentity.delete(identity);
                }
                this.githubIssueBases.delete(raw.id);
                removed += 1;
                continue;
            }
            if (matchesProject && provider === "github-pending") {
                raw.source = null;
                changed = true;
            }
            next.push(raw);
        }
        if (removed || changed) this.applySnapshot(next);
        if (repository) this.loadedGitHubRepositories.delete(repository);
        this.rebuildRemoteTodoIds();
        return removed;
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
        const localTodos = this.snapshotRaw().filter((todo) => !this.remoteTodoIds.has(todo.id));
        const overlays = new Map(this.githubOverlaysByIdentity);
        for (const todo of this.getTodos()) {
            if (!this.remoteTodoIds.has(todo.id)) continue;
            const overlay = this.overlayFromTodo(todo);
            const identity = TodoStore.githubIdentity(overlay.repository, overlay.issue_number);
            if (this.hasMeaningfulGitHubOverlay(overlay)) overlays.set(identity, overlay);
            else overlays.delete(identity);
        }
        const persisted = TodoList.fromRaw({
            generated_at: nowIso,
            github_overlays: [...overlays.values()],
            schema_version: 4,
            todos: localTodos,
        });
        this.todoList.generated_at = nowIso;
        this.githubOverlaysByIdentity = new Map(
            persisted.github_overlays.map((overlay) => [
                TodoStore.githubIdentity(overlay.repository, overlay.issue_number),
                cloneJson(overlay),
            ]),
        );
        return persisted.toJson();
    }
}

/**
 * @typedef {Object} ExpenseDetails
 * @description Editable fields accepted when creating or updating one shared expense.
 * @property {string} description
 * @property {string} date
 * @property {string} currency
 * @property {number} amount_minor
 * @property {import("./model.js").ExpenseAmountRaw[]} payers
 * @property {import("./model.js").ExpenseAmountRaw[]} allocations
 * @property {import("./model.js").ExpenseAllocationRuleRaw | null} [allocation_rule]
 * @property {string | null} [category_key]
 * @property {string | null} [project_key]
 * @property {string | null} [section_key]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} ExpenseTransferDetails
 * @description Editable fields accepted when recording or updating a settlement transfer.
 * @property {string} date
 * @property {string} currency
 * @property {number} amount_minor
 * @property {string} from_participant_key
 * @property {string} to_participant_key
 * @property {string} [notes]
 */

/**
 * @typedef {Object} ExpenseBalance
 * @description One participant's current net position in one currency; positive means they should receive money and negative means they owe money.
 * @property {string} participantKey
 * @property {string} currency
 * @property {number} amountMinor
 */

/**
 * @typedef {Object} ExpenseSettlementSuggestion
 * @description One deterministic payment that reduces all current balances for a currency to zero when combined with the other suggestions.
 * @property {string} currency
 * @property {number} amountMinor
 * @property {string} fromParticipantKey
 * @property {string} toParticipantKey
 */

/**
 * Owns the provider-neutral expense document, validated mutations, balances, settlement suggestions, and atomic persistence payloads.
 * Every amount entering the store is re-parsed through ExpenseDocument, keeping UI code, private import scripts, and future provider adapters behind the same exact-integer invariants.
 */
export class ExpenseStore {
    /**
     * Initializes an empty ledger and retains the shared project store used to validate optional cross-component assignments.
     * @param {EntryStore} projectStore Store containing the shared ProjectList resource.
     */
    constructor(projectStore) {
        this.projectStore = projectStore;
        this.document = ExpenseDocument.createEmpty();
        /** @type {ExpenseManifest | null} */
        this.manifest = null;
    }

    /**
     * Replaces the loaded expense document after network loading, draft restoration, or undo/redo.
     * Optional project and section references are checked against the same inventory used by time entries and TODOs.
     * @param {ExpenseDocument | null} document Parsed expense document.
     * @returns {void}
     */
    setDocument(document) {
        const next = document instanceof ExpenseDocument ? document : ExpenseDocument.createEmpty();
        for (const expense of next.expenses) {
            if (!this.projectStore.resolveAssignment(expense.project_key, expense.section_key)) {
                const assignment = [expense.project_key, expense.section_key].filter(Boolean).join("/") || "(none)";
                throw new Error(`Expense ${expense.id} references unknown project assignment ${assignment}.`);
            }
        }
        this.document = next;
    }

    /**
     * Stores the manifest associated with the currently loaded document.
     * @param {ExpenseManifest | null} manifest Parsed expense manifest.
     * @returns {void}
     */
    setManifest(manifest) {
        this.manifest = manifest instanceof ExpenseManifest ? manifest : null;
    }

    /**
     * Clears all in-memory expense state while leaving shared projects untouched.
     * @returns {void}
     */
    clear() {
        this.document = ExpenseDocument.createEmpty();
        this.manifest = null;
    }

    /**
     * Returns the current expense document model.
     * @returns {ExpenseDocument}
     */
    getDocument() {
        return this.document;
    }

    /**
     * Returns integrity metadata associated with the currently loaded expense document.
     * @returns {ExpenseManifest | null}
     */
    getManifest() {
        return this.manifest;
    }

    /**
     * Finds one expense by stable id.
     * @param {string} id Expense id.
     * @returns {import("./model.js").Expense | null}
     */
    getExpenseById(id) {
        return this.document.getExpenseById(id);
    }

    /**
     * Finds one settlement transfer by stable id.
     * @param {string} id Transfer id.
     * @returns {import("./model.js").ExpenseTransfer | null}
     */
    getTransferById(id) {
        return this.document.getTransferById(id);
    }

    /**
     * Returns the current participant inventory as model objects.
     * @returns {import("./model.js").ExpenseParticipant[]}
     */
    getParticipants() {
        return this.document.participants.slice();
    }

    /**
     * Returns the current category inventory as model objects.
     * @returns {import("./model.js").ExpenseCategory[]}
     */
    getCategories() {
        return this.document.categories.slice();
    }

    /**
     * Returns all expense records as model objects.
     * @returns {import("./model.js").Expense[]}
     */
    getExpenses() {
        return this.document.expenses.slice();
    }

    /**
     * Returns all settlement transfers as model objects.
     * @returns {import("./model.js").ExpenseTransfer[]}
     */
    getTransfers() {
        return this.document.transfers.slice();
    }

    /**
     * Produces a detached complete document snapshot for undo history and IndexedDB drafts.
     * @returns {import("./model.js").ExpensesFileRaw}
     */
    snapshotRaw() {
        return cloneJson(this.document.toObject());
    }

    /**
     * Rebuilds all expense models from a detached snapshot, rerunning cross-record and project-assignment validation.
     * @param {import("./model.js").ExpensesFileRaw} raw Complete expense document snapshot.
     * @returns {void}
     */
    applySnapshot(raw) {
        this.setDocument(ExpenseDocument.fromRaw(raw));
    }

    /**
     * Generates a collision-resistant local identifier for an expense or transfer without requiring a server round trip.
     * @param {"expense" | "transfer"} kind Record kind used as a readable id prefix.
     * @returns {string}
     */
    reserveId(kind) {
        const collection = kind === "transfer" ? this.document.transfersById : this.document.expensesById;
        let suffix = "";
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            suffix = crypto.randomUUID();
        } else {
            suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        }
        let candidate = `local:${kind}:${suffix}`;
        while (collection.has(candidate)) candidate = `local:${kind}:${suffix}-${Math.random().toString(36).slice(2)}`;
        return candidate;
    }

    /**
     * Replaces participant and category metadata as one validated mutation while retaining all money records.
     * Existing records prevent referenced keys from being removed, though their definitions may be renamed or archived.
     * @param {import("./model.js").ExpenseParticipantRaw[]} participants New participant definitions.
     * @param {import("./model.js").ExpenseCategoryRaw[]} categories New category definitions.
     * @returns {void}
     */
    updateInventory(participants, categories) {
        this.applySnapshot({
            ...this.snapshotRaw(),
            participants: cloneJson(participants),
            categories: cloneJson(categories),
        });
    }

    /**
     * Creates one expense from editable details and returns its normalized model.
     * @param {ExpenseDetails} details Exact expense details.
     * @param {string} [nowIso] Creation/update timestamp.
     * @returns {import("./model.js").Expense}
     */
    createExpense(details, nowIso = utcNowIso()) {
        const id = this.reserveId("expense");
        const raw = {
            id,
            description: details.description,
            date: details.date,
            currency: details.currency,
            amount_minor: details.amount_minor,
            payers: cloneJson(details.payers),
            allocations: cloneJson(details.allocations),
            allocation_rule: details.allocation_rule ? cloneJson(details.allocation_rule) : null,
            category_key: details.category_key || null,
            project_key: details.project_key || null,
            section_key: details.section_key || null,
            notes: details.notes || "",
            created_at: nowIso,
            updated_at: nowIso,
            source: null,
        };
        const next = this.snapshotRaw();
        next.expenses = [...(next.expenses || []), raw];
        this.applySnapshot(next);
        const created = this.getExpenseById(id);
        if (!created) throw new Error("Failed to create expense.");
        return created;
    }

    /**
     * Updates editable fields while preserving stable identity, creation time, and import provenance.
     * @param {string} id Expense id.
     * @param {ExpenseDetails} details Exact replacement details.
     * @param {string} [nowIso] Update timestamp.
     * @returns {import("./model.js").Expense}
     */
    updateExpense(id, details, nowIso = utcNowIso()) {
        const current = this.getExpenseById(id);
        if (!current) throw new Error("Expense not found.");
        const next = this.snapshotRaw();
        const index = (next.expenses || []).findIndex((expense) => expense.id === current.id);
        if (index < 0) throw new Error("Expense not found.");
        next.expenses[index] = {
            ...next.expenses[index],
            description: details.description,
            date: details.date,
            currency: details.currency,
            amount_minor: details.amount_minor,
            payers: cloneJson(details.payers),
            allocations: cloneJson(details.allocations),
            allocation_rule: details.allocation_rule ? cloneJson(details.allocation_rule) : null,
            category_key: details.category_key || null,
            project_key: details.project_key || null,
            section_key: details.section_key || null,
            notes: details.notes || "",
            updated_at: nowIso,
        };
        this.applySnapshot(next);
        const updated = this.getExpenseById(current.id);
        if (!updated) throw new Error("Failed to update expense.");
        return updated;
    }

    /**
     * Deletes one expense immediately; the view's snapshot history makes this reversible.
     * @param {string} id Expense id.
     * @returns {boolean}
     */
    deleteExpense(id) {
        if (!this.getExpenseById(id)) return false;
        const next = this.snapshotRaw();
        next.expenses = (next.expenses || []).filter((expense) => expense.id !== id);
        this.applySnapshot(next);
        return true;
    }

    /**
     * Records a settlement transfer and returns its normalized model.
     * @param {ExpenseTransferDetails} details Transfer details.
     * @param {string} [nowIso] Creation/update timestamp.
     * @returns {import("./model.js").ExpenseTransfer}
     */
    createTransfer(details, nowIso = utcNowIso()) {
        const id = this.reserveId("transfer");
        const next = this.snapshotRaw();
        next.transfers = [
            ...(next.transfers || []),
            {
                id,
                date: details.date,
                currency: details.currency,
                amount_minor: details.amount_minor,
                from_participant_key: details.from_participant_key,
                to_participant_key: details.to_participant_key,
                notes: details.notes || "",
                created_at: nowIso,
                updated_at: nowIso,
                source: null,
            },
        ];
        this.applySnapshot(next);
        const created = this.getTransferById(id);
        if (!created) throw new Error("Failed to create settlement.");
        return created;
    }

    /**
     * Deletes one settlement transfer immediately; the view's snapshot history makes this reversible.
     * @param {string} id Transfer id.
     * @returns {boolean}
     */
    deleteTransfer(id) {
        if (!this.getTransferById(id)) return false;
        const next = this.snapshotRaw();
        next.transfers = (next.transfers || []).filter((transfer) => transfer.id !== id);
        this.applySnapshot(next);
        return true;
    }

    /**
     * Computes every non-zero participant balance independently per currency.
     * Expense contributions add credit, allocations subtract debt, outgoing settlements reduce debt, and incoming settlements reduce credit.
     * @returns {ExpenseBalance[]}
     */
    calculateBalances() {
        /** @type {Map<string, Map<string, number>>} */
        const byCurrency = new Map();
        const add = (currency, participantKey, amountMinor) => {
            let balances = byCurrency.get(currency);
            if (!balances) {
                balances = new Map();
                byCurrency.set(currency, balances);
            }
            const next = (balances.get(participantKey) || 0) + amountMinor;
            if (!Number.isSafeInteger(next)) throw new Error("Expense balance exceeds the safe integer range.");
            balances.set(participantKey, next);
        };
        for (const expense of this.document.expenses) {
            for (const payer of expense.payers) add(expense.currency, payer.participant_key, payer.amount_minor);
            for (const allocation of expense.allocations) add(expense.currency, allocation.participant_key, -allocation.amount_minor);
        }
        for (const transfer of this.document.transfers) {
            add(transfer.currency, transfer.from_participant_key, transfer.amount_minor);
            add(transfer.currency, transfer.to_participant_key, -transfer.amount_minor);
        }
        const result = [];
        for (const [currency, balances] of [...byCurrency].sort(([left], [right]) => left.localeCompare(right))) {
            const total = [...balances.values()].reduce((sum, amount) => sum + amount, 0);
            if (total !== 0) throw new Error(`Expense balances for ${currency} do not sum to zero.`);
            for (const [participantKey, amountMinor] of [...balances].sort(([left], [right]) => left.localeCompare(right))) {
                if (amountMinor !== 0) result.push({ participantKey, currency, amountMinor });
            }
        }
        return result;
    }

    /**
     * Builds a deterministic minimal-style settlement plan by greedily matching sorted debtors and creditors per currency.
     * The output never mutates the ledger; accepting one suggestion records an ordinary transfer through createTransfer().
     * @returns {ExpenseSettlementSuggestion[]}
     */
    suggestSettlements() {
        const balances = this.calculateBalances();
        const currencies = [...new Set(balances.map((balance) => balance.currency))].sort();
        const suggestions = [];
        for (const currency of currencies) {
            const debtors = balances
                .filter((balance) => balance.currency === currency && balance.amountMinor < 0)
                .map((balance) => ({ key: balance.participantKey, amount: -balance.amountMinor }))
                .sort((left, right) => left.key.localeCompare(right.key));
            const creditors = balances
                .filter((balance) => balance.currency === currency && balance.amountMinor > 0)
                .map((balance) => ({ key: balance.participantKey, amount: balance.amountMinor }))
                .sort((left, right) => left.key.localeCompare(right.key));
            let debtorIndex = 0;
            let creditorIndex = 0;
            while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
                const debtor = debtors[debtorIndex];
                const creditor = creditors[creditorIndex];
                const amountMinor = Math.min(debtor.amount, creditor.amount);
                suggestions.push({
                    currency,
                    amountMinor,
                    fromParticipantKey: debtor.key,
                    toParticipantKey: creditor.key,
                });
                debtor.amount -= amountMinor;
                creditor.amount -= amountMinor;
                if (debtor.amount === 0) debtorIndex += 1;
                if (creditor.amount === 0) creditorIndex += 1;
            }
        }
        return suggestions;
    }

    /**
     * Builds the exact expense document and manifest payloads that must be saved atomically through DataSource.saveFiles().
     * The in-memory document remains untouched until the caller confirms a successful save, avoiding false clean state after network errors.
     * @param {string} documentPath Workspace-configured expense document path.
     * @param {string} manifestPath Workspace-configured expense manifest path.
     * @param {string} [nowIso] Shared generation timestamp.
     * @returns {{document: ExpenseDocument, manifest: ExpenseManifest, files: Array<{path: string, content: string}>}}
     */
    buildPersistenceFiles(documentPath, manifestPath, nowIso = utcNowIso()) {
        const raw = this.snapshotRaw();
        raw.generated_at = nowIso;
        const document = ExpenseDocument.fromRaw(raw);
        const content = document.toJson();
        const manifest = ExpenseManifest.fromDocument(document, documentPath, content, nowIso);
        return {
            document,
            manifest,
            files: [
                { path: documentPath, content },
                { path: manifestPath, content: manifest.toJson() },
            ],
        };
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
