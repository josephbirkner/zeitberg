/**
 * A combined presentation of separate TODO stores, never a merged persistence document.
 * Rows carry both their repository and local task id; edits and history are delegated to
 * the originating workspace's ordinary TodoView.
 */
export class CombinedTodos {
    /** @param {import("./workspace.sessions.js").WorkspaceSessions} sessions Open repository coordinator. */
    constructor(sessions) {
        this.sessions = sessions;
        this.enabled = false;
        this.rendering = false;
        this.sequence = 0;
        /** @type {WeakMap<object, number>} */
        this.actionOrder = new WeakMap();
        /** @type {Array<{session: import("./workspace.sessions.js").WorkspaceSession, action: object}>} */
        this.redo = [];
        /** @type {Array<{session: import("./workspace.sessions.js").WorkspaceSession, id: string}>} */
        this.rows = [];
        this.selectedKey = "";
        this.lastTap = { key: "", time: 0 };
        this.lastDestination = "";
        /** @type {Map<string, {session: import("./workspace.sessions.js").WorkspaceSession, label: string}>} */
        this.destinations = new Map();
        const app = sessions.app;
        app.todoView.listEl.addEventListener("click", (event) => this.click(event), true);
        app.todoView.listEl.addEventListener("dblclick", (event) => {
            if (this.active) event.stopImmediatePropagation();
        }, true);
        document.addEventListener("keydown", (event) => this.keydown(event), true);
        app.todoView.form.addEventListener("submit", (event) => this.submit(event), true);
        app.todoView.assignmentInput.addEventListener("input", () => app.todoView.assignmentInput.setCustomValidity(""));
    }

    /** @returns {boolean} Whether the combined document currently owns TODO interactions. */
    get active() { return this.enabled && this.sessions.app.state.activeTab === "todos"; }

    /**
     * Tracks edit chronology across repositories and expands the ordinary create dialog's assignment list.
     * This hook does not change workspace-local undo stacks or serialized TODO IDs.
     * @param {import("./workspace.sessions.js").WorkspaceSession} session Newly opened repository.
     * @returns {() => void} Restores the original local controller methods when the session is disposed.
     */
    attach(session) {
        const view = session.views.todoView;
        const apply = view.applyMutation.bind(view);
        view.applyMutation = (...args) => {
            const previous = view.undoStack.slice(-1)[0];
            const result = apply(...args);
            const action = view.undoStack.slice(-1)[0];
            if (action && action !== previous) {
                this.actionOrder.set(action, ++this.sequence);
                this.redo = [];
            }
            return result;
        };
        const create = view.openCreateDialog.bind(view);
        view.openCreateDialog = (assignment) => {
            view.assignmentInput.setCustomValidity("");
            create(assignment);
            if (!this.active || !view.dialog.open) return;
            this.destinations.clear();
            view.assignmentListEl.replaceChildren();
            for (const origin of this.sessions.available("todos")) {
                for (const option of origin.store.getAssignmentOptions().filter((option) => !option.archived)) {
                    const label = `${origin.name} → ${option.label}`;
                    // Equal workspace names remain distinguishable without exposing credentials.
                    const unique = this.destinations.has(label) ? `${label} (${origin.id})` : label;
                    this.destinations.set(unique, { session: origin, label: option.label });
                    view.assignmentListEl.append(new Option(unique, unique));
                }
            }
            view.assignmentInput.value = this.destinations.has(this.lastDestination)
                ? this.lastDestination : [...this.destinations.keys()].find((key) => this.destinations.get(key).session === session) || "";
        };
        const undo = view.undo.bind(view);
        const redo = view.redo.bind(view);
        view.undo = () => {
            const action = view.undoStack.slice(-1)[0];
            undo();
            if (action && view.redoStack.slice(-1)[0] === action) this.redo.push({ session, action });
        };
        view.redo = () => {
            const action = view.redoStack.slice(-1)[0];
            redo();
            if (action && view.undoStack.slice(-1)[0] === action) this.redo = this.redo.filter((item) => item.action !== action);
        };
        return () => {
            view.applyMutation = apply;
            view.openCreateDialog = create;
            view.undo = undo;
            view.redo = redo;
        };
    }

    /**
     * Selects an origin without leaving the combined document, then applies the ordinary action.
     * Consecutive clicks are detected by composite identity, so a selection rerender cannot swallow double-click editing.
     * @param {MouseEvent} event Pointer action within the shared task list.
     * @returns {void}
     */
    click(event) {
        if (!this.active || !(event.target instanceof Element)) return;
        const row = event.target.closest(".todo-row");
        if (!(row instanceof HTMLElement) || event.target.closest(".todo-issue-link")) return;
        event.stopImmediatePropagation();
        const session = this.sessions.sessions.get(row.dataset.workspace || "");
        const id = row.dataset.todoId;
        if (!session || !id) return;
        const key = JSON.stringify([session.id, id]);
        const edit = key === this.lastTap.key && performance.now() - this.lastTap.time < 450;
        this.lastTap = { key, time: performance.now() };
        this.select(session, id);
        if (event.target.closest("[data-todo-action='toggle']")) {
            session.views.todoView.toggleSelectedTodo();
        } else if (edit) {
            session.views.todoView.openEditDialog(session.todoStore.getTodoById(id));
        }
        this.render();
    }

    /** @param {import("./workspace.sessions.js").WorkspaceSession} session Origin. @param {string} id Local task id. @returns {void} */
    select(session, id) {
        const app = this.sessions.app;
        const filters = {
            searchQuery: app.todoView.searchQuery, currentOnly: app.todoView.currentOnly,
            openOnly: app.todoView.openOnly,
        };
        this.selectedKey = JSON.stringify([session.id, id]);
        this.sessions.mount(session, "todos", false);
        Object.assign(session.views.todoView, filters);
        session.views.todoView.selectedTodoId = id;
        app.shell.setTab("todos", "none");
        this.render();
        app.scheduleRouteReplace();
    }

