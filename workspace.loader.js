import { WorkspaceConfigurationError } from "./datasource.js";
import {
    ExpenseDocument,
    ExpenseManifest,
    Manifest,
    ProjectList,
    TodoList,
    WeekRequirements,
    Workspace,
} from "./model.js";
import { chunkKey, isoWeekStartFromYearWeek } from "./utils.js";
import { WorkspaceSetupRequiredError } from "./workspace.js";

/**
 * Parses one normalized week document and returns its entry records after schema validation.
 * Including the manifest path in failures makes both corrupt IndexedDB records and malformed network responses diagnosable.
 * @param {import("./model.js").ManifestChunk} chunk
 * @param {string} raw
 * @returns {Array<Object>}
 */
export function parseWeekChunkEntries(chunk, raw) {
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        throw new Error(`${chunk.path} is not valid JSON.`);
    }
    if (!payload || typeof payload !== "object" || Number(payload.schema_version) !== 2) {
        throw new Error(`${chunk.path} must use entry schema_version 2.`);
    }
    return Array.isArray(payload.entries) ? payload.entries : [];
}


/**
 * @typedef {Object} WorkspaceLoaderRuntime
 * @description Mutable repository-session values needed while hydrating one workspace.
 * @property {import("./config.js").WorkspaceConnection | null} activeWorkspaceConnection
 * @property {import("./config.js").AppConfig} config
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {import("./routing.js").AppRoute | null} pendingRoute
 * @property {Workspace | null} workspace
 * @property {Object | null} workspaceConfigBaseRaw
 * @property {import("./config.js").WorkspaceRegistry} workspaceRegistry
 * @property {{reason: "missing" | "invalid_json" | "invalid", path: string, detail: string, raw: Object | null} | null} workspaceSetup
 */

/**
 * @typedef {Object} WorkspaceLoaderOptions
 * @description Stores, views, services, and notifications used by repository hydration.
 * @property {WorkspaceLoaderRuntime} runtime
 * @property {boolean} isLocalMode
 * @property {import("./config.js").ConfigService} configService
 * @property {import("./appstate.js").AppState} state
 * @property {import("./store.js").EntryStore} store
 * @property {import("./store.js").TodoStore} todoStore
 * @property {import("./store.js").ExpenseStore} expenseStore
 * @property {import("./cache.js").ChunkCache} chunkCache
 * @property {import("./locale.js").LocaleService} locale
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {import("./week.view.js").WeekView} weekView
 * @property {import("./search.view.js").SearchView} searchView
 * @property {import("./todo.view.js").TodoView} todoView
 * @property {import("./expense.view.js").ExpenseView} expenseView
 * @property {import("./workspace.js").WorkspaceController} workspaceController
 * @property {(loaded: number, total: number, label: string) => void} onProgress
 * @property {(message: string, timeout?: number, tone?: "error" | "success") => void} onToast
 * @property {() => void} onSearchDirty
 * @property {() => void} onRepositorySummaryChanged
 * @property {() => void} onNavigationChanged
 */

/**
 * Loads and validates workspace documents, manifests, cached chunks, and editor drafts.
 * It mutates the supplied stores and views but owns neither routing nor screen transitions, allowing App to decide how loading success, setup requirements, and failures affect navigation.
 */
export class WorkspaceLoader {
    /**
     * Captures one repository session and the stores that receive its normalized documents.
     * @param {WorkspaceLoaderOptions} options Loader dependencies supplied by the application composition root.
     */
    constructor(options) {
        this.runtime = options.runtime;
        this.isLocalMode = options.isLocalMode;
        this.configService = options.configService;
        this.state = options.state;
        this.store = options.store;
        this.todoStore = options.todoStore;
        this.expenseStore = options.expenseStore;
        this.chunkCache = options.chunkCache;
        this.locale = options.locale;
        this.timeContext = options.timeContext;
        this.weekView = options.weekView;
        this.searchView = options.searchView;
        this.todoView = options.todoView;
        this.expenseView = options.expenseView;
        this.workspaceController = options.workspaceController;
        this.setProgress = options.onProgress;
        this.toast = options.onToast;
        this.markSearchDirty = options.onSearchDirty;
        this.refreshRepoLabel = options.onRepositorySummaryChanged;
        this.refreshSidebarNavigation = options.onNavigationChanged;
    }


