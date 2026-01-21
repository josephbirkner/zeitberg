import { AppState } from "./appstate.js";
import { ChunkCache } from "./cache.js";
import { ConfigService, DEFAULT_CONFIG } from "./config.js";
import { GitHubDataSource, LocalDataSource } from "./datasource.js";
import { EntryStore } from "./store.js";
import { SearchView } from "./search.view.js";
import { WeekView } from "./week.view.js";
import { getRequiredElement, getSourceMode, safeText, setVisible, isoWeekStartFromYearWeek, chunkKey, TimeContext } from "./utils.js";
import { Manifest } from "./model.js";

/**
 * Main application controller.
 */
class App {
    constructor() {
        this.configService = new ConfigService();
        this.config = this.configService.loadConfig();
        this.token = this.configService.loadToken();
        this.isLocalMode = getSourceMode() === "local";
        this.state = new AppState(this.config, this.isLocalMode);
        this.state.setToken(this.token);
        this.timeContext = new TimeContext(this.config.timezone);
        this.store = new EntryStore(this.timeContext);
        this.chunkCache = new ChunkCache();

        this.dataSource = this.isLocalMode ? new LocalDataSource() : new GitHubDataSource(this.config, this.token);

        this.authStatusEl = getRequiredElement("authStatus");
        this.logoutBtn = getRequiredElement("logoutBtn");
        this.loginSection = getRequiredElement("loginSection");
        this.loginForm = getRequiredElement("loginForm");
        this.loginErrorEl = getRequiredElement("loginError");
        this.clearSavedBtn = getRequiredElement("clearSavedBtn");

        this.viewTabsEl = getRequiredElement("viewTabs");
        this.tabWeekBtn = getRequiredElement("tabWeek");
        this.tabSearchBtn = getRequiredElement("tabSearch");
        this.weekControlsEl = getRequiredElement("weekControls");

        this.appSection = getRequiredElement("appSection");
        this.repoLabelEl = getRequiredElement("repoLabel");
        this.reloadDataBtn = getRequiredElement("reloadDataBtn");
        this.loadProgressEl = getRequiredElement("loadProgress");
        this.loadProgressLabelEl = getRequiredElement("loadProgressLabel");
        this.dataErrorEl = getRequiredElement("dataError");

        this.weekViewSection = getRequiredElement("weekViewSection");
        this.weekLabelEl = getRequiredElement("weekLabel");
        this.weekScrollEl = getRequiredElement("weekScroll");
        this.prevWeekBtn = getRequiredElement("prevWeekBtn");
        this.nextWeekBtn = getRequiredElement("nextWeekBtn");
        this.latestWeekBtn = getRequiredElement("latestWeekBtn");
        this.zoomInput = getRequiredElement("zoomInput");
        this.editorBadgeEl = getRequiredElement("editorBadge");

        this.entryDialog = getRequiredElement("entryDialog");
        this.entryForm = getRequiredElement("entryForm");
        this.entryCloseBtn = getRequiredElement("entryCloseBtn");
        this.entryCancelBtn = getRequiredElement("entryCancelBtn");
        this.entryMetaEl = getRequiredElement("entryMeta");
        this.entryProjectInput = getRequiredElement("entryProject");
        this.entryTagsInput = getRequiredElement("entryTags");
        this.entryDescInput = getRequiredElement("entryDesc");
        this.entryBillableInput = getRequiredElement("entryBillable");
        this.projectDatalistEl = getRequiredElement("projectDatalist");

        this.searchViewEl = getRequiredElement("searchView");
        this.searchInput = getRequiredElement("searchInput");
        this.projectSelect = getRequiredElement("projectSelect");
        this.fromDateInput = getRequiredElement("fromDate");
        this.toDateInput = getRequiredElement("toDate");
        this.maxRowsInput = getRequiredElement("maxRows");
        this.sortSelect = getRequiredElement("sortSelect");
        this.statsEl = getRequiredElement("stats");
        this.entriesTbody = getRequiredElement("entriesTbody");

        this.ownerInput = getRequiredElement("ownerInput");
        this.repoInput = getRequiredElement("repoInput");
        this.refInput = getRequiredElement("refInput");
        this.tokenInput = getRequiredElement("tokenInput");
        this.rememberInput = getRequiredElement("rememberInput");

        this.weekView = new WeekView({
            store: this.store,
            chunkCache: this.chunkCache,
            appState: this.state,
            timeContext: this.timeContext,
            dataSource: this.dataSource,
            elements: {
                weekViewSection: this.weekViewSection,
                weekControls: this.weekControlsEl,
                weekLabel: this.weekLabelEl,
                weekScroll: this.weekScrollEl,
                prevWeekBtn: this.prevWeekBtn,
                nextWeekBtn: this.nextWeekBtn,
                latestWeekBtn: this.latestWeekBtn,
                zoomInput: this.zoomInput,
                editorBadge: this.editorBadgeEl,
                entryDialog: this.entryDialog,
                entryForm: this.entryForm,
                entryCloseBtn: this.entryCloseBtn,
                entryCancelBtn: this.entryCancelBtn,
                entryMeta: this.entryMetaEl,
                entryProject: this.entryProjectInput,
                entryTags: this.entryTagsInput,
                entryDesc: this.entryDescInput,
                entryBillable: this.entryBillableInput,
            },
            onToast: (message, timeout) => this.toast(message, timeout),
            onBusy: (busy) => this.setBusy(busy),
            onSearchDirty: () => this.markSearchDirty(),
            onManifestUpdated: () => this.refreshRepoLabel(),
        });

        this.searchView = new SearchView({
            store: this.store,
            timeContext: this.timeContext,
            elements: {
                searchView: this.searchViewEl,
                searchInput: this.searchInput,
                projectSelect: this.projectSelect,
                fromDate: this.fromDateInput,
                toDate: this.toDateInput,
                maxRows: this.maxRowsInput,
                sortSelect: this.sortSelect,
                stats: this.statsEl,
                entriesTbody: this.entriesTbody,
                projectDatalist: this.projectDatalistEl,
            },
            onJumpToEntry: (entry) => {
                if (this.viewTabsEl.hidden) return;
                this.setTab("week");
                this.weekView.jumpToEntry(entry);
            },
        });

        this.toastTimer = 0;
        this.resizeRaf = 0;
    }

