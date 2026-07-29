import { AppState } from "./appstate.js";
import { ChunkCache, DraftJournal } from "./cache.js";
import { ConfigService, DEFAULT_CONFIG } from "./config.js";
import { GitHubDataSource, LocalDataSource } from "./datasource.js";
import { EntryStore, TodoStore } from "./store.js";
import { SearchView } from "./search.view.js";
import { TodoView } from "./todo.view.js";
import { WeekView } from "./week.view.js";
import {
    chunkKey,
    getRequiredElement,
    getSourceMode,
    isoWeekStartFromYearWeek,
    safeText,
    setVisible,
    TimeContext,
    utcNowIso,
} from "./utils.js";
import { Manifest, ProjectList, TodoList, WeekRequirements } from "./model.js";

/**
 * @typedef {Object} ProjectDialogOptions
 * @property {import("./store.js").EntryStore} store
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {Object} elements
 * @property {HTMLDialogElement} elements.dialog
 * @property {HTMLFormElement} elements.form
 * @property {HTMLButtonElement} elements.closeBtn
 * @property {HTMLButtonElement} elements.cancelBtn
 * @property {HTMLButtonElement} elements.addBtn
 * @property {HTMLElement} elements.list
 * @property {(message: string, timeout?: number, tone?: "error" | "success") => void} onToast
 * @property {(isBusy: boolean) => void} onBusy
 * @property {(projectList: import("./model.js").ProjectList) => void} onProjectsSaved
 */

/**
 * Manages the project list dialog UI and persistence.
 * Reads and writes projects.json using the shared save pipeline.
 */
class ProjectDialog {
    /**
     * Captures references to UI elements and callback hooks.
     * Keeps the main UI flow and data loading coordinated.
     * @param {ProjectDialogOptions} options
     */
    constructor(options) {
        this.store = options.store;
        this.dataSource = options.dataSource;
        this.dialog = options.elements.dialog;
        this.form = options.elements.form;
        this.closeBtn = options.elements.closeBtn;
        this.cancelBtn = options.elements.cancelBtn;
        this.addBtn = options.elements.addBtn;
        this.listEl = options.elements.list;
        this.onToast = options.onToast;
        this.onBusy = options.onBusy;
        this.onProjectsSaved = options.onProjectsSaved;

        this.bindEvents();
    }

    /**
     * Updates the data source after login or mode changes.
     * Keeps the main UI flow and data loading coordinated.
     * @param {import("./datasource.js").DataSource} dataSource
     * @returns {void}
     */
    setDataSource(dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Wires click and submit handlers for dialog controls.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    bindEvents() {
        this.closeBtn.addEventListener("click", () => this.close());
        this.cancelBtn.addEventListener("click", () => this.close());
        this.dialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.close();
        });
        this.addBtn.addEventListener("click", () => this.addProjectRow());
        this.form.addEventListener("submit", (ev) => this.handleSubmit(ev));
    }

    /**
     * Populates the list and opens the modal dialog.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    open() {
        this.renderList();
        if (!this.dialog.open) this.dialog.showModal();
        queueMicrotask(() => {
            const input = this.listEl.querySelector(".project-name");
            if (input instanceof HTMLInputElement) input.focus();
        });
    }

    /**
     * Closes the dialog if it is currently open.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    close() {
        if (this.dialog.open) this.dialog.close();
    }

    /**
     * Rebuilds the project rows from the store state.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    renderList() {
        this.listEl.innerHTML = "";
        const projects = this.store.getProjects();
        const sorted = projects.slice().sort((a, b) => {
            if (a.archived !== b.archived) return a.archived ? 1 : -1;
            return a.name.localeCompare(b.name);
        });

        const frag = document.createDocumentFragment();
        for (const project of sorted) {
            frag.append(this.buildProjectRow(project));
        }
        this.listEl.append(frag);
    }

    /**
     * Adds a blank project row for quick creation.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    addProjectRow() {
        const row = this.buildProjectRow({
            name: "",
            color: "#7c5cff",
            billable: false,
            archived: false,
        });
        this.listEl.append(row);
        const input = row.querySelector(".project-name");
        if (input instanceof HTMLInputElement) input.focus();
    }

    /**
     * Builds a project row DOM element with editable controls.
     * Keeps the main UI flow and data loading coordinated.
     * @param {{name: string, color: string, billable: boolean, archived: boolean}} project
     * @returns {HTMLElement}
     */
    buildProjectRow(project) {
        const row = document.createElement("div");
        row.className = "project-row";

        const nameWrap = document.createElement("label");
        nameWrap.className = "project-field";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "project-name";
        nameInput.value = project.name || "";
        nameInput.spellcheck = false;
        nameWrap.append(nameSpan, nameInput);

        const colorWrap = document.createElement("label");
        colorWrap.className = "project-field";
        const colorSpan = document.createElement("span");
        colorSpan.textContent = "Color";
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "project-color";
        colorInput.value = /^#[0-9a-f]{6}$/i.test(project.color || "") ? project.color : "#7c5cff";
        colorWrap.append(colorSpan, colorInput);

        const billableWrap = document.createElement("label");
        billableWrap.className = "checkbox project-field";
        const billableInput = document.createElement("input");
        billableInput.type = "checkbox";
        billableInput.className = "project-billable";
        billableInput.checked = project.billable === true;
        const billableSpan = document.createElement("span");
        billableSpan.textContent = "Billable";
        billableWrap.append(billableInput, billableSpan);

        const archivedWrap = document.createElement("label");
        archivedWrap.className = "checkbox project-field";
        const archivedInput = document.createElement("input");
        archivedInput.type = "checkbox";
        archivedInput.className = "project-archived";
        archivedInput.checked = project.archived === true;
        const archivedSpan = document.createElement("span");
        archivedSpan.textContent = "Archived";
        archivedWrap.append(archivedInput, archivedSpan);

        row.append(nameWrap, colorWrap, billableWrap, archivedWrap);
        return row;
    }

    /**
     * Reads and validates project rows from the dialog.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {{projects: Array<{name: string, color: string, billable: boolean, archived: boolean}>, error: string | null}}
     */
    collectProjects() {
        const rows = Array.from(this.listEl.querySelectorAll(".project-row"));
        const projects = [];
        const seen = new Set();

        for (const row of rows) {
            const nameInput = row.querySelector(".project-name");
            const colorInput = row.querySelector(".project-color");
            const billableInput = row.querySelector(".project-billable");
            const archivedInput = row.querySelector(".project-archived");
            if (!(nameInput instanceof HTMLInputElement)) continue;
            if (!(colorInput instanceof HTMLInputElement)) continue;
            if (!(billableInput instanceof HTMLInputElement)) continue;
            if (!(archivedInput instanceof HTMLInputElement)) continue;

            const name = nameInput.value.trim();
            if (!name) {
                return { projects: [], error: "Every project needs a name." };
            }
            const key = name.toLowerCase();
            if (seen.has(key)) {
                return { projects: [], error: `Duplicate project name: ${name}` };
            }
            seen.add(key);

            const color = colorInput.value.trim();
            if (!/^#[0-9a-f]{6}$/i.test(color)) {
                return { projects: [], error: `Invalid color for ${name}.` };
            }

            projects.push({
                name,
                color,
                billable: billableInput.checked,
                archived: archivedInput.checked,
            });
        }

        return { projects, error: null };
    }

    /**
     * Validates input and saves projects.json through the data source.
     * Keeps the main UI flow and data loading coordinated.
     * @param {Event} ev
     * @returns {Promise<void>}
     */
    async handleSubmit(ev) {
        ev.preventDefault();
        const { projects, error } = this.collectProjects();
        if (error) {
            this.onToast(error, 4000);
            return;
        }

        const payload = {
            generated_at: utcNowIso(),
            projects,
            schema_version: 1,
        };
        const projectList = ProjectList.fromRaw(payload);
        const content = projectList.toJson();

        this.onBusy(true);
        try {
            await this.dataSource.saveFiles([{ path: "data/projects.json", content }], "Update projects");
            this.store.setProjectList(projectList);
            this.onProjectsSaved(projectList);
            this.close();
        } catch (err) {
            this.onToast(String(err), 5000);
        } finally {
            this.onBusy(false);
        }
    }
}

