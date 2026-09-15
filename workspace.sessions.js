import { AppState } from "./appstate.js";
import { ChunkCache } from "./cache.js";
import { EntryStore, TodoStore, ExpenseStore } from "./store.js";
import { TimeContext } from "./utils.js";
import { createHostedDataSource, LocalDataSource } from "./datasource.js";
import { configForRouteWorkspace, WorkspaceSetupRequiredError } from "./workspace.js";
import { WorkspaceLoader } from "./workspace.loader.js";
import { CombinedTodos } from "./workspace.todos.js";
import { AutosaveTimer } from "./autosave.js";

const VIEW_KEYS = /** @type {const} */ (["weekView", "todoView", "expenseView", "searchView", "projectDialog"]);
const SERVICE_KEYS = /** @type {const} */ (["state", "store", "todoStore", "expenseStore", "timeContext", "chunkCache"]);
const RUNTIME_KEYS = /** @type {const} */ (["config", "dataSource", "workspace", "workspaceSetup", "workspaceConfigBaseRaw", "activeWorkspaceConnection", "token"]);

/**
 * One independently owned repository session. Stores, edit histories, draft namespaces,
 * and in-flight operations never migrate between sessions when the shared UI changes tabs.
 */
export class WorkspaceSession {
    /** @param {import("./app.js").App} app Composition root supplying the initial session. */
    constructor(app) {
        this.id = app.activeWorkspaceConnection?.id || "";
        this.state = app.state;
        this.store = app.store;
        this.todoStore = app.todoStore;
        this.expenseStore = app.expenseStore;
        this.timeContext = app.timeContext;
        this.chunkCache = app.chunkCache;
        this.runtime = {
            config: app.config, dataSource: app.dataSource, workspace: app.workspace,
            workspaceSetup: app.workspaceSetup, workspaceConfigBaseRaw: app.workspaceConfigBaseRaw,
            activeWorkspaceConnection: app.activeWorkspaceConnection, token: app.token,
            workspaceRegistry: app.workspaceRegistry, pendingRoute: null,
        };
        this.views = {
            weekView: app.weekView, todoView: app.todoView, expenseView: app.expenseView,
            searchView: app.searchView, projectDialog: app.projectDialog,
        };
        this.route = null;
        this.scroll = { week: 0, todos: 0, expenses: 0 };
        this.ready = false;
        this.error = "";
        this.saveError = "";
        this.needsReconnect = false;
        /** @type {WorkspaceSetupRequiredError | null} */
        this.setupError = null;
        /** @type {Promise<void> | null} */
        this.saving = null;
        this.saveAgain = false;
        this.automaticSave = false;
    }

    /** @returns {string} Human-readable repository name, including before hydration. */
    get name() { return this.runtime.workspace?.name || this.runtime.activeWorkspaceConnection?.displayName || this.id; }

    /** @param {string} module UI module name. @returns {boolean} Whether this workspace supplies the document. */
    supports(module) {
        const component = module === "week" || module === "search" ? "time_tracking" : module;
        return this.ready && Boolean(this.runtime.workspace?.hasComponent(component));
    }

    /** @returns {boolean} Whether persisted documents differ from their acknowledged baselines. */
    get dirty() {
        return this.views.weekView.dirtyWeekStarts.size > 0 || this.views.todoView.dirty || this.views.expenseView.dirty;
    }
}

/**
 * Keeps open workspaces alive behind a single set of accessible document controls.
 * Provider loading remains in WorkspaceLoader; this layer owns mounting, workspace selection,
 * independent navigation memory, and the save-all orchestration only.
 */