    /**
     * @returns {void}
     */
    start() {
        this.ownerInput.value = this.config.owner;
        this.repoInput.value = this.config.repo;
        this.refInput.value = this.config.ref;
        this.rememberInput.checked = this.configService.isTokenRemembered();

        this.loginForm.addEventListener("submit", (ev) => this.handleLoginSubmit(ev));
        this.clearSavedBtn.addEventListener("click", () => this.handleClearSaved());
        this.tabWeekBtn.addEventListener("click", () => this.setTab("week"));
        this.tabSearchBtn.addEventListener("click", () => this.setTab("search"));
        this.logoutBtn.addEventListener("click", () => this.logout());
        this.reloadDataBtn.addEventListener("click", () => this.reloadData());

        document.addEventListener("keydown", (ev) => this.handleGlobalKeydown(ev));
        window.addEventListener("resize", () => this.handleResize());

        this.setProgress(0, 1, "");

        if (this.isLocalMode) {
            this.setAuthStatus("Local mode");
            setVisible(this.logoutBtn, false);
            setVisible(this.reloadDataBtn, true);
            setVisible(this.loginSection, false);
            setVisible(this.appSection, true);
            setVisible(this.viewTabsEl, true);
            this.setAppMode(true);
            this.setTab(this.state.activeTab);
            this.reloadData();
            return;
        }

        setVisible(this.loginSection, true);
        setVisible(this.appSection, false);
        setVisible(this.logoutBtn, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.viewTabsEl, false);
        setVisible(this.weekControlsEl, false);
        this.setAppMode(false);
        this.setTab(this.state.activeTab);

        if (this.token) {
            this.connectWithToken(this.token).catch(() => {
                setVisible(this.loginSection, true);
            });
        } else {
            this.setAuthStatus("Not logged in");
        }
    }