/**
 * Main application controller.
 * Coordinates data loading, UI wiring, and view lifecycle.
 */
class App {
    /**
     * Initializes state, data sources, and UI element references.
     * Does not perform network requests until start() is called.
     */
    constructor() {
        this.configService = new ConfigService();
        this.config = this.configService.loadConfig();
        this.token = this.configService.loadToken();
        this.isLocalMode = getSourceMode() === "local";
        this.state = new AppState(this.config, this.isLocalMode);
        this.state.setToken(this.token);
        this.timeContext = new TimeContext(this.config.timezone);
        this.store = new EntryStore(this.timeContext);
        this.todoStore = new TodoStore(this.store);
        this.chunkCache = new ChunkCache();
        this.draftJournal = new DraftJournal();

        this.dataSource = this.isLocalMode ? new LocalDataSource() : new GitHubDataSource(this.config, this.token);

        this.authStatusEl = getRequiredElement("authStatus", HTMLElement);
        this.logoutBtn = getRequiredElement("logoutBtn", HTMLButtonElement);
        this.loginSection = getRequiredElement("loginSection", HTMLElement);
        this.loginForm = getRequiredElement("loginForm", HTMLFormElement);
        this.loginErrorEl = getRequiredElement("loginError", HTMLElement);
        this.clearSavedBtn = getRequiredElement("clearSavedBtn", HTMLButtonElement);

        this.topbarEl = getRequiredElement("topbar", HTMLElement);
        this.appMenuRootEl = getRequiredElement("appMenuRoot", HTMLElement);
        this.menuBtn = getRequiredElement("menuBtn", HTMLButtonElement);
        this.appMenuPanelEl = getRequiredElement("appMenuPanel", HTMLElement);
        this.menuWeekBtn = getRequiredElement("menuWeekBtn", HTMLButtonElement);
        this.menuTodoBtn = getRequiredElement("menuTodoBtn", HTMLButtonElement);
        this.menuSearchBtn = getRequiredElement("menuSearchBtn", HTMLButtonElement);
        this.weekControlsEl = getRequiredElement("weekControls", HTMLElement);
        this.projectsBtn = getRequiredElement("projectsBtn", HTMLButtonElement);

        this.appSection = getRequiredElement("appSection", HTMLElement);
        this.loadingSection = getRequiredElement("loadingSection", HTMLElement);
        this.loadingErrorEl = getRequiredElement("loadingError", HTMLElement);
        this.loadingActionsEl = getRequiredElement("loadingActions", HTMLElement);
        this.loadingRetryBtn = getRequiredElement("loadingRetryBtn", HTMLButtonElement);
        this.loadingLogoutBtn = getRequiredElement("loadingLogoutBtn", HTMLButtonElement);
        this.repoLabelEl = getRequiredElement("repoLabel", HTMLElement);
        this.reloadDataBtn = getRequiredElement("reloadDataBtn", HTMLButtonElement);
        this.loadProgressEl = getRequiredElement("loadProgress", HTMLProgressElement);
        this.loadProgressLabelEl = getRequiredElement("loadProgressLabel", HTMLElement);
        this.dataErrorEl = getRequiredElement("dataError", HTMLElement);

        this.weekViewSection = getRequiredElement("weekViewSection", HTMLElement);
        this.weekLabelEl = getRequiredElement("weekLabel", HTMLElement);
        this.weekBillableEl = getRequiredElement("weekBillable", HTMLElement);
        this.weekReqBtn = getRequiredElement("weekReqBtn", HTMLButtonElement);
        this.weekScrollEl = getRequiredElement("weekScroll", HTMLElement);
        this.prevWeekBtn = getRequiredElement("prevWeekBtn", HTMLButtonElement);
        this.nextWeekBtn = getRequiredElement("nextWeekBtn", HTMLButtonElement);
        this.latestWeekBtn = getRequiredElement("latestWeekBtn", HTMLButtonElement);
        this.zoomInput = getRequiredElement("zoomInput", HTMLInputElement);
        this.editorBadgeEl = getRequiredElement("editorBadge", HTMLElement);

        this.entryDialog = getRequiredElement("entryDialog", HTMLDialogElement);
        this.entryForm = getRequiredElement("entryForm", HTMLFormElement);
        this.entryCloseBtn = getRequiredElement("entryCloseBtn", HTMLButtonElement);
        this.entryCancelBtn = getRequiredElement("entryCancelBtn", HTMLButtonElement);
        this.entryMetaEl = getRequiredElement("entryMeta", HTMLElement);
        this.entryProjectInput = getRequiredElement("entryProject", HTMLInputElement);
        this.entryProjectListEl = getRequiredElement("entryProjectList", HTMLDataListElement);
        this.entryDescInput = getRequiredElement("entryDesc", HTMLTextAreaElement);
        this.entryDescSuggestionsEl = getRequiredElement("entryDescSuggestions", HTMLElement);
        this.projectsDialog = getRequiredElement("projectsDialog", HTMLDialogElement);
        this.projectsForm = getRequiredElement("projectsForm", HTMLFormElement);
        this.projectsCloseBtn = getRequiredElement("projectsCloseBtn", HTMLButtonElement);
        this.projectsCancelBtn = getRequiredElement("projectsCancelBtn", HTMLButtonElement);
        this.projectsOkBtn = getRequiredElement("projectsOkBtn", HTMLButtonElement);
        this.addProjectBtn = getRequiredElement("addProjectBtn", HTMLButtonElement);
        this.projectsList = getRequiredElement("projectsList", HTMLElement);
        this.weekReqDialog = getRequiredElement("weekReqDialog", HTMLDialogElement);
        this.weekReqForm = getRequiredElement("weekReqForm", HTMLFormElement);
        this.weekReqCloseBtn = getRequiredElement("weekReqCloseBtn", HTMLButtonElement);
        this.weekReqCancelBtn = getRequiredElement("weekReqCancelBtn", HTMLButtonElement);
        this.weekReqOkBtn = getRequiredElement("weekReqOkBtn", HTMLButtonElement);
        this.weekReqMeta = getRequiredElement("weekReqMeta", HTMLElement);
        this.weekReqHours = getRequiredElement("weekReqHours", HTMLInputElement);
        this.weekReqComment = getRequiredElement("weekReqComment", HTMLTextAreaElement);

        this.searchViewEl = getRequiredElement("searchView", HTMLElement);
        this.searchInput = getRequiredElement("searchInput", HTMLInputElement);
        this.projectSelect = getRequiredElement("projectSelect", HTMLSelectElement);
        this.fromDateInput = getRequiredElement("fromDate", HTMLInputElement);
        this.toDateInput = getRequiredElement("toDate", HTMLInputElement);
        this.maxRowsInput = getRequiredElement("maxRows", HTMLInputElement);
        this.sortSelect = getRequiredElement("sortSelect", HTMLSelectElement);
        this.statsEl = getRequiredElement("stats", HTMLElement);
        this.entriesTbody = getRequiredElement("entriesTbody", HTMLTableSectionElement);

        this.todoViewEl = getRequiredElement("todoView", HTMLElement);
        this.todoListEl = getRequiredElement("todoList", HTMLElement);
        this.todoAddBtn = getRequiredElement("todoAddBtn", HTMLButtonElement);
        this.todoSaveBtn = getRequiredElement("todoSaveBtn", HTMLButtonElement);
        this.todoSearchInput = getRequiredElement("todoSearch", HTMLInputElement);
        this.todoFilterSelect = getRequiredElement("todoFilter", HTMLSelectElement);
        this.todoProjectFilterSelect = getRequiredElement("todoProjectFilter", HTMLSelectElement);
        this.todoStatsEl = getRequiredElement("todoStats", HTMLElement);
        this.todoDialog = getRequiredElement("todoDialog", HTMLDialogElement);
        this.todoForm = getRequiredElement("todoForm", HTMLFormElement);
        this.todoDialogTitleEl = getRequiredElement("todoDialogTitle", HTMLElement);
        this.todoCloseBtn = getRequiredElement("todoCloseBtn", HTMLButtonElement);
        this.todoCancelBtn = getRequiredElement("todoCancelBtn", HTMLButtonElement);
        this.todoContentInput = getRequiredElement("todoContent", HTMLInputElement);
        this.todoDescriptionInput = getRequiredElement("todoDescription", HTMLTextAreaElement);
        this.todoProjectSelect = getRequiredElement("todoProject", HTMLSelectElement);
        this.todoSectionInput = getRequiredElement("todoSection", HTMLInputElement);
        this.todoDueDateInput = getRequiredElement("todoDueDate", HTMLInputElement);
        this.todoDueTimeInput = getRequiredElement("todoDueTime", HTMLInputElement);
        this.todoRecurrenceInput = getRequiredElement("todoRecurrence", HTMLInputElement);
        this.todoPrioritySelect = getRequiredElement("todoPriority", HTMLSelectElement);
        this.todoLabelsInput = getRequiredElement("todoLabels", HTMLInputElement);
        this.todoDialogMetaEl = getRequiredElement("todoDialogMeta", HTMLElement);

        this.ownerInput = getRequiredElement("ownerInput", HTMLInputElement);
        this.repoInput = getRequiredElement("repoInput", HTMLInputElement);
        this.refInput = getRequiredElement("refInput", HTMLInputElement);
        this.tokenInput = getRequiredElement("tokenInput", HTMLInputElement);
        this.rememberInput = getRequiredElement("rememberInput", HTMLInputElement);

        this.weekView = new WeekView({
            store: this.store,
            chunkCache: this.chunkCache,
            draftJournal: this.draftJournal,
            draftNamespace: this.buildDraftNamespace(),
            appState: this.state,
            timeContext: this.timeContext,
            dataSource: this.dataSource,
            elements: {
                weekViewSection: this.weekViewSection,
                weekControls: this.weekControlsEl,
                weekLabel: this.weekLabelEl,
                weekBillable: this.weekBillableEl,
                weekReqBtn: this.weekReqBtn,
                weekScroll: this.weekScrollEl,
                prevWeekBtn: this.prevWeekBtn,
                nextWeekBtn: this.nextWeekBtn,
                latestWeekBtn: this.latestWeekBtn,
                zoomInput: this.zoomInput,
                editorBadge: this.editorBadgeEl,
                weekReqDialog: this.weekReqDialog,
                weekReqForm: this.weekReqForm,
                weekReqCloseBtn: this.weekReqCloseBtn,
                weekReqCancelBtn: this.weekReqCancelBtn,
                weekReqOkBtn: this.weekReqOkBtn,
                weekReqMeta: this.weekReqMeta,
                weekReqHours: this.weekReqHours,
                weekReqComment: this.weekReqComment,
                entryDialog: this.entryDialog,
                entryForm: this.entryForm,
                entryCloseBtn: this.entryCloseBtn,
                entryCancelBtn: this.entryCancelBtn,
                entryMeta: this.entryMetaEl,
                entryProject: this.entryProjectInput,
                entryProjectList: this.entryProjectListEl,
                entryDesc: this.entryDescInput,
                entryDescSuggestions: this.entryDescSuggestionsEl,
            },
            onToast: (message, timeout, tone) => this.toast(message, timeout, tone),
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
            },
            onJumpToEntry: (entry) => {
                if (this.appSection.hidden) return;
                this.setTab("week");
                this.weekView.jumpToEntry(entry);
            },
        });

