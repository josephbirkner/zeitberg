import { cloneJson, createMaterialIcon, hhmmToMinutes, setVisible, utcNowIso } from "./utils.js";
import { Recurrence } from "./model.js";
import { buildGitHubIssueUrl } from "./datasource.js";

const TODO_DOCUMENT_NAME = "todos";

/**
 * @typedef {Object} TodoViewElements
 * @property {HTMLElement} todoView
 * @property {HTMLElement} todoList
 * @property {HTMLButtonElement} todoAddBtn
 * @property {HTMLInputElement} searchInput
 * @property {HTMLButtonElement} todoCurrentFilterBtn
 * @property {HTMLButtonElement} todoOpenFilterBtn
 * @property {HTMLElement} todoProjectFilters
 * @property {HTMLDialogElement} todoDialog
 * @property {HTMLFormElement} todoForm
 * @property {HTMLElement} todoDialogTitle
 * @property {HTMLButtonElement} todoCloseBtn
 * @property {HTMLButtonElement} todoCancelBtn
 * @property {HTMLInputElement} todoContent
 * @property {HTMLTextAreaElement} todoDescription
 * @property {HTMLInputElement} todoAssignment
 * @property {HTMLDataListElement} todoAssignmentList
 * @property {HTMLInputElement} todoDueDate
 * @property {HTMLInputElement} todoDueTime
 * @property {HTMLInputElement} todoRecurrence
 * @property {HTMLSelectElement} todoPriority
 * @property {HTMLInputElement} todoLabels
 * @property {HTMLElement} todoDialogMeta
 * @property {HTMLButtonElement} editorBadge
 */

/**
 * @typedef {Object} TodoViewOptions
 * @property {import("./store.js").TodoStore} store
 * @property {import("./store.js").EntryStore} projectStore
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {import("./cache.js").DraftJournal} draftJournal
 * @property {string} draftNamespace
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {import("./locale.js").LocaleService} locale
 * @property {TodoViewElements} elements
 * @property {(message: string, timeout?: number, tone?: "error" | "success") => void} onToast
 * @property {(isBusy: boolean) => void} onBusy
 * @property {() => void} onSaved
 * @property {(summary: string) => void} onStatsChanged
 * @property {() => void} [onStateChange]
 */

/**
 * @typedef {Object} TodoEditorAction
 * @property {string} label
 * @property {import("./model.js").TodoRaw[]} before
 * @property {import("./model.js").TodoRaw[]} after
 * @property {string | null} selectionBefore
 * @property {string | null} selectionAfter
 */

/**
 * Compares normalized TODO snapshots without relying on model identity.
 * TodoStore always emits fields in a stable order, so JSON equality is sufficient and inexpensive for the small task document.
 * @param {import("./model.js").TodoRaw[]} left
 * @param {import("./model.js").TodoRaw[]} right
 * @returns {boolean}
 */
function todoSnapshotsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Converts a snapshot into an id-indexed map for three-way browser-draft merging.
 * @param {import("./model.js").TodoRaw[]} todos
 * @returns {Map<string, import("./model.js").TodoRaw>}
 */
function todosById(todos) {
    const result = new Map();
    for (const todo of todos) {
        const id = typeof todo?.id === "string" ? todo.id : "";
        if (id) result.set(id, todo);
    }
    return result;
}

/**
 * Compares two optional raw TODO rows while treating two missing values as equal.
 * @param {import("./model.js").TodoRaw | undefined} left
 * @param {import("./model.js").TodoRaw | undefined} right
 * @returns {boolean}
 */
function rawTodosEqual(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Splits the repository due-date format into HTML date and time control values.
 * Date-only values retain an empty time, while ISO-like timestamps contribute their local HH:MM portion.
 * @param {import("./model.js").TodoDueRaw | null} due
 * @returns {{date: string, time: string}}
 */
function splitDue(due) {
    const raw = typeof due?.date === "string" ? due.date : "";
    const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
    const timeMatch = /T(\d{2}:\d{2})/.exec(raw);
    return {
        date: dateMatch ? dateMatch[1] : "",
        time: timeMatch ? timeMatch[1] : "",
    };
}

/**
 * Returns the YYYY-MM-DD comparison key from any supported due-date value.
 * @param {import("./model.js").TodoDueRaw | null} due
 * @returns {string}
 */
function dueDateKey(due) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(due?.date || ""));
    return match ? match[1] : "";
}

/**
 * Builds a stable, readable GitHub issue body from a zeitplural TODO.
 * A hidden local-id marker supports future reconciliation without exposing workspace credentials or repository details.
 * @param {import("./model.js").Todo} todo Linked TODO model.
 * @returns {string}
 */
export function buildTodoIssueBody(todo) {
    const description = String(todo?.description || "").trim();
    const completed = todo?.completed_at ? `\n\n_Originally completed in zeitplural on ${todo.completed_at}._` : "";
    const safeId = String(todo?.id || "").replace(/--/g, "—");
    const content = description || "_No additional description._";
    return `${content}${completed}\n\n---\n<sub>Linked to zeitplural task <code>${safeId}</code>.</sub>\n<!-- zeitplural-todo-id: ${safeId} -->`;
}

/**
 * Converts one linked TODO into the GitHub issue fields for which the workspace is authoritative.
 * The section's integration label and task labels are de-duplicated while completion maps to GitHub's ordinary open/closed state.
 * @param {import("./model.js").Todo} todo Linked TODO model.
 * @param {string | null} sectionLabel Optional issue type label supplied by the assigned project section.
 * @returns {{title: string, body: string, labels: string[], state: "open" | "closed"}}
 */
export function buildTodoIssueWrite(todo, sectionLabel) {
    const labels = new Set();
    if (sectionLabel) labels.add(String(sectionLabel).trim());
    for (const label of todo?.labels || []) {
        const normalized = String(label || "").trim();
        if (normalized) labels.add(normalized);
    }
    return {
        title: String(todo?.content || "").trim(),
        body: buildTodoIssueBody(todo),
        labels: [...labels],
        state: todo?.isCompleted() || todo?.archived ? "closed" : "open",
    };
}

/**
 * Reports whether a task is suitable for the public issue integration.
 * Legacy provider-specific implementation notes remain available in the private workspace but are deliberately excluded from the public tracker.
 * @param {import("./model.js").Todo} todo TODO model to inspect.
 * @returns {boolean}
 */
export function isTodoIssuePublishable(todo) {
    return !/\b(?:toggl|todoist)\b/i.test(`${String(todo?.content || "")}\n${String(todo?.description || "")}`);
}

/**
 * Manages the keyboard-first TODO list, modal editor, undo history, persistence, and browser drafts.
 * The view owns interaction state only; TodoStore owns task models and EntryStore remains the sole owner of shared projects.
 */