    /**
     * @param {KeyboardEvent} ev
     * @returns {void}
     */
    handleGlobalKeydown(ev) {
        if (ev.ctrlKey && !ev.altKey && !this.appSection.hidden && !this.viewTabsEl.hidden) {
            const key = String(ev.key || "");
            const keyLower = key.toLowerCase();

            if (keyLower === "k") {
                ev.preventDefault();
                this.setTab("search");
                queueMicrotask(() => {
                    try {
                        this.searchInput.focus();
                        this.searchInput.select();
                    } catch {
                        // ignore
                    }
                });
                return;
            }

            if (keyLower === "g" || keyLower === "w") {
                ev.preventDefault();
                this.setTab("week");
                return;
            }

            const isZoomOut = key === "[" || key === "{" || ev.code === "BracketLeft";
            const isZoomIn = key === "]" || key === "}" || ev.code === "BracketRight";
            if (isZoomOut || isZoomIn) {
                if (this.state.activeTab === "week" && !(this.appSection.hidden || this.weekViewSection.hidden)) {
                    ev.preventDefault();
                    this.weekView.nudgeZoom(isZoomOut ? -1 : 1);
                }
                return;
            }
        }

        this.weekView.handleKeydown(ev);
    }

    /**
     * @returns {void}
     */
    handleResize() {
        if (this.resizeRaf) return;
        this.resizeRaf = window.requestAnimationFrame(() => {
            this.resizeRaf = 0;
            this.weekView.handleResize();
        });
    }

    /**
     * @param {Event} ev
     * @returns {void}
     */
    async handleLoginSubmit(ev) {
        ev.preventDefault();
        this.setError(this.loginErrorEl, "");

        const owner = this.ownerInput.value.trim();
        const repo = this.repoInput.value.trim();
        const ref = this.refInput.value.trim();
        const tok = this.tokenInput.value.trim();
        const remember = this.rememberInput.checked;

        if (!owner || !repo || !ref || !tok) {
            this.setError(this.loginErrorEl, "Please fill in owner, repo, ref, and token.");
            return;
        }

        this.config = { ...this.config, owner, repo, ref };
        this.state.setConfig(this.config);
        this.configService.saveConfig(this.config);
        this.configService.saveToken(tok, remember);
        this.tokenInput.value = "";

        try {
            await this.connectWithToken(tok);
        } catch (err) {
            this.setError(this.loginErrorEl, safeText(err));
        }
    }

    /**
     * @returns {void}
     */
    handleClearSaved() {
        this.configService.clearSaved();
        this.chunkCache.clearAll();
        this.config = { ...DEFAULT_CONFIG };
        this.state.setConfig(this.config);
        this.ownerInput.value = this.config.owner;
        this.repoInput.value = this.config.repo;
        this.refInput.value = this.config.ref;
        this.tokenInput.value = "";
        this.rememberInput.checked = false;
        this.setAuthStatus("Cleared");
    }

    /**
     * @param {string} text
     * @returns {void}
     */
    setAuthStatus(text) {
        this.authStatusEl.textContent = text;
    }

    /**
     * @param {HTMLElement} el
     * @param {string} message
     * @returns {void}
     */
    setError(el, message) {
        if (!message) {
            el.textContent = "";
            setVisible(el, false);
            return;
        }
        el.textContent = message;
        setVisible(el, true);
    }

    /**
     * @param {string} message
     * @param {number} timeoutMs
     * @returns {void}
     */
    toast(message, timeoutMs = 2400) {
        window.clearTimeout(this.toastTimer);
        this.setError(this.dataErrorEl, message ? String(message) : "");
        if (!message) return;
        this.toastTimer = window.setTimeout(() => {
            this.setError(this.dataErrorEl, "");
        }, Math.max(400, timeoutMs));
    }

