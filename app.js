import { AppState } from "./appstate.js";
import { ChunkCache, DraftJournal } from "./cache.js";
import {
    ConfigService,
    DEFAULT_CONFIG,
    formatGitHubRepositoryUrl,
    getEffectiveUiViewportWidth,
    getRecommendedUiZoom,
    parseGitHubRepository,
    WorkspaceRegistry,
} from "./config.js";
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
import { Manifest, ProjectList, TodoList, WeekRequirements, Workspace } from "./model.js";
import {
    consumeCapabilityLink,
    formatAppRoute,
    formatCapabilityLink,
    getApplicationBasePath,
    RouteController,
} from "./routing.js";

const MIN_APP_ZOOM = 0.8;
const MAX_APP_ZOOM = 2;
const APP_ZOOM_STEP = 0.1;
/** @type {Array<[string, number]>} */
const RESPONSIVE_CLASS_BREAKPOINTS = [
    ["ui-compact", 520],
    ["ui-project-compact", 720],
    ["ui-narrow", 760],
    ["ui-toolbar-compact", 840],
    ["ui-medium", 980],
];

/**
 * Applies a credential-free route locator to the legacy active-repository configuration shape.
 * Multi-workspace persistence builds on this adapter while current views and the GitHub data source continue consuming owner, repo, ref, and workspacePath directly.
 * @param {import("./config.js").AppConfig} config Existing application configuration.
 * @param {import("./routing.js").WorkspaceRouteLocator | null} locator Parsed route locator.
 * @returns {import("./config.js").AppConfig}
 */
function configForRouteWorkspace(config, locator) {
    if (!locator || locator.provider !== "github") return { ...config };
    const repository = parseGitHubRepository(locator.repositoryUrl);
    return {
        ...config,
        owner: repository.owner,
        repo: repository.repo,
        ref: locator.ref,
        workspacePath: locator.workspacePath,
    };
}

/**
 * Parses one normalized week document and returns its entry records after schema validation.
 * Including the manifest path in failures makes both corrupt IndexedDB records and malformed network responses diagnosable.
 * @param {import("./model.js").ManifestChunk} chunk
 * @param {string} raw
 * @returns {Array<Object>}
 */