    /**
     * Loads and installs the root zeitberg workspace configuration before component documents are requested.
     * The workspace supplies all repository paths and the shared timezone, allowing the same application build to operate against local, GitHub, and future provider-backed repositories.
     * @returns {Promise<void>}
     */
    async fetchWorkspace() {
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.workspaceLocal" : "loading.workspace"),
        );
        let raw;
        try {
            raw = await this.runtime.dataSource.fetchWorkspace();
        } catch (error) {
            if (error instanceof WorkspaceConfigurationError) {
                throw new WorkspaceSetupRequiredError(error.reason, error.path, error);
            }
            throw error;
        }
        let workspace;
        try {
            workspace = Workspace.fromRaw(raw);
        } catch (error) {
            throw new WorkspaceSetupRequiredError(
                "invalid",
                this.runtime.dataSource.getWorkspaceConfigPath(),
                error,
                raw,
            );
        }
        const expectedWorkspaceId = String(this.runtime.pendingRoute?.workspace?.expectedWorkspaceId || "");
        if (expectedWorkspaceId && workspace.workspace_id !== expectedWorkspaceId) {
            throw new Error(
                `Workspace identity mismatch: the link expects ${expectedWorkspaceId}, but the repository contains ${workspace.workspace_id}.`,
            );
        }
        this.runtime.workspace = workspace;
        this.runtime.workspaceSetup = null;
        this.runtime.workspaceConfigBaseRaw = workspace.toObject();
        this.runtime.dataSource.setWorkspace(workspace);
        this.refreshSidebarNavigation();
        this.timeContext.setTimeZone(workspace.timezone);
        this.runtime.config = { ...this.runtime.config, timezone: workspace.timezone };
        this.state.setConfig(this.runtime.config);
        if (!this.isLocalMode) {
            const locator = this.runtime.activeWorkspaceConnection?.toLocator() || this.workspaceController.getCurrentWorkspaceRouteLocator();
            const connection = this.runtime.workspaceRegistry.upsert(locator, {
                displayName: workspace.name,
                expectedWorkspaceId: workspace.workspace_id,
            });
            this.runtime.workspaceRegistry.setActive(connection.id);
            this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
            this.runtime.activeWorkspaceConnection = connection;
        }
        this.weekView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.expenseView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
    }

    /**
     * Loads the entries manifest from the data source.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async fetchManifest() {
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.manifestLocal" : "loading.manifest"),
        );
        const raw = await this.runtime.dataSource.fetchManifest();
        const manifest = Manifest.fromRaw(raw, this.runtime.dataSource.getEntriesDirectory());
        this.store.setManifest(manifest);
        this.refreshRepoLabel();
    }

    /**
     * Loads projects.json and updates the project list.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async fetchProjects() {
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.projectsLocal" : "loading.projects"),
        );
        const raw = await this.runtime.dataSource.fetchProjects();
        const projectList = ProjectList.fromRaw(raw || {});
        this.store.setProjectList(projectList);
        this.weekView.setProjects(projectList);
        this.expenseView.setProjects();
        this.markSearchDirty();
    }

    /**
     * Loads week-requirements.json and updates the week requirements model.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async fetchWeekRequirements() {
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.requirementsLocal" : "loading.requirements"),
        );
        try {
            const raw = await this.runtime.dataSource.fetchWeekRequirements();
            const requirements = WeekRequirements.fromRaw(raw || {});
            this.store.setWeekRequirements(requirements);
            this.weekView.setWeekRequirements(requirements);
        } catch (err) {
            const defaults = WeekRequirements.createDefault();
            this.store.setWeekRequirements(defaults);
            this.weekView.setWeekRequirements(defaults);
            this.toast(
                this.locale.t("toast.requirementsNotLoaded", { error: this.locale.localizeError(err) }),
                5000,
            );
        }
    }

    /**
     * Loads data/todos.json, establishes its clean editor baseline, and restores any durable unsaved browser draft.
     * Project references are resolved later by TodoView through the already loaded shared ProjectList.
     * @returns {Promise<void>}
     */
    async fetchTodos() {
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.todosLocal" : "loading.todos"),
        );
        const raw = await this.runtime.dataSource.fetchTodos();
        this.todoStore.setTodoList(TodoList.fromRaw(raw || {}));
        await this.todoView.initializeLoadedData();
        this.refreshRepoLabel();
    }

    /**
     * Loads and verifies the exact expense document against its workspace-configured integrity manifest, then restores any durable browser draft.
     * @returns {Promise<void>}
     */
    async fetchExpenses() {
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.expensesLocal" : "loading.expenses"),
        );
        const [content, manifestRaw] = await Promise.all([
            this.runtime.dataSource.fetchExpensesText(),
            this.runtime.dataSource.fetchExpensesManifest(),
        ]);
        const manifest = ExpenseManifest.fromRaw(manifestRaw, this.runtime.dataSource.getExpensesPath());
        manifest.verifyContent(content);
        let raw;
        try {
            raw = JSON.parse(content);
        } catch {
            throw new Error("expenses.json is not valid JSON.");
        }
        const document = ExpenseDocument.fromRaw(raw);
        if (
            manifest.participants !== document.participants.length ||
            manifest.categories !== document.categories.length ||
            manifest.expenses !== document.expenses.length ||
            manifest.transfers !== document.transfers.length
        ) {
            throw new Error("Expense manifest counts do not match expenses.json.");
        }
        this.expenseStore.setDocument(document);
        this.expenseStore.setManifest(manifest);
        await this.expenseView.initializeLoadedData();
        this.refreshRepoLabel();
    }

    /**
     * Loads all week chunks and rebuilds store indexes.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async loadAllChunks() {
        if (!this.store.getManifest()) {
            await this.fetchManifest();
        }
        const manifest = this.store.getManifest();
        if (!manifest) {
            throw new Error("Missing manifest data.");
        }
        const chunkFiles = manifest.chunks;
        if (!chunkFiles.length) {
            this.store.clear({ keepProjects: true, keepWeekRequirements: true });
            this.store.setManifest(manifest);
            this.state.setLatestWeekStart(null);
            this.state.setWeekStart(null);
            this.weekView.setLatestWeekStart(null);
            this.weekView.reset();
            this.searchView.reset();
            await this.finalizeLoadedEntries();
            return;
        }

        this.setProgress(
            0,
            chunkFiles.length,
            this.locale.t("loading.progress", {
                loaded: this.locale.formatNumber(0),
                total: this.locale.formatNumber(chunkFiles.length),
            }),
        );

        this.store.clear({ keepProjects: true, keepWeekRequirements: true });
        this.store.setManifest(manifest);

        let cacheHits = 0;
        let memoryHits = 0;
        /** @type {Map<string, Array<Object>>} */
        const entriesByKey = new Map();
        /** @type {import("./model.js").ManifestChunk[]} */
        const cacheCandidates = [];

        for (const chunk of chunkFiles) {
            const key = chunkKey(chunk.year, chunk.week);
            const memory = this.chunkCache.getMemory(key);
            if (memory && memory.sha === chunk.sha) {
                entriesByKey.set(key, memory.entriesRaw || []);
                memoryHits += 1;
            } else {
                cacheCandidates.push(chunk);
            }
        }

        this.setProgress(
            memoryHits,
            chunkFiles.length,
            this.locale.t("loading.checkCache", { count: this.locale.formatNumber(cacheCandidates.length) }),
        );
        const cachedRawBySha = await this.chunkCache.getRawByShas(cacheCandidates.map((chunk) => chunk.sha));
        /** @type {import("./model.js").ManifestChunk[]} */
        const downloadChunks = [];
        const corruptCacheShas = new Set();
        for (const chunk of cacheCandidates) {
            const key = chunkKey(chunk.year, chunk.week);
            const cachedRaw = cachedRawBySha.get(chunk.sha);
            if (cachedRaw) {
                try {
                    entriesByKey.set(key, parseWeekChunkEntries(chunk, cachedRaw));
                    cacheHits += 1;
                    continue;
                } catch {
                    corruptCacheShas.add(chunk.sha);
                }
            }
            downloadChunks.push(chunk);
        }
        await this.chunkCache.deleteRawByShas(corruptCacheShas);

        /** @type {Map<string, string>} */
        let downloadedRawBySha = new Map();
        if (downloadChunks.length) {
            this.setProgress(
                memoryHits + cacheHits,
                chunkFiles.length,
                this.locale.t("loading.download", { count: this.locale.formatNumber(downloadChunks.length) }),
            );
            downloadedRawBySha = await this.runtime.dataSource.fetchChunkTexts(downloadChunks);
        }

        const cacheWrites = new Map();
        for (const chunk of downloadChunks) {
            const raw = downloadedRawBySha.get(chunk.sha);
            if (typeof raw !== "string" || !raw) {
                throw new Error(`Data source did not return ${chunk.path}.`);
            }
            const key = chunkKey(chunk.year, chunk.week);
            entriesByKey.set(key, parseWeekChunkEntries(chunk, raw));
            cacheWrites.set(chunk.sha, raw);
        }
        await this.chunkCache.putRawByShas(cacheWrites);

        for (let index = 0; index < chunkFiles.length; index++) {
            const chunk = chunkFiles[index];
            const key = chunkKey(chunk.year, chunk.week);
            const entriesRaw = entriesByKey.get(key);
            if (!entriesRaw) throw new Error(`Failed to prepare ${chunk.path}.`);
            this.chunkCache.setMemory(key, { sha: chunk.sha, entriesRaw });
            const weekStart = isoWeekStartFromYearWeek(chunk.year, chunk.week);
            this.store.applyWeekSnapshot(weekStart, entriesRaw);
            this.setProgress(
                index + 1,
                chunkFiles.length,
                this.locale.t("loading.prepare", {
                    loaded: this.locale.formatNumber(index + 1),
                    total: this.locale.formatNumber(chunkFiles.length),
                    week: key,
                }),
            );
        }

        this.setProgress(
            chunkFiles.length,
            chunkFiles.length,
            this.locale.t("loading.complete", {
                loaded: this.locale.formatNumber(chunkFiles.length),
                total: this.locale.formatNumber(chunkFiles.length),
                memory: this.locale.formatNumber(memoryHits),
                cached: this.locale.formatNumber(cacheHits),
                downloaded: this.locale.formatNumber(downloadChunks.length),
            }),
        );

        await this.finalizeLoadedEntries();
    }

    /**
     * Restores unsaved browser drafts and rebuilds all derived UI state after chunk loading.
     * Running this once for empty and populated manifests keeps reload behavior identical in both cases.
     * @returns {Promise<void>}
     */
    async finalizeLoadedEntries() {
        await this.weekView.restoreDrafts();
        this.store.recomputeNextEntryId();

        const latest = this.store.getLatestWeekStart();
        this.state.setLatestWeekStart(latest);
        this.weekView.setLatestWeekStart(this.state.latestWeekStart);
        if (latest) {
            const focusedToday = this.weekView.focusTodayLastEntry(true);
            if (!focusedToday) {
                this.state.setWeekStart(latest);
                this.weekView.setWeekStart(latest);
            }
        } else {
            this.state.setWeekStart(null);
            this.weekView.reset();
        }

        this.searchView.markDirty();
        this.searchView.applyFiltersAndRender();
    }
}