    /**
     * @param {boolean} isBusy
     * @returns {void}
     */
    setBusy(isBusy) {
        this.logoutBtn.disabled = isBusy;
        this.reloadDataBtn.disabled = isBusy;
        this.tabWeekBtn.disabled = isBusy;
        this.tabSearchBtn.disabled = isBusy;
        this.prevWeekBtn.disabled = isBusy;
        this.nextWeekBtn.disabled = isBusy;
        this.latestWeekBtn.disabled = isBusy;
        this.zoomInput.disabled = isBusy;
        this.searchInput.disabled = isBusy;
        this.projectSelect.disabled = isBusy;
        this.fromDateInput.disabled = isBusy;
        this.toDateInput.disabled = isBusy;
        this.maxRowsInput.disabled = isBusy;
        this.sortSelect.disabled = isBusy;
    }

    /**
     * @param {number} loaded
     * @param {number} total
     * @param {string} label
     * @returns {void}
     */
    setProgress(loaded, total, label) {
        const max = Math.max(1, total || 0);
        this.loadProgressEl.max = max;
        this.loadProgressEl.value = Math.min(Math.max(0, loaded), max);
        this.loadProgressLabelEl.textContent = label || "";
    }

    /**
     * @param {"week" | "search"} tab
     * @returns {void}
     */
    setTab(tab) {
        const next = tab === "search" ? "search" : "week";
        this.state.setActiveTab(next);
        this.tabWeekBtn.setAttribute("aria-selected", next === "week" ? "true" : "false");
        this.tabSearchBtn.setAttribute("aria-selected", next === "search" ? "true" : "false");
        this.weekView.setActive(next === "week");
        this.searchView.setActive(next === "search");
        setVisible(this.weekControlsEl, next === "week" && !this.viewTabsEl.hidden);
    }

    /**
     * @param {boolean} isEnabled
     * @returns {void}
     */
    setAppMode(isEnabled) {
        const enabled = Boolean(isEnabled);
        document.body.classList.toggle("app-mode", enabled);
        document.documentElement.classList.toggle("app-mode", enabled);
    }

    /**
     * @returns {void}
     */
    markSearchDirty() {
        this.searchView.markDirty();
        if (this.state.activeTab === "search") {
            this.searchView.applyFiltersAndRender();
        }
    }