export class TodoView {
    /**
     * Captures dependencies and UI references, then installs local event handlers.
     * Network and IndexedDB operations are deferred until repository data has loaded.
     * @param {TodoViewOptions} options
     */
    constructor(options) {
        this.store = options.store;
        this.projectStore = options.projectStore;
        this.dataSource = options.dataSource;
        this.draftJournal = options.draftJournal;
        this.draftNamespace = options.draftNamespace;
        this.timeContext = options.timeContext;
        this.locale = options.locale;
        this.onToast = options.onToast;
        this.onBusy = options.onBusy;
        this.onSaved = options.onSaved;
        this.onStatsChanged = options.onStatsChanged;
        this.onStateChange = options.onStateChange || (() => {});

        this.viewEl = options.elements.todoView;
        this.listEl = options.elements.todoList;
        this.addBtn = options.elements.todoAddBtn;
        this.searchInput = options.elements.searchInput;
        this.currentFilterBtn = options.elements.todoCurrentFilterBtn;
        this.openFilterBtn = options.elements.todoOpenFilterBtn;
        this.projectFiltersEl = options.elements.todoProjectFilters;
        this.dialog = options.elements.todoDialog;
        this.form = options.elements.todoForm;
        this.dialogTitleEl = options.elements.todoDialogTitle;
        this.closeBtn = options.elements.todoCloseBtn;
        this.cancelBtn = options.elements.todoCancelBtn;
        this.contentInput = options.elements.todoContent;
        this.descriptionInput = options.elements.todoDescription;
        this.assignmentInput = options.elements.todoAssignment;
        this.assignmentListEl = options.elements.todoAssignmentList;
        this.dueDateInput = options.elements.todoDueDate;
        this.dueTimeInput = options.elements.todoDueTime;
        this.recurrenceInput = options.elements.todoRecurrence;
        this.prioritySelect = options.elements.todoPriority;
        this.labelsInput = options.elements.todoLabels;
        this.dialogMetaEl = options.elements.todoDialogMeta;
        this.editorBadgeEl = options.elements.editorBadge;

        this.active = false;
        this.busy = false;
        this.saveInFlight = false;
        this.selectedTodoId = null;
        this.editingTodoId = null;
        this.searchQuery = "";
        this.currentOnly = true;
        this.openOnly = true;
        this.projectFilterKey = "*";
        this.originalDue = null;
        this.originalDueFields = { date: "", time: "" };
        /** @type {import("./model.js").RecurrenceRaw | null} */
        this.originalRecurrence = null;
        this.originalRecurrenceText = "";
        this.cleanSnapshot = [];
        this.dirty = false;
        /** @type {TodoEditorAction[]} */
        this.undoStack = [];
        /** @type {TodoEditorAction[]} */
        this.redoStack = [];
        this.draftWriteChain = Promise.resolve();
        this.draftWarningShown = false;
        this.restoringRoute = false;

        this.bindEvents();
        this.populateProjectControls({ projectKey: null, sectionKey: null });
        this.updateFilterButtons();
        this.updateSaveState();
    }

    /**
     * Rebuilds locale-sensitive project controls, task summaries, dates, recurrence descriptions, and save state.
     * Stable filter values and selected task ids survive because only presentation nodes are regenerated.
     * @returns {void}
     */
    refreshLocale() {
        this.populateProjectControls();
        this.render();
        this.updateSaveState();
    }