        this.todoView = new TodoView({
            store: this.todoStore,
            projectStore: this.store,
            dataSource: this.dataSource,
            draftJournal: this.draftJournal,
            draftNamespace: this.buildDraftNamespace(),
            timeContext: this.timeContext,
            elements: {
                todoView: this.todoViewEl,
                todoList: this.todoListEl,
                todoAddBtn: this.todoAddBtn,
                todoSaveBtn: this.todoSaveBtn,
                todoSearch: this.todoSearchInput,
                todoFilter: this.todoFilterSelect,
                todoProjectFilter: this.todoProjectFilterSelect,
                todoStats: this.todoStatsEl,
                todoDialog: this.todoDialog,
                todoForm: this.todoForm,
                todoDialogTitle: this.todoDialogTitleEl,
                todoCloseBtn: this.todoCloseBtn,
                todoCancelBtn: this.todoCancelBtn,
                todoContent: this.todoContentInput,
                todoDescription: this.todoDescriptionInput,
                todoProject: this.todoProjectSelect,
                todoSection: this.todoSectionInput,
                todoDueDate: this.todoDueDateInput,
                todoDueTime: this.todoDueTimeInput,
                todoRecurrence: this.todoRecurrenceInput,
                todoPriority: this.todoPrioritySelect,
                todoLabels: this.todoLabelsInput,
                todoDialogMeta: this.todoDialogMetaEl,
                editorBadge: this.editorBadgeEl,
            },
            onToast: (message, timeout, tone) => this.toast(message, timeout, tone),
            onBusy: (busy) => this.setBusy(busy),
            onSaved: () => this.refreshRepoLabel(),
        });