    /**
     * Applies keyboard navigation and chronological cross-workspace TODO undo/redo.
     * Text inputs and dialogs retain their native keyboard semantics.
     * @param {KeyboardEvent} event Global key press.
     * @returns {void}
     */
    keydown(event) {
        if (!this.active || document.querySelector("dialog[open]")) return;
        if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
        const command = event.ctrlKey || event.metaKey;
        if (command && ["z", "y"].includes(event.key.toLowerCase())) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.history(event.key.toLowerCase() === "y" || event.shiftKey);
            return;
        }
        if (!command && ["ArrowDown", "ArrowUp"].includes(event.key) && this.rows.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const current = this.rows.findIndex((row) => JSON.stringify([row.session.id, row.id]) === this.selectedKey);
            const index = Math.max(0, Math.min(this.rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
            const row = this.rows[index];
            this.select(row.session, row.id);
            this.sessions.app.todoView.listEl.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
        }
    }

    /**
     * Routes undo to the most recent remaining task action, or replays the coordinated redo chain.
     * @param {boolean} redo Whether to redo rather than undo.
     * @returns {void}
     */
    history(redo) {
        let target;
        if (redo) {
            target = this.redo.slice(-1)[0];
            if (!target || target.session.views.todoView.redoStack.slice(-1)[0] !== target.action) return;
        } else {
            target = this.sessions.available("todos").map((session) => ({ session, action: session.views.todoView.undoStack.slice(-1)[0] }))
                .filter((item) => item.action).sort((a, b) => (this.actionOrder.get(b.action) || 0) - (this.actionOrder.get(a.action) || 0))[0];
        }
        if (!target) return;
        const view = target.session.views.todoView;
        if (view.busy) return;
        this.select(target.session, view.selectedTodoId || "");
        if (redo) view.redo();
        else view.undo();
        this.selectedKey = JSON.stringify([target.session.id, view.selectedTodoId]);
        this.render();
    }

    /**
     * Resolves the combined Workspace → Project → Section value before normal form validation.
     * Existing tasks never change repositories implicitly; only new tasks use this destination picker.
     * @param {SubmitEvent} event Task form submission.
     * @returns {void}
     */
    submit(event) {
        const app = this.sessions.app;
        if (!this.active || app.todoView.editingTodoId !== null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const destination = this.destinations.get(app.todoView.assignmentInput.value);
        if (!destination) {
            app.todoView.assignmentInput.setCustomValidity(app.locale.t("toast.invalidAssignment"));
            app.todoView.assignmentInput.reportValidity();
            return;
        }
        this.lastDestination = app.todoView.assignmentInput.value;
        this.sessions.mount(destination.session, "todos", false);
        const view = destination.session.views.todoView;
        view.editingTodoId = null;
        view.originalDue = null;
        view.originalDueFields = { date: "", time: "" };
        view.originalRecurrence = null;
        view.originalRecurrenceText = "";
        view.assignmentInput.value = destination.label;
        view.handleDialogSubmit(event);
        this.selectedKey = JSON.stringify([destination.session.id, view.selectedTodoId]);
        this.render();
    }

    /**
     * Renders origin-labelled groups from independently filtered stores, preserving scroll position.
     * Empty and inaccessible workspaces do not inject placeholder tasks or distort task totals.
     * @returns {void}
     */
    render() {
        if (!this.active || this.rendering) return;
        this.rendering = true;
        try {
            const app = this.sessions.app;
            const selected = app.todoView;
            const scroll = selected.listEl.scrollTop;
            const fragment = document.createDocumentFragment();
            this.rows = [];
            let open = 0;
            let completed = 0;
            selected.projectFiltersEl.hidden = true;
            for (const session of this.sessions.available("todos")) {
                const view = session.views.todoView;
                const filterContext = Object.assign(Object.create(view), {
                    searchQuery: selected.searchQuery, currentOnly: selected.currentOnly,
                    openOnly: selected.openOnly, projectFilterKey: "*",
                });
                const todos = view.getVisibleTodos.call(filterContext);
                const all = session.todoStore.getTodos().filter((todo) => !todo.archived);
                open += all.filter((todo) => !todo.isCompleted()).length;
                completed += all.filter((todo) => todo.isCompleted()).length;
                if (!todos.length) continue;
                const heading = document.createElement("h3");
                heading.className = "combined-workspace-heading";
                heading.textContent = session.name;
                fragment.append(heading);
                for (const todo of todos) {
                    this.rows.push({ session, id: todo.id });
                    const row = view.buildTodoRow(todo);
                    row.dataset.workspace = session.id;
                    const isSelected = JSON.stringify([session.id, todo.id]) === this.selectedKey;
                    row.classList.toggle("is-selected", isSelected);
                    row.setAttribute("aria-selected", String(isSelected));
                    fragment.append(row);
                }
            }
            if (!this.rows.length) {
                const empty = document.createElement("p");
                empty.className = "todo-empty";
                empty.textContent = app.locale.t("todo.empty");
                fragment.append(empty);
            }
            selected.listEl.replaceChildren(fragment);
            selected.listEl.scrollTop = scroll;
            app.shell.todoSummary = app.locale.t("todo.stats", {
                shown: app.locale.formatNumber(this.rows.length), open: app.locale.formatNumber(open),
                completed: app.locale.formatNumber(completed),
            });
            app.shell.refreshDataBadge();
        } finally { this.rendering = false; }
    }
}