export class WorkspaceSessions {
    /** @param {import("./app.js").App} app Shared application shell and provider services. */
    constructor(app) {
        this.app = app;
        /** @type {Map<string, WorkspaceSession>} */
        this.sessions = new Map();
        /** @type {WorkspaceSession | null} */
        this.current = null;
        /** @type {Map<string, string>} */
        this.selected = new Map();
        this.initializing = false;
        this.started = false;
        this.generation = 0;
        /** @type {Map<string, Promise<WorkspaceSession | null>>} */
        this.opening = new Map();
        /** @type {Map<string, string>} */
        this.unavailable = new Map();
        /** @type {WeakSet<import("./datasource.js").DataSource>} */
        this.queuedSources = new WeakSet();
        /** @type {Map<object, Map<string, Function>>} */
        this.originalMethods = new Map();
        /** @type {Map<WorkspaceSession, () => void>} */
        this.todoDetachers = new Map();
        this.selector = /** @type {HTMLSelectElement | null} */ (document.getElementById("documentWorkspaces"));
        this.label = document.getElementById("documentWorkspaceName");
        this.todos = new CombinedTodos(this);
        this.restoringScroll = false;
        this.autosave = new AutosaveTimer(
            () => this.saveAll(true),
            () => this.renderSaveState(),
            (error) => app.shell.toast(String(error), 5000),
        );
        this.previousSaveState = "saved";
        this.bindings = {
            weekView: app.weekView.sessionBinding, todoView: app.todoView.sessionBinding,
            expenseView: app.expenseView.sessionBinding, searchView: app.searchView.sessionBinding,
            projectDialog: app.projectDialog.sessionBinding,
        };
        this.selector?.addEventListener("change", () => {
            this.selectWorkspace(this.selector.value);
            // Mounting focuses the document; keep native picker navigation on the title instead.
            queueMicrotask(() => this.selector.focus({ preventScroll: true }));
        });
        // Consumers retain stable relays; event listeners resolve their concrete receiver at dispatch time.
        for (const key of VIEW_KEYS) {
            for (const owner of [app, app.shell, app.workspaceController, app.workspaceLoader]) {
                if (key in owner) owner[key] = this.bindings[key].proxy;
            }
        }
        const switchWorkspace = app.workspaceController.switchWorkspace.bind(app.workspaceController);
        app.workspaceController.switchWorkspace = async (id, route = null) => {
            const session = this.sessions.get(id);
            if (session?.ready) {
                const connection = session.runtime.activeWorkspaceConnection;
                if (connection?.provider !== "local") {
                    const credential = await app.workspaceController.loadUsableWorkspaceCredential(connection);
                    if (credential && credential !== session.runtime.token) {
                        const source = session.runtime.dataSource;
                        source.setToken(credential);
                        session.runtime.token = credential;
                        session.state.setToken(credential);
                        session.needsReconnect = false;
                        session.saveError = "";
                        if (this.current === session) { app.dataSource = source; app.token = credential; }
                    }
                }
                app.workspaceController.closeWorkspaceSettings("none");
                this.mount(session, route ? app.tabForRoute(route) : app.state.activeTab);
                if (route) app.applyLoadedRoute(route);
                return;
            }
            if (this.current && id !== this.current.id) {
                const connection = app.workspaceRegistry.getById(id);
                if (connection) {
                    const loaded = await this.open(connection);
                    if (loaded?.ready) {
                        app.workspaceController.closeWorkspaceSettings("none");
                        this.mount(loaded, route ? app.tabForRoute(route) : app.state.activeTab);
                        if (route) app.applyLoadedRoute(route);
                        return;
                    }
                    if (loaded?.setupError) {
                        this.mount(loaded, app.state.activeTab, false, true);
                        app.workspaceController.enterWorkspaceSetup(loaded.setupError);
                        return;
                    }
                    if (!loaded) app.workspaceController.requestWorkspaceCredential(connection);
                    // A failed repository must not evict the current document or its edits.
                    app.shell.toast(loaded?.error || app.locale.t("workspaceSessions.reconnect"), 6000);
                    return;
                }
            }
            await switchWorkspace(id, route);
        };
        const setTab = app.shell.setTab.bind(app.shell);
        const disconnect = app.workspaceController.disconnectWorkspace.bind(app.workspaceController);
        app.workspaceController.disconnectWorkspace = (id) => {
            void (async () => {
                const session = this.sessions.get(id);
                if (session) await this.close(session);
                if (this.sessions.has(id)) return;
                disconnect(id);
                this.render();
            })();
        };
        app.shell.setTab = (tab, history = "push") => {
            this.captureScroll();
            if (this.current && history !== "none") {
                const remembered = this.sessions.get(this.selected.get(tab) || "");
                const target = remembered?.supports(tab) ? remembered : this.available(tab)[0];
                if (target && target !== this.current) this.mount(target, tab, false);
            }
            setTab(tab, history);
            this.restoreScroll();
            if (this.current) this.selected.set(tab, this.current.id);
            this.render();
        };
        document.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && this.current) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!document.querySelector("dialog[open]")) void this.saveAll();
            }
        }, true);
        window.addEventListener("beforeunload", (event) => {
            if (![...this.sessions.values()].some((session) => session.dirty || session.saving)) return;
            event.preventDefault();
            event.returnValue = "";
        });
        for (const element of [app.weekView.weekScrollEl, app.todoView.listEl, app.expenseView.expenseList]) {
            element.addEventListener("scroll", () => this.captureScroll(), { passive: true });
        }
    }

    /** @returns {void} Records only the visible document; hidden elements report zero scroll in some browsers. */
    captureScroll() {
        if (!this.current || this.restoringScroll) return;
        const app = this.app;
        if (app.state.activeTab === "week") this.current.scroll.week = app.weekView.weekScrollEl.scrollTop;
        if (app.state.activeTab === "todos") this.current.scroll.todos = app.todoView.listEl.scrollTop;
        if (app.state.activeTab === "expenses") this.current.scroll.expenses = app.expenseView.expenseList.scrollTop;
    }

    /** @returns {void} Restores the mounted document after layout without letting intermediate scroll events overwrite its memory. */
    restoreScroll() {
        const session = this.current;
        if (!session) return;
        this.restoringScroll = true;
        const positions = { ...session.scroll };
        requestAnimationFrame(() => {
            if (this.current !== session) return;
            const app = this.app;
            if (app.state.activeTab === "week") app.weekView.weekScrollEl.scrollTop = positions.week;
            if (app.state.activeTab === "todos") app.todoView.listEl.scrollTop = positions.todos;
            if (app.state.activeTab === "expenses") app.expenseView.expenseList.scrollTop = positions.expenses;
            this.restoringScroll = false;
        });
    }

    /** @param {string} module Module name. @returns {WorkspaceSession[]} Ready sessions in registry order. */
    available(module) {
        return this.app.workspaceRegistry.list().map((connection) => this.sessions.get(connection.id))
            .filter((session) => session?.supports(module));
    }

    /**
     * Registers the initial ordinary load, then hydrates other remembered connections without
     * changing the visible document. Credentials are read only from their existing browser tier.
     * @returns {Promise<void>}
     */
    async loaded() {
        const app = this.app;
        if (!app.workspace || !app.activeWorkspaceConnection) return;
        if (!this.current) {
            const session = new WorkspaceSession(app);
            for (const key of VIEW_KEYS) Reflect.set(session.views, key, this.bindings[key].target);
            session.ready = true;
            this.current = session;
            this.sessions.set(session.id, session);
            this.prepare(session);
        } else {
            for (const key of RUNTIME_KEYS) this.current.runtime[key] = app[key];
            this.current.ready = true;
            this.current.error = "";
            this.current.setupError = null;
        }
        this.selected.set(app.state.activeTab, this.current.id);
        this.render();
        if (this.started) return;
        this.started = true;
        this.initializing = true;
        this.render();
        const generation = this.generation;
        for (const connection of app.workspaceRegistry.list()) {
            if (generation !== this.generation) return;
            if (!this.sessions.has(connection.id)) await this.open(connection);
        }
        this.initializing = false;
        this.render();
    }

    /**
     * Builds controller instances using their original dependency contracts, with no new DOM listeners.
     * Each controller's asynchronous methods retain these fixed stores even while another session is mounted.
     * @template {{sessionOptions: object}} T
     * @param {T} prototype Original concrete controller.
     * @param {object} overrides Workspace-owned dependency replacements.
     * @returns {T} Fresh unbound controller.
     */
    fork(prototype, overrides) {
        const Constructor = /** @type {new(options: object) => T} */ (prototype.constructor);
        return new Constructor({ ...prototype.sessionOptions, ...overrides, bindEvents: false });
    }

    /**
     * Opens one repository into detached stores using exactly the normal cache/validation/draft pipeline.
     * A failed load stays explicitly unavailable and cannot contribute partial data to combined views.
     * @param {import("./config.js").WorkspaceConnection} connection Remembered repository locator.
     * @returns {Promise<WorkspaceSession | null>} Loaded or failed session; null when credentials are absent.
     */
    async open(connection) {
        if (this.opening.has(connection.id)) return this.opening.get(connection.id);
        const opening = this.openConnection(connection).catch((error) => {
            this.unavailable.set(connection.id, String(error));
            this.render();
            return null;
        });
        this.opening.set(connection.id, opening);
        try { return await opening; }
        finally { this.opening.delete(connection.id); }
    }

    /**
     * Hydrates one deduplicated connection request into isolated models and controller state.
     * @param {import("./config.js").WorkspaceConnection} connection Repository to load.
     * @returns {Promise<WorkspaceSession | null>} Hydrated session or an inaccessible connection.
     */
    async openConnection(connection) {
        const app = this.app;
        const generation = this.generation;
        const existing = this.sessions.get(connection.id);
        if (existing?.ready) return existing;
        const credential = connection.provider === "local" ? "" : await app.workspaceController.loadUsableWorkspaceCredential(connection);
        if (connection.provider !== "local" && !credential) {
            this.unavailable.set(connection.id, app.locale.t("workspaceSessions.reconnect"));
            return null;
        }
        if (generation !== this.generation) return null;
        this.unavailable.delete(connection.id);
        const session = new WorkspaceSession(app);
        session.id = connection.id;
        const config = { ...configForRouteWorkspace(app.config, connection.toLocator()), localWorkspaceId: connection.expectedWorkspaceId };
        session.state = new AppState(config, connection.provider === "local");
        session.state.setToken(credential);
        session.timeContext = new TimeContext(config.timezone);
        session.store = new EntryStore(session.timeContext);
        session.todoStore = new TodoStore(session.store);
        session.expenseStore = new ExpenseStore(session.store);
        session.chunkCache = new ChunkCache();
        session.runtime = {
            config, dataSource: connection.provider === "local" ? new LocalDataSource(config) : createHostedDataSource(config, credential),
            workspace: null, workspaceSetup: null, workspaceConfigBaseRaw: null,
            activeWorkspaceConnection: connection, token: credential, workspaceRegistry: app.workspaceRegistry,
            pendingRoute: { version: 1, component: null, panel: "main", workspace: connection.toLocator(), state: {} },
        };
        const dependencies = {
            store: session.store, projectStore: session.store, todoStore: session.todoStore,
            appState: session.state, timeContext: session.timeContext, chunkCache: session.chunkCache,
            dataSource: session.runtime.dataSource,
        };
        session.views = {
            weekView: this.fork(this.bindings.weekView.target, dependencies),
            todoView: this.fork(this.bindings.todoView.target, { ...dependencies, store: session.todoStore }),
            expenseView: this.fork(this.bindings.expenseView.target, { ...dependencies, store: session.expenseStore }),
            searchView: this.fork(this.bindings.searchView.target, dependencies),
            projectDialog: this.fork(this.bindings.projectDialog.target, dependencies),
        };
        this.sessions.set(session.id, session);
        this.prepare(session);
        const controller = Object.assign(Object.create(Object.getPrototypeOf(app.workspaceController)), app.workspaceController, {
            runtime: session.runtime, state: session.state, ...session.views,
        });
        const loader = new WorkspaceLoader({
            ...app.workspaceLoader.sessionOptions, ...session, ...session.views,
            runtime: session.runtime, workspaceController: controller,
            isLocalMode: connection.provider === "local",
            activateRegistry: false,
            onProgress: () => {}, onNavigationChanged: () => {}, onRepositorySummaryChanged: () => {},
            onSearchDirty: () => {}, onToast: (message) => app.shell.toast(`${session.name}: ${message}`, 5000),
        });
        try {
            await loader.fetchWorkspace();
            if (generation !== this.generation) return null;
            await loader.fetchProjects();
            const workspace = session.runtime.workspace;
            if (workspace.hasComponent("time_tracking")) {
                await Promise.all([loader.fetchManifest(), loader.fetchWeekRequirements()]);
                await loader.loadAllChunks();
            }
            if (workspace.hasComponent("todos")) await loader.fetchTodos();
            if (workspace.hasComponent("expenses")) await loader.fetchExpenses();
            if (generation !== this.generation) return null;
            session.ready = true;
        } catch (error) {
            session.error = String(error);
            if (error instanceof WorkspaceSetupRequiredError) session.setupError = error;
        }
        this.render();
        for (const source of this.sessions.values()) source.views.searchView.markDirty();
        if (app.state.activeTab === "search") app.searchView.applyFiltersAndRender();
        return session;
    }

    /**
     * Serializes every saveFiles caller for one repository, including configuration dialogs.
     * A rejected write does not poison the queue: a subsequent explicit retry can proceed.
     * @param {WorkspaceSession} session Repository whose source should be queued once.
     * @returns {void}
     */
    queueWrites(session) {
        const dataSource = session.runtime.dataSource;
        if (!this.queuedSources.has(dataSource)) {
            this.queuedSources.add(dataSource);
            let tail = Promise.resolve();
            const write = dataSource.saveFiles.bind(dataSource);
            dataSource.saveFiles = (files, message) => {
                const result = tail.then(() => write(files, message));
                tail = result.then(() => { session.saveError = ""; }, (error) => {
                    session.saveError = String(error);
                    if (error?.status === 401) session.needsReconnect = true;
                });
                return result;
            };
        }
    }

    /**
     * Wires a concrete workspace's controllers to the shared presentation boundary.
     * @param {WorkspaceSession} session Newly owned workspace controllers.
     * @returns {void}
     */
    prepare(session) {
        this.queueWrites(session);
        this.todoDetachers.set(session, this.todos.attach(session));
        session.views.projectDialog.onProjectsSaved = (projects) => {
            session.views.weekView.setProjects(projects);
            session.views.todoView.setProjects();
            session.views.expenseView.setProjects();
            for (const source of this.sessions.values()) source.views.searchView.markDirty();
            if (this.current === session) this.app.shell.refreshRepoLabel();
        };
        session.views.projectDialog.onTodosSaved = async ({ reloadGitHub }) => {
            if (!session.runtime.workspace?.hasComponent("todos")) return;
            if (reloadGitHub) await session.views.todoView.loadGitHubIssues();
            await session.views.todoView.acceptExternallySavedState();
            session.views.todoView.setProjects();
            if (this.current === session) this.app.shell.refreshRepoLabel();
        };
        session.views.projectDialog.hasUnsavedTodos = () => Boolean(session.runtime.workspace?.hasComponent("todos"))
            && session.views.todoView.hasBlockingProjectMigrationChanges();
        session.views.searchView.getSources = () => this.available("search").map((source) => ({
            id: source.id, name: source.name, store: source.store, timeContext: source.timeContext,
        }));
        session.views.searchView.onJumpToEntry = (entry) => {
            const origin = session.views.searchView.origins.get(entry);
            const target = this.sessions.get(origin?.id || session.id);
            if (!target?.ready) return;
            this.mount(target, "week");
            target.views.weekView.jumpToEntry(entry);
        };
        const present = () => this.current === session;
        const uiMethods = ["render", "rebuildWeekView", "updateEditorBadge", "updateSaveState", "updateTopbarActions",
            "updateFilterButtons", "populateProjectControls", "populateProjectControl", "renderProjects", "applyFiltersAndRender", "renderSelectedEntry",
            "updateWeekSummary", "updateWeekScaleAndReposition", "openConflictDialog", "reset"];
        for (const view of Object.values(session.views)) {
            const originals = new Map();
            this.originalMethods.set(view, originals);
            if ("onEdit" in view) {
                originals.set("onEdit", view.onEdit);
                view.onEdit = () => {
                    this.renderSaveState();
                    this.autosave.edited();
                    this.renderSaveState();
                };
            }
            for (const name of uiMethods) {
                if (typeof view[name] !== "function") continue;
                const original = view[name].bind(view);
                originals.set(name, original);
                view[name] = (...args) => {
                    const result = present() ? original(...args) : undefined;
                    if (name === "updateSaveState" || name === "updateEditorBadge") this.renderSaveState();
                    return result;
                };
            }
            if ("onBusy" in view) {
                originals.set("onBusy", view.onBusy);
                view.onBusy = (busy) => {
                    if ("busy" in view) view.busy = busy;
                    if (present()) this.app.shell.setBusy(busy);
                };
            }
            if ("onToast" in view) {
                originals.set("onToast", view.onToast);
                view.onToast = (message, timeout, tone) => {
                    if (session.automaticSave && tone === "success") return;
                    this.app.shell.toast(present() ? message : `${session.name}: ${message}`, timeout, tone);
                };
            }
            for (const name of ["onStateChange", "onSaved", "onStatsChanged", "onManifestUpdated", "onSearchDirty"]) {
                if (typeof view[name] !== "function") continue;
                const original = view[name];
                originals.set(name, original);
                view[name] = (...args) => {
                    if (present()) original(...args);
                    this.render();
                };
            }
        }
    }

    /**
     * Mounts an already loaded workspace without fetching, discarding edits, or recreating histories.
     * The document's saved scroll coordinates are restored after its normal render path.
     * @param {WorkspaceSession} session Destination repository.
     * @param {"week" | "todos" | "expenses" | "search"} tab Requested module.
     * @param {boolean} [navigate] Whether to update the shell and browser URL.
     * @param {boolean} [setup] Whether to mount an unconfigured repository for explicit setup only.
     * @returns {void}
     */
    mount(session, tab, navigate = true, setup = false) {
        const app = this.app;
        if (!session.ready && !setup) return;
        if (!session.supports(tab)) tab = session.supports("week") ? "week" : session.supports("todos") ? "todos" : "expenses";
        if (this.current !== session) {
            if (this.current) {
                this.current.route = app.buildCurrentRoute();
                this.captureScroll();
                for (const key of RUNTIME_KEYS) this.current.runtime[key] = app[key];
                app.weekView.setActive(false);
                app.todoView.setActive(false);
                app.expenseView.setActive(false);
                app.searchView.setActive(false);
            }
            this.current = session;
            for (const key of VIEW_KEYS) this.bindings[key].target = session.views[key];
            for (const key of SERVICE_KEYS) {
                Reflect.set(app, key, session[key]);
                for (const owner of [app.shell, app.workspaceController, app.workspaceLoader]) {
                    if (key in owner) owner[key] = session[key];
                }
            }
            for (const key of RUNTIME_KEYS) app[key] = session.runtime[key];
            app.workspaceRegistry.setActive(session.id);
            if (!app.isLocalMode) app.configService.saveWorkspaceRegistry(app.workspaceRegistry);
            app.weekView.zoomInput.value = String(app.weekView.zoom);
            app.weekView.rebuildWeekView();
            app.todoView.setProjects();
            app.expenseView.setProjects();
            app.searchView.markDirty();
            app.shell.setBusy(session.views.weekView.busy || session.views.todoView.busy || session.views.expenseView.busy);
            app.shell.refreshRepoLabel();
            this.restoreScroll();
        }
        this.selected.set(tab, session.id);
        if (navigate) app.shell.setTab(tab);
        this.render();
    }

    /**
     * Saves all pending documents, retaining a failed workspace's edits for an explicit retry.
     * Each workspace has one queue; independent repositories can save concurrently.
     * @param {boolean} [automatic] Automatic attempts skip workspaces requiring reconnection without opening dialogs.
     * @returns {Promise<void>}
     */
    async saveAll(automatic = false) {
        this.autosave.beginSave();
        const reconnect = [...this.sessions.values()].find((session) => session.dirty && session.needsReconnect);
        if (reconnect && !automatic) {
            this.app.workspaceController.openWorkspaceSettings();
            this.app.workspaceController.requestWorkspaceCredential(reconnect.runtime.activeWorkspaceConnection);
        }
        await Promise.all([...this.sessions.values()].filter((session) => session.ready && !session.needsReconnect && (session.dirty || session.saving))
            .map((session) => this.saveSession(session, automatic)));
        this.renderSaveState();
    }

    /**
     * Drains explicit save requests for one workspace without overlapping its document writes.
     * A second Save during an in-flight snapshot requests another pass for any newer edits.
     * @param {WorkspaceSession} session Repository whose pending documents should be saved.
     * @param {boolean} [automatic] Suppresses redundant success toasts for background saves.
     * @returns {Promise<void>}
     */
    async saveSession(session, automatic = false) {
        if (session.saving) { session.saveAgain = true; return session.saving; }
        session.automaticSave = automatic;
        session.saving = (async () => {
            do {
                session.saveAgain = false;
                session.saveError = "";
                const { weekView, todoView, expenseView } = session.views;
                const errors = [];
                if (weekView.dirtyWeekStarts.size) {
                    await weekView.saveDirtyWeeksNow();
                    if (weekView.lastSaveError) errors.push(weekView.lastSaveError);
                }
                if (todoView.dirty) {
                    await todoView.saveNow();
                    if (todoView.conflicts.size) errors.push(this.app.locale.t("toast.todoResolveConflicts"));
                    else if (todoView.lastSaveError) errors.push(todoView.lastSaveError);
                }
                if (expenseView.dirty) {
                    await expenseView.saveNow();
                    if (expenseView.lastSaveError) errors.push(expenseView.lastSaveError);
                }
                session.saveError = errors.join("\n");
            } while (session.saveAgain && session.dirty && !session.saveError);
        })();
        this.render();
        try { await session.saving; }
        catch (error) { session.saveError = String(error); }
        finally { session.saving = null; session.automaticSave = false; this.render(); }
    }

    /**
     * Closes a repository only after an explicit save-and-close decision for dirty documents.
     * Failed writes remain visible in the modal and keep the session, its edits, and its connection intact.
     * @param {WorkspaceSession} session Workspace requested for closing.
     * @returns {Promise<void>}
     */
    async close(session) {
        if (session.dirty || session.saving) {
            const dialog = document.createElement("dialog");
            dialog.className = "dialog workspace-close-dialog";
            const card = document.createElement("div");
            card.className = "dialog-card";
            const title = document.createElement("h2");
            title.className = "dialog-title";
            title.textContent = this.app.locale.t("workspaceSessions.closeTitle", { workspace: session.name });
            title.id = "workspaceCloseTitle";
            dialog.setAttribute("aria-labelledby", title.id);
            const error = document.createElement("p");
            error.role = "alert";
            error.hidden = true;
            const save = document.createElement("button");
            save.className = "btn";
            save.textContent = this.app.locale.t("workspaceSessions.saveClose");
            const cancel = document.createElement("button");
            cancel.className = "btn btn-secondary";
            cancel.textContent = this.app.locale.t("workspaceSessions.cancel");
            const actions = document.createElement("div");
            actions.className = "row dialog-actions";
            actions.append(cancel, save);
            card.append(title, error, actions);
            dialog.append(card);
            document.body.append(dialog);
            const accepted = await new Promise((resolve) => {
                cancel.onclick = () => { dialog.close(); resolve(false); };
                dialog.addEventListener("cancel", () => resolve(false));
                save.onclick = async () => {
                    save.disabled = true;
                    try {
                        let attempts = 0;
                        do {
                            if (++attempts > 3) throw new Error(this.app.locale.t("workspaceSessions.pending"));
                            if (session.saving) await session.saving;
                            if (session.dirty) await this.saveSession(session);
                            if (session.saveError || (session.dirty && session.views.todoView.conflicts.size)) {
                                throw new Error(session.saveError || this.app.locale.t("toast.todoResolveConflicts"));
                            }
                        } while (session.dirty || session.saving);
                        dialog.close();
                        resolve(true);
                    } catch (failure) {
                        error.textContent = String(failure);
                        error.hidden = false;
                    } finally { save.disabled = false; }
                };
                dialog.showModal();
                cancel.focus();
            });
            dialog.remove();
            if (!accepted) return;
        }
        session.views.weekView.stopNowTimer();
        this.sessions.delete(session.id);
        for (const [module, selected] of this.selected) if (selected === session.id) this.selected.delete(module);
        if (this.current === session) {
            const next = this.available(this.app.state.activeTab)[0] || [...this.sessions.values()].find((candidate) => candidate.ready);
            if (next) this.mount(next, this.app.state.activeTab);
            else this.app.logout(false);
        }
        this.todoDetachers.get(session)?.();
        this.todoDetachers.delete(session);
        this.todos.redo = this.todos.redo.filter((item) => item.session !== session);
        for (const view of Object.values(session.views)) this.originalMethods.delete(view);
        for (const source of this.sessions.values()) source.views.searchView.markDirty();
        this.render();
    }

    /**
     * Drops all in-memory sessions on logout/credential clearing without deleting remembered connections.
     * Original controller methods are restored so the next login can safely reuse the shared event relays.
     * @returns {void}
     */
    reset() {
        this.autosave.reset();
        this.previousSaveState = "saved";
        this.generation++;
        this.opening.clear();
        this.unavailable.clear();
        for (const detach of this.todoDetachers.values()) detach();
        this.todoDetachers.clear();
        for (const session of this.sessions.values()) {
            session.views.weekView.stopNowTimer();
            session.store.clear();
            session.todoStore.clear();
            session.expenseStore.clear();
            session.runtime.token = "";
            session.state.setToken("");
            session.chunkCache.clearMemory();
        }
        for (const [view, methods] of this.originalMethods) {
            for (const [name, original] of methods) view[name] = original;
        }
        this.originalMethods.clear();
        this.sessions.clear();
        this.selected.clear();
        this.current = null;
        this.started = false;
        this.todos.enabled = false;
        this.todos.redo = [];
        this.selector?.replaceChildren();
        if (this.label) this.label.textContent = "";
    }

    /**
     * Applies the title dropdown through the existing per-module navigation and search scope paths.
     * An empty choice represents combined tasks or cross-workspace search, never a new repository session.
     * @param {string} id Ready workspace session ID, or an empty string for all workspaces.
     * @returns {void}
     */
    selectWorkspace(id) {
        const app = this.app;
        if (app.state.activeTab === "search") {
            const select = app.searchView.workspaceSelect;
            if (select) {
                select.value = id;
                select.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return;
        }
        if (app.state.activeTab === "todos" && !id) {
            this.todos.enabled = true;
            this.render();
            app.writeCurrentRoute("push");
            return;
        }
        const session = this.sessions.get(id);
        if (!session?.ready && app.workspaceRegistry.getById(id)) {
            void app.workspaceController.switchWorkspace(id).catch((error) => app.shell.toast(String(error), 6000));
            return;
        }
        if (!session?.supports(app.state.activeTab)) return;
        if (app.state.activeTab === "todos") this.todos.enabled = false;
        app.todoView.projectFiltersEl.hidden = false;
        this.mount(session, app.state.activeTab);
    }

    /**
     * Updates the page-title dropdown with compatible workspaces and connections awaiting hydration.
     * Unavailable connections remain reachable for reconnection; loaded repositories lacking the module
     * are omitted. A single choice renders as a plain heading, without a hidden interactive overlay.
     * @returns {void}
     */
    render() {
        if (!this.current || !this.selector || !this.label) return;
        const app = this.app;
        this.label.textContent = this.current.name;
        const available = this.available(app.state.activeTab);
        const all = app.state.activeTab === "search" || (app.state.activeTab === "todos" && available.length > 1);
        let selectedId = this.current.id;
        if (app.state.activeTab === "search") {
            selectedId = app.searchView.workspaceScope;
            this.label.textContent = selectedId
                ? this.sessions.get(selectedId)?.name || app.workspaceRegistry.getById(selectedId)?.displayName || selectedId
                : app.locale.t("workspaceSessions.all");
        }
        if (this.todos.active) {
            selectedId = "";
            this.label.textContent = app.locale.t("workspaceSessions.all");
        }
        const choices = app.workspaceRegistry.list().filter((connection) => {
            const session = this.sessions.get(connection.id);
            return (!session?.ready && app.state.activeTab !== "search") || session?.supports(app.state.activeTab);
        }).map((connection) => ({ id: connection.id, name: this.sessions.get(connection.id)?.name || connection.displayName }));
        if (all) choices.unshift({ id: "", name: app.locale.t("workspaceSessions.all") });
        // Retain the native select node/options during ordinary renders so keyboard focus and an open picker are not disrupted.
        const changed = choices.length !== this.selector.options.length || choices.some((choice, index) => {
            const option = this.selector.options[index];
            return option?.value !== choice.id || option?.textContent !== choice.name;
        });
        if (changed) this.selector.replaceChildren(...choices.map((choice) => new Option(choice.name, choice.id)));
        this.selector.value = selectedId;
        this.selector.hidden = choices.length < 2;
        this.selector.setAttribute("aria-label", app.locale.t("workspaceSessions.workspace"));
        this.selector.title = this.label.textContent;
        this.label.title = this.label.textContent;
        const chevron = document.querySelector(".workspace-title-chevron");
        if (chevron instanceof HTMLElement || chevron instanceof SVGElement) {
            chevron.toggleAttribute("hidden", this.selector.hidden);
        }
        this.renderSaveState();
        this.todos.render();
        const unavailable = app.workspaceRegistry.list().filter((connection) =>
            this.unavailable.has(connection.id) || this.sessions.get(connection.id)?.error);
        const status = document.getElementById("workspaceAvailability");
        if (status) {
            status.hidden = unavailable.length === 0 && !this.initializing;
            status.textContent = unavailable.length
                ? app.locale.t("workspaceSessions.unavailable", { workspaces: unavailable.map((connection) => connection.displayName).join(", ") })
                : app.locale.t("workspaceSessions.loading");
            status.title = unavailable.map((connection) => `${connection.displayName}: ${this.unavailable.get(connection.id) || this.sessions.get(connection.id)?.error}`).join("\n");
            status.onclick = () => app.workspaceController.openWorkspaceSettings();
        }
        app.refreshSidebarNavigation();
    }

    /** @returns {void} Keeps the shared save button truthful even when an inactive module updates its local badge. */
    renderSaveState() {
        if (!this.current) return;
        const app = this.app;
        const dirty = [...this.sessions.values()].filter((session) => session.dirty);
        const saving = [...this.sessions.values()].some((session) => session.saving
            || session.views.weekView.saveInFlight || session.views.todoView.saveInFlight || session.views.expenseView.saveInFlight);
        const failed = dirty.filter((session) => session.saveError);
        const reconnect = dirty.filter((session) => session.needsReconnect);
        this.autosave.update(dirty.some((session) => session.ready && !session.needsReconnect), saving);
        const state = reconnect.length ? "reconnect" : failed.length ? "failed" : saving ? "saving" : dirty.length ? "dirty" : "saved";
        const badge = app.editorBadgeEl;
        badge.disabled = false;
        badge.classList.toggle("is-dirty", dirty.length > 0);
        if (state !== "saved") badge.classList.remove("is-just-saved");
        else if (this.previousSaveState === "saving") badge.classList.add("is-just-saved");
        this.previousSaveState = state;
        badge.dataset.state = state;
        badge.title = failed.length
            ? failed.map((session) => `${session.name}: ${session.saveError}`).join("\n")
            : dirty.length ? `${app.locale.t("workspaceSessions.autosaveHelp")}\n${dirty.map((session) => session.name).join(", ")}` : "";
        const action = app.locale.t(state === "reconnect" ? "workspaceSessions.reconnectAction" : "workspaceSessions.saveAll");
        badge.setAttribute("aria-label", `${action}${failed.length ? `: ${failed.map((session) => session.name).join(", ")}` : ""}`);
        // Keep countdown updates out of the live region: screen readers hear state changes, not every second.
        let label = badge.querySelector(".save-label");
        let countdown = badge.querySelector(".save-countdown");
        if (!label || !countdown) {
            label = document.createElement("span");
            label.className = "save-label";
            label.setAttribute("aria-live", "polite");
            countdown = document.createElement("span");
            countdown.className = "save-countdown";
            countdown.setAttribute("aria-hidden", "true");
            badge.removeAttribute("aria-live");
            badge.replaceChildren(label, countdown);
        }
        const key = { dirty: "saveCountdown", failed: "retryCountdown", reconnect: "reconnectAction", saving: "savingShort", saved: "saved" }[state];
        const text = app.locale.t(state === "saved" ? "status.saved" : `workspaceSessions.${key}`);
        if (label.textContent !== text) label.textContent = text;
        const seconds = this.autosave.deadline && !saving
            ? app.locale.t(state === "failed" ? "workspaceSessions.retryIn" : "workspaceSessions.autosaveCountdown", { seconds: this.autosave.seconds })
            : "";
        if (countdown.textContent !== seconds) countdown.textContent = seconds;
        countdown.toggleAttribute("hidden", !seconds);
    }
}