    /**
     * @returns {void}
     */
    refreshRepoLabel() {
        const manifest = this.store.getManifest();
        if (!manifest) {
            this.repoLabelEl.textContent = "";
            return;
        }

        const totals = [];
        totals.push(`${manifest.chunks.length} week file(s)`);
        if (typeof manifest.total_entries === "number" && Number.isFinite(manifest.total_entries)) {
            totals.push(`${manifest.total_entries} entries`);
        }
        if (manifest.generated_at) totals.push(`manifest @ ${manifest.generated_at}`);

        if (this.isLocalMode) {
            this.repoLabelEl.textContent = `Local data • ${totals.join(" • ")}`;
        } else {
            this.repoLabelEl.textContent = `${this.config.owner}/${this.config.repo}@${this.config.ref} • ${totals.join(" • ")}`;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async fetchManifest() {
        this.setProgress(0, 1, this.isLocalMode ? "Loading manifest (local)…" : "Loading manifest…");
        const raw = await this.dataSource.fetchManifest();
        const manifest = Manifest.fromRaw(raw);
        this.store.setManifest(manifest);
        this.refreshRepoLabel();
    }

    /**
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
            this.store.clear();
            this.store.setManifest(manifest);
            this.state.setLatestWeekStart(null);
            this.state.setWeekStart(null);
            this.weekView.setLatestWeekStart(null);
            this.weekView.reset();
            this.searchView.reset();
            return;
        }

        this.setProgress(0, chunkFiles.length, `Loading 0/${chunkFiles.length}…`);

        this.store.clear();
        this.store.setManifest(manifest);

        let cacheHits = 0;
        let downloads = 0;

        for (let i = 0; i < chunkFiles.length; i++) {
            const chunk = chunkFiles[i];
            const key = chunkKey(chunk.year, chunk.week);
            this.setProgress(i, chunkFiles.length, `Loading ${i}/${chunkFiles.length} • ${key}`);

            const mem = this.chunkCache.getMemory(key);
            if (mem && mem.sha === chunk.sha) {
                const weekStart = isoWeekStartFromYearWeek(chunk.year, chunk.week);
                this.store.applyWeekSnapshot(weekStart, mem.entriesRaw || []);
                continue;
            }

            let payload = null;
            const cachedRaw = await this.chunkCache.getRawBySha(chunk.sha);
            if (typeof cachedRaw === "string" && cachedRaw) {
                try {
                    payload = JSON.parse(cachedRaw);
                    cacheHits += 1;
                } catch {
                    await this.chunkCache.deleteRawBySha(chunk.sha);
                    payload = null;
                }
            }

            if (!payload) {
                const raw = await this.dataSource.fetchChunkText(chunk);
                payload = JSON.parse(raw);
                downloads += 1;
                await this.chunkCache.putRawBySha(chunk.sha, raw);
            }

            const entriesRaw = Array.isArray(payload.entries) ? payload.entries : [];
            this.chunkCache.setMemory(key, { sha: chunk.sha, entriesRaw });
            const weekStart = isoWeekStartFromYearWeek(chunk.year, chunk.week);
            this.store.applyWeekSnapshot(weekStart, entriesRaw);
        }

        const cacheSummary = ` • cached ${cacheHits} • downloaded ${downloads}`;
        this.setProgress(chunkFiles.length, chunkFiles.length, `Loaded ${chunkFiles.length}/${chunkFiles.length} week files${cacheSummary}`);

        this.store.recomputeNextEntryId();
        const latest = this.store.getLatestWeekStart();
        this.state.setLatestWeekStart(latest);
        if (!this.state.weekStart && latest) {
            this.state.setWeekStart(latest);
        }
        this.weekView.setLatestWeekStart(this.state.latestWeekStart);
        if (this.state.weekStart) {
            this.weekView.setWeekStart(this.state.weekStart);
        }

        this.searchView.markDirty();
        this.searchView.applyFiltersAndRender();
    }

    /**
     * @returns {Promise<void>}
     */
    async reloadData() {
        this.setBusy(true);
        this.setError(this.dataErrorEl, "");
        this.entriesTbody.innerHTML = "";
        this.statsEl.textContent = "";
        this.weekView.reset();
        try {
            await this.fetchManifest();
            await this.loadAllChunks();
        } catch (err) {
            this.setError(this.dataErrorEl, safeText(err));
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * @param {string} token
     * @returns {Promise<void>}
     */
    async connectWithToken(token) {
        this.token = token;
        this.state.setToken(token);
        this.dataSource = new GitHubDataSource(this.config, token);
        this.weekView.setDataSource(this.dataSource);
        this.setAuthStatus("Connecting…");
        this.setBusy(true);
        try {
            const { repoInfo, userInfo } = await this.dataSource.checkConnection();
            const repoLabel = repoInfo?.full_name ? repoInfo.full_name : `${this.config.owner}/${this.config.repo}`;
            this.state.ghUser = userInfo;
            this.setAuthStatus(userInfo?.login ? `Logged in as ${userInfo.login}` : `Connected to ${repoLabel}`);
            setVisible(this.logoutBtn, true);
            setVisible(this.reloadDataBtn, true);
            setVisible(this.loginSection, false);
            setVisible(this.appSection, true);
            setVisible(this.viewTabsEl, true);
            this.setAppMode(true);
            this.setTab(this.state.activeTab);
            await this.reloadData();
        } catch (err) {
            this.state.ghUser = null;
            this.setAuthStatus("Not logged in");
            throw err;
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * @returns {void}
     */
    logout() {
        this.token = "";
        this.state.setToken("");
        this.state.ghUser = null;
        this.state.setWeekStart(null);
        this.state.setLatestWeekStart(null);
        this.store.clear();
        this.chunkCache.clearMemory();
        this.weekView.reset();
        this.searchView.reset();
        this.setProgress(0, 1, "");
        this.setAuthStatus("Not logged in");
        this.repoLabelEl.textContent = "";
        setVisible(this.viewTabsEl, false);
        setVisible(this.weekControlsEl, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.logoutBtn, false);
        setVisible(this.appSection, false);
        setVisible(this.loginSection, true);
        this.setAppMode(false);
        this.configService.saveToken("", false);
    }
}

const app = new App();
app.start();