    /**
     * Replaces the persistence backend after login or source-mode changes.
     * @param {import("./datasource.js").DataSource} dataSource
     * @returns {void}
     */
    setDataSource(dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Changes the IndexedDB namespace used to isolate unsaved TODO edits by repository and branch.
     * @param {string} namespace
     * @returns {void}
     */
    setDraftNamespace(namespace) {
        this.draftNamespace = String(namespace || "").trim();
    }

    /**
     * Wires list, toolbar, and dialog events while keeping global shortcuts in App.
     * @returns {void}
     */
    bindEvents() {
        this.addBtn.addEventListener("click", () => this.openCreateDialog());
        this.searchInput.addEventListener("input", () => {
            if (!this.active) return;
            this.searchQuery = this.searchInput.value;
            this.render();
        });
        this.searchInput.addEventListener("keydown", (event) => this.handleSearchKeydown(event));
        this.currentFilterBtn.addEventListener("click", () => {
            this.currentOnly = !this.currentOnly;
            this.updateFilterButtons();
            this.render();
        });
        this.openFilterBtn.addEventListener("click", () => {
            this.openOnly = !this.openOnly;
            this.updateFilterButtons();
            this.render();
        });
        this.projectFiltersEl.addEventListener("click", (event) => this.handleProjectFilterClick(event));
        this.listEl.addEventListener("click", (event) => this.handleListClick(event));
        this.listEl.addEventListener("dblclick", (event) => this.handleListDoubleClick(event));
        this.closeBtn.addEventListener("click", () => this.closeDialog());
        this.cancelBtn.addEventListener("click", () => this.closeDialog());
        this.dialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            this.closeDialog();
        });
        this.form.addEventListener("submit", (event) => this.handleDialogSubmit(event));
        this.dialog.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                this.form.requestSubmit();
            }
        });
    }

    /**
     * Shows or hides the TODO surface and restores keyboard focus when activated.
     * @param {boolean} isActive
     * @returns {void}
     */
    setActive(isActive) {
        this.active = Boolean(isActive);
        setVisible(this.viewEl, this.active);
        if (!this.active) return;
        this.updateFilterButtons();
        this.render();
        queueMicrotask(() => {
            if (!this.dialog.open) this.listEl.focus({ preventScroll: true });
        });
    }

    /**
     * Applies application-wide network busy state to TODO controls without discarding edits.
     * @param {boolean} isBusy
     * @returns {void}
     */
    setBusy(isBusy) {
        this.busy = Boolean(isBusy);
        this.addBtn.disabled = this.busy;
        this.searchInput.disabled = this.busy;
        this.currentFilterBtn.disabled = this.busy;
        this.openFilterBtn.disabled = this.busy;
        for (const button of this.projectFiltersEl.querySelectorAll("button")) {
            if (button instanceof HTMLButtonElement) button.disabled = this.busy;
        }
        this.closeBtn.disabled = this.busy;
        this.cancelBtn.disabled = this.busy;
        this.contentInput.disabled = this.busy;
        this.descriptionInput.disabled = this.busy;
        this.assignmentInput.disabled = this.busy;
        this.dueDateInput.disabled = this.busy;
        this.dueTimeInput.disabled = this.busy;
        this.recurrenceInput.disabled = this.busy;
        this.prioritySelect.disabled = this.busy;
        this.labelsInput.disabled = this.busy;
        this.updateSaveState();
    }

    /**
     * Clears transient editor state after logout while leaving durable browser drafts untouched.
     * @returns {void}
     */
    reset() {
        this.closeDialog();
        this.selectedTodoId = null;
        this.editingTodoId = null;
        this.cleanSnapshot = [];
        this.dirty = false;
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.searchQuery = "";
        this.currentOnly = true;
        this.openOnly = true;
        this.projectFilterKey = "*";
        this.projectFiltersEl.innerHTML = "";
        this.assignmentInput.value = "";
        this.assignmentListEl.innerHTML = "";
        this.listEl.innerHTML = "";
        this.updateFilterButtons();
        this.onStatsChanged("");
        this.updateSaveState();
    }

    /**
     * Returns the TODO query independently of the shared top-bar input's current view.
     * Keeping this local value lets App restore a previous TODO search after visiting Week or Search.
     * @returns {string}
     */
    getSearchQuery() {
        return this.searchQuery;
    }

    /**
     * Returns the navigation state owned by the TODO component.
     * Persisted task data remains in the workspace; this compact state contains only filters, the query, and the current selection.
     * @returns {{query: string, project: string, selectedTodoId: string | null, currentOnly: boolean, openOnly: boolean}}
     */
    getRouteState() {
        return {
            query: this.searchQuery,
            project: this.projectFilterKey,
            selectedTodoId: this.selectedTodoId,
            currentOnly: this.currentOnly,
            openOnly: this.openOnly,
        };
    }

    /**
     * Restores TODO filters and selection after tasks and the shared project taxonomy have loaded.
     * A missing or filtered-out selection is normalized to the first visible task by the ordinary rendering path.
     * @param {Object.<string, unknown>} state Parsed route state.
     * @returns {void}
     */
    restoreRouteState(state) {
        const routeState = state && typeof state === "object" ? state : {};
        this.restoringRoute = true;
        try {
            this.searchQuery = String(routeState.query || "");
            this.searchInput.value = this.searchQuery;
            this.currentOnly = typeof routeState.currentOnly === "boolean" ? routeState.currentOnly : true;
            this.openOnly = typeof routeState.openOnly === "boolean" ? routeState.openOnly : true;
            this.projectFilterKey = String(routeState.project || "*");
            this.selectedTodoId = routeState.selectedTodoId ? String(routeState.selectedTodoId) : null;
            this.populateProjectControls();
            this.updateFilterButtons();
            this.render();
            this.selectTodo(this.selectedTodoId, false);
        } finally {
            this.restoringRoute = false;
        }
    }

    /**
     * Announces filter or selection changes to the application route coordinator.
     * History restoration suppresses the callback until all dependent controls agree with the parsed route.
     * @returns {void}
     */
    notifyStateChange() {
        if (!this.restoringRoute) this.onStateChange();
    }

    /**
     * Synchronizes the two independent TODO filter toggles with their accessible pressed state.
     * The clock limits results to dated tasks due today or earlier; the checkmark hides completed tasks.
     * @returns {void}
     */
    updateFilterButtons() {
        this.currentFilterBtn.setAttribute("aria-pressed", this.currentOnly ? "true" : "false");
        this.openFilterBtn.setAttribute("aria-pressed", this.openOnly ? "true" : "false");
    }

    /**
     * Establishes freshly loaded repository TODOs as the clean baseline and restores any matching IndexedDB draft.
     * @returns {Promise<void>}
     */
    async initializeLoadedData() {
        this.cleanSnapshot = cloneJson(this.store.snapshotRaw());
        this.dirty = false;
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        await this.restoreDraft();
        this.chooseValidSelection();
        this.populateProjectControls();
        this.render();
    }

    /**
     * Refreshes project selectors after the shared project inventory changes.
     * Existing archived assignments remain visible in the editor, while new assignments use active projects only.
     * @returns {void}
     */
    setProjects() {
        this.populateProjectControls();
        this.render();
    }

    /**
     * Rebuilds the project filter and the editor's single searchable project/section list from the shared taxonomy.
     * Archived assignments stay available only when they are the value of the TODO currently being edited.
     * @param {{projectKey: string | null, sectionKey: string | null} | undefined} [selectedAssignment]
     * @returns {void}
     */
    populateProjectControls(selectedAssignment = undefined) {
        const previousLabel = this.assignmentInput.value;
        const resolvedPrevious = this.projectStore.findAssignmentByLabel(previousLabel);
        const selectedKeys = selectedAssignment === undefined ? resolvedPrevious : selectedAssignment;
        const projects = this.projectStore
            .getProjects()
            .slice()
            .sort((left, right) => this.locale.compare(left.name, right.name));

        const activeKeys = new Set(projects.filter((project) => !project.archived).map((project) => project.key));
        if (this.projectFilterKey !== "*" && this.projectFilterKey !== "" && !activeKeys.has(this.projectFilterKey)) {
            this.projectFilterKey = "*";
        }
        this.projectFiltersEl.innerHTML = "";
        const filterOptions = [
            { key: "*", label: this.locale.t("todo.all") },
            { key: "", label: this.locale.t("search.noProject") },
            ...projects.filter((project) => !project.archived).map((project) => ({ key: project.key, label: project.name })),
        ];
        for (const filter of filterOptions) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "todo-project-filter";
            button.dataset.projectKey = filter.key;
            button.textContent = filter.label;
            button.setAttribute("aria-pressed", filter.key === this.projectFilterKey ? "true" : "false");
            button.disabled = this.busy;
            this.projectFiltersEl.append(button);
        }

        this.assignmentListEl.innerHTML = "";
        for (const assignment of this.projectStore.getAssignmentOptions()) {
            const isSelected =
                selectedKeys !== null &&
                assignment.projectKey === selectedKeys?.projectKey &&
                assignment.sectionKey === selectedKeys?.sectionKey;
            if (assignment.archived && !isSelected) continue;
            const option = document.createElement("option");
            option.value = assignment.label;
            option.label = assignment.archived
                ? `${assignment.label} (${this.locale.t("search.archived")})`
                : assignment.label;
            this.assignmentListEl.append(option);
        }
        this.assignmentInput.value = selectedKeys
            ? this.projectStore.getAssignmentLabel(selectedKeys.projectKey, selectedKeys.sectionKey)
            : previousLabel;
    }

    /**
     * Applies a project chip as the active TODO filter and keeps its pressed state synchronized without rebuilding project data.
     * @param {MouseEvent} event
     * @returns {void}
     */
    handleProjectFilterClick(event) {
        const target = event.target instanceof Element ? event.target.closest(".todo-project-filter") : null;
        if (!(target instanceof HTMLButtonElement) || target.disabled) return;
        this.projectFilterKey = target.dataset.projectKey ?? "*";
        for (const button of this.projectFiltersEl.querySelectorAll(".todo-project-filter")) {
            if (!(button instanceof HTMLButtonElement)) continue;
            button.setAttribute("aria-pressed", button === target ? "true" : "false");
        }
        this.render();
        queueMicrotask(() => this.listEl.focus({ preventScroll: true }));
    }

    /**
     * Returns TODOs matching the active status, project, and free-text filters in deterministic display order.
     * @returns {import("./model.js").Todo[]}
     */
    getVisibleTodos() {
        const projectFilter = this.projectFilterKey;
        const query = this.searchQuery.trim().toLowerCase();
        const today = this.timeContext.formatDate(new Date());
        const result = this.store.getTodos().filter((todo) => {
            if (todo.archived) return false;
            const completed = todo.isCompleted();
            const due = dueDateKey(todo.due);
            if (this.openOnly && completed) return false;
            if (this.currentOnly && (!due || due > today)) return false;
            if (projectFilter !== "*" && (todo.projectKey || "") !== projectFilter) return false;
            const assignmentText = this.projectStore.getAssignmentLabel(todo.projectKey, todo.sectionKey).toLowerCase();
            if (query && !`${todo.searchHaystack} ${assignmentText}`.includes(query)) return false;
            return true;
        });

        result.sort((left, right) => {
            if (left.isCompleted() !== right.isCompleted()) return left.isCompleted() ? 1 : -1;
            const leftDue = dueDateKey(left.due) || "9999-12-31";
            const rightDue = dueDateKey(right.due) || "9999-12-31";
            if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
            if (left.priority !== right.priority) return right.priority - left.priority;
            const projectOrder = String(left.projectKey || "").localeCompare(String(right.projectKey || ""));
            if (projectOrder !== 0) return projectOrder;
            const sectionOrder = String(left.sectionKey || "").localeCompare(String(right.sectionKey || ""));
            if (sectionOrder !== 0) return sectionOrder;
            return left.order - right.order || left.content.localeCompare(right.content);
        });
        return result;
    }

    /**
     * Rebuilds the TODO list from filtered models and updates summary/dirty indicators.
     * @returns {void}
     */
    render() {
        const visible = this.getVisibleTodos();
        if (!visible.some((todo) => todo.id === this.selectedTodoId)) {
            this.selectedTodoId = visible[0]?.id || null;
        }
        this.listEl.innerHTML = "";
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "todo-empty";
            empty.textContent = this.locale.t("todo.empty");
            this.listEl.append(empty);
        } else {
            const fragment = document.createDocumentFragment();
            for (const group of this.buildTodoGroups(visible)) {
                fragment.append(this.buildTodoGroupElement(group));
            }
            this.listEl.append(fragment);
        }

        const all = this.store.getTodos().filter((todo) => !todo.archived);
        const openCount = all.filter((todo) => !todo.isCompleted()).length;
        const completedCount = all.length - openCount;
        this.onStatsChanged(
            this.locale.t("todo.stats", {
                shown: this.locale.formatNumber(visible.length),
                open: this.locale.formatNumber(openCount),
                completed: this.locale.formatNumber(completedCount),
            }),
        );
        this.updateSaveState();
        this.notifyStateChange();
    }

    /**
     * Groups already-filtered TODOs by configured project and section while retaining the due-date ordering inside each group.
     * Project and section order follows projects.json, with the intentional no-project bucket rendered last.
     * @param {import("./model.js").Todo[]} todos
     * @returns {Array<{projectKey: string | null, projectName: string, color: string, rootTodos: import("./model.js").Todo[], sections: Array<{sectionKey: string, sectionName: string, todos: import("./model.js").Todo[]}>}>}
     */
    buildTodoGroups(todos) {
        const projects = this.projectStore.getProjects();
        const projectOrder = new Map(projects.map((project, index) => [project.key, index]));
        const groupsByKey = new Map();

        for (const todo of todos) {
            const projectKey = todo.projectKey || "";
            let group = groupsByKey.get(projectKey);
            if (!group) {
                const project = this.projectStore.getProjectByKey(projectKey);
                group = {
                    projectKey: project?.key || null,
                    projectName: project?.name || this.locale.t("search.noProject"),
                    color: project?.color || "",
                    rootTodos: [],
                    sectionsByKey: new Map(),
                };
                groupsByKey.set(projectKey, group);
            }
            if (!todo.sectionKey) {
                group.rootTodos.push(todo);
                continue;
            }
            let section = group.sectionsByKey.get(todo.sectionKey);
            if (!section) {
                const project = this.projectStore.getProjectByKey(todo.projectKey);
                const sectionModel = project?.getSectionByKey(todo.sectionKey);
                section = {
                    sectionKey: todo.sectionKey,
                    sectionName: sectionModel?.name || todo.sectionKey,
                    todos: [],
                };
                group.sectionsByKey.set(todo.sectionKey, section);
            }
            section.todos.push(todo);
        }

        return Array.from(groupsByKey.values())
            .sort((left, right) => {
                if (left.projectKey === null) return 1;
                if (right.projectKey === null) return -1;
                return (projectOrder.get(left.projectKey) ?? Number.MAX_SAFE_INTEGER) -
                    (projectOrder.get(right.projectKey) ?? Number.MAX_SAFE_INTEGER);
            })
            .map((group) => {
                const project = this.projectStore.getProjectByKey(group.projectKey);
                const sectionOrder = new Map((project?.listSections() || []).map((section, index) => [section.key, index]));
                return {
                    projectKey: group.projectKey,
                    projectName: group.projectName,
                    color: group.color,
                    rootTodos: group.rootTodos,
                    sections: Array.from(group.sectionsByKey.values()).sort(
                        (left, right) =>
                            (sectionOrder.get(left.sectionKey) ?? Number.MAX_SAFE_INTEGER) -
                                (sectionOrder.get(right.sectionKey) ?? Number.MAX_SAFE_INTEGER) ||
                            this.locale.compare(left.sectionName, right.sectionName),
                    ),
                };
            });
    }

    /**
     * Builds a project group with a root-level add action and visually distinct section groups with their own add actions.
     * @param {{projectKey: string | null, projectName: string, color: string, rootTodos: import("./model.js").Todo[], sections: Array<{sectionKey: string, sectionName: string, todos: import("./model.js").Todo[]}>}} group
     * @returns {HTMLElement}
     */
    buildTodoGroupElement(group) {
        const container = document.createElement("section");
        container.className = "todo-project-group";
        if (group.color) container.style.setProperty("--todo-project-color", group.color);

        const header = document.createElement("div");
        header.className = "todo-group-header";
        const title = document.createElement("div");
        title.className = "todo-group-title";
        title.textContent = group.projectName;
        const count = document.createElement("span");
        count.className = "todo-group-count";
        const total = group.rootTodos.length + group.sections.reduce((sum, section) => sum + section.todos.length, 0);
        count.textContent = this.locale.formatNumber(total);
        header.append(
            title,
            count,
            this.buildTodoGroupAddButton(
                group.projectKey,
                null,
                this.locale.t("todo.addTo", { assignment: group.projectName }),
            ),
        );
        container.append(header);

        for (const todo of group.rootTodos) container.append(this.buildTodoRow(todo));
        for (const section of group.sections) {
            const sectionContainer = document.createElement("div");
            sectionContainer.className = "todo-section-group";
            const sectionHeader = document.createElement("div");
            sectionHeader.className = "todo-section-header";
            const sectionTitle = document.createElement("span");
            sectionTitle.textContent = section.sectionName;
            const sectionCount = document.createElement("span");
            sectionCount.className = "todo-group-count";
            sectionCount.textContent = this.locale.formatNumber(section.todos.length);
            sectionHeader.append(
                sectionTitle,
                sectionCount,
                this.buildTodoGroupAddButton(
                    group.projectKey,
                    section.sectionKey,
                    this.locale.t("todo.addTo", { assignment: `${group.projectName} / ${section.sectionName}` }),
                ),
            );
            sectionContainer.append(sectionHeader);
            for (const todo of section.todos) sectionContainer.append(this.buildTodoRow(todo));
            container.append(sectionContainer);
        }
        return container;
    }

    /**
     * Creates an icon-only add button carrying the configured assignment for a TODO group header.
     * @param {string | null} projectKey
     * @param {string | null} sectionKey
     * @param {string} label
     * @returns {HTMLButtonElement}
     */
    buildTodoGroupAddButton(projectKey, sectionKey, label) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "todo-group-add";
        button.dataset.todoAddProject = projectKey || "";
        button.dataset.todoAddSection = sectionKey || "";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.append(createMaterialIcon("add"));
        return button;
    }

    /**
     * Builds one semantic list row with completion, project, due date, priority, and imported hierarchy cues.
     * @param {import("./model.js").Todo} todo
     * @returns {HTMLElement}
     */
    buildTodoRow(todo) {
        const row = document.createElement("div");
        row.className = "todo-row";
        row.dataset.todoId = todo.id;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", todo.id === this.selectedTodoId ? "true" : "false");
        row.classList.toggle("is-selected", todo.id === this.selectedTodoId);
        row.classList.toggle("is-completed", todo.isCompleted());
        row.style.setProperty("--todo-depth", String(this.getTodoDepth(todo)));
        const assignment = this.projectStore.resolveAssignment(todo.projectKey, todo.sectionKey);
        if (assignment?.color) row.style.setProperty("--todo-project-color", assignment.color);

        const check = document.createElement("button");
        check.type = "button";
        check.className = "todo-check";
        check.dataset.todoAction = "toggle";
        check.setAttribute(
            "aria-label",
            this.locale.t(todo.isCompleted() ? "todo.reopen" : "todo.complete", { task: todo.content }),
        );
        if (todo.isCompleted()) check.append(createMaterialIcon("check", "app-icon todo-check-icon"));

        const body = document.createElement("div");
        body.className = "todo-body";
        const title = document.createElement("div");
        title.className = "todo-content";
        title.textContent = todo.content;
        body.append(title);
        if (todo.description) {
            const description = document.createElement("div");
            description.className = "todo-description";
            description.textContent = todo.description;
            body.append(description);
        }

        const meta = document.createElement("div");
        meta.className = "todo-meta";
        const due = this.buildDueBadge(todo);
        if (due) meta.append(due);
        if (todo.completion_history.length) {
            const completionCount = document.createElement("span");
            completionCount.className = "todo-completion-count";
            completionCount.textContent = this.locale.t("todo.doneCount", {
                count: this.locale.formatNumber(todo.completion_history.length),
            });
            completionCount.title = this.locale.plural(
                "todo.occurrencesCompleted",
                todo.completion_history.length,
            );
            meta.append(completionCount);
        }
        if (todo.priority > 1) {
            const priority = document.createElement("span");
            priority.className = `todo-priority priority-${todo.priority}`;
            priority.textContent = `P${5 - todo.priority}`;
            meta.append(priority);
        }
        if (todo.labels.length) {
            const labels = document.createElement("span");
            labels.textContent = todo.labels.map((label) => `#${label}`).join(" ");
            meta.append(labels);
        }
        const issueUrl = this.getTodoIssueUrl(todo);
        if (issueUrl) {
            const issueLink = document.createElement("a");
            issueLink.className = "todo-issue-link";
            issueLink.href = issueUrl;
            issueLink.target = "_blank";
            issueLink.rel = "noreferrer";
            issueLink.title = this.locale.t("todo.openIssue", { number: todo.source?.id });
            issueLink.setAttribute(
                "aria-label",
                this.locale.t("todo.openLinkedIssue", { number: todo.source?.id }),
            );
            issueLink.append(createMaterialIcon("open_in_new", "app-icon todo-issue-icon"));
            issueLink.append(document.createTextNode(`#${todo.source?.id}`));
            meta.append(issueLink);
        }
        if (meta.childElementCount) body.append(meta);
        row.append(check, body);
        return row;
    }

    /**
     * Returns a safe public URL for a TODO whose source metadata points at a GitHub issue.
     * Invalid or legacy provenance is treated as non-linkable during rendering and is reported explicitly if synchronization is attempted.
     * @param {import("./model.js").Todo} todo TODO model that may carry issue source metadata.
     * @returns {string | null}
     */
    getTodoIssueUrl(todo) {
        if (String(todo?.source?.provider || "").toLowerCase() !== "github" || !todo.source?.project_id) return null;
        try {
            return buildGitHubIssueUrl(todo.source.project_id, todo.source.id);
        } catch {
            return null;
        }
    }

    /**
     * Computes a bounded indentation depth from imported parent links.
     * Cycles or missing parents stop traversal instead of affecting rendering.
     * @param {import("./model.js").Todo} todo
     * @returns {number}
     */
    getTodoDepth(todo) {
        let depth = 0;
        let parentId = todo.parent_id;
        const seen = new Set([todo.id]);
        while (parentId && depth < 4 && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = this.store.getTodoById(parentId);
            if (!parent) break;
            depth += 1;
            parentId = parent.parent_id;
        }
        return depth;
    }

    /**
     * Creates a compact due-date badge with overdue, today, and recurrence styling.
     * @param {import("./model.js").Todo} todo
     * @returns {HTMLElement | null}
     */
    buildDueBadge(todo) {
        const key = dueDateKey(todo.due);
        if (!key) return null;
        const today = this.timeContext.formatDate(new Date());
        const due = document.createElement("span");
        due.className = "todo-due";
        if (!todo.isCompleted() && key < today) due.classList.add("is-overdue");
        if (!todo.isCompleted() && key === today) due.classList.add("is-today");
        const fields = splitDue(todo.due);
        const minutes = fields.time ? hhmmToMinutes(fields.time) ?? 0 : 12 * 60;
        const date = this.timeContext.dateFromLocalDayMinutes(key, minutes);
        if (todo.isRecurring()) due.append(createMaterialIcon("repeat", "app-icon todo-recurrence-icon"));
        due.append(
            document.createTextNode(
                `${this.locale.formatDate(date, this.timeContext.timeZone)}${
                    fields.time ? ` ${this.locale.formatTime(date, this.timeContext.timeZone)}` : ""
                }`,
            ),
        );
        if (todo.recurrence) due.title = this.locale.describeRecurrence(todo.recurrence, this.timeContext.timeZone);
        return due;
    }

    /**
     * Ensures the selection points at a currently visible task when filters or data change.
     * @returns {void}
     */
    chooseValidSelection() {
        const visible = this.getVisibleTodos();
        if (!visible.some((todo) => todo.id === this.selectedTodoId)) {
            this.selectedTodoId = visible[0]?.id || null;
        }
    }

    /**
     * Updates selection classes without rebuilding the list and optionally scrolls the row into view.
     * @param {string | null} id
     * @param {boolean} [ensureVisible]
     * @returns {void}
     */
    selectTodo(id, ensureVisible = true) {
        this.selectedTodoId = id;
        for (const row of this.listEl.querySelectorAll(".todo-row")) {
            if (!(row instanceof HTMLElement)) continue;
            const selected = row.dataset.todoId === id;
            row.classList.toggle("is-selected", selected);
            row.setAttribute("aria-selected", selected ? "true" : "false");
            if (selected && ensureVisible) row.scrollIntoView({ block: "nearest" });
        }
        this.notifyStateChange();
    }

    /**
     * Handles row selection and the dedicated completion button.
     * @param {MouseEvent} event
     * @returns {void}
     */
    handleListClick(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const addButton = target.closest(".todo-group-add");
        if (addButton instanceof HTMLButtonElement) {
            this.openCreateDialog({
                projectKey: addButton.dataset.todoAddProject || null,
                sectionKey: addButton.dataset.todoAddSection || null,
            });
            return;
        }
        const row = target.closest(".todo-row");
        if (!(row instanceof HTMLElement)) return;
        const id = row.dataset.todoId || "";
        if (!id) return;
        this.selectTodo(id, false);
        if (target.closest("[data-todo-action='toggle']")) this.toggleSelectedTodo();
    }

    /**
     * Opens the editor when a TODO row is double-clicked.
     * @param {MouseEvent} event
     * @returns {void}
     */
    handleListDoubleClick(event) {
        const target = event.target;
        if (!(target instanceof Element) || target.closest("[data-todo-action='toggle'], .todo-issue-link")) return;
        const row = target.closest(".todo-row");
        if (!(row instanceof HTMLElement)) return;
        const todo = this.store.getTodoById(row.dataset.todoId || "");
        if (todo) this.openEditDialog(todo);
    }

    /**
     * Moves from the search field into the list or clears the current query with Escape.
     * @param {KeyboardEvent} event
     * @returns {void}
     */
    handleSearchKeydown(event) {
        if (!this.active) return;
        if (event.key === "ArrowDown") {
            event.preventDefault();
            this.listEl.focus();
            this.chooseValidSelection();
            this.selectTodo(this.selectedTodoId);
        } else if (event.key === "Escape") {
            event.preventDefault();
            if (this.searchQuery) {
                this.searchInput.value = "";
                this.searchQuery = "";
                this.render();
            } else {
                this.listEl.focus();
            }
        }
    }

    /**
     * Handles TODO-specific global keyboard commands when the view is active.
     * Text controls retain native editing shortcuts; list commands operate only outside form controls.
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    handleKeydown(event) {
        if (!this.active || this.viewEl.hidden || this.dialog.open) return false;
        const ctrl = event.ctrlKey || event.metaKey;
        const key = String(event.key || "");
        const keyLower = key.toLowerCase();
        if (ctrl && keyLower === "s") {
            event.preventDefault();
            void this.saveNow();
            return true;
        }

        const target = event.target;
        const isFormControl =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLButtonElement;
        if (isFormControl) return false;

        if (ctrl && keyLower === "z") {
            event.preventDefault();
            this.undo();
            return true;
        }
        if (ctrl && keyLower === "y") {
            event.preventDefault();
            this.redo();
            return true;
        }
        if (key === "ArrowDown" || key === "ArrowUp") {
            event.preventDefault();
            this.moveSelection(key === "ArrowDown" ? 1 : -1);
            return true;
        }
        if (key === "Enter") {
            event.preventDefault();
            const todo = this.store.getTodoById(this.selectedTodoId || "");
            if (todo) this.openEditDialog(todo);
            return true;
        }
        if (key === " ") {
            event.preventDefault();
            this.toggleSelectedTodo();
            return true;
        }
        if (!ctrl && !event.altKey && keyLower === "a") {
            event.preventDefault();
            this.openCreateDialog();
            return true;
        }
        if (!ctrl && !event.altKey && (keyLower === "d" || key === "Delete")) {
            event.preventDefault();
            this.deleteSelectedTodo();
            return true;
        }
        if (!ctrl && !event.altKey && key === "/") {
            event.preventDefault();
            this.searchInput.focus();
            this.searchInput.select();
            return true;
        }
        return false;
    }

    /**
     * Moves selection by one visible row, clamping at the first and last task.
     * @param {number} delta
     * @returns {void}
     */
    moveSelection(delta) {
        const visible = this.getVisibleTodos();
        if (!visible.length) return;
        let index = visible.findIndex((todo) => todo.id === this.selectedTodoId);
        if (index < 0) index = delta > 0 ? -1 : visible.length;
        index = Math.max(0, Math.min(visible.length - 1, index + delta));
        this.selectTodo(visible[index].id);
    }

    /**
     * Opens a blank editor with sensible defaults derived from the active project filter.
     * Group-level add buttons may provide an exact project/section assignment.
     * @param {{projectKey: string | null, sectionKey: string | null} | undefined} [selectedAssignment]
     * @returns {void}
     */
    openCreateDialog(selectedAssignment = undefined) {
        if (this.busy || this.saveInFlight) return;
        this.editingTodoId = null;
        this.dialogTitleEl.textContent = this.locale.t("todo.addTitle");
        this.dialogMetaEl.textContent = this.locale.t("todo.newTask");
        this.contentInput.value = "";
        this.descriptionInput.value = "";
        const defaultAssignment = selectedAssignment || {
            projectKey: this.projectFilterKey !== "*" ? this.projectFilterKey || null : null,
            sectionKey: null,
        };
        this.populateProjectControls(defaultAssignment);
        this.dueDateInput.value = "";
        this.dueTimeInput.value = "";
        this.recurrenceInput.value = "";
        this.prioritySelect.value = "1";
        this.labelsInput.value = "";
        this.originalDue = null;
        this.originalDueFields = { date: "", time: "" };
        this.originalRecurrence = null;
        this.originalRecurrenceText = "";
        if (!this.dialog.open) this.dialog.showModal();
        queueMicrotask(() => this.contentInput.focus());
    }

    /**
     * Opens the modal editor populated from an existing TODO, including lossless recurrence fields.
     * @param {import("./model.js").Todo} todo
     * @returns {void}
     */
    openEditDialog(todo) {
        if (this.busy || this.saveInFlight) return;
        this.editingTodoId = todo.id;
        this.dialogTitleEl.textContent = this.locale.t("todo.editTitle");
        const hierarchy = todo.parent_id ? ` • ${this.locale.t("todo.subtask")}` : "";
        const source =
            todo.source?.provider && todo.source.provider !== "github"
                ? ` • ${this.locale.t("todo.importedFrom", { provider: todo.source.provider })}`
                : "";
        this.dialogMetaEl.replaceChildren(
            document.createTextNode(
                `${this.locale.t(todo.isCompleted() ? "todo.completed" : "todo.open")}${hierarchy}${source}`,
            ),
        );
        const issueUrl = this.getTodoIssueUrl(todo);
        if (issueUrl) {
            const issueLink = document.createElement("a");
            issueLink.className = "todo-dialog-issue-link";
            issueLink.href = issueUrl;
            issueLink.target = "_blank";
            issueLink.rel = "noreferrer";
            issueLink.append(createMaterialIcon("open_in_new", "app-icon todo-issue-icon"));
            issueLink.append(
                document.createTextNode(this.locale.t("todo.githubIssue", { number: todo.source?.id })),
            );
            this.dialogMetaEl.append(document.createTextNode(" • "), issueLink);
        }
        this.contentInput.value = todo.content;
        this.descriptionInput.value = todo.description;
        this.populateProjectControls({ projectKey: todo.projectKey, sectionKey: todo.sectionKey });
        this.originalDue = todo.due ? cloneJson(todo.due) : null;
        this.originalDueFields = splitDue(todo.due);
        this.originalRecurrence = todo.recurrence ? todo.recurrence.toRaw() : null;
        this.originalRecurrenceText = this.locale.describeRecurrence(todo.recurrence, this.timeContext.timeZone);
        this.dueDateInput.value = this.originalDueFields.date;
        this.dueTimeInput.value = this.originalDueFields.time;
        this.recurrenceInput.value = this.originalRecurrenceText;
        this.prioritySelect.value = String(todo.priority);
        this.labelsInput.value = todo.labels.join(", ");
        if (!this.dialog.open) this.dialog.showModal();
        queueMicrotask(() => {
            this.contentInput.focus();
            this.contentInput.select();
        });
    }

    /**
     * Closes the TODO editor and returns focus to the list when appropriate.
     * @returns {void}
     */
    closeDialog() {
        if (this.dialog.open) this.dialog.close();
        this.editingTodoId = null;
        if (this.active) queueMicrotask(() => this.listEl.focus({ preventScroll: true }));
    }

    /**
     * Builds the current due occurrence, preserving its exact normalized object when date and time controls were untouched.
     * @returns {import("./model.js").TodoDueRaw | null}
     */
    collectDue() {
        const date = this.dueDateInput.value;
        const time = date ? this.dueTimeInput.value : "";
        if (!date) return null;
        if (
            this.originalDue &&
            date === this.originalDueFields.date &&
            time === this.originalDueFields.time
        ) {
            return cloneJson(this.originalDue);
        }
        return {
            date: time ? `${date}T${time}:00` : date,
            timezone: time ? this.timeContext.timeZone : null,
        };
    }

    /**
     * Parses recurrence editor text into a structured rule anchored to the current due occurrence.
     * An untouched imported custom rule is preserved losslessly; newly entered unsupported phrases are rejected before mutation.
     * @param {import("./model.js").TodoDueRaw | null} due
     * @returns {import("./model.js").RecurrenceRaw | null}
     */
    collectRecurrence(due) {
        const text = this.recurrenceInput.value.trim();
        if (!text) return null;
        if (!due) {
            throw new Error(this.locale.t("toast.recurrenceDue"));
        }
        const dueFields = splitDue(due);
        const scheduleUntouched =
            dueFields.date === this.originalDueFields.date &&
            dueFields.time === this.originalDueFields.time &&
            text === this.originalRecurrenceText;
        if (scheduleUntouched && this.originalRecurrence) {
            return cloneJson(this.originalRecurrence);
        }
        const recurrence = Recurrence.fromText(text, due.date);
        if (!recurrence) {
            throw new Error(this.locale.t("toast.unsupportedRecurrence"));
        }
        return recurrence.toRaw();
    }

    /**
     * Reads and normalizes editable dialog values before passing them to TodoStore validation.
     * @returns {import("./store.js").TodoDetails}
     */
    collectDetails() {
        const assignment = this.projectStore.findAssignmentByLabel(this.assignmentInput.value);
        if (!assignment) {
            throw new Error(this.locale.t("toast.invalidAssignment"));
        }
        const labels = this.labelsInput.value
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean);
        const due = this.collectDue();
        return {
            content: this.contentInput.value.trim(),
            description: this.descriptionInput.value,
            projectKey: assignment.projectKey,
            sectionKey: assignment.sectionKey,
            labels,
            priority: Number(this.prioritySelect.value || 1),
            due,
            recurrence: this.collectRecurrence(due),
        };
    }

    /**
     * Creates or updates a TODO from modal values as one undoable editor action.
     * @param {Event} event
     * @returns {void}
     */
    handleDialogSubmit(event) {
        event.preventDefault();
        if (this.busy || this.saveInFlight) return;
        let details;
        try {
            details = this.collectDetails();
        } catch (error) {
            this.onToast(error instanceof Error ? error.message : String(error));
            if (!this.projectStore.findAssignmentByLabel(this.assignmentInput.value)) {
                this.assignmentInput.focus();
            } else {
                this.recurrenceInput.focus();
            }
            return;
        }
        if (!details.content) {
            this.onToast(this.locale.t("toast.todoTitle"));
            this.contentInput.focus();
            return;
        }
        const editingId = this.editingTodoId;
        let selectionAfter = editingId;
        const succeeded = this.applyMutation(editingId ? "Edit TODO" : "Add TODO", () => {
            if (editingId) {
                this.store.updateTodo(editingId, details);
            } else {
                selectionAfter = this.store.createTodo(details).id;
            }
        }, selectionAfter);
        if (!succeeded) return;
        if (!editingId) {
            const action = this.undoStack[this.undoStack.length - 1];
            if (action) action.selectionAfter = selectionAfter;
        }
        this.selectedTodoId = selectionAfter;
        this.closeDialog();
        this.render();
        this.selectTodo(selectionAfter);
    }

    /**
     * Applies a store mutation, captures before/after snapshots, and persists the resulting dirty state.
     * @param {string} label
     * @param {() => void} mutation
     * @param {string | null} [selectionAfter]
     * @returns {boolean}
     */
    applyMutation(label, mutation, selectionAfter = this.selectedTodoId) {
        if (this.busy || this.saveInFlight) return false;
        const before = this.store.snapshotRaw();
        const selectionBefore = this.selectedTodoId;
        try {
            mutation();
        } catch (error) {
            this.store.applySnapshot(before);
            this.onToast(String(error));
            return false;
        }
        const after = this.store.snapshotRaw();
        if (todoSnapshotsEqual(before, after)) return false;
        this.undoStack.push({ label, before, after, selectionBefore, selectionAfter });
        this.redoStack.length = 0;
        this.selectedTodoId = selectionAfter;
        this.refreshDirtyState();
        this.render();
        return true;
    }

    /**
     * Toggles completion for the selected TODO and keeps selection near its former position when filters remove it.
     * @returns {void}
     */
    toggleSelectedTodo() {
        const id = this.selectedTodoId;
        if (!id) return;
        const visible = this.getVisibleTodos();
        const oldIndex = Math.max(0, visible.findIndex((todo) => todo.id === id));
        const succeeded = this.applyMutation("Toggle TODO", () => {
            this.store.toggleTodoCompleted(id);
        }, id);
        if (!succeeded) return;
        const nextVisible = this.getVisibleTodos();
        if (!nextVisible.some((todo) => todo.id === id)) {
            this.selectedTodoId = nextVisible[Math.min(oldIndex, Math.max(0, nextVisible.length - 1))]?.id || null;
        }
        this.render();
        this.selectTodo(this.selectedTodoId);
    }

    /**
     * Deletes the selected TODO immediately while relying on undo instead of a confirmation prompt.
     * @returns {void}
     */
    deleteSelectedTodo() {
        const id = this.selectedTodoId;
        if (!id) return;
        const visible = this.getVisibleTodos();
        const oldIndex = Math.max(0, visible.findIndex((todo) => todo.id === id));
        const succeeded = this.applyMutation("Delete TODO", () => {
            if (!this.store.deleteTodo(id)) throw new Error("TODO not found.");
        }, null);
        if (!succeeded) return;
        const nextVisible = this.getVisibleTodos();
        this.selectedTodoId = nextVisible[Math.min(oldIndex, Math.max(0, nextVisible.length - 1))]?.id || null;
        this.render();
        this.selectTodo(this.selectedTodoId);
    }

    /**
     * Restores the previous TODO snapshot and records the action for redo.
     * @returns {void}
     */
    undo() {
        if (this.busy || this.saveInFlight) return;
        const action = this.undoStack.pop();
        if (!action) return;
        this.store.applySnapshot(action.before);
        this.selectedTodoId = action.selectionBefore;
        this.redoStack.push(action);
        this.refreshDirtyState();
        this.render();
        this.selectTodo(this.selectedTodoId);
    }

    /**
     * Reapplies the next TODO snapshot from redo history.
     * @returns {void}
     */
    redo() {
        if (this.busy || this.saveInFlight) return;
        const action = this.redoStack.pop();
        if (!action) return;
        this.store.applySnapshot(action.after);
        this.selectedTodoId = action.selectionAfter;
        this.undoStack.push(action);
        this.refreshDirtyState();
        this.render();
        this.selectTodo(this.selectedTodoId);
    }

    /**
     * Compares current tasks with the last persisted snapshot and queues the matching IndexedDB draft operation.
     * @returns {void}
     */
    refreshDirtyState() {
        this.dirty = !todoSnapshotsEqual(this.cleanSnapshot, this.store.snapshotRaw());
        if (this.dirty) {
            this.queueDraftWrite();
        } else {
            this.queueDraftDelete();
        }
        this.updateSaveState();
    }

    /**
     * Synchronizes the save action and, while this view is active, the shared top-bar status badge.
     * “Changed” means the in-memory task document differs from its last successful repository or local-server save.
     * @returns {void}
     */
    updateSaveState() {
        const status = this.locale.t(
            this.saveInFlight ? "status.saving" : this.dirty ? "status.changed" : "status.saved",
        );
        this.viewEl.classList.toggle("is-dirty", this.dirty);
        if (this.active) {
            this.editorBadgeEl.classList.toggle("is-dirty", this.dirty);
            this.editorBadgeEl.disabled = this.busy || this.saveInFlight;
            this.editorBadgeEl.title = this.dirty
                ? this.locale.t("topbar.saveTitle")
                : this.locale.t("status.todoNoUnsaved");
            this.editorBadgeEl.setAttribute(
                "aria-label",
                this.locale.t(this.dirty ? "status.todoSaveChanged" : "status.todoChangesSaved"),
            );
            this.editorBadgeEl.innerHTML = `<span class="dot"></span><span class="save">${status}</span>`;
        }
    }

    /**
     * Queues a durable draft write behind earlier keystrokes so IndexedDB state cannot arrive out of order.
     * @returns {void}
     */
    queueDraftWrite() {
        const namespace = this.draftNamespace;
        if (!namespace) return;
        const baseValue = { todos: cloneJson(this.cleanSnapshot) };
        const value = { todos: cloneJson(this.store.snapshotRaw()) };
        this.enqueueDraftOperation(
            () =>
                this.draftJournal.putDocumentDraft(namespace, TODO_DOCUMENT_NAME, {
                    baseValue,
                    value,
                    updatedAt: Date.now(),
                }),
            this.locale.t("toast.todoDraftUnavailable"),
        );
    }

    /**
     * Queues removal of the current TODO draft after save or a complete undo.
     * @returns {void}
     */
    queueDraftDelete() {
        const namespace = this.draftNamespace;
        if (!namespace) return;
        this.enqueueDraftOperation(
            () => this.draftJournal.deleteDocumentDraft(namespace, TODO_DOCUMENT_NAME),
            this.locale.t("toast.todoDraftCleanup"),
        );
    }

    /**
     * Serializes one IndexedDB operation behind the previous operation and emits at most one durability warning.
     * @param {() => Promise<boolean>} operation
     * @param {string} failureMessage
     * @returns {void}
     */
    enqueueDraftOperation(operation, failureMessage) {
        this.draftWriteChain = this.draftWriteChain
            .catch(() => undefined)
            .then(async () => {
                let succeeded = false;
                try {
                    succeeded = await operation();
                } catch {
                    succeeded = false;
                }
                if (!succeeded && !this.draftWarningShown) {
                    this.draftWarningShown = true;
                    this.onToast(failureMessage, 5000);
                }
            });
    }

    /**
     * Waits until all TODO draft writes queued by synchronous editor commands have settled.
     * @returns {Promise<void>}
     */
    async flushDraftWrites() {
        await this.draftWriteChain.catch(() => undefined);
    }

    /**
     * Three-way merges a browser TODO draft over newer repository data using its stored clean baseline.
     * Local edits win per-task conflicts, while untouched tasks receive remote updates and additions.
     * @param {import("./model.js").TodoRaw[]} baseline
     * @param {import("./model.js").TodoRaw[]} localDraft
     * @param {import("./model.js").TodoRaw[]} remoteCurrent
     * @returns {import("./model.js").TodoRaw[]}
     */
    mergeDraftTodos(baseline, localDraft, remoteCurrent) {
        const baselineById = todosById(baseline);
        const localById = todosById(localDraft);
        const remoteById = todosById(remoteCurrent);
        const orderedIds = [];
        const seen = new Set();
        for (const todo of [...localDraft, ...remoteCurrent, ...baseline]) {
            if (!todo?.id || seen.has(todo.id)) continue;
            seen.add(todo.id);
            orderedIds.push(todo.id);
        }
        const merged = [];
        for (const id of orderedIds) {
            const baselineTodo = baselineById.get(id);
            const localTodo = localById.get(id);
            const remoteTodo = remoteById.get(id);
            const localChanged = !rawTodosEqual(baselineTodo, localTodo);
            const selected = localChanged ? localTodo : remoteTodo;
            if (selected) merged.push(cloneJson(selected));
        }
        return merged;
    }

    /**
     * Restores or merges an unsaved TODO draft after repository data has loaded.
     * @returns {Promise<boolean>}
     */
    async restoreDraft() {
        await this.flushDraftWrites();
        if (!this.draftNamespace) return false;
        const draft = await this.draftJournal.getDocumentDraft(this.draftNamespace, TODO_DOCUMENT_NAME);
        const localDraft = Array.isArray(draft?.value?.todos) ? draft.value.todos : null;
        const baseline = Array.isArray(draft?.baseValue?.todos) ? draft.baseValue.todos : null;
        if (!localDraft || !baseline) return false;

        const remoteCurrent = this.store.snapshotRaw();
        if (todoSnapshotsEqual(remoteCurrent, localDraft)) {
            await this.draftJournal.deleteDocumentDraft(this.draftNamespace, TODO_DOCUMENT_NAME);
            return false;
        }
        const baseStillCurrent = todoSnapshotsEqual(remoteCurrent, baseline);
        const restored = baseStillCurrent ? cloneJson(localDraft) : this.mergeDraftTodos(baseline, localDraft, remoteCurrent);
        this.store.applySnapshot(restored);
        this.dirty = !todoSnapshotsEqual(this.cleanSnapshot, restored);
        if (this.dirty) this.queueDraftWrite();
        this.onToast(
            this.locale.t(baseStillCurrent ? "toast.todoRestored" : "toast.todoRestoredMerged"),
            5000,
            "success",
        );
        this.updateSaveState();
        return true;
    }

    /**
     * Resolves the issue repository, type label, and optional issue number for one TODO.
     * Existing source metadata wins for repository identity, while the currently selected section supplies the label so moving a task between App sections updates its issue type.
     * @param {import("./model.js").Todo} todo TODO model to inspect.
     * @returns {{repository: string, sectionLabel: string | null, issueNumber: number | null} | null}
     */
    resolveGitHubIssueBinding(todo) {
        if (!isTodoIssuePublishable(todo)) return null;
        const assignment = this.projectStore.resolveAssignment(todo.projectKey, todo.sectionKey);
        const projectRepository = assignment?.project?.getExternalReference("github")?.id || null;
        const sectionLabel = assignment?.section?.getExternalReference("github-label")?.id || null;
        const source = String(todo.source?.provider || "").toLowerCase() === "github" ? todo.source : null;
        const repository = source?.project_id || projectRepository;
        if (!repository) return null;

        let issueNumber = null;
        if (source) {
            const parsed = Number(source.id);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error(`TODO "${todo.content}" has an invalid linked GitHub issue number.`);
            }
            issueNumber = parsed;
        }
        return {
            repository,
            sectionLabel: sectionLabel || source?.section_id || null,
            issueNumber,
        };
    }

    /**
     * Synchronizes only issue-backed TODOs changed since the last successful workspace save.
     * Remote writes happen before the workspace commit; newly assigned issue numbers are journaled immediately, making a retry update the created issue instead of creating a duplicate.
     * Deleted linked TODOs close their issue, while local-server mode deliberately skips remote integration and follows the same remaining save path.
     * @returns {Promise<void>}
     */
    async synchronizeGitHubIssues() {
        if (!this.dataSource.supportsGitHubIssueSync()) return;
        const baselineById = todosById(this.cleanSnapshot);
        const currentIds = this.store.snapshotRaw().map((todo) => todo.id);
        const currentIdSet = new Set(currentIds);

        for (const id of currentIds) {
            let todo = this.store.getTodoById(id);
            if (!todo) continue;
            const binding = this.resolveGitHubIssueBinding(todo);
            if (!binding) continue;
            const baseline = baselineById.get(id);
            if (baseline && rawTodosEqual(baseline, todo.toRaw())) continue;

            try {
                const issueWrite = buildTodoIssueWrite(todo, binding.sectionLabel);
                let issueNumber = binding.issueNumber;
                if (issueNumber === null) {
                    const created = await this.dataSource.createGitHubIssue(binding.repository, issueWrite);
                    issueNumber = Number(created?.number);
                    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
                        throw new Error("GitHub did not return the created issue number.");
                    }
                    this.store.setTodoSource(id, {
                        provider: "github",
                        id: String(issueNumber),
                        project_id: binding.repository,
                        section_id: binding.sectionLabel,
                    });
                    this.queueDraftWrite();
                    if (issueWrite.state === "closed") {
                        await this.dataSource.updateGitHubIssue(binding.repository, issueNumber, { state: "closed" });
                    }
                } else {
                    await this.dataSource.updateGitHubIssue(binding.repository, issueNumber, issueWrite);
                    const expectedSource = {
                        provider: "github",
                        id: String(issueNumber),
                        project_id: binding.repository,
                        section_id: binding.sectionLabel,
                    };
                    if (JSON.stringify(todo.source) !== JSON.stringify(expectedSource)) {
                        this.store.setTodoSource(id, expectedSource);
                        this.queueDraftWrite();
                    }
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`GitHub issue sync failed for "${todo.content}": ${detail}`);
            }
        }

        for (const baseline of this.cleanSnapshot) {
            if (currentIdSet.has(baseline.id) || String(baseline.source?.provider || "").toLowerCase() !== "github") continue;
            if (!baseline.source?.project_id) continue;
            try {
                await this.dataSource.updateGitHubIssue(baseline.source.project_id, baseline.source.id, { state: "closed" });
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`GitHub issue sync failed for deleted TODO "${baseline.content}": ${detail}`);
            }
        }
    }

    /**
     * Persists the workspace-configured TODO document through the same hosted/local saveFiles pipeline used by other components.
     * @returns {Promise<void>}
     */
    async saveNow() {
        if (this.busy || this.saveInFlight) return;
        if (!this.dirty) {
            this.onToast(this.locale.t("toast.nothingToSave"));
            return;
        }
        this.saveInFlight = true;
        this.onBusy(true);
        this.updateSaveState();
        try {
            await this.flushDraftWrites();
            await this.synchronizeGitHubIssues();
            const content = this.store.serialize(utcNowIso());
            await this.dataSource.saveFiles([{ path: this.dataSource.getTodosPath(), content }], "Update TODOs");
            this.cleanSnapshot = cloneJson(this.store.snapshotRaw());
            this.dirty = false;
            this.queueDraftDelete();
            await this.flushDraftWrites();
            this.onSaved();
            this.onToast(this.locale.t("toast.todoSaved"), 2400, "success");
        } catch (error) {
            this.onToast(String(error), 5000);
        } finally {
            this.saveInFlight = false;
            this.onBusy(false);
            this.updateSaveState();
            this.render();
        }
    }
}