function parseWeekChunkEntries(chunk, raw) {
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
 * Manages the shared project/section taxonomy and persists it through the shared save pipeline.
 * Stable keys and hidden external-provider references survive display-name edits; new keys are generated only when new rows are saved.
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
     * Wires dialog controls to local row creation and repository persistence.
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
     * Rebuilds nested project and section rows from the authoritative store model.
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
     * Adds a blank root project whose key will be reserved from its first saved name.
     * @returns {void}
     */
    addProjectRow() {
        const row = this.buildProjectRow({
            key: "",
            name: "",
            color: "#7c5cff",
            billable: false,
            archived: false,
            sections: [],
            externalRefs: [],
        });
        this.listEl.append(row);
        const input = row.querySelector(".project-name");
        if (input instanceof HTMLInputElement) input.focus();
    }

    /**
     * Builds one project card with default metadata and a nested section editor.
     * The dataset retains an existing stable key without exposing provider bindings as editable fields.
     * @param {{key: string, name: string, color: string, billable: boolean, archived: boolean, sections: Array<Object>, externalRefs?: import("./model.js").ExternalReferenceRaw[], listSections?: () => import("./model.js").Section[]}} project
     * @returns {HTMLElement}
     */
    buildProjectRow(project) {
        const row = document.createElement("div");
        row.className = "project-row";
        row.dataset.projectKey = project.key || "";

        const fields = document.createElement("div");
        fields.className = "project-fields";

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

        fields.append(nameWrap, colorWrap, billableWrap, archivedWrap);

        const sectionsHead = document.createElement("div");
        sectionsHead.className = "project-sections-head";
        const sectionsTitle = document.createElement("span");
        sectionsTitle.textContent = "Sections";
        const addSectionBtn = document.createElement("button");
        addSectionBtn.type = "button";
        addSectionBtn.className = "btn btn-secondary project-add-section";
        addSectionBtn.textContent = "Add section";
        sectionsHead.append(sectionsTitle, addSectionBtn);

        const sectionsEl = document.createElement("div");
        sectionsEl.className = "project-sections";
        const sections = project.listSections ? project.listSections() : project.sections || [];
        for (const section of sections) {
            sectionsEl.append(this.buildSectionRow(section));
        }
        addSectionBtn.addEventListener("click", () => {
            const sectionRow = this.buildSectionRow({
                key: "",
                name: "",
                color: null,
                billable: null,
                archived: false,
            });
            sectionsEl.append(sectionRow);
            const input = sectionRow.querySelector(".section-name");
            if (input instanceof HTMLInputElement) input.focus();
        });

        row.append(fields, sectionsHead, sectionsEl);
        return row;
    }

    /**
     * Builds controls for one section and its optional color/billable overrides.
     * An unchecked custom-color switch and the “Inherit” billable choice explicitly serialize as null.
     * @param {{key: string, name: string, color: string | null, billable: boolean | null, archived: boolean}} section
     * @returns {HTMLElement}
     */
    buildSectionRow(section) {
        const row = document.createElement("div");
        row.className = "section-row";
        row.dataset.sectionKey = section.key || "";

        const nameWrap = document.createElement("label");
        nameWrap.className = "project-field section-name-field";
        const nameLabel = document.createElement("span");
        nameLabel.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "section-name";
        nameInput.value = section.name || "";
        nameInput.spellcheck = false;
        nameWrap.append(nameLabel, nameInput);

        const colorWrap = document.createElement("label");
        colorWrap.className = "project-field section-color-field";
        const colorLabel = document.createElement("span");
        colorLabel.textContent = "Color override";
        const colorControls = document.createElement("span");
        colorControls.className = "section-color-controls";
        const useColor = document.createElement("input");
        useColor.type = "checkbox";
        useColor.className = "section-use-color";
        useColor.checked = typeof section.color === "string" && Boolean(section.color);
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "section-color";
        colorInput.value = /^#[0-9a-f]{6}$/i.test(section.color || "") ? String(section.color) : "#7c5cff";
        colorInput.disabled = !useColor.checked;
        useColor.addEventListener("change", () => {
            colorInput.disabled = !useColor.checked;
        });
        colorControls.append(useColor, colorInput);
        colorWrap.append(colorLabel, colorControls);

        const billableWrap = document.createElement("label");
        billableWrap.className = "project-field";
        const billableLabel = document.createElement("span");
        billableLabel.textContent = "Billable";
        const billableSelect = document.createElement("select");
        billableSelect.className = "section-billable";
        billableSelect.append(new Option("Inherit", "inherit"), new Option("Billable", "true"), new Option("Not billable", "false"));
        billableSelect.value = typeof section.billable === "boolean" ? String(section.billable) : "inherit";
        billableWrap.append(billableLabel, billableSelect);

        const archivedWrap = document.createElement("label");
        archivedWrap.className = "checkbox project-field";
        const archivedInput = document.createElement("input");
        archivedInput.type = "checkbox";
        archivedInput.className = "section-archived";
        archivedInput.checked = section.archived === true;
        const archivedLabel = document.createElement("span");
        archivedLabel.textContent = "Archived";
        archivedWrap.append(archivedInput, archivedLabel);

        row.append(nameWrap, colorWrap, billableWrap, archivedWrap);
        return row;
    }

    /**
     * Reads nested controls, validates names/colors, reserves keys for new definitions, and preserves existing external references.
     * @returns {{projects: import("./model.js").ProjectRaw[], error: string | null}}
     */
    collectProjects() {
        const rows = Array.from(this.listEl.querySelectorAll(".project-row"));
        const projects = [];
        const seenNames = new Set();
        const usedProjectKeys = new Set(
            rows.map((row) => (row instanceof HTMLElement ? row.dataset.projectKey || "" : "")).filter(Boolean),
        );
        const currentByKey = new Map(this.store.getProjects().map((project) => [project.key, project]));

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
            const nameIdentity = name.toLowerCase();
            if (seenNames.has(nameIdentity)) {
                return { projects: [], error: `Duplicate project name: ${name}` };
            }
            seenNames.add(nameIdentity);

            const color = colorInput.value.trim();
            if (!/^#[0-9a-f]{6}$/i.test(color)) {
                return { projects: [], error: `Invalid color for ${name}.` };
            }

            const existingKey = row instanceof HTMLElement ? row.dataset.projectKey || "" : "";
            const projectKey = existingKey || ProjectList.reserveKey(name, usedProjectKeys);
            const currentProject = currentByKey.get(projectKey);
            const currentSectionsByKey = new Map(
                (currentProject?.listSections() || []).map((section) => [section.key, section]),
            );
            const sectionRows = Array.from(row.querySelectorAll(".section-row"));
            const usedSectionKeys = new Set(
                sectionRows
                    .map((sectionRow) => (sectionRow instanceof HTMLElement ? sectionRow.dataset.sectionKey || "" : ""))
                    .filter(Boolean),
            );
            const seenSectionNames = new Set();
            const sections = [];

            for (const sectionRow of sectionRows) {
                if (!(sectionRow instanceof HTMLElement)) continue;
                const sectionNameInput = sectionRow.querySelector(".section-name");
                const useColorInput = sectionRow.querySelector(".section-use-color");
                const sectionColorInput = sectionRow.querySelector(".section-color");
                const sectionBillableInput = sectionRow.querySelector(".section-billable");
                const sectionArchivedInput = sectionRow.querySelector(".section-archived");
                if (!(sectionNameInput instanceof HTMLInputElement)) continue;
                if (!(useColorInput instanceof HTMLInputElement)) continue;
                if (!(sectionColorInput instanceof HTMLInputElement)) continue;
                if (!(sectionBillableInput instanceof HTMLSelectElement)) continue;
                if (!(sectionArchivedInput instanceof HTMLInputElement)) continue;

                const sectionName = sectionNameInput.value.trim();
                if (!sectionName) return { projects: [], error: `Every section in ${name} needs a name.` };
                const sectionNameIdentity = sectionName.toLowerCase();
                if (seenSectionNames.has(sectionNameIdentity)) {
                    return { projects: [], error: `Duplicate section in ${name}: ${sectionName}` };
                }
                seenSectionNames.add(sectionNameIdentity);
                const existingSectionKey = sectionRow.dataset.sectionKey || "";
                const sectionKey = existingSectionKey || ProjectList.reserveKey(sectionName, usedSectionKeys);
                const sectionColor = useColorInput.checked ? sectionColorInput.value.trim() : null;
                if (sectionColor !== null && !/^#[0-9a-f]{6}$/i.test(sectionColor)) {
                    return { projects: [], error: `Invalid color for ${name} / ${sectionName}.` };
                }
                const billableValue = sectionBillableInput.value;
                const sectionBillable = billableValue === "true" ? true : billableValue === "false" ? false : null;
                sections.push({
                    archived: sectionArchivedInput.checked,
                    billable: sectionBillable,
                    color: sectionColor,
                    external_refs: (currentSectionsByKey.get(sectionKey)?.externalRefs || []).map((reference) => ({ ...reference })),
                    key: sectionKey,
                    name: sectionName,
                });
            }

            projects.push({
                key: projectKey,
                name,
                color,
                billable: billableInput.checked,
                archived: archivedInput.checked,
                sections,
                external_refs: (currentProject?.externalRefs || []).map((reference) => ({ ...reference })),
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
            schema_version: 2,
        };
        const projectList = ProjectList.fromRaw(payload);
        const content = projectList.toJson();

        this.onBusy(true);
        try {
            await this.dataSource.saveFiles([{ path: this.dataSource.getProjectsPath(), content }], "Update projects");
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
        this.routeController = new RouteController(window, getApplicationBasePath(document));
        this.routeController.restoreStaticRoute();
        /** @type {import("./routing.js").CapabilityLink | null} */
        this.capabilityImport = null;
        this.capabilityImportStartupError = "";
        try {
            this.capabilityImport = consumeCapabilityLink(window, this.routeController.basePath);
        } catch (error) {
            this.capabilityImportStartupError = safeText(error);
        }
        this.initialRoute = this.capabilityImport?.route || this.routeController.read();
        /** @type {import("./routing.js").AppRoute | null} */
        this.pendingRoute = this.initialRoute.component ? this.initialRoute : null;
        this.routeRestoreInProgress = false;
        this.activeGlobalPanel = null;
        this.workspaceDialogOpenedByPush = false;
        this.configService = new ConfigService();
        this.isLocalMode = this.initialRoute.workspace?.provider === "local" || getSourceMode() === "local";
        const storedConfig = this.configService.loadConfig();
        this.workspaceRegistry = this.isLocalMode
            ? new WorkspaceRegistry()
            : this.configService.loadWorkspaceRegistry(storedConfig);
        const routeConnection = this.workspaceRegistry.findByLocator(this.initialRoute.workspace);
        if (routeConnection) {
            this.workspaceRegistry.setActive(routeConnection.id);
            this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
        }
        this.activeWorkspaceConnection = this.isLocalMode
            ? null
            : routeConnection || (!this.initialRoute.workspace ? this.workspaceRegistry.getActive() : null);
        const initialLocator = this.initialRoute.workspace || this.activeWorkspaceConnection?.toLocator() || null;
        this.config = this.isLocalMode
            ? {
                  ...storedConfig,
                  workspacePath: this.initialRoute.workspace?.workspacePath || storedConfig.workspacePath,
                  localWorkspaceId: this.initialRoute.workspace?.expectedWorkspaceId || "",
              }
            : configForRouteWorkspace(storedConfig, initialLocator);
        this.token = this.capabilityImport
            ? ""
            : this.activeWorkspaceConnection
              ? this.configService.loadWorkspaceCredential(this.activeWorkspaceConnection.id)
              : this.initialRoute.workspace
                ? ""
                : this.configService.loadToken();
        this.state = new AppState(this.config, this.isLocalMode);
        this.state.setToken(this.token);
        this.timeContext = new TimeContext(this.config.timezone);
        this.store = new EntryStore(this.timeContext);
        this.todoStore = new TodoStore(this.store);
        this.chunkCache = new ChunkCache();
        this.draftJournal = new DraftJournal();
        this.repositorySummary = "";
        this.todoSummary = "";
        /** @type {Workspace | null} */
        this.workspace = null;

        this.dataSource = this.isLocalMode ? new LocalDataSource(this.config) : new GitHubDataSource(this.config, this.token);

        this.authStatusEl = getRequiredElement("authStatus", HTMLElement);
        this.logoutBtn = getRequiredElement("logoutBtn", HTMLButtonElement);
        this.loginSection = getRequiredElement("loginSection", HTMLElement);
        this.loginForm = getRequiredElement("loginForm", HTMLFormElement);
        this.loginErrorEl = getRequiredElement("loginError", HTMLElement);
        this.clearSavedBtn = getRequiredElement("clearSavedBtn", HTMLButtonElement);

        this.sidebarEl = getRequiredElement("appSidebar", HTMLElement);
        this.topbarEl = getRequiredElement("topbar", HTMLElement);
        this.appHomeLink = getRequiredElement("appHomeLink", HTMLAnchorElement);
        this.workspaceSettingsBtn = getRequiredElement("workspaceSettingsBtn", HTMLButtonElement);
        this.menuWeekBtn = getRequiredElement("menuWeekBtn", HTMLButtonElement);
        this.menuTodoBtn = getRequiredElement("menuTodoBtn", HTMLButtonElement);
        this.menuSearchBtn = getRequiredElement("menuSearchBtn", HTMLButtonElement);
        this.appZoomOutBtn = getRequiredElement("appZoomOutBtn", HTMLButtonElement);
        this.appZoomResetBtn = getRequiredElement("appZoomResetBtn", HTMLButtonElement);
        this.appZoomLabelEl = getRequiredElement("appZoomLabel", HTMLElement);
        this.appZoomInBtn = getRequiredElement("appZoomInBtn", HTMLButtonElement);
        this.appThemeToggleBtn = getRequiredElement("appThemeToggleBtn", HTMLButtonElement);
        this.landingThemeToggleBtn = getRequiredElement("landingThemeToggleBtn", HTMLButtonElement);
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
        this.weekBillableEl = getRequiredElement("weekBillable", HTMLElement);
        this.weekReqBtn = getRequiredElement("weekReqBtn", HTMLButtonElement);
        this.weekScrollEl = getRequiredElement("weekScroll", HTMLElement);
        this.prevWeekBtn = getRequiredElement("prevWeekBtn", HTMLButtonElement);
        this.nextWeekBtn = getRequiredElement("nextWeekBtn", HTMLButtonElement);
        this.latestWeekBtn = getRequiredElement("latestWeekBtn", HTMLButtonElement);
        this.weekNormalBtn = getRequiredElement("weekNormalBtn", HTMLButtonElement);
        this.weekAddBtn = getRequiredElement("weekAddBtn", HTMLButtonElement);
        this.weekSplitBtn = getRequiredElement("weekSplitBtn", HTMLButtonElement);
        this.weekUndoBtn = getRequiredElement("weekUndoBtn", HTMLButtonElement);
        this.weekRedoBtn = getRequiredElement("weekRedoBtn", HTMLButtonElement);
        this.weekZoomOutBtn = getRequiredElement("weekZoomOutBtn", HTMLButtonElement);
        this.weekZoomInBtn = getRequiredElement("weekZoomInBtn", HTMLButtonElement);
        this.zoomInput = getRequiredElement("zoomInput", HTMLInputElement);
        this.editorBadgeEl = getRequiredElement("editorBadge", HTMLButtonElement);

        this.entryDialog = getRequiredElement("entryDialog", HTMLDialogElement);
        this.entryForm = getRequiredElement("entryForm", HTMLFormElement);
        this.entryCloseBtn = getRequiredElement("entryCloseBtn", HTMLButtonElement);
        this.entryDeleteBtn = getRequiredElement("entryDeleteBtn", HTMLButtonElement);
        this.entryCancelBtn = getRequiredElement("entryCancelBtn", HTMLButtonElement);
        this.entryMetaEl = getRequiredElement("entryMeta", HTMLElement);
        this.entryAssignmentInput = getRequiredElement("entryAssignment", HTMLInputElement);
        this.entryAssignmentListEl = getRequiredElement("entryAssignmentList", HTMLDataListElement);
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
        this.weekReqSummary = getRequiredElement("weekReqSummary", HTMLElement);
        this.weekReqHours = getRequiredElement("weekReqHours", HTMLInputElement);
        this.weekReqComment = getRequiredElement("weekReqComment", HTMLTextAreaElement);

        this.searchViewEl = getRequiredElement("searchView", HTMLElement);
        this.searchFiltersPanelEl = getRequiredElement("searchFiltersPanel", HTMLDetailsElement);
        this.globalSearchEl = getRequiredElement("globalSearch", HTMLElement);
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
        this.todoTopbarControlsEl = getRequiredElement("todoTopbarControls", HTMLElement);
        this.todoAddBtn = getRequiredElement("todoAddBtn", HTMLButtonElement);
        this.todoCurrentFilterBtn = getRequiredElement("todoCurrentFilterBtn", HTMLButtonElement);
        this.todoOpenFilterBtn = getRequiredElement("todoOpenFilterBtn", HTMLButtonElement);
        this.todoProjectFiltersEl = getRequiredElement("todoProjectFilters", HTMLElement);
        this.todoDialog = getRequiredElement("todoDialog", HTMLDialogElement);
        this.todoForm = getRequiredElement("todoForm", HTMLFormElement);
        this.todoDialogTitleEl = getRequiredElement("todoDialogTitle", HTMLElement);
        this.todoCloseBtn = getRequiredElement("todoCloseBtn", HTMLButtonElement);
        this.todoCancelBtn = getRequiredElement("todoCancelBtn", HTMLButtonElement);
        this.todoContentInput = getRequiredElement("todoContent", HTMLInputElement);
        this.todoDescriptionInput = getRequiredElement("todoDescription", HTMLTextAreaElement);
        this.todoAssignmentInput = getRequiredElement("todoAssignment", HTMLInputElement);
        this.todoAssignmentListEl = getRequiredElement("todoAssignmentList", HTMLDataListElement);
        this.todoDueDateInput = getRequiredElement("todoDueDate", HTMLInputElement);
        this.todoDueTimeInput = getRequiredElement("todoDueTime", HTMLInputElement);
        this.todoRecurrenceInput = getRequiredElement("todoRecurrence", HTMLInputElement);
        this.todoPrioritySelect = getRequiredElement("todoPriority", HTMLSelectElement);
        this.todoLabelsInput = getRequiredElement("todoLabels", HTMLInputElement);
        this.todoDialogMetaEl = getRequiredElement("todoDialogMeta", HTMLElement);

        this.repositoryInput = getRequiredElement("repositoryInput", HTMLInputElement);
        this.refInput = getRequiredElement("refInput", HTMLInputElement);
        this.tokenInput = getRequiredElement("tokenInput", HTMLInputElement);
        this.rememberInput = getRequiredElement("rememberInput", HTMLInputElement);

        this.workspaceDialog = getRequiredElement("workspaceDialog", HTMLDialogElement);
        this.workspaceDialogCloseBtn = getRequiredElement("workspaceDialogCloseBtn", HTMLButtonElement);
        this.workspaceListEl = getRequiredElement("workspaceList", HTMLElement);
        this.workspaceAddForm = getRequiredElement("workspaceAddForm", HTMLFormElement);
        this.workspaceProviderInput = getRequiredElement("workspaceProvider", HTMLSelectElement);
        this.workspaceRepositoryInput = getRequiredElement("workspaceRepository", HTMLInputElement);
        this.workspaceRefInput = getRequiredElement("workspaceRef", HTMLInputElement);
        this.workspacePathInput = getRequiredElement("workspacePath", HTMLInputElement);
        this.workspaceTokenInput = getRequiredElement("workspaceToken", HTMLInputElement);
        this.workspaceRememberInput = getRequiredElement("workspaceRemember", HTMLInputElement);
        this.workspaceErrorEl = getRequiredElement("workspaceError", HTMLElement);
        this.workspaceShareBtn = getRequiredElement("workspaceShareBtn", HTMLButtonElement);
        this.workspaceShareDialog = getRequiredElement("workspaceShareDialog", HTMLDialogElement);
        this.workspaceShareCloseBtn = getRequiredElement("workspaceShareCloseBtn", HTMLButtonElement);
        this.workspaceShareDetailsEl = getRequiredElement("workspaceShareDetails", HTMLElement);
        this.workspaceCopyLocatorBtn = getRequiredElement("workspaceCopyLocatorBtn", HTMLButtonElement);
        this.workspaceShareTokenInput = getRequiredElement("workspaceShareToken", HTMLInputElement);
        this.workspaceCopyCapabilityBtn = getRequiredElement("workspaceCopyCapabilityBtn", HTMLButtonElement);
        this.workspaceShareErrorEl = getRequiredElement("workspaceShareError", HTMLElement);

        this.capabilityImportDialog = getRequiredElement("capabilityImportDialog", HTMLDialogElement);
        this.capabilityImportDetailsEl = getRequiredElement("capabilityImportDetails", HTMLElement);
        this.capabilityHostConfirmWrap = getRequiredElement("capabilityHostConfirmWrap", HTMLElement);
        this.capabilityHostConfirmInput = getRequiredElement("capabilityHostConfirm", HTMLInputElement);
        this.capabilityHostConfirmTextEl = getRequiredElement("capabilityHostConfirmText", HTMLElement);
        this.capabilityRememberInput = getRequiredElement("capabilityRemember", HTMLInputElement);
        this.capabilityImportErrorEl = getRequiredElement("capabilityImportError", HTMLElement);
        this.capabilityImportCancelBtn = getRequiredElement("capabilityImportCancelBtn", HTMLButtonElement);
        this.capabilityImportOpenBtn = getRequiredElement("capabilityImportOpenBtn", HTMLButtonElement);

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
                weekBillable: this.weekBillableEl,
                weekReqBtn: this.weekReqBtn,
                weekScroll: this.weekScrollEl,
                prevWeekBtn: this.prevWeekBtn,
                nextWeekBtn: this.nextWeekBtn,
                latestWeekBtn: this.latestWeekBtn,
                weekNormalBtn: this.weekNormalBtn,
                weekAddBtn: this.weekAddBtn,
                weekSplitBtn: this.weekSplitBtn,
                weekUndoBtn: this.weekUndoBtn,
                weekRedoBtn: this.weekRedoBtn,
                weekZoomOutBtn: this.weekZoomOutBtn,
                weekZoomInBtn: this.weekZoomInBtn,
                zoomInput: this.zoomInput,
                editorBadge: this.editorBadgeEl,
                weekReqDialog: this.weekReqDialog,
                weekReqForm: this.weekReqForm,
                weekReqCloseBtn: this.weekReqCloseBtn,
                weekReqCancelBtn: this.weekReqCancelBtn,
                weekReqOkBtn: this.weekReqOkBtn,
                weekReqMeta: this.weekReqMeta,
                weekReqSummary: this.weekReqSummary,
                weekReqHours: this.weekReqHours,
                weekReqComment: this.weekReqComment,
                entryDialog: this.entryDialog,
                entryForm: this.entryForm,
                entryCloseBtn: this.entryCloseBtn,
                entryDeleteBtn: this.entryDeleteBtn,
                entryCancelBtn: this.entryCancelBtn,
                entryMeta: this.entryMetaEl,
                entryAssignment: this.entryAssignmentInput,
                entryAssignmentList: this.entryAssignmentListEl,
                entryDesc: this.entryDescInput,
                entryDescSuggestions: this.entryDescSuggestionsEl,
            },
            onToast: (message, timeout, tone) => this.toast(message, timeout, tone),
            onBusy: (busy) => this.setBusy(busy),
            onSearchDirty: () => this.markSearchDirty(),
            onManifestUpdated: () => this.refreshRepoLabel(),
            onStateChange: () => this.scheduleRouteReplace(),
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
            onStateChange: () => this.scheduleRouteReplace(),
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
                searchInput: this.searchInput,
                todoCurrentFilterBtn: this.todoCurrentFilterBtn,
                todoOpenFilterBtn: this.todoOpenFilterBtn,
                todoProjectFilters: this.todoProjectFiltersEl,
                todoDialog: this.todoDialog,
                todoForm: this.todoForm,
                todoDialogTitle: this.todoDialogTitleEl,
                todoCloseBtn: this.todoCloseBtn,
                todoCancelBtn: this.todoCancelBtn,
                todoContent: this.todoContentInput,
                todoDescription: this.todoDescriptionInput,
                todoAssignment: this.todoAssignmentInput,
                todoAssignmentList: this.todoAssignmentListEl,
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
            onStatsChanged: (summary) => {
                this.todoSummary = summary;
                this.refreshDataBadge();
            },
            onStateChange: () => this.scheduleRouteReplace(),
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
        this.searchFiltersNarrow = false;
        /** @type {"auto" | "manual"} */
        this.uiZoomMode = this.config.uiZoomMode === "manual" ? "manual" : "auto";
        const initialUiZoom = this.uiZoomMode === "auto" ? this.getRecommendedAppZoom() : this.config.uiZoom;
        this.uiZoom = this.normalizeAppZoom(initialUiZoom);
        /** @type {"dark" | "light"} */
        this.theme = this.config.theme === "light" ? "light" : "dark";
        this.setTheme(this.theme, false);
        this.setAppZoom(this.uiZoom, false, this.uiZoomMode);
    }

    /**
     * Applies one shared color theme to the public landing page and initialized application.
     * The preference is stored with other non-workspace UI configuration; dark remains the default when no valid preference exists.
     * @param {"dark" | "light"} theme Requested theme name.
     * @param {boolean} [shouldPersist] Whether to persist the preference immediately.
     * @returns {void}
     */
    setTheme(theme, shouldPersist = true) {
        this.theme = theme === "light" ? "light" : "dark";
        this.config = { ...this.config, theme: this.theme };
        this.state.setConfig(this.config);
        document.documentElement.dataset.theme = this.theme;

        const useLight = this.theme === "dark";
        const actionLabel = useLight ? "Use light theme" : "Use dark theme";
        for (const button of [this.appThemeToggleBtn, this.landingThemeToggleBtn]) {
            button.title = actionLabel;
            button.setAttribute("aria-label", actionLabel);
            button.setAttribute("aria-pressed", this.theme === "light" ? "true" : "false");
        }
        const landingLabel = this.landingThemeToggleBtn.querySelector("span");
        if (landingLabel) landingLabel.textContent = useLight ? "Light" : "Dark";

        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta instanceof HTMLMetaElement) {
            themeMeta.content = this.theme === "dark" ? "#17191f" : "#f7f7f4";
        }
        if (shouldPersist) this.configService.saveConfig(this.config);
    }

    /**
     * Switches between the supported light and dark themes.
     * Both landing-page and application controls invoke this method so appearance never depends on authentication state.
     * @returns {void}
     */
    toggleTheme() {
        this.setTheme(this.theme === "dark" ? "light" : "dark");
    }

    /**
     * Clamps an arbitrary persisted value to the supported application zoom range.
     * Rounding to tenths keeps button stepping stable despite floating-point arithmetic.
     * @param {unknown} value
     * @returns {number}
     */
    normalizeAppZoom(value) {
        const parsed = Number(value);
        const finite = Number.isFinite(parsed) ? parsed : 1;
        return Math.round(Math.max(MIN_APP_ZOOM, Math.min(MAX_APP_ZOOM, finite)) * 10) / 10;
    }

    /**
     * Returns the default application zoom used by automatic mode.
     * Automatic mode currently preserves the browser's natural 100% application scale on every device.
     * @returns {number}
     */
    getRecommendedAppZoom() {
        return getRecommendedUiZoom();
    }

    /**
     * Returns the viewport width available to the application after CSS zoom.
     * Using this effective width makes manually enlarged layouts reflow just like genuinely narrow viewports.
     * @returns {number}
     */
    getEffectiveAppViewportWidth() {
        return getEffectiveUiViewportWidth(window.innerWidth, this.uiZoom);
    }

    /**
     * Synchronizes responsive CSS classes, search-filter state, and shared application state.
     * Every breakpoint is evaluated against effective width so Safari, other browsers, and manual app zoom all select the same layout mode.
     * @returns {void}
     */
    updateResponsiveLayout() {
        const effectiveWidth = this.getEffectiveAppViewportWidth();
        this.state.setEffectiveViewportWidth(effectiveWidth);
        for (const [className, maxWidth] of RESPONSIVE_CLASS_BREAKPOINTS) {
            document.documentElement.classList.toggle(className, effectiveWidth <= maxWidth);
        }

        const searchFiltersNarrow = effectiveWidth <= 760;
        if (searchFiltersNarrow !== this.searchFiltersNarrow) {
            this.searchFiltersNarrow = searchFiltersNarrow;
            this.searchFiltersPanelEl.open = !searchFiltersNarrow;
        }
    }

    /**
     * Applies a whole-application visual zoom, records whether it is automatic or manual, and optionally persists it.
     * Browsers do not expose their native page-zoom setting to page scripts, so CSS zoom provides the equivalent in-app control.
     * @param {number} value
     * @param {boolean} [shouldPersist]
     * @param {"auto" | "manual"} [mode]
     * @returns {void}
     */
    setAppZoom(value, shouldPersist = true, mode = "manual") {
        this.uiZoom = this.normalizeAppZoom(value);
        this.uiZoomMode = mode === "auto" ? "auto" : "manual";
        document.body.style.setProperty("zoom", String(this.uiZoom));
        this.appZoomLabelEl.textContent = `${Math.round(this.uiZoom * 100)}%`;
        this.appZoomResetBtn.title =
            this.uiZoomMode === "auto"
                ? `Automatic app zoom (${Math.round(this.uiZoom * 100)}%)`
                : `Restore automatic app zoom (currently ${Math.round(this.uiZoom * 100)}%)`;
        this.appZoomOutBtn.disabled = this.uiZoom <= MIN_APP_ZOOM;
        this.appZoomInBtn.disabled = this.uiZoom >= MAX_APP_ZOOM;
        this.config = { ...this.config, uiZoom: this.uiZoom, uiZoomMode: this.uiZoomMode };
        this.state.setConfig(this.config);
        this.updateResponsiveLayout();
        if (shouldPersist) this.configService.saveConfig(this.config);
        window.requestAnimationFrame(() => this.weekView.handleResize());
    }

    /**
     * Restores the default zoom and optionally persists automatic mode.
     * The reset control returns to the neutral 100% application scale while preserving responsive mobile layout behavior.
     * @param {boolean} [shouldPersist]
     * @returns {void}
     */
    setAutomaticAppZoom(shouldPersist = true) {
        this.setAppZoom(this.getRecommendedAppZoom(), shouldPersist, "auto");
    }

    /**
     * Moves the application zoom by one ten-percent step in the requested direction.
     * @param {number} direction Negative zooms out; positive zooms in.
     * @returns {void}
     */
    nudgeAppZoom(direction) {
        const step = direction < 0 ? -APP_ZOOM_STEP : APP_ZOOM_STEP;
        this.setAppZoom(this.uiZoom + step);
    }

    /**
     * Creates one consistently styled action for a workspace registry row.
     * Action names and connection ids are stored in data attributes so one delegated list listener can handle rows rebuilt after reordering.
     * @param {string} label Visible action label.
     * @param {string} action Stable action identifier.
     * @param {string} connectionId Registry connection id.
     * @param {boolean} [disabled] Whether the action is currently unavailable.
     * @returns {HTMLButtonElement}
     */
    createWorkspaceActionButton(label, action, connectionId, disabled = false) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-secondary workspace-row-action";
        button.textContent = label;
        button.dataset.workspaceAction = action;
        button.dataset.workspaceId = connectionId;
        button.disabled = disabled;
        return button;
    }

    /**
     * Rebuilds Workspace settings from the credential-free browser registry.
     * Credentials are represented only by a remembered/session status label; token values are never inserted into the DOM or diagnostics.
     * @returns {void}
     */
    renderWorkspaceRegistry() {
        this.workspaceListEl.innerHTML = "";
        this.workspaceAddForm.hidden = this.isLocalMode;
        this.workspaceShareBtn.disabled = !this.workspace;

        const connections = this.workspaceRegistry.list();
        if (!connections.length) {
            const empty = document.createElement("p");
            empty.className = "workspace-empty muted";
            empty.textContent = "No saved workspace connections.";
            this.workspaceListEl.append(empty);
            return;
        }

        connections.forEach((connection, index) => {
            const isActive = connection.id === this.activeWorkspaceConnection?.id;
            const hasCredential =
                connection.provider === "local" || Boolean(this.configService.loadWorkspaceCredential(connection.id));
            const row = document.createElement("div");
            row.className = `workspace-row${isActive ? " is-active" : ""}`;
            row.setAttribute("role", "listitem");

            const info = document.createElement("div");
            info.className = "workspace-row-main";
            const heading = document.createElement("div");
            heading.className = "workspace-row-title";
            const name = document.createElement("strong");
            name.textContent = connection.displayName;
            heading.append(name);
            if (isActive) {
                const badge = document.createElement("span");
                badge.className = "workspace-active-badge";
                badge.textContent = "Active";
                heading.append(badge);
            }
            const credentialBadge = document.createElement("span");
            credentialBadge.className = "workspace-credential-badge muted";
            credentialBadge.textContent = connection.provider === "local" ? "Local server" : hasCredential ? "Authenticated" : "Token required";
            heading.append(credentialBadge);

            const meta = document.createElement("div");
            meta.className = "workspace-row-location muted";
            let repository = connection.expectedWorkspaceId;
            if (connection.provider !== "local") {
                repository = connection.repositoryUrl;
                try {
                    repository = new URL(connection.repositoryUrl).pathname.replace(/^\/+/, "");
                } catch {
                    // Keep the already validated absolute URL if browser URL parsing is unavailable.
                }
            }
            meta.textContent = [connection.provider, repository, connection.ref, connection.workspacePath]
                .filter(Boolean)
                .join(" · ");
            info.append(heading, meta);

            const actions = document.createElement("div");
            actions.className = "workspace-row-actions";
            actions.append(
                this.createWorkspaceActionButton(
                    isActive && this.workspace ? "Open" : hasCredential ? "Switch" : "Authenticate",
                    "open",
                    connection.id,
                    isActive && Boolean(this.workspace),
                ),
                this.createWorkspaceActionButton("Earlier", "up", connection.id, index === 0),
                this.createWorkspaceActionButton("Later", "down", connection.id, index === connections.length - 1),
            );
            if (connection.provider !== "local") {
                actions.append(this.createWorkspaceActionButton("Disconnect", "disconnect", connection.id));
            }
            row.append(info, actions);
            this.workspaceListEl.append(row);
        });
    }

    /**
     * Opens Workspace settings as a modal global panel and optionally records that navigation in browser history.
     * The underlying component remains mounted, allowing Back or dialog close to return to its exact view state.
     * @param {"push" | "none"} [historyMode] Whether opening should create a browser-history entry.
     * @returns {void}
     */
    openWorkspaceSettings(historyMode = "push") {
        if (this.appSection.hidden || !this.workspace) return;
        this.activeGlobalPanel = "workspaces";
        this.workspaceDialogOpenedByPush = historyMode === "push";
        this.workspaceSettingsBtn.setAttribute("aria-current", "page");
        this.setError(this.workspaceErrorEl, "");
        this.renderWorkspaceRegistry();
        if (!this.workspaceDialog.open) this.workspaceDialog.showModal();
        if (historyMode === "push") this.writeCurrentRoute("push");
    }

    /**
     * Closes Workspace settings and restores the route beneath it.
     * A panel opened by an in-app push returns through browser history; a directly loaded settings URL is normalized in place.
     * @param {"back" | "replace" | "none"} [historyMode] Route behavior used while closing.
     * @returns {void}
     */
    closeWorkspaceSettings(historyMode = "back") {
        const wasOpen = this.workspaceDialog.open;
        if (wasOpen) this.workspaceDialog.close();
        this.activeGlobalPanel = null;
        this.workspaceSettingsBtn.removeAttribute("aria-current");
        if (!wasOpen || historyMode === "none" || this.routeRestoreInProgress) {
            if (historyMode === "none") this.workspaceDialogOpenedByPush = false;
            return;
        }
        if (historyMode === "back" && this.workspaceDialogOpenedByPush) {
            this.workspaceDialogOpenedByPush = false;
            window.history.back();
            return;
        }
        this.workspaceDialogOpenedByPush = false;
        this.writeCurrentRoute("replace");
    }

    /**
     * Handles a delegated click from one registry-row control.
     * Reordering and disconnection are local browser operations; opening a row performs an authenticated, failure-isolated workspace switch.
     * @param {Event} event Click event originating inside the workspace list.
     * @returns {Promise<void>}
     */
    async handleWorkspaceListClick(event) {
        const target = event.target instanceof Element ? event.target.closest("[data-workspace-action]") : null;
        if (!(target instanceof HTMLButtonElement)) return;
        const action = target.dataset.workspaceAction || "";
        const connectionId = target.dataset.workspaceId || "";
        if (!connectionId) return;
        if (action === "open") {
            await this.switchWorkspace(connectionId);
            return;
        }
        if (action === "up" || action === "down") {
            if (this.workspaceRegistry.move(connectionId, action === "up" ? -1 : 1)) {
                this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
                this.renderWorkspaceRegistry();
            }
            return;
        }
        if (action === "disconnect") this.disconnectWorkspace(connectionId);
    }

    /**
     * Prefills the add/authentication form for an existing connection that lacks a stored token.
     * Keeping the current workspace mounted prevents an unavailable or unauthenticated secondary repository from blocking the usable one.
     * @param {import("./config.js").WorkspaceConnection} connection Connection requiring authentication.
     * @returns {void}
     */
    requestWorkspaceCredential(connection) {
        this.workspaceProviderInput.value = connection.provider;
        this.workspaceRepositoryInput.value = connection.repositoryUrl;
        this.workspaceRefInput.value = connection.ref;
        this.workspacePathInput.value = connection.workspacePath;
        this.workspaceTokenInput.value = "";
        this.workspaceRememberInput.checked = false;
        this.setError(this.workspaceErrorEl, `Enter a token to authenticate ${connection.displayName}.`);
        queueMicrotask(() => this.workspaceTokenInput.focus());
    }

    /**
     * Applies a registered GitHub connection to all runtime configuration holders without loading its documents.
     * Callers preflight first when another usable workspace is mounted, then connect through the ordinary shared load pipeline.
     * @param {import("./config.js").WorkspaceConnection} connection Connection becoming active.
     * @param {string} token Credential scoped to that connection id.
     * @returns {void}
     */
    activateWorkspaceConnection(connection, token) {
        this.workspaceRegistry.setActive(connection.id);
        this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
        this.activeWorkspaceConnection = connection;
        this.config =
            connection.provider === "local"
                ? {
                      ...this.config,
                      workspacePath: connection.workspacePath,
                      localWorkspaceId: connection.expectedWorkspaceId,
                  }
                : configForRouteWorkspace(this.config, connection.toLocator());
        this.configService.saveConfig(this.config);
        this.state.setConfig(this.config);
        this.token = token;
        this.state.setToken(token);
        this.repositoryInput.value = connection.repositoryUrl;
        this.refInput.value = connection.ref;
        this.rememberInput.checked = this.configService.isWorkspaceCredentialRemembered(connection.id);
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
    }

    /**
     * Builds the initial component route used after changing repositories.
     * Component intent is retained, while record ids, week positions, and filters are reset because they belong to the previous workspace.
     * @param {import("./config.js").WorkspaceConnection} connection Target connection.
     * @returns {import("./routing.js").AppRoute}
     */
    routeForWorkspaceConnection(connection) {
        const component = this.state.activeTab === "todos" ? "todos" : "time";
        const panel = this.state.activeTab === "search" ? "search" : "main";
        return {
            version: 1,
            component,
            panel,
            workspace: connection.toLocator(),
            state: {},
        };
    }

    /**
     * Verifies repository access before an already loaded workspace is replaced.
     * This deliberately uses a temporary data source, so failed credentials or an unavailable repository cannot mutate active stores or Git save state.
     * @param {import("./config.js").WorkspaceConnection} connection Candidate connection.
     * @param {string} token Candidate credential.
     * @returns {Promise<{repoInfo: any, userInfo: any}>}
     */
    async preflightWorkspaceConnection(connection, token) {
        const candidateConfig = configForRouteWorkspace(this.config, connection.toLocator());
        const candidateSource = new GitHubDataSource(candidateConfig, token);
        return await candidateSource.checkConnection();
    }

    /**
     * Switches to a registered workspace while preserving unsaved work in its isolated draft journal.
     * Active saves are never interrupted, and the current UI remains available when candidate preflight fails.
     * @param {string} connectionId Registry connection id.
     * @param {import("./routing.js").AppRoute | null} [requestedRoute] Route whose component state should be restored after switching.
     * @returns {Promise<void>}
     */
    async switchWorkspace(connectionId, requestedRoute = null) {
        const connection = this.workspaceRegistry.getById(connectionId);
        if (!connection) return;
        if (connection.id === this.activeWorkspaceConnection?.id && this.workspace) {
            this.closeWorkspaceSettings();
            return;
        }
        if (this.weekView.saveInFlight || this.todoView.saveInFlight) {
            this.toast("Wait for the active save to finish before switching workspaces.", 4000);
            return;
        }
        if (connection.provider === "local") {
            await Promise.all([this.weekView.flushDraftWrites(), this.todoView.flushDraftWrites()]);
            this.activateWorkspaceConnection(connection, "");
            this.pendingRoute = requestedRoute || this.routeForWorkspaceConnection(connection);
            this.dataSource = new LocalDataSource(this.config);
            this.weekView.setDataSource(this.dataSource);
            this.todoView.setDataSource(this.dataSource);
            this.projectDialog.setDataSource(this.dataSource);
            this.closeWorkspaceSettings("none");
            await this.reloadData();
            return;
        }
        const credential = this.configService.loadWorkspaceCredential(connection.id);
        if (!credential) {
            this.requestWorkspaceCredential(connection);
            return;
        }

        this.setError(this.workspaceErrorEl, "");
        this.setBusy(true);
        let connectionInfo;
        try {
            connectionInfo = await this.preflightWorkspaceConnection(connection, credential);
        } catch (error) {
            const message = `Could not open ${connection.displayName}: ${safeText(error)}`;
            this.setError(this.workspaceErrorEl, message);
            this.toast(message, 6000);
            return;
        } finally {
            this.setBusy(false);
        }

        await Promise.all([this.weekView.flushDraftWrites(), this.todoView.flushDraftWrites()]);
        this.activateWorkspaceConnection(connection, credential);
        this.pendingRoute = requestedRoute || this.routeForWorkspaceConnection(connection);
        this.closeWorkspaceSettings("none");
        try {
            await this.connectWithToken(credential, connectionInfo);
        } catch (error) {
            this.setError(this.loginErrorEl, safeText(error));
        }
    }

    /**
     * Adds or re-authenticates a GitHub workspace from the settings form, then opens it through the same switch pipeline as registry rows.
     * The new credential is persisted only in the selected browser tier and never in the registry record.
     * @param {Event} event Workspace form submission.
     * @returns {Promise<void>}
     */
    async handleWorkspaceAdd(event) {
        event.preventDefault();
        this.setError(this.workspaceErrorEl, "");
        if (this.workspaceProviderInput.value !== "github") {
            this.setError(this.workspaceErrorEl, "This provider is not available yet.");
            return;
        }

        const token = this.workspaceTokenInput.value.trim();
        if (!token) {
            this.setError(this.workspaceErrorEl, "Enter a token for this workspace.");
            return;
        }
        let locator;
        try {
            const repository = parseGitHubRepository(this.workspaceRepositoryInput.value);
            locator = {
                provider: "github",
                repositoryUrl: formatGitHubRepositoryUrl(repository.owner, repository.repo),
                ref: this.workspaceRefInput.value.trim(),
                workspacePath: this.workspacePathInput.value.trim(),
                expectedWorkspaceId: "",
            };
            if (!locator.ref) throw new Error("Enter a branch or ref.");
            const connection = this.workspaceRegistry.upsert(locator);
            this.configService.saveWorkspaceCredential(connection.id, token, this.workspaceRememberInput.checked);
            this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
            this.workspaceTokenInput.value = "";
            this.renderWorkspaceRegistry();
            await this.switchWorkspace(connection.id);
        } catch (error) {
            this.setError(this.workspaceErrorEl, safeText(error));
        }
    }

    /**
     * Removes one browser connection and both of its credential records without changing repository data.
     * Disconnecting the mounted workspace returns to login; every other connection remains registered and independently usable.
     * @param {string} connectionId Registry connection id.
     * @returns {void}
     */
    disconnectWorkspace(connectionId) {
        if (this.weekView.saveInFlight || this.todoView.saveInFlight) {
            this.toast("Wait for the active save to finish before disconnecting a workspace.", 4000);
            return;
        }
        const wasActive = connectionId === this.activeWorkspaceConnection?.id;
        const removed = this.workspaceRegistry.remove(connectionId);
        if (!removed) return;
        this.configService.clearWorkspaceCredential(connectionId);
        this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
        if (!wasActive) {
            this.renderWorkspaceRegistry();
            return;
        }
        this.activeWorkspaceConnection = null;
        this.closeWorkspaceSettings("none");
        this.logout(false);
    }

    /**
     * Returns the active component route with global Workspace settings removed.
     * Both locator and capability links use this exact model so the recipient restores the same sub-app and optional view state.
     * @returns {import("./routing.js").AppRoute}
     */
    buildWorkspaceShareRoute() {
        const route = this.buildCurrentRoute();
        if (route.panel === "workspaces") {
            route.panel = route.component === "time" && route.state.returnPanel === "search" ? "search" : "main";
            delete route.state.returnPanel;
        }
        return route;
    }

    /**
     * Formats provider, repository, branch, config path, and verified identity for a consent surface.
     * The summary is intentionally credential-free and may safely be rendered in the DOM.
     * @param {import("./routing.js").WorkspaceRouteLocator} locator Workspace coordinates.
     * @returns {string}
     */
    describeWorkspaceLocator(locator) {
        const repository = locator.provider === "local" ? "Local server" : locator.repositoryUrl;
        const details = [locator.provider, repository, locator.ref, locator.workspacePath, locator.expectedWorkspaceId];
        return details.filter(Boolean).join(" · ");
    }

    /**
     * Opens the explicit locator/capability choice for the mounted workspace.
     * Capability creation remains unavailable in local mode because a local-server route is not a transferable repository authority.
     * @returns {void}
     */
    openWorkspaceShareDialog() {
        if (!this.workspace) return;
        const route = this.buildWorkspaceShareRoute();
        if (!route.workspace) return;
        this.closeWorkspaceSettings("replace");
        this.workspaceShareDetailsEl.textContent = this.describeWorkspaceLocator(route.workspace);
        this.workspaceShareTokenInput.value = "";
        this.workspaceShareTokenInput.disabled = route.workspace.provider === "local";
        this.workspaceCopyCapabilityBtn.disabled = route.workspace.provider === "local";
        this.setError(
            this.workspaceShareErrorEl,
            route.workspace.provider === "local" ? "Local workspaces can only produce locator links for this server." : "",
        );
        if (!this.workspaceShareDialog.open) this.workspaceShareDialog.showModal();
    }

    /**
     * Closes the share dialog and clears any unsubmitted token from its input.
     * @returns {void}
     */
    closeWorkspaceShareDialog() {
        this.workspaceShareTokenInput.value = "";
        this.setError(this.workspaceShareErrorEl, "");
        if (this.workspaceShareDialog.open) this.workspaceShareDialog.close();
    }

    /**
     * Copies a credential-free route to the active workspace and underlying component state.
     * @returns {Promise<void>}
     */
    async copyActiveWorkspaceLink() {
        if (!this.workspace) return;
        const route = this.buildWorkspaceShareRoute();
        const relative = formatAppRoute(route, this.routeController.basePath);
        const url = new URL(relative, window.location.origin).toString();
        try {
            await navigator.clipboard.writeText(url);
            this.toast("Workspace link copied.", 2400, "success");
        } catch {
            window.prompt("Copy this workspace link:", url);
        }
    }

    /**
     * Creates and copies a bearer-capability link after the owner explicitly supplies a dedicated token.
     * Clipboard failure never falls back to a visible prompt, avoiding accidental on-screen disclosure of the encoded bearer payload.
     * @returns {Promise<void>}
     */
    async copyActiveCapabilityLink() {
        this.setError(this.workspaceShareErrorEl, "");
        const token = this.workspaceShareTokenInput.value.trim();
        try {
            const link = formatCapabilityLink(
                this.buildWorkspaceShareRoute(),
                token,
                window.location.origin,
                this.routeController.basePath,
            );
            await navigator.clipboard.writeText(link);
            this.workspaceShareTokenInput.value = "";
            this.toast("Capability link copied. Share it as securely as the token itself.", 4500, "success");
        } catch (error) {
            this.setError(this.workspaceShareErrorEl, safeText(error));
        }
    }

    /**
     * Displays a scrubbed capability import for explicit recipient consent.
     * No credential is persisted or sent while this dialog is open; custom provider hosts additionally require a dedicated trust checkbox.
     * @returns {void}
     */
    openCapabilityImportDialog() {
        const capability = this.capabilityImport;
        const locator = capability?.route.workspace || null;
        if (!capability || !locator) return;
        this.capabilityImportDetailsEl.textContent = this.describeWorkspaceLocator(locator);
        this.capabilityRememberInput.checked = false;
        this.capabilityHostConfirmInput.checked = false;
        setVisible(this.capabilityHostConfirmWrap, capability.requiresHostConfirmation);
        if (capability.requiresHostConfirmation) {
            let host = locator.repositoryUrl;
            try {
                host = new URL(locator.repositoryUrl).host;
            } catch {
                // Locator validation already bounded the repository text.
            }
            this.capabilityHostConfirmTextEl.textContent = `I trust ${host} and permit sending the credential to this custom provider host.`;
        }
        this.setError(this.capabilityImportErrorEl, "");
        if (!this.capabilityImportDialog.open) this.capabilityImportDialog.showModal();
    }

    /**
     * Discards an imported bearer credential while retaining the public route as an independently authenticatable locator.
     * @returns {void}
     */
    cancelCapabilityImport() {
        this.capabilityImport = null;
        if (this.capabilityImportDialog.open) this.capabilityImportDialog.close();
        this.showLoginScreen();
        this.setError(this.loginErrorEl, "Capability not imported. Enter your own credential to open this workspace.");
    }

    /**
     * Accepts a scrubbed capability, stores its credential in the explicitly selected tier, and only then starts provider access.
     * The registry entry is bound to the capability's validated locator before component state is restored.
     * @returns {Promise<void>}
     */
    async acceptCapabilityImport() {
        const capability = this.capabilityImport;
        const locator = capability?.route.workspace || null;
        if (!capability || !locator) return;
        if (capability.requiresHostConfirmation && !this.capabilityHostConfirmInput.checked) {
            this.setError(this.capabilityImportErrorEl, "Confirm the custom provider host before opening this capability.");
            return;
        }
        if (locator.provider !== "github") {
            this.setError(this.capabilityImportErrorEl, `${locator.provider} connections are not available yet.`);
            return;
        }

        try {
            const connection = this.workspaceRegistry.upsert(locator, {
                expectedWorkspaceId: locator.expectedWorkspaceId,
            });
            this.workspaceRegistry.setActive(connection.id);
            this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
            this.configService.saveWorkspaceCredential(
                connection.id,
                capability.credential,
                this.capabilityRememberInput.checked,
            );
            this.activateWorkspaceConnection(connection, capability.credential);
            this.pendingRoute = capability.route;
            this.capabilityImport = null;
            this.capabilityImportDialog.close();
            await this.connectWithToken(this.token);
        } catch (error) {
            this.setError(this.capabilityImportErrorEl, safeText(error));
        }
    }

    /**
     * Builds the IndexedDB namespace used for unsaved week drafts.
     * Browser origins already isolate local servers, while GitHub mode additionally separates owner, repository, and branch.
     * @returns {string}
     */
    buildDraftNamespace() {
        if (this.isLocalMode) {
            return `local:${this.activeWorkspaceConnection?.expectedWorkspaceId || this.workspace?.workspace_id || "default"}`;
        }
        if (this.activeWorkspaceConnection) return `workspace:${this.activeWorkspaceConnection.id}`;
        const owner = String(this.config.owner || "").trim();
        const repo = String(this.config.repo || "").trim();
        const ref = String(this.config.ref || "").trim();
        return `github:${owner}/${repo}@${ref}`;
    }

    /**
     * Returns the public locator for the active local folder or GitHub repository.
     * The expected workspace id is included only after zeitplural.json has loaded; credentials are held separately and can never enter this object.
     * @returns {import("./routing.js").WorkspaceRouteLocator}
     */
    getCurrentWorkspaceRouteLocator() {
        if (this.isLocalMode) {
            return {
                provider: "local",
                repositoryUrl: "",
                ref: "",
                workspacePath: this.config.workspacePath || "zeitplural.json",
                expectedWorkspaceId:
                    this.workspace?.workspace_id ||
                    this.activeWorkspaceConnection?.expectedWorkspaceId ||
                    String(this.config.localWorkspaceId || ""),
            };
        }
        if (this.activeWorkspaceConnection) {
            return {
                ...this.activeWorkspaceConnection.toLocator(),
                expectedWorkspaceId: this.workspace?.workspace_id || this.activeWorkspaceConnection.expectedWorkspaceId || "",
            };
        }
        return {
            provider: "github",
            repositoryUrl: formatGitHubRepositoryUrl(this.config.owner, this.config.repo),
            ref: this.config.ref,
            workspacePath: this.config.workspacePath || "zeitplural.json",
            expectedWorkspaceId: this.workspace?.workspace_id || "",
        };
    }

    /**
     * Captures the active component and all navigation-relevant view state in the route model.
     * Time search shares one route state with the week timeline, while TODO filters remain wholly owned by TodoView.
     * @returns {import("./routing.js").AppRoute}
     */
    buildCurrentRoute() {
        const globalPanel = this.activeGlobalPanel === "workspaces" ? "workspaces" : null;
        if (this.state.activeTab === "todos") {
            return {
                version: 1,
                component: "todos",
                panel: globalPanel || "main",
                workspace: this.getCurrentWorkspaceRouteLocator(),
                state: this.todoView.getRouteState(),
            };
        }

        const underlyingPanel = this.state.activeTab === "search" ? "search" : "main";
        const panel = globalPanel || underlyingPanel;
        return {
            version: 1,
            component: "time",
            panel,
            workspace: this.getCurrentWorkspaceRouteLocator(),
            state: {
                ...this.weekView.getRouteState(),
                ...(underlyingPanel === "search" ? this.searchView.getRouteState() : {}),
                ...(globalPanel && underlyingPanel === "search" ? { returnPanel: "search" } : {}),
            },
        };
    }

    /**
     * Writes the latest initialized application state to browser history.
     * Pushes are reserved for component/panel navigation; view interactions use debounced replacement through scheduleRouteReplace().
     * @param {"push" | "replace"} [mode] History mutation kind.
     * @returns {void}
     */
    writeCurrentRoute(mode = "replace") {
        if (this.routeRestoreInProgress || this.appSection.hidden || !this.workspace) return;
        this.routeController.write(this.buildCurrentRoute(), mode);
    }

    /**
     * Schedules a high-frequency route update for scroll, zoom, filters, and selection.
     * The lazy route factory captures state after the final event in a burst and keeps browser Back/Forward focused on meaningful navigation.
     * @returns {void}
     */
    scheduleRouteReplace() {
        if (this.routeRestoreInProgress || this.appSection.hidden || !this.workspace) return;
        this.routeController.scheduleReplace(() => this.buildCurrentRoute());
    }

    /**
     * Maps a component-first route to the existing view identifiers used by AppState.
     * @param {import("./routing.js").AppRoute} route Parsed route.
     * @returns {"week" | "todos" | "search"}
     */
    tabForRoute(route) {
        if (route.component === "todos") return "todos";
        if (
            route.component === "time" &&
            (route.panel === "search" || (route.panel === "workspaces" && route.state.returnPanel === "search"))
        ) {
            return "search";
        }
        return "week";
    }

    /**
     * Normalizes a requested component against both the loaded workspace and the components implemented in this release.
     * Unavailable TODO or future Expense routes fall back to an enabled Time component, then to TODOs, without leaving a broken blank surface.
     * @param {import("./routing.js").AppRoute} route Requested route.
     * @returns {import("./routing.js").AppRoute}
     */
    normalizeLoadedRoute(route) {
        if (!this.workspace || !route.component) return this.buildCurrentRoute();
        const hasTime = this.workspace.hasComponent("time_tracking");
        const hasTodos = this.workspace.hasComponent("todos");
        let component = route.component;
        let panel = route.panel;

        if (component === "expenses" || (component === "time" && !hasTime) || (component === "todos" && !hasTodos)) {
            component = hasTime ? "time" : hasTodos ? "todos" : "time";
            panel = "main";
        }
        if (component !== "time" && panel === "search") panel = "main";
        return { ...route, component, panel };
    }

    /**
     * Applies a parsed route after workspace documents and view models are ready.
     * Route-originated changes are suppressed until the next animation frame, then one normalized replaceState records any safe fallback.
     * @param {import("./routing.js").AppRoute} route Requested route.
     * @returns {void}
     */
    applyLoadedRoute(route) {
        const normalized = this.normalizeLoadedRoute(route);
        this.routeRestoreInProgress = true;
        const tab = this.tabForRoute(normalized);
        this.setTab(tab, "none");
        if (normalized.component === "time") {
            this.weekView.restoreRouteState(normalized.state);
            if (tab === "search") this.searchView.restoreRouteState(normalized.state);
        } else if (normalized.component === "todos") {
            this.todoView.restoreRouteState(normalized.state);
        }
        if (normalized.panel === "workspaces") this.openWorkspaceSettings("none");
        else this.closeWorkspaceSettings("none");

        window.requestAnimationFrame(() => {
            this.routeRestoreInProgress = false;
            this.routeController.write(this.buildCurrentRoute(), "replace");
        });
    }

    /**
     * Reports whether a locator addresses the active repository connection.
     * The expected workspace id is verified separately after loading because an empty first-connection locator is still allowed.
     * @param {import("./routing.js").WorkspaceRouteLocator | null} locator Requested workspace locator.
     * @returns {boolean}
     */
    routeTargetsCurrentConnection(locator) {
        if (!locator) return true;
        if (this.isLocalMode) {
            return (
                locator.provider === "local" &&
                (!locator.expectedWorkspaceId ||
                    locator.expectedWorkspaceId ===
                        (this.activeWorkspaceConnection?.expectedWorkspaceId || this.workspace?.workspace_id || ""))
            );
        }
        if (locator.provider !== "github") return false;
        try {
            const repository = parseGitHubRepository(locator.repositoryUrl);
            return (
                repository.owner.toLowerCase() === this.config.owner.toLowerCase() &&
                repository.repo.toLowerCase() === this.config.repo.toLowerCase() &&
                locator.ref === this.config.ref &&
                locator.workspacePath === (this.config.workspacePath || "zeitplural.json")
            );
        } catch {
            return false;
        }
    }

    /**
     * Handles Back/Forward navigation after RouteController has parsed the new address.
     * A locator for another repository is prefilled but never receives the current repository's credential automatically; the user authenticates that connection explicitly.
     * @param {import("./routing.js").AppRoute} route Parsed browser route.
     * @returns {Promise<void>}
     */
    async handleRouteNavigation(route) {
        if (!route.component) {
            if (this.isLocalMode && this.workspace) {
                this.routeController.write(this.buildCurrentRoute(), "replace");
                return;
            }
            this.pendingRoute = null;
            this.showLoginScreen();
            return;
        }

        this.pendingRoute = route;
        if (!this.routeTargetsCurrentConnection(route.workspace)) {
            if (this.isLocalMode && route.workspace?.provider === "local") {
                const localConnection = this.workspaceRegistry.findByLocator(route.workspace);
                if (localConnection) {
                    await this.switchWorkspace(localConnection.id, route);
                    return;
                }
                this.routeController.write(this.buildCurrentRoute(), "replace");
                this.toast("That workspace is not exposed by the local server.", 5000);
                return;
            }
            if (route.workspace?.provider === "github") {
                this.repositoryInput.value = route.workspace.repositoryUrl;
                this.refInput.value = route.workspace.ref;
                const registered = this.workspaceRegistry.findByLocator(route.workspace);
                if (registered) {
                    const credential = this.configService.loadWorkspaceCredential(registered.id);
                    this.rememberInput.checked = this.configService.isWorkspaceCredentialRemembered(registered.id);
                    if (credential && this.workspace && !this.appSection.hidden) {
                        await this.switchWorkspace(registered.id, route);
                        return;
                    }
                } else {
                    this.rememberInput.checked = false;
                }
            }
            this.showLoginScreen();
            this.setError(this.loginErrorEl, "Authenticate to open the workspace named in this link.");
            return;
        }

        if (this.workspace && !this.appSection.hidden) {
            this.applyLoadedRoute(route);
            return;
        }
        if (this.token) {
            try {
                await this.connectWithToken(this.token);
            } catch (error) {
                this.setError(this.loginErrorEl, safeText(error));
            }
        } else {
            this.showLoginScreen();
        }
    }

    /**
     * Discovers every repository exposed by server.py and builds a local workspace registry from their public ids.
     * The server remains the sole authority over filesystem paths; browser routes and persisted records contain only workspace_id, display name, and bootstrap path.
     * @returns {Promise<void>}
     */
    async initializeLocalMode() {
        this.showLoadingScreen("Discovering local workspaces…");
        try {
            const discoverySource = new LocalDataSource(this.config);
            const catalog = await discoverySource.fetchAvailableWorkspaces();
            if (!catalog.workspaces.length) throw new Error("The local server exposes no workspaces.");

            const persistedOrder = new Map(
                this.configService
                    .loadWorkspaceRegistry(this.config)
                    .list()
                    .filter((connection) => connection.provider === "local")
                    .map((connection, index) => [connection.id, index]),
            );
            const registry = new WorkspaceRegistry();
            const connections = catalog.workspaces.map((item) =>
                registry.upsert(
                    {
                        provider: "local",
                        repositoryUrl: "",
                        ref: "",
                        workspacePath: item.workspace_path,
                        expectedWorkspaceId: item.workspace_id,
                    },
                    { displayName: item.name, expectedWorkspaceId: item.workspace_id },
                ),
            );
            registry.connections.sort(
                (left, right) =>
                    (persistedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
                        (persistedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
                    left.order - right.order,
            );
            registry.reindex();

            const requestedWorkspaceId =
                this.pendingRoute?.workspace?.expectedWorkspaceId ||
                String(this.config.localWorkspaceId || "") ||
                catalog.default_workspace_id;
            const selected =
                connections.find((connection) => connection.expectedWorkspaceId === requestedWorkspaceId) ||
                connections.find((connection) => connection.expectedWorkspaceId === catalog.default_workspace_id) ||
                connections[0];
            if (!selected) throw new Error("The local server did not provide a selectable workspace.");

            this.workspaceRegistry = registry;
            this.activateWorkspaceConnection(selected, "");
            this.dataSource = new LocalDataSource(this.config);
            this.weekView.setDataSource(this.dataSource);
            this.todoView.setDataSource(this.dataSource);
            this.projectDialog.setDataSource(this.dataSource);
            this.pendingRoute = this.pendingRoute
                ? { ...this.pendingRoute, workspace: selected.toLocator() }
                : {
                      version: 1,
                      component: "time",
                      panel: "main",
                      workspace: selected.toLocator(),
                      state: {},
                  };
            this.setAuthStatus("Local mode");
            await this.reloadData();
        } catch (error) {
            this.showLoadingError(safeText(error));
        }
    }

    /**
     * Boots the application and triggers the initial load flow.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    start() {
        this.repositoryInput.value = formatGitHubRepositoryUrl(this.config.owner, this.config.repo);
        this.refInput.value = this.config.ref;
        this.rememberInput.checked = this.activeWorkspaceConnection
            ? this.configService.isWorkspaceCredentialRemembered(this.activeWorkspaceConnection.id)
            : this.configService.isTokenRemembered();
        if (this.pendingRoute) this.state.setActiveTab(this.tabForRoute(this.pendingRoute));

        this.loginForm.addEventListener("submit", (ev) => this.handleLoginSubmit(ev));
        this.clearSavedBtn.addEventListener("click", () => this.handleClearSaved());
        this.workspaceSettingsBtn.addEventListener("click", () => {
            if (this.workspaceDialog.open) this.closeWorkspaceSettings();
            else this.openWorkspaceSettings();
        });
        this.workspaceDialogCloseBtn.addEventListener("click", () => this.closeWorkspaceSettings());
        this.workspaceDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.closeWorkspaceSettings();
        });
        this.workspaceAddForm.addEventListener("submit", (ev) => void this.handleWorkspaceAdd(ev));
        this.workspaceListEl.addEventListener("click", (ev) => void this.handleWorkspaceListClick(ev));
        this.workspaceShareBtn.addEventListener("click", () => this.openWorkspaceShareDialog());
        this.workspaceShareCloseBtn.addEventListener("click", () => this.closeWorkspaceShareDialog());
        this.workspaceShareDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.closeWorkspaceShareDialog();
        });
        this.workspaceCopyLocatorBtn.addEventListener("click", () => void this.copyActiveWorkspaceLink());
        this.workspaceCopyCapabilityBtn.addEventListener("click", () => void this.copyActiveCapabilityLink());
        this.capabilityImportCancelBtn.addEventListener("click", () => this.cancelCapabilityImport());
        this.capabilityImportOpenBtn.addEventListener("click", () => void this.acceptCapabilityImport());
        this.capabilityImportDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.cancelCapabilityImport();
        });
        this.menuWeekBtn.addEventListener("click", () => this.setTab("week"));
        this.menuTodoBtn.addEventListener("click", () => this.setTab("todos"));
        this.menuSearchBtn.addEventListener("click", () => {
            this.setTab("search");
            queueMicrotask(() => this.searchInput.focus());
        });
        this.appZoomOutBtn.addEventListener("click", () => this.nudgeAppZoom(-1));
        this.appZoomResetBtn.addEventListener("click", () => this.setAutomaticAppZoom());
        this.appZoomInBtn.addEventListener("click", () => this.nudgeAppZoom(1));
        this.appThemeToggleBtn.addEventListener("click", () => this.toggleTheme());
        this.landingThemeToggleBtn.addEventListener("click", () => this.toggleTheme());
        this.projectsBtn.addEventListener("click", () => this.projectDialog.open());
        this.logoutBtn.addEventListener("click", () => this.logout());
        this.reloadDataBtn.addEventListener("click", () => void this.reloadData());
        this.searchInput.addEventListener("input", () => {
            if (this.appSection.hidden || this.state.activeTab === "search" || this.state.activeTab === "todos") return;
            this.searchView.setSearchQuery(this.searchInput.value);
            if (this.searchInput.value.trim()) this.setTab("search");
        });
        this.loadingRetryBtn.addEventListener("click", () => void this.reloadData());
        this.loadingLogoutBtn.addEventListener("click", () => this.logout());
        this.editorBadgeEl.addEventListener("click", () => this.saveActiveView());

        document.addEventListener("keydown", (ev) => this.handleGlobalKeydown(ev));
        window.addEventListener("resize", () => this.handleResize());
        this.routeController.start((route) => void this.handleRouteNavigation(route));

        this.setProgress(0, 1, "");
        setVisible(this.sidebarEl, false);
        setVisible(this.topbarEl, false);
        setVisible(this.loadingSection, false);

        if (this.capabilityImportStartupError) {
            this.showLoginScreen();
            this.setError(this.loginErrorEl, this.capabilityImportStartupError);
            return;
        }
        if (this.capabilityImport) {
            this.showLoginScreen();
            this.openCapabilityImportDialog();
            return;
        }

        if (this.isLocalMode) {
            this.setAuthStatus("Local mode");
            setVisible(this.logoutBtn, false);
            setVisible(this.reloadDataBtn, true);
            setVisible(this.projectsBtn, true);
            void this.initializeLocalMode();
            return;
        }

        setVisible(this.logoutBtn, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.projectsBtn, false);

        if (!this.pendingRoute) {
            this.setAuthStatus(this.token ? "Saved connection available" : "Not logged in");
            this.showLoginScreen();
        } else if (this.token) {
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
     * Shows the login form and hides both initialized and loading application surfaces.
     * This is the stable unauthenticated state used at startup, after connection failures, and after logout.
     * @returns {void}
     */
    showLoginScreen() {
        document.body.classList.remove("app-ready");
        setVisible(this.sidebarEl, false);
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
        document.body.classList.remove("app-ready");
        setVisible(this.sidebarEl, false);
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
        setVisible(this.sidebarEl, true);
        setVisible(this.topbarEl, true);
        setVisible(this.appSection, true);
        this.loadingSection.setAttribute("aria-busy", "false");
        this.setAppMode(true);
        this.setTab(this.state.activeTab, "none");
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
                if (this.state.activeTab !== "todos") this.setTab("search");
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
            const isStandardZoomOut = key === "-" || key === "_" || ev.code === "Minus";
            const isStandardZoomIn = key === "+" || key === "=" || ev.code === "Equal";
            if (isZoomOut || isZoomIn || isStandardZoomOut || isStandardZoomIn) {
                if (this.state.activeTab === "week" && !(this.appSection.hidden || this.weekViewSection.hidden)) {
                    ev.preventDefault();
                    this.weekView.nudgeZoom(isZoomOut || isStandardZoomOut ? -1 : 1);
                }
                return;
            }
        }

        if (this.state.activeTab === "todos" && this.todoView.handleKeydown(ev)) return;
        this.weekView.handleKeydown(ev);
    }

    /**
     * Saves the document owned by the active editable view.
     * The shared Saved/Changed control uses the same persistence methods as Ctrl+S, so Week and TODO status never diverge.
     * @returns {void}
     */
    saveActiveView() {
        if (this.state.activeTab === "todos") {
            void this.todoView.saveNow();
            return;
        }
        if (this.state.activeTab === "week") {
            void this.weekView.saveDirtyWeeksNow();
            this.weekView.focusTimeline();
        }
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
            if (this.uiZoomMode === "auto") {
                const recommendedUiZoom = this.getRecommendedAppZoom();
                if (recommendedUiZoom !== this.uiZoom) {
                    this.setAppZoom(recommendedUiZoom, false, "auto");
                }
            }
            this.updateResponsiveLayout();
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

        const ref = this.refInput.value.trim();
        const pendingConnection = this.workspaceRegistry.findByLocator(this.pendingRoute?.workspace || null);
        const fallbackToken = pendingConnection
            ? this.configService.loadWorkspaceCredential(pendingConnection.id)
            : this.routeTargetsCurrentConnection(this.pendingRoute?.workspace || null)
              ? this.token
              : "";
        const tok = this.tokenInput.value.trim() || fallbackToken;
        const remember = this.rememberInput.checked;

        if (!this.repositoryInput.value.trim() || !ref || !tok) {
            this.setError(this.loginErrorEl, "Please fill in the repository URL, ref, and token.");
            return;
        }

        let repository;
        try {
            repository = parseGitHubRepository(this.repositoryInput.value);
        } catch (error) {
            this.setError(this.loginErrorEl, safeText(error));
            return;
        }

        const expectedWorkspaceId = String(this.pendingRoute?.workspace?.expectedWorkspaceId || "");
        const workspacePath = String(this.pendingRoute?.workspace?.workspacePath || this.config.workspacePath || "zeitplural.json");
        const locator = {
            provider: /** @type {const} */ ("github"),
            repositoryUrl: formatGitHubRepositoryUrl(repository.owner, repository.repo),
            ref,
            workspacePath,
            expectedWorkspaceId,
        };
        const connection = this.workspaceRegistry.upsert(locator, { expectedWorkspaceId });
        this.workspaceRegistry.setActive(connection.id);
        this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
        this.configService.saveWorkspaceCredential(connection.id, tok, remember);
        this.activateWorkspaceConnection(connection, tok);
        if (!this.pendingRoute) {
            this.pendingRoute = {
                version: 1,
                component: "time",
                panel: "main",
                workspace: connection.toLocator(),
                state: {},
            };
        } else {
            this.pendingRoute = {
                ...this.pendingRoute,
                workspace: connection.toLocator(),
            };
        }
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
        this.token = "";
        this.state.setToken("");
        this.config = { ...DEFAULT_CONFIG };
        this.workspaceRegistry = this.configService.loadWorkspaceRegistry(this.config);
        this.activeWorkspaceConnection = null;
        this.state.setConfig(this.config);
        this.setTheme(this.config.theme, false);
        this.setAutomaticAppZoom(false);
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
        this.repositoryInput.value = formatGitHubRepositoryUrl(this.config.owner, this.config.repo);
        this.refInput.value = this.config.ref;
        this.tokenInput.value = "";
        this.rememberInput.checked = false;
        this.setAuthStatus("Cleared");
        this.pendingRoute = null;
        this.routeController.write({ version: 1, component: null, panel: "main", workspace: null, state: {} }, "replace");
    }

    /**
     * Updates the authentication status display.
     * Keeps the main UI flow and data loading coordinated.
     * @param {string} text
     * @returns {void}
     */
    setAuthStatus(text) {
        this.authStatusEl.textContent = text;
        this.authStatusEl.title = text;
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
        this.workspaceSettingsBtn.disabled = isBusy;
        this.workspaceDialogCloseBtn.disabled = isBusy;
        this.workspaceProviderInput.disabled = isBusy;
        this.workspaceRepositoryInput.disabled = isBusy;
        this.workspaceRefInput.disabled = isBusy;
        this.workspacePathInput.disabled = isBusy;
        this.workspaceTokenInput.disabled = isBusy;
        this.workspaceRememberInput.disabled = isBusy;
        this.workspaceShareBtn.disabled = isBusy || !this.workspace;
        this.workspaceShareCloseBtn.disabled = isBusy;
        this.workspaceCopyLocatorBtn.disabled = isBusy;
        this.workspaceShareTokenInput.disabled = isBusy || this.isLocalMode;
        this.workspaceCopyCapabilityBtn.disabled = isBusy || this.isLocalMode;
        this.capabilityRememberInput.disabled = isBusy;
        this.capabilityHostConfirmInput.disabled = isBusy;
        this.capabilityImportCancelBtn.disabled = isBusy;
        this.capabilityImportOpenBtn.disabled = isBusy;
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
        this.weekView.setBusy(isBusy);
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
     * @param {"push" | "replace" | "none"} [historyMode] Whether this navigation should create, replace, or leave browser history.
     * @returns {void}
     */
    setTab(tab, historyMode = "push") {
        const next = tab === "search" || tab === "todos" ? tab : "week";
        const searchesTodos = next === "todos";
        const searchQuery = searchesTodos ? this.todoView.getSearchQuery() : this.searchView.getSearchQuery();
        this.searchInput.value = searchQuery;
        this.searchInput.placeholder = searchesTodos ? "Search TODOs…" : "Search time entries…";
        this.searchInput.setAttribute("aria-label", searchesTodos ? "Search TODOs" : "Search time entries");
        this.globalSearchEl.title = searchesTodos ? "Search TODOs (Ctrl+K)" : "Search time entries (Ctrl+K)";
        this.state.setActiveTab(next);
        this.topbarEl.dataset.activeTab = next;
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
        setVisible(this.todoTopbarControlsEl, next === "todos" && !this.topbarEl.hidden);
        setVisible(this.editorBadgeEl, next !== "search" && !this.topbarEl.hidden);
        this.refreshDataBadge();
        if (historyMode !== "none") this.writeCurrentRoute(historyMode);
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
            this.repositorySummary = "";
            this.refreshDataBadge();
            return;
        }

        const totals = [];
        totals.push(`${manifest.chunks.length} week file(s)`);
        if (typeof manifest.total_entries === "number" && Number.isFinite(manifest.total_entries)) {
            totals.push(`${manifest.total_entries} entries`);
        }
        totals.push(`${this.todoStore.getTodos().length} TODOs`);
        if (manifest.generated_at) totals.push(`manifest @ ${manifest.generated_at}`);

        const workspaceName = this.workspace?.name ? `${this.workspace.name} • ` : "";
        if (this.isLocalMode) {
            this.repositorySummary = `${workspaceName}Local data • ${totals.join(" • ")}`;
        } else {
            this.repositorySummary = `${workspaceName}${this.config.owner}/${this.config.repo}@${this.config.ref} • ${totals.join(" • ")}`;
        }
        this.refreshDataBadge();
    }

    /**
     * Chooses the content of the shared bottom-right overlay for the active view.
     * TODO mode shows task counts; Week and Search retain repository/manifest diagnostics.
     * @returns {void}
     */
    refreshDataBadge() {
        this.repoLabelEl.textContent = this.state.activeTab === "todos" ? this.todoSummary : this.repositorySummary;
    }

    /**
     * Loads and installs the root zeitplural workspace configuration before component documents are requested.
     * The workspace supplies all repository paths and the shared timezone, allowing the same application build to operate against local, GitHub, and future provider-backed repositories.
     * @returns {Promise<void>}
     */
    async fetchWorkspace() {
        this.setProgress(0, 1, this.isLocalMode ? "Loading workspace (local)…" : "Loading workspace…");
        const raw = await this.dataSource.fetchWorkspace();
        const workspace = Workspace.fromRaw(raw);
        const expectedWorkspaceId = String(this.pendingRoute?.workspace?.expectedWorkspaceId || "");
        if (expectedWorkspaceId && workspace.workspace_id !== expectedWorkspaceId) {
            throw new Error(
                `Workspace identity mismatch: the link expects ${expectedWorkspaceId}, but the repository contains ${workspace.workspace_id}.`,
            );
        }
        this.workspace = workspace;
        this.dataSource.setWorkspace(workspace);
        this.timeContext.setTimeZone(workspace.timezone);
        this.config = { ...this.config, timezone: workspace.timezone };
        this.state.setConfig(this.config);
        if (!this.isLocalMode) {
            const locator = this.activeWorkspaceConnection?.toLocator() || this.getCurrentWorkspaceRouteLocator();
            const connection = this.workspaceRegistry.upsert(locator, {
                displayName: workspace.name,
                expectedWorkspaceId: workspace.workspace_id,
            });
            this.workspaceRegistry.setActive(connection.id);
            this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
            this.activeWorkspaceConnection = connection;
        }
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
    }

    /**
     * Loads the entries manifest from the data source.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async fetchManifest() {
        this.setProgress(0, 1, this.isLocalMode ? "Loading manifest (local)…" : "Loading manifest…");
        const raw = await this.dataSource.fetchManifest();
        const manifest = Manifest.fromRaw(raw, this.dataSource.getEntriesDirectory());
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
        const raw = await this.dataSource.fetchProjects();
        const projectList = ProjectList.fromRaw(raw || {});
        this.store.setProjectList(projectList);
        this.weekView.setProjects(projectList);
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

        this.setProgress(memoryHits, chunkFiles.length, `Checking ${cacheCandidates.length} cached week files…`);
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
                `Downloading ${downloadChunks.length} week files in bulk…`,
            );
            downloadedRawBySha = await this.dataSource.fetchChunkTexts(downloadChunks);
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
            this.setProgress(index + 1, chunkFiles.length, `Preparing ${index + 1}/${chunkFiles.length} • ${key}`);
        }

        const cacheSummary = ` • memory ${memoryHits} • cached ${cacheHits} • downloaded ${downloadChunks.length}`;
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
        this.store.clear();
        this.todoStore.clear();
        this.todoView.reset();
        try {
            await this.fetchWorkspace();
            await Promise.all([this.fetchManifest(), this.fetchProjects()]);
            await Promise.all([this.fetchWeekRequirements(), this.fetchTodos()]);
            await this.loadAllChunks();
            const requestedRoute = this.pendingRoute;
            this.routeRestoreInProgress = Boolean(requestedRoute);
            this.showApplicationScreen();
            if (requestedRoute) {
                this.pendingRoute = null;
                this.applyLoadedRoute(requestedRoute);
            } else {
                this.routeController.write(this.buildCurrentRoute(), "replace");
            }
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
     * @param {{repoInfo: any, userInfo: any} | null} [connectionInfo] Optional successful preflight result used to avoid duplicate provider checks while switching.
     * @returns {Promise<void>}
     */
    async connectWithToken(token, connectionInfo = null) {
        this.token = token;
        this.state.setToken(token);
        this.dataSource = new GitHubDataSource(this.config, token);
        this.workspace = null;
        this.weekView.setDataSource(this.dataSource);
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDataSource(this.dataSource);
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
        this.projectDialog.setDataSource(this.dataSource);
        this.setAuthStatus("Connecting…");
        this.showLoadingScreen("Connecting to GitHub…");
        this.setBusy(true);
        try {
            const { repoInfo, userInfo } = connectionInfo || (await this.dataSource.checkConnection());
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
     * Clears the mounted workspace and returns to login.
     * Ordinary logout forgets only the active workspace credential; disconnect callers can remove the registry row first and suppress duplicate credential cleanup.
     * @param {boolean} [clearCredential] Whether to remove the active connection's stored credential.
     * @returns {void}
     */
    logout(clearCredential = true) {
        if (clearCredential && this.activeWorkspaceConnection) {
            this.configService.clearWorkspaceCredential(this.activeWorkspaceConnection.id);
        }
        this.token = "";
        this.state.setToken("");
        this.state.ghUser = null;
        this.state.setWeekStart(null);
        this.state.setLatestWeekStart(null);
        this.workspace = null;
        this.pendingRoute = null;
        this.store.clear();
        this.todoStore.clear();
        this.chunkCache.clearMemory();
        this.weekView.reset();
        this.todoView.reset();
        this.searchView.reset();
        this.searchInput.value = "";
        this.setProgress(0, 1, "");
        this.setAuthStatus("Not logged in");
        this.repositorySummary = "";
        this.todoSummary = "";
        this.refreshDataBadge();
        this.projectDialog.close();
        this.closeWorkspaceSettings("none");
        setVisible(this.weekControlsEl, false);
        setVisible(this.todoTopbarControlsEl, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.logoutBtn, false);
        setVisible(this.projectsBtn, false);
        this.showLoginScreen();
        const activeConnection = this.activeWorkspaceConnection || this.workspaceRegistry.getActive();
        if (activeConnection) {
            this.activeWorkspaceConnection = activeConnection;
            this.config = configForRouteWorkspace(this.config, activeConnection.toLocator());
            this.state.setConfig(this.config);
            this.repositoryInput.value = activeConnection.repositoryUrl;
            this.refInput.value = activeConnection.ref;
            if (!clearCredential) {
                this.token = this.configService.loadWorkspaceCredential(activeConnection.id);
                this.state.setToken(this.token);
            }
        }
        this.tokenInput.value = "";
        this.rememberInput.checked = Boolean(
            !clearCredential &&
                activeConnection &&
                this.configService.isWorkspaceCredentialRemembered(activeConnection.id),
        );
        this.routeController.write({ version: 1, component: null, panel: "main", workspace: null, state: {} }, "replace");
    }
}

const app = new App();
app.start();