        this.projectDialog = new ProjectDialog({
            store: this.store,
            dataSource: this.dataSource,
            elements: {
                dialog: this.projectsDialog,
                form: this.projectsForm,
                closeBtn: this.projectsCloseBtn,
                cancelBtn: this.projectsCancelBtn,
                addBtn: this.addProjectBtn,
                list: this.projectsList,
            },
            onToast: (message, timeout, tone) => this.toast(message, timeout, tone),
            onBusy: (busy) => this.setBusy(busy),
            onProjectsSaved: (projectList) => this.handleProjectsSaved(projectList),
        });

        this.toastTimer = 0;
        this.resizeRaf = 0;
    }

    /**
     * Builds the IndexedDB namespace used for unsaved week drafts.
     * Browser origins already isolate local servers, while GitHub mode additionally separates owner, repository, and branch.
     * @returns {string}
     */
    buildDraftNamespace() {
        if (this.isLocalMode) return "local";
        const owner = String(this.config.owner || "").trim();
        const repo = String(this.config.repo || "").trim();
        const ref = String(this.config.ref || "").trim();
        return `github:${owner}/${repo}@${ref}`;
    }

    /**
     * Boots the application and triggers the initial load flow.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    start() {
        this.ownerInput.value = this.config.owner;
        this.repoInput.value = this.config.repo;
        this.refInput.value = this.config.ref;
        this.rememberInput.checked = this.configService.isTokenRemembered();

        this.loginForm.addEventListener("submit", (ev) => this.handleLoginSubmit(ev));
        this.clearSavedBtn.addEventListener("click", () => this.handleClearSaved());
        this.menuBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.setMenuOpen(this.appMenuPanelEl.hidden);
        });
        this.appMenuPanelEl.addEventListener("keydown", (ev) => this.handleMenuKeydown(ev));
        this.appMenuRootEl.addEventListener("focusout", () => {
            window.setTimeout(() => {
                if (!this.appMenuRootEl.contains(document.activeElement)) this.closeMenu();
            }, 0);
        });
        this.menuWeekBtn.addEventListener("click", () => {
            this.setTab("week");
            this.closeMenu();
        });
        this.menuTodoBtn.addEventListener("click", () => {
            this.setTab("todos");
            this.closeMenu();
        });
        this.menuSearchBtn.addEventListener("click", () => {
            this.setTab("search");
            this.closeMenu();
            queueMicrotask(() => this.searchInput.focus());
        });
        this.projectsBtn.addEventListener("click", () => {
            this.closeMenu();
            this.projectDialog.open();
        });
        this.logoutBtn.addEventListener("click", () => this.logout());
        this.reloadDataBtn.addEventListener("click", () => {
            this.closeMenu();
            void this.reloadData();
        });
        this.loadingRetryBtn.addEventListener("click", () => void this.reloadData());
        this.loadingLogoutBtn.addEventListener("click", () => this.logout());

        document.addEventListener("keydown", (ev) => this.handleGlobalKeydown(ev));
        document.addEventListener("click", (ev) => this.handleDocumentClick(ev));
        window.addEventListener("resize", () => this.handleResize());

        this.setProgress(0, 1, "");
        setVisible(this.topbarEl, false);
        setVisible(this.loadingSection, false);

        if (this.isLocalMode) {
            this.setAuthStatus("Local mode");
            setVisible(this.logoutBtn, false);
            setVisible(this.reloadDataBtn, true);
            setVisible(this.projectsBtn, true);
            this.showLoadingScreen("Preparing local data…");
            void this.reloadData();
            return;
        }

        setVisible(this.logoutBtn, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.projectsBtn, false);

        if (this.token) {
            this.showLoadingScreen("Connecting to GitHub…");
            this.connectWithToken(this.token).catch((err) => {
                this.showLoginScreen();
                this.setError(this.loginErrorEl, safeText(err));
            });
        } else {
            this.setAuthStatus("Not logged in");
            this.showLoginScreen();
        }
    }

    /**
     * Opens or closes the application menu and synchronizes accessibility state.
     * The menu is anchored to the top-left trigger and is unavailable outside the initialized application screen.
     * @param {boolean} isOpen
     * @returns {void}
     */
    setMenuOpen(isOpen) {
        const open = Boolean(isOpen) && !this.topbarEl.hidden;
        setVisible(this.appMenuPanelEl, open);
        this.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
        this.menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        if (open) {
            const activeItem =
                this.state.activeTab === "search"
                    ? this.menuSearchBtn
                    : this.state.activeTab === "todos"
                      ? this.menuTodoBtn
                      : this.menuWeekBtn;
            queueMicrotask(() => activeItem.focus());
        }
    }

    /**
     * Closes the application menu without changing the active view.
     * This is shared by menu actions, outside clicks, Escape handling, and screen transitions.
     * @returns {void}
     */
    closeMenu() {
        this.setMenuOpen(false);
    }

    /**
     * Dismisses the application menu when a pointer action lands outside it.
     * Keeping this behavior in App avoids global event knowledge inside individual views.
     * @param {MouseEvent} ev
     * @returns {void}
     */
    handleDocumentClick(ev) {
        if (this.appMenuPanelEl.hidden) return;
        const target = ev.target;
        if (target instanceof Node && this.appMenuRootEl.contains(target)) return;
        this.closeMenu();
    }

    /**
     * Moves keyboard focus through visible menu commands with arrow, Home, and End keys.
     * Enter and Space retain native button behavior, while Escape is handled by the global shortcut dispatcher.
     * @param {KeyboardEvent} ev
     * @returns {void}
     */
    handleMenuKeydown(ev) {
        const supportedKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
        if (!supportedKeys.has(ev.key)) return;
        const items = Array.from(this.appMenuPanelEl.querySelectorAll("button[role='menuitem']")).filter(
            (item) => item instanceof HTMLButtonElement && !item.hidden && !item.disabled,
        );
        if (!items.length) return;

        ev.preventDefault();
        ev.stopPropagation();
        const activeIndex = items.indexOf(document.activeElement);
        let nextIndex = 0;
        if (ev.key === "End") {
            nextIndex = items.length - 1;
        } else if (ev.key === "ArrowDown") {
            nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
        } else if (ev.key === "ArrowUp") {
            nextIndex = activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length;
        }
        const nextItem = items[nextIndex];
        if (nextItem instanceof HTMLButtonElement) nextItem.focus();
    }

    /**
     * Shows the login form and hides both initialized and loading application surfaces.
     * This is the stable unauthenticated state used at startup, after connection failures, and after logout.
     * @returns {void}
     */
    showLoginScreen() {
        this.closeMenu();
        document.body.classList.remove("app-ready");
        setVisible(this.topbarEl, false);
        setVisible(this.loadingSection, false);
        setVisible(this.appSection, false);
        setVisible(this.loginSection, true);
        this.setAppMode(false);
    }

    /**
     * Shows the dedicated initialization surface while repository data is being loaded.
     * Progress and recoverable errors remain isolated here so the compact top bar only represents a ready application.
     * @param {string} label
     * @returns {void}
     */
    showLoadingScreen(label) {
        this.closeMenu();
        document.body.classList.remove("app-ready");
        setVisible(this.topbarEl, false);
        setVisible(this.loginSection, false);
        setVisible(this.appSection, false);
        setVisible(this.loadingSection, true);
        setVisible(this.loadingActionsEl, false);
        this.setError(this.loadingErrorEl, "");
        this.loadingSection.setAttribute("aria-busy", "true");
        this.setAppMode(true);
        this.setProgress(0, 1, label);
    }

    /**
     * Reveals the initialized application and restores the previously active Week or Search view.
     * Called only after all required repository chunks and supporting configuration have been loaded.
     * @returns {void}
     */
    showApplicationScreen() {
        document.body.classList.add("app-ready");
        setVisible(this.loginSection, false);
        setVisible(this.loadingSection, false);
        setVisible(this.topbarEl, true);
        setVisible(this.appSection, true);
        this.loadingSection.setAttribute("aria-busy", "false");
        this.setAppMode(true);
        this.setTab(this.state.activeTab);
    }

    /**
     * Keeps the loading screen visible and presents retry controls after initialization fails.
     * GitHub mode also offers a route back to login, while local mode can only retry the local server request.
     * @param {string} message
     * @returns {void}
     */
    showLoadingError(message) {
        this.loadingSection.setAttribute("aria-busy", "false");
        this.setError(this.loadingErrorEl, message);
        setVisible(this.loadingActionsEl, true);
        setVisible(this.loadingLogoutBtn, !this.isLocalMode);
        queueMicrotask(() => this.loadingRetryBtn.focus());
    }

    /**
     * Handles global keyboard shortcuts and delegates to WeekView.
     * Keeps the main UI flow and data loading coordinated.
     * @param {KeyboardEvent} ev
     * @returns {void}
     */
    handleGlobalKeydown(ev) {
        if (!this.appMenuPanelEl.hidden) {
            if (ev.key === "Escape") {
                ev.preventDefault();
                this.closeMenu();
                this.menuBtn.focus();
            }
            return;
        }
        if (document.querySelector("dialog[open]")) {
            if ((ev.ctrlKey || ev.metaKey) && String(ev.key || "").toLowerCase() === "s") {
                ev.preventDefault();
            }
            return;
        }
        if (ev.ctrlKey && !ev.altKey && !this.appSection.hidden) {
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

            if (keyLower === "t") {
                ev.preventDefault();
                this.setTab("todos");
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

        if (this.state.activeTab === "todos" && this.todoView.handleKeydown(ev)) return;
        this.weekView.handleKeydown(ev);
    }

    /**
     * Debounces resize handling for the week view.
     * Keeps the main UI flow and data loading coordinated.
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
     * Validates login input and starts the GitHub connection flow.
     * Keeps the main UI flow and data loading coordinated.
     * @param {Event} ev
     * @returns {Promise<void>}
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
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
        this.tokenInput.value = "";

        try {
            await this.connectWithToken(tok);
        } catch (err) {
            this.setError(this.loginErrorEl, safeText(err));
        }
    }

    /**
     * Clears persisted config/token values and resets local state.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    handleClearSaved() {
        this.configService.clearSaved();
        this.chunkCache.clearAll();
        this.config = { ...DEFAULT_CONFIG };
        this.state.setConfig(this.config);
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
        this.ownerInput.value = this.config.owner;
        this.repoInput.value = this.config.repo;
        this.refInput.value = this.config.ref;
        this.tokenInput.value = "";
        this.rememberInput.checked = false;
        this.setAuthStatus("Cleared");
    }

    /**
     * Updates the authentication status display.
     * Keeps the main UI flow and data loading coordinated.
     * @param {string} text
     * @returns {void}
     */
    setAuthStatus(text) {
        this.authStatusEl.textContent = text;
    }

    /**
     * Writes an error message into the provided element.
     * Keeps the main UI flow and data loading coordinated.
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
     * Shows a temporary toast-style message with optional success styling.
     * Keeps the main UI flow and data loading coordinated.
     * @param {string} message
     * @param {number} timeoutMs
     * @param {"error" | "success"} [tone]
     * @returns {void}
     */
    toast(message, timeoutMs = 2400, tone = "error") {
        window.clearTimeout(this.toastTimer);
        if (!message) {
            this.dataErrorEl.classList.remove("is-success");
            this.setError(this.dataErrorEl, "");
            return;
        }
        this.dataErrorEl.classList.toggle("is-success", tone === "success");
        this.setError(this.dataErrorEl, String(message));
        this.toastTimer = window.setTimeout(() => {
            this.dataErrorEl.classList.remove("is-success");
            this.setError(this.dataErrorEl, "");
        }, Math.max(400, timeoutMs));
    }

    /**
     * Enables or disables UI controls during network work.
     * Keeps the main UI flow and data loading coordinated.
     * @param {boolean} isBusy
     * @returns {void}
     */
    setBusy(isBusy) {
        this.logoutBtn.disabled = isBusy;
        this.reloadDataBtn.disabled = isBusy;
        this.projectsBtn.disabled = isBusy;
        this.menuBtn.disabled = isBusy;
        this.menuWeekBtn.disabled = isBusy;
        this.menuTodoBtn.disabled = isBusy;
        this.menuSearchBtn.disabled = isBusy;
        this.prevWeekBtn.disabled = isBusy;
        this.nextWeekBtn.disabled = isBusy;
        this.latestWeekBtn.disabled = isBusy;
        this.zoomInput.disabled = isBusy;
        this.weekReqBtn.disabled = isBusy;
        this.searchInput.disabled = isBusy;
        this.projectSelect.disabled = isBusy;
        this.fromDateInput.disabled = isBusy;
        this.toDateInput.disabled = isBusy;
        this.maxRowsInput.disabled = isBusy;
        this.sortSelect.disabled = isBusy;
        this.projectsCloseBtn.disabled = isBusy;
        this.projectsCancelBtn.disabled = isBusy;
        this.projectsOkBtn.disabled = isBusy;
        this.addProjectBtn.disabled = isBusy;
        this.weekReqCloseBtn.disabled = isBusy;
        this.weekReqCancelBtn.disabled = isBusy;
        this.weekReqOkBtn.disabled = isBusy;
        this.weekReqHours.disabled = isBusy;
        this.weekReqComment.disabled = isBusy;
        this.todoView.setBusy(isBusy);
    }

    /**
     * Updates the progress bar and label for load operations.
     * Keeps the main UI flow and data loading coordinated.
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
     * Switches between Week, TODO, and Search tabs.
     * Keeps the main UI flow and data loading coordinated.
     * @param {"week" | "todos" | "search"} tab
     * @returns {void}
     */
    setTab(tab) {
        const next = tab === "search" || tab === "todos" ? tab : "week";
        this.state.setActiveTab(next);
        for (const [button, isCurrent] of [
            [this.menuWeekBtn, next === "week"],
            [this.menuTodoBtn, next === "todos"],
            [this.menuSearchBtn, next === "search"],
        ]) {
            if (!(button instanceof HTMLButtonElement)) continue;
            if (isCurrent) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        }
        this.weekView.setActive(next === "week");
        this.todoView.setActive(next === "todos");
        this.searchView.setActive(next === "search");
        setVisible(this.weekControlsEl, next === "week" && !this.topbarEl.hidden);
        setVisible(this.editorBadgeEl, next !== "search" && !this.topbarEl.hidden);
    }

    /**
     * Toggles app-mode layout behavior on the document.
     * Keeps the main UI flow and data loading coordinated.
     * @param {boolean} isEnabled
     * @returns {void}
     */
    setAppMode(isEnabled) {
        const enabled = Boolean(isEnabled);
        document.body.classList.toggle("app-mode", enabled);
        document.documentElement.classList.toggle("app-mode", enabled);
    }

    /**
     * Marks search data dirty and refreshes when visible.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    markSearchDirty() {
        this.searchView.markDirty();
        if (this.state.activeTab === "search") {
            this.searchView.applyFiltersAndRender();
        }
    }

    /**
     * Applies a newly saved project list to the UI.
     * Keeps the main UI flow and data loading coordinated.
     * @param {ProjectList} projectList
     * @returns {void}
     */
    handleProjectsSaved(projectList) {
        this.weekView.setProjects(projectList);
        this.todoView.setProjects();
        this.markSearchDirty();
    }

    /**
     * Updates the footer badge with repository and manifest info.
     * Keeps the main UI flow and data loading coordinated.
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
        totals.push(`${this.todoStore.getTodos().length} TODOs`);
        if (manifest.generated_at) totals.push(`manifest @ ${manifest.generated_at}`);

        if (this.isLocalMode) {
            this.repoLabelEl.textContent = `Local data • ${totals.join(" • ")}`;
        } else {
            this.repoLabelEl.textContent = `${this.config.owner}/${this.config.repo}@${this.config.ref} • ${totals.join(" • ")}`;
        }
    }

    /**
     * Loads the entries manifest from the data source.
     * Keeps the main UI flow and data loading coordinated.
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
     * Loads projects.json and updates the project list.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async fetchProjects() {
        this.setProgress(0, 1, this.isLocalMode ? "Loading projects (local)…" : "Loading projects…");
        try {
            const raw = await this.dataSource.fetchProjects();
            const projectList = ProjectList.fromRaw(raw || {});
            this.store.setProjectList(projectList);
            this.weekView.setProjects(projectList);
        } catch (err) {
            const emptyList = ProjectList.fromRaw({ projects: [], generated_at: "" });
            this.store.setProjectList(emptyList);
            this.weekView.setProjects(emptyList);
            this.toast(`Projects not loaded: ${safeText(err)}`, 5000);
        }
        this.markSearchDirty();
    }

    /**
     * Loads week-requirements.json and updates the week requirements model.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async fetchWeekRequirements() {
        this.setProgress(0, 1, this.isLocalMode ? "Loading week requirements (local)…" : "Loading week requirements…");
        try {
            const raw = await this.dataSource.fetchWeekRequirements();
            const requirements = WeekRequirements.fromRaw(raw || {});
            this.store.setWeekRequirements(requirements);
            this.weekView.setWeekRequirements(requirements);
        } catch (err) {
            const defaults = WeekRequirements.createDefault();
            this.store.setWeekRequirements(defaults);
            this.weekView.setWeekRequirements(defaults);
            this.toast(`Week requirements not loaded: ${safeText(err)}`, 5000);
        }
    }

    /**
     * Loads data/todos.json, establishes its clean editor baseline, and restores any durable unsaved browser draft.
     * Project references are resolved later by TodoView through the already loaded shared ProjectList.
     * @returns {Promise<void>}
     */
    async fetchTodos() {
        this.setProgress(0, 1, this.isLocalMode ? "Loading TODOs (local)…" : "Loading TODOs…");
        const raw = await this.dataSource.fetchTodos();
        this.todoStore.setTodoList(TodoList.fromRaw(raw || {}));
        await this.todoView.initializeLoadedData();
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

        this.setProgress(0, chunkFiles.length, `Loading 0/${chunkFiles.length}…`);

        this.store.clear({ keepProjects: true, keepWeekRequirements: true });
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
        const seedResult = this.store.mergeProjectsFromEntries();
        if (seedResult.added > 0) {
            if (seedResult.projectList) this.weekView.setProjects(seedResult.projectList);
            this.todoView.setProjects();
            this.toast(`Seeded ${seedResult.added} project(s) from entries. Open Projects to review and save.`, 5000, "success");
        }

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

    /**
     * Reloads manifest, shared projects, TODOs, requirements, and all time-entry chunks.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<boolean>}
     */
    async reloadData() {
        this.showLoadingScreen(this.isLocalMode ? "Preparing local data…" : "Preparing repository data…");
        this.setBusy(true);
        this.setError(this.dataErrorEl, "");
        this.entriesTbody.innerHTML = "";
        this.statsEl.textContent = "";
        await this.weekView.flushDraftWrites();
        await this.todoView.flushDraftWrites();
        this.weekView.reset();
        this.todoStore.clear();
        this.todoView.reset();
        try {
            await this.fetchManifest();
            await this.fetchProjects();
            await this.fetchWeekRequirements();
            await this.fetchTodos();
            await this.loadAllChunks();
            this.showApplicationScreen();
            return true;
        } catch (err) {
            this.showLoadingError(safeText(err));
            return false;
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * Connects to GitHub using the provided token and loads data.
     * Keeps the main UI flow and data loading coordinated.
     * @param {string} token
     * @returns {Promise<void>}
     */
    async connectWithToken(token) {
        this.token = token;
        this.state.setToken(token);
        this.dataSource = new GitHubDataSource(this.config, token);
        this.weekView.setDataSource(this.dataSource);
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDataSource(this.dataSource);
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
        this.projectDialog.setDataSource(this.dataSource);
        this.setAuthStatus("Connecting…");
        this.showLoadingScreen("Connecting to GitHub…");
        this.setBusy(true);
        try {
            const { repoInfo, userInfo } = await this.dataSource.checkConnection();
            const repoLabel = repoInfo?.full_name ? repoInfo.full_name : `${this.config.owner}/${this.config.repo}`;
            this.state.ghUser = userInfo;
            this.setAuthStatus(userInfo?.login ? `Logged in as ${userInfo.login}` : `Connected to ${repoLabel}`);
            setVisible(this.logoutBtn, true);
            setVisible(this.reloadDataBtn, true);
            setVisible(this.projectsBtn, true);
            await this.reloadData();
        } catch (err) {
            this.state.ghUser = null;
            this.setAuthStatus("Not logged in");
            this.showLoginScreen();
            throw err;
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * Clears user session state and resets the UI to login.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    logout() {
        this.token = "";
        this.state.setToken("");
        this.state.ghUser = null;
        this.state.setWeekStart(null);
        this.state.setLatestWeekStart(null);
        this.store.clear();
        this.todoStore.clear();
        this.chunkCache.clearMemory();
        this.weekView.reset();
        this.todoView.reset();
        this.searchView.reset();
        this.setProgress(0, 1, "");
        this.setAuthStatus("Not logged in");
        this.repoLabelEl.textContent = "";
        this.projectDialog.close();
        setVisible(this.weekControlsEl, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.logoutBtn, false);
        setVisible(this.projectsBtn, false);
        this.showLoginScreen();
        this.configService.saveToken("", false);
    }
}

const app = new App();
app.start();
