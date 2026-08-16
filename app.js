import { AppState } from "./appstate.js";
import { ChunkCache, DraftJournal } from "./cache.js";
import {
    ConfigService,
    DEFAULT_CONFIG,
    formatGitHubRepositoryUrl,
    getEffectiveUiViewportWidth,
    getRecommendedUiZoom,
    inferHostedProvider,
    parseGitHubRepository,
    WorkspaceRegistry,
} from "./config.js";
import { createHostedDataSource, LocalDataSource } from "./datasource.js";
import { EntryStore, ExpenseStore, TodoStore } from "./store.js";
import { ExpenseView } from "./expense.view.js";
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
import {
    ExpenseDocument,
    ExpenseManifest,
    Manifest,
    ProjectList,
    TodoList,
    WeekRequirements,
    Workspace,
} from "./model.js";
import { LocaleService, resolveLocale } from "./locale.js";
import {
    consumeOAuthCallback,
    readOAuthClientId,
    refreshOAuthCredential,
    startOAuthAuthorization,
} from "./oauth.js";
import {
    consumeCapabilityLink,
    formatAppRoute,
    formatCapabilityLink,
    getApplicationBasePath,
    normalizeWorkspaceRouteLocator,
    RouteController,
    workspaceRouteLocatorKey,
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
 * Applies a credential-free route locator to the active provider configuration.
 * GitHub retains owner/repo fields for its REST and GraphQL endpoints; every provider also receives the full normalized repository URL used by the shared data-source factory.
 * @param {import("./config.js").AppConfig} config Existing application configuration.
 * @param {import("./routing.js").WorkspaceRouteLocator | null} locator Parsed route locator.
 * @returns {import("./config.js").AppConfig}
 */
function configForRouteWorkspace(config, locator) {
    if (!locator) return { ...config };
    const next = {
        ...config,
        provider: locator.provider,
        repositoryUrl: locator.repositoryUrl,
        ref: locator.ref,
        workspacePath: locator.workspacePath,
    };
    if (locator.provider === "github") {
        const repository = parseGitHubRepository(locator.repositoryUrl);
        next.owner = repository.owner;
        next.repo = repository.repo;
    } else if (locator.provider !== "local") {
        const parts = new URL(locator.repositoryUrl).pathname.split("/").filter(Boolean);
        next.owner = parts[0] || "";
        next.repo = String(parts[parts.length - 1] || "").replace(/\.git$/i, "");
    }
    return next;
}

/**
 * Converts one connection form into the same normalized, credential-free locator used by routes and the workspace registry.
 * GitHub's historical owner/repository shorthand remains accepted; every other provider requires a full HTTPS URL so credentials cannot be redirected through an inferred host.
 * @param {string} provider Selected provider identifier.
 * @param {string} repositoryValue Repository URL or GitHub shorthand.
 * @param {string} ref Branch or ref.
 * @param {string} workspacePath Repository-relative bootstrap path.
 * @param {string} [expectedWorkspaceId] Optional identity asserted by a route.
 * @returns {import("./routing.js").WorkspaceRouteLocator}
 */
function buildHostedWorkspaceLocator(provider, repositoryValue, ref, workspacePath, expectedWorkspaceId = "") {
    const selectedProvider = String(provider || "").trim().toLowerCase();
    let repositoryUrl = String(repositoryValue || "").trim();
    if (selectedProvider === "github") {
        const repository = parseGitHubRepository(repositoryUrl);
        repositoryUrl = formatGitHubRepositoryUrl(repository.owner, repository.repo);
    }
    const locator = normalizeWorkspaceRouteLocator({
        provider: selectedProvider,
        repositoryUrl,
        ref: String(ref || "").trim(),
        workspacePath: String(workspacePath || "zeitplural.json").trim(),
        expectedWorkspaceId: String(expectedWorkspaceId || "").trim(),
    });
    if (!locator || locator.provider === "local") throw new Error("Select a supported hosted Git provider.");
    return locator;
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
 * @property {import("./locale.js").LocaleService} locale
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
        this.locale = options.locale;
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
     * Rebuilds an open project editor with labels and sort order from the active locale.
     * The language setting lives in a separate modal, so no in-progress project form can be discarded by this refresh.
     * @returns {void}
     */
    refreshLocale() {
        if (this.dialog.open) this.renderList();
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
            return this.locale.compare(a.name, b.name);
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
        nameSpan.textContent = this.locale.t("projects.name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "project-name";
        nameInput.value = project.name || "";
        nameInput.spellcheck = false;
        nameWrap.append(nameSpan, nameInput);

        const colorWrap = document.createElement("label");
        colorWrap.className = "project-field";
        const colorSpan = document.createElement("span");
        colorSpan.textContent = this.locale.t("projects.color");
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
        billableSpan.textContent = this.locale.t("projects.billable");
        billableWrap.append(billableInput, billableSpan);

        const archivedWrap = document.createElement("label");
        archivedWrap.className = "checkbox project-field";
        const archivedInput = document.createElement("input");
        archivedInput.type = "checkbox";
        archivedInput.className = "project-archived";
        archivedInput.checked = project.archived === true;
        const archivedSpan = document.createElement("span");
        archivedSpan.textContent = this.locale.t("projects.archived");
        archivedWrap.append(archivedInput, archivedSpan);

        fields.append(nameWrap, colorWrap, billableWrap, archivedWrap);

        const sectionsHead = document.createElement("div");
        sectionsHead.className = "project-sections-head";
        const sectionsTitle = document.createElement("span");
        sectionsTitle.textContent = this.locale.t("projects.sections");
        const addSectionBtn = document.createElement("button");
        addSectionBtn.type = "button";
        addSectionBtn.className = "btn btn-secondary project-add-section";
        addSectionBtn.textContent = this.locale.t("projects.addSection");
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
        nameLabel.textContent = this.locale.t("projects.name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "section-name";
        nameInput.value = section.name || "";
        nameInput.spellcheck = false;
        nameWrap.append(nameLabel, nameInput);

        const colorWrap = document.createElement("label");
        colorWrap.className = "project-field section-color-field";
        const colorLabel = document.createElement("span");
        colorLabel.textContent = this.locale.t("projects.colorOverride");
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
        billableLabel.textContent = this.locale.t("projects.billable");
        const billableSelect = document.createElement("select");
        billableSelect.className = "section-billable";
        billableSelect.append(
            new Option(this.locale.t("projects.inherit"), "inherit"),
            new Option(this.locale.t("projects.billable"), "true"),
            new Option(this.locale.t("projects.notBillable"), "false"),
        );
        billableSelect.value = typeof section.billable === "boolean" ? String(section.billable) : "inherit";
        billableWrap.append(billableLabel, billableSelect);

        const archivedWrap = document.createElement("label");
        archivedWrap.className = "checkbox project-field";
        const archivedInput = document.createElement("input");
        archivedInput.type = "checkbox";
        archivedInput.className = "section-archived";
        archivedInput.checked = section.archived === true;
        const archivedLabel = document.createElement("span");
        archivedLabel.textContent = this.locale.t("projects.archived");
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
                return { projects: [], error: this.locale.t("projects.everyProjectName") };
            }
            const nameIdentity = name.toLowerCase();
            if (seenNames.has(nameIdentity)) {
                return { projects: [], error: this.locale.t("projects.duplicateProject", { name }) };
            }
            seenNames.add(nameIdentity);

            const color = colorInput.value.trim();
            if (!/^#[0-9a-f]{6}$/i.test(color)) {
                return { projects: [], error: this.locale.t("projects.invalidColor", { name }) };
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
                if (!sectionName) {
                    return { projects: [], error: this.locale.t("projects.everySectionName", { project: name }) };
                }
                const sectionNameIdentity = sectionName.toLowerCase();
                if (seenSectionNames.has(sectionNameIdentity)) {
                    return {
                        projects: [],
                        error: this.locale.t("projects.duplicateSection", { project: name, section: sectionName }),
                    };
                }
                seenSectionNames.add(sectionNameIdentity);
                const existingSectionKey = sectionRow.dataset.sectionKey || "";
                const sectionKey = existingSectionKey || ProjectList.reserveKey(sectionName, usedSectionKeys);
                const sectionColor = useColorInput.checked ? sectionColorInput.value.trim() : null;
                if (sectionColor !== null && !/^#[0-9a-f]{6}$/i.test(sectionColor)) {
                    return {
                        projects: [],
                        error: this.locale.t("projects.invalidSectionColor", { project: name, section: sectionName }),
                    };
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
        const oauthCallbackRequested = new URL(window.location.href).searchParams.has("oauth_provider");
        if (!oauthCallbackRequested) this.routeController.restoreStaticRoute();
        /** @type {Promise<import("./oauth.js").OAuthCallbackResult | null>} */
        this.oauthCallbackPromise = oauthCallbackRequested
            ? consumeOAuthCallback(window, this.routeController.basePath)
            : Promise.resolve(null);
        this.oauthCallbackRequested = oauthCallbackRequested;
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
        const persistedLocale = this.configService.loadLocale();
        const browserLanguages = Array.isArray(navigator.languages)
            ? navigator.languages
            : navigator.language
              ? [navigator.language]
              : [];
        this.locale = new LocaleService(resolveLocale(persistedLocale, browserLanguages));
        if (!persistedLocale) this.configService.saveLocale(this.locale.locale);
        this.locale.applyDocument(document);
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
        this.expenseStore = new ExpenseStore(this.store);
        this.chunkCache = new ChunkCache();
        this.draftJournal = new DraftJournal();
        this.repositorySummary = "";
        this.todoSummary = "";
        this.expenseSummary = "";
        /** @type {Workspace | null} */
        this.workspace = null;

        this.dataSource = this.isLocalMode
            ? new LocalDataSource(this.config)
            : createHostedDataSource(this.config, this.token);

        this.authStatusEl = getRequiredElement("authStatus", HTMLElement);
        this.logoutBtn = getRequiredElement("logoutBtn", HTMLButtonElement);
        this.loginSection = getRequiredElement("loginSection", HTMLElement);
        this.loginForm = getRequiredElement("loginForm", HTMLFormElement);
        this.loginErrorEl = getRequiredElement("loginError", HTMLElement);
        this.loginOAuthBtn = getRequiredElement("loginOAuthBtn", HTMLButtonElement);
        this.createWorkspaceBtn = getRequiredElement("createWorkspaceBtn", HTMLButtonElement);
        this.clearSavedBtn = getRequiredElement("clearSavedBtn", HTMLButtonElement);

        this.sidebarEl = getRequiredElement("appSidebar", HTMLElement);
        this.topbarEl = getRequiredElement("topbar", HTMLElement);
        this.appHomeLink = getRequiredElement("appHomeLink", HTMLAnchorElement);
        this.workspaceSettingsBtn = getRequiredElement("workspaceSettingsBtn", HTMLButtonElement);
        this.menuWeekBtn = getRequiredElement("menuWeekBtn", HTMLButtonElement);
        this.menuTodoBtn = getRequiredElement("menuTodoBtn", HTMLButtonElement);
        this.menuExpenseBtn = getRequiredElement("menuExpenseBtn", HTMLButtonElement);
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
        this.searchFromLabelEl = getRequiredElement("searchFromLabel", HTMLElement);
        this.searchToLabelEl = getRequiredElement("searchToLabel", HTMLElement);
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

        this.expenseViewEl = getRequiredElement("expenseView", HTMLElement);
        this.expenseBalanceStripEl = getRequiredElement("expenseBalanceStrip", HTMLElement);
        this.expenseCategoryFiltersEl = getRequiredElement("expenseCategoryFilters", HTMLElement);
        this.expenseListEl = getRequiredElement("expenseList", HTMLElement);
        this.expenseTopbarControlsEl = getRequiredElement("expenseTopbarControls", HTMLElement);
        this.expenseAddBtn = getRequiredElement("expenseAddBtn", HTMLButtonElement);
        this.expenseSettleBtn = getRequiredElement("expenseSettleBtn", HTMLButtonElement);
        this.expenseInventoryBtn = getRequiredElement("expenseInventoryBtn", HTMLButtonElement);
        this.expenseDialog = getRequiredElement("expenseDialog", HTMLDialogElement);
        this.expenseForm = getRequiredElement("expenseForm", HTMLFormElement);
        this.expenseDialogTitleEl = getRequiredElement("expenseDialogTitle", HTMLElement);
        this.expenseDialogMetaEl = getRequiredElement("expenseDialogMeta", HTMLElement);
        this.expenseCloseBtn = getRequiredElement("expenseCloseBtn", HTMLButtonElement);
        this.expenseCancelBtn = getRequiredElement("expenseCancelBtn", HTMLButtonElement);
        this.expenseDeleteBtn = getRequiredElement("expenseDeleteBtn", HTMLButtonElement);
        this.expenseDescriptionInput = getRequiredElement("expenseDescription", HTMLInputElement);
        this.expenseDateInput = getRequiredElement("expenseDate", HTMLInputElement);
        this.expenseAmountInput = getRequiredElement("expenseAmount", HTMLInputElement);
        this.expenseCurrencyInput = getRequiredElement("expenseCurrency", HTMLInputElement);
        this.expenseCategorySelect = getRequiredElement("expenseCategory", HTMLSelectElement);
        this.expenseAssignmentInput = getRequiredElement("expenseAssignment", HTMLInputElement);
        this.expenseAssignmentListEl = getRequiredElement("expenseAssignmentList", HTMLDataListElement);
        this.expenseAllocationTypeSelect = getRequiredElement("expenseAllocationType", HTMLSelectElement);
        this.expenseNotesInput = getRequiredElement("expenseNotes", HTMLTextAreaElement);
        this.expenseOwedHeadingEl = getRequiredElement("expenseOwedHeading", HTMLElement);
        this.expenseSplitRowsEl = getRequiredElement("expenseSplitRows", HTMLElement);
        this.expenseSettlementDialog = getRequiredElement("expenseSettlementDialog", HTMLDialogElement);
        this.expenseSettlementCloseBtn = getRequiredElement("expenseSettlementCloseBtn", HTMLButtonElement);
        this.expenseSettlementListEl = getRequiredElement("expenseSettlementList", HTMLElement);
        this.expenseInventoryDialog = getRequiredElement("expenseInventoryDialog", HTMLDialogElement);
        this.expenseInventoryForm = getRequiredElement("expenseInventoryForm", HTMLFormElement);
        this.expenseInventoryCloseBtn = getRequiredElement("expenseInventoryCloseBtn", HTMLButtonElement);
        this.expenseInventoryCancelBtn = getRequiredElement("expenseInventoryCancelBtn", HTMLButtonElement);
        this.expenseAddParticipantBtn = getRequiredElement("expenseAddParticipantBtn", HTMLButtonElement);
        this.expenseAddCategoryBtn = getRequiredElement("expenseAddCategoryBtn", HTMLButtonElement);
        this.expenseParticipantListEl = getRequiredElement("expenseParticipantList", HTMLElement);
        this.expenseCategoryListEl = getRequiredElement("expenseCategoryList", HTMLElement);

        this.providerInput = getRequiredElement("providerInput", HTMLSelectElement);
        this.landingProviderStatusTextEl = getRequiredElement("landingProviderStatusText", HTMLElement);
        this.repositoryInput = getRequiredElement("repositoryInput", HTMLInputElement);
        this.refInput = getRequiredElement("refInput", HTMLInputElement);
        this.tokenInput = getRequiredElement("tokenInput", HTMLInputElement);
        this.rememberInput = getRequiredElement("rememberInput", HTMLInputElement);

        this.workspaceDialog = getRequiredElement("workspaceDialog", HTMLDialogElement);
        this.workspaceDialogCloseBtn = getRequiredElement("workspaceDialogCloseBtn", HTMLButtonElement);
        this.workspaceLanguageSelect = getRequiredElement("workspaceLanguage", HTMLSelectElement);
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
        this.workspaceOAuthBtn = getRequiredElement("workspaceOAuthBtn", HTMLButtonElement);
        this.workspaceCreateBtn = getRequiredElement("workspaceCreateBtn", HTMLButtonElement);

        this.workspaceCreateDialog = getRequiredElement("workspaceCreateDialog", HTMLDialogElement);
        this.workspaceCreateForm = getRequiredElement("workspaceCreateForm", HTMLFormElement);
        this.workspaceCreateCloseBtn = getRequiredElement("workspaceCreateCloseBtn", HTMLButtonElement);
        this.workspaceCreateCancelBtn = getRequiredElement("workspaceCreateCancelBtn", HTMLButtonElement);
        this.workspaceCreateProviderInput = getRequiredElement("workspaceCreateProvider", HTMLSelectElement);
        this.workspaceCreateRepositoryInput = getRequiredElement("workspaceCreateRepository", HTMLInputElement);
        this.workspaceCreateNameInput = getRequiredElement("workspaceCreateName", HTMLInputElement);
        this.workspaceCreateTimezoneInput = getRequiredElement("workspaceCreateTimezone", HTMLInputElement);
        this.workspaceCreateTokenInput = getRequiredElement("workspaceCreateToken", HTMLInputElement);
        this.workspaceCreateRememberInput = getRequiredElement("workspaceCreateRemember", HTMLInputElement);
        this.workspaceCreateProviderNoteEl = getRequiredElement("workspaceCreateProviderNote", HTMLElement);
        this.workspaceCreateErrorEl = getRequiredElement("workspaceCreateError", HTMLElement);
        this.workspaceCreateOAuthBtn = getRequiredElement("workspaceCreateOAuthBtn", HTMLButtonElement);
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
            locale: this.locale,
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
            locale: this.locale,
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
            locale: this.locale,
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

        this.expenseView = new ExpenseView({
            store: this.expenseStore,
            projectStore: this.store,
            dataSource: this.dataSource,
            draftJournal: this.draftJournal,
            draftNamespace: this.buildDraftNamespace(),
            timeContext: this.timeContext,
            locale: this.locale,
            elements: {
                expenseView: this.expenseViewEl,
                expenseBalanceStrip: this.expenseBalanceStripEl,
                expenseCategoryFilters: this.expenseCategoryFiltersEl,
                expenseList: this.expenseListEl,
                searchInput: this.searchInput,
                expenseAddBtn: this.expenseAddBtn,
                expenseSettleBtn: this.expenseSettleBtn,
                expenseInventoryBtn: this.expenseInventoryBtn,
                editorBadge: this.editorBadgeEl,
                expenseDialog: this.expenseDialog,
                expenseForm: this.expenseForm,
                expenseDialogTitle: this.expenseDialogTitleEl,
                expenseDialogMeta: this.expenseDialogMetaEl,
                expenseCloseBtn: this.expenseCloseBtn,
                expenseCancelBtn: this.expenseCancelBtn,
                expenseDeleteBtn: this.expenseDeleteBtn,
                expenseDescription: this.expenseDescriptionInput,
                expenseDate: this.expenseDateInput,
                expenseAmount: this.expenseAmountInput,
                expenseCurrency: this.expenseCurrencyInput,
                expenseCategory: this.expenseCategorySelect,
                expenseAssignment: this.expenseAssignmentInput,
                expenseAssignmentList: this.expenseAssignmentListEl,
                expenseAllocationType: this.expenseAllocationTypeSelect,
                expenseNotes: this.expenseNotesInput,
                expenseOwedHeading: this.expenseOwedHeadingEl,
                expenseSplitRows: this.expenseSplitRowsEl,
                expenseSettlementDialog: this.expenseSettlementDialog,
                expenseSettlementCloseBtn: this.expenseSettlementCloseBtn,
                expenseSettlementList: this.expenseSettlementListEl,
                expenseInventoryDialog: this.expenseInventoryDialog,
                expenseInventoryForm: this.expenseInventoryForm,
                expenseInventoryCloseBtn: this.expenseInventoryCloseBtn,
                expenseInventoryCancelBtn: this.expenseInventoryCancelBtn,
                expenseAddParticipantBtn: this.expenseAddParticipantBtn,
                expenseAddCategoryBtn: this.expenseAddCategoryBtn,
                expenseParticipantList: this.expenseParticipantListEl,
                expenseCategoryList: this.expenseCategoryListEl,
            },
            onToast: (message, timeout, tone) => this.toast(message, timeout, tone),
            onBusy: (busy) => this.setBusy(busy),
            onSaved: () => this.refreshRepoLabel(),
            onStatsChanged: (summary) => {
                this.expenseSummary = summary;
                this.refreshDataBadge();
            },
            onStateChange: () => this.scheduleRouteReplace(),
        });

        this.projectDialog = new ProjectDialog({
            store: this.store,
            dataSource: this.dataSource,
            locale: this.locale,
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
        this.applyLocale(this.locale.locale, false);
    }

    /**
     * Applies one interface language across declarative markup, dynamic views, formatters, and accessibility labels.
     * The preference is browser-local and never written into a workspace repository; changing it preserves all selected records and route state.
     * @param {unknown} locale Requested supported language.
     * @param {boolean} [shouldPersist] Whether ConfigService should retain the selection for later visits.
     * @returns {void}
     */
    applyLocale(locale, shouldPersist = true) {
        this.locale.setLocale(locale);
        if (shouldPersist) this.configService.saveLocale(this.locale.locale);
        this.locale.applyDocument(document);
        this.workspaceLanguageSelect.value = this.locale.locale;
        this.setTheme(this.theme, false);
        this.setAppZoom(this.uiZoom, false, this.uiZoomMode);
        this.updateProviderForm(this.providerInput, this.repositoryInput);
        this.updateProviderForm(this.workspaceProviderInput, this.workspaceRepositoryInput);
        this.refreshOAuthControls();
        this.updateSearchControls();
        this.projectDialog.refreshLocale();
        this.weekView.refreshLocale();
        this.searchView.refreshLocale();
        this.todoView.refreshLocale();
        this.expenseView.refreshLocale();
        this.renderWorkspaceRegistry();
        this.refreshRepoLabel();
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
        const actionLabel = this.locale.t(useLight ? "nav.useLightTheme" : "nav.useDarkTheme");
        for (const button of [this.appThemeToggleBtn, this.landingThemeToggleBtn]) {
            button.title = actionLabel;
            button.setAttribute("aria-label", actionLabel);
            button.setAttribute("aria-pressed", this.theme === "light" ? "true" : "false");
        }
        const landingLabel = this.landingThemeToggleBtn.querySelector("span");
        if (landingLabel) landingLabel.textContent = this.locale.t(useLight ? "nav.light" : "nav.dark");

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
        const zoomPercent = this.locale.formatNumber(Math.round(this.uiZoom * 100));
        this.appZoomLabelEl.textContent = `${zoomPercent}%`;
        this.appZoomResetBtn.title =
            this.uiZoomMode === "auto"
                ? this.locale.t("nav.zoomAutomatic", { percent: zoomPercent })
                : this.locale.t("nav.zoomRestoreAutomatic", { percent: zoomPercent });
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
     * Returns the concise provider label used in connection progress and form hints.
     * @param {string} provider Provider identifier from a locator or select control.
     * @returns {string}
     */
    providerDisplayName(provider) {
        const labels = {
            github: "GitHub",
            gitlab: "GitLab.com",
            codeberg: "Codeberg",
            forgejo: "Forgejo",
            custom: this.locale.t("provider.selfHosted"),
            local: this.locale.t("provider.local"),
        };
        return labels[provider] || this.locale.t("provider.generic");
    }

    /**
     * Updates provider-specific labels and URL examples without altering credentials or an already entered repository.
     * @param {HTMLSelectElement} providerInput Provider selector that changed.
     * @param {HTMLInputElement} repositoryInput Related repository URL field.
     * @returns {void}
     */
    updateProviderForm(providerInput, repositoryInput) {
        const provider = providerInput.value;
        const placeholders = {
            github: "https://github.com/you/zeitplural-data",
            gitlab: "https://gitlab.com/you/zeitplural-data",
            codeberg: "https://codeberg.org/you/zeitplural-data",
            forgejo: "https://git.example.org/you/zeitplural-data",
            custom: "https://git.example.org/you/zeitplural-data",
        };
        repositoryInput.placeholder = placeholders[provider] || placeholders.custom;
        if (providerInput === this.providerInput) {
            this.landingProviderStatusTextEl.textContent = `${this.providerDisplayName(provider)} API`;
        }
    }

    /**
     * Selects the safe built-in provider implied by a pasted repository URL.
     * Unknown hosts switch only the generic GitHub default to auto-detection, preserving an explicit Forgejo choice for self-hosted instances.
     * @param {HTMLSelectElement} providerInput Provider selector paired with the URL.
     * @param {HTMLInputElement} repositoryInput Repository URL field.
     * @returns {void}
     */
    inferProviderForForm(providerInput, repositoryInput) {
        try {
            const inferred = inferHostedProvider(repositoryInput.value);
            if (inferred !== "custom" || providerInput.value === "github") providerInput.value = inferred;
            this.updateProviderForm(providerInput, repositoryInput);
            this.refreshOAuthControls();
        } catch {
            // Incomplete input remains available for ordinary native form validation.
        }
    }

    /**
     * Synchronizes OAuth actions with the selected provider and deployment client-id configuration.
     * Empty public client ids disable only OAuth; manually supplied scoped tokens remain available for every hosted connector.
     * @returns {void}
     */
    refreshOAuthControls() {
        const configure = (button, provider) => {
            const supported = provider === "gitlab" || provider === "codeberg";
            const clientId = supported ? readOAuthClientId(document, provider) : "";
            button.hidden = !supported;
            button.disabled = supported && !clientId;
            button.title = !supported
                ? this.locale.t("workspace.oauthAvailable")
                : clientId
                  ? this.locale.t("workspace.oauthAuthorize", { provider: this.providerDisplayName(provider) })
                  : this.locale.t("workspace.oauthUnavailable", { provider: this.providerDisplayName(provider) });
        };
        configure(this.loginOAuthBtn, this.providerInput.value);
        configure(this.workspaceOAuthBtn, this.workspaceProviderInput.value);
        configure(this.workspaceCreateOAuthBtn, this.workspaceCreateProviderInput.value);
        this.workspaceCreateProviderNoteEl.textContent =
            this.workspaceCreateProviderInput.value === "codeberg"
                ? this.locale.t("workspace.codebergScope")
                : this.locale.t("workspace.gitlabScope");
    }

    /**
     * Starts provider authorization for an existing repository connection form.
     * Only repository coordinates and the remember choice cross the redirect in session storage; no token is present before the provider returns a code.
     * @param {"landing" | "settings"} source Connection form supplying the intent.
     * @returns {Promise<void>}
     */
    async beginOAuthConnection(source) {
        const isSettings = source === "settings";
        const providerInput = isSettings ? this.workspaceProviderInput : this.providerInput;
        const repositoryInput = isSettings ? this.workspaceRepositoryInput : this.repositoryInput;
        const refInput = isSettings ? this.workspaceRefInput : this.refInput;
        const pathInput = isSettings ? this.workspacePathInput : null;
        const rememberInput = isSettings ? this.workspaceRememberInput : this.rememberInput;
        const errorElement = isSettings ? this.workspaceErrorEl : this.loginErrorEl;
        this.setError(errorElement, "");
        try {
            const locator = buildHostedWorkspaceLocator(
                providerInput.value,
                repositoryInput.value,
                refInput.value,
                pathInput?.value || this.pendingRoute?.workspace?.workspacePath || this.config.workspacePath,
                this.pendingRoute?.workspace?.expectedWorkspaceId || "",
            );
            const clientId = readOAuthClientId(document, locator.provider);
            await startOAuthAuthorization(
                window,
                locator.provider,
                clientId,
                {
                    mode: "connect",
                    repositoryUrl: locator.repositoryUrl,
                    ref: locator.ref,
                    workspacePath: locator.workspacePath,
                    expectedWorkspaceId: locator.expectedWorkspaceId,
                    remember: rememberInput.checked,
                },
                this.routeController.basePath,
            );
        } catch (error) {
            this.setError(errorElement, safeText(error));
        }
    }

    /**
     * Opens the repository-creation dialog with safe defaults and provider-specific access guidance.
     * @returns {void}
     */
    openWorkspaceCreateDialog() {
        this.workspaceCreateTokenInput.value = "";
        this.workspaceCreateRememberInput.checked = false;
        this.workspaceCreateTimezoneInput.value = this.workspace?.timezone || this.config.timezone || "Europe/Berlin";
        this.setError(this.workspaceCreateErrorEl, "");
        this.refreshOAuthControls();
        if (!this.workspaceCreateDialog.open) this.workspaceCreateDialog.showModal();
    }

    /**
     * Closes repository creation and clears any unsubmitted token from the DOM.
     * @returns {void}
     */
    closeWorkspaceCreateDialog() {
        this.workspaceCreateTokenInput.value = "";
        this.setError(this.workspaceCreateErrorEl, "");
        if (this.workspaceCreateDialog.open) this.workspaceCreateDialog.close();
    }

    /**
     * Starts OAuth authorization for private repository creation.
     * Repository and workspace names remain short-lived session intent until the provider returns consent.
     * @returns {Promise<void>}
     */
    async beginOAuthWorkspaceCreation() {
        this.setError(this.workspaceCreateErrorEl, "");
        const provider = this.workspaceCreateProviderInput.value;
        try {
            await startOAuthAuthorization(
                window,
                provider,
                readOAuthClientId(document, provider),
                {
                    mode: "create",
                    repositoryUrl: "",
                    ref: "main",
                    workspacePath: "zeitplural.json",
                    expectedWorkspaceId: "",
                    remember: this.workspaceCreateRememberInput.checked,
                    repositoryName: this.workspaceCreateRepositoryInput.value,
                    workspaceName: this.workspaceCreateNameInput.value,
                    timezone: this.workspaceCreateTimezoneInput.value,
                },
                this.routeController.basePath,
            );
        } catch (error) {
            this.setError(this.workspaceCreateErrorEl, safeText(error));
        }
    }

    /**
     * Loads the checked-in workspace template and specializes its identity, name, timezone, and empty time index.
     * The template directory remains the single source of initial document shapes for manual copying and provider-assisted creation.
     * @param {string} workspaceName Human-readable workspace name.
     * @param {string} timezone IANA timezone identifier.
     * @returns {Promise<{files: import("./datasource.js").SaveFile[], workspace: Workspace}>}
     */
    async loadWorkspaceTemplateFiles(workspaceName, timezone) {
        const paths = [
            "README.md",
            "zeitplural.json",
            "data/projects.json",
            "data/todos.json",
            "data/expenses.json",
            "data/week-requirements.json",
            "data/index/entries-manifest.json",
            "data/index/expenses-manifest.json",
        ];
        const files = await Promise.all(
            paths.map(async (path) => {
                const response = await fetch(new URL(`./workspace-template/${path}`, import.meta.url), { cache: "no-store" });
                if (!response.ok) throw new Error(`Could not load workspace template file ${path}.`);
                return { path, content: await response.text() };
            }),
        );
        const workspaceFile = files.find((file) => file.path === "zeitplural.json");
        const manifestFile = files.find((file) => file.path === "data/index/entries-manifest.json");
        if (!workspaceFile || !manifestFile) throw new Error("The workspace template is incomplete.");
        const workspaceRaw = JSON.parse(workspaceFile.content);
        workspaceRaw.workspace_id = crypto.randomUUID();
        workspaceRaw.name = String(workspaceName || "").trim();
        workspaceRaw.timezone = String(timezone || "").trim();
        const workspace = Workspace.fromRaw(workspaceRaw);
        workspaceFile.content = workspace.toJson();

        const manifestRaw = JSON.parse(manifestFile.content);
        manifestRaw.timezone = workspace.timezone;
        manifestFile.content = `${JSON.stringify(manifestRaw, null, 2)}\n`;
        return { files, workspace };
    }

    /**
     * Creates, initializes, registers, and opens one private GitLab or Codeberg workspace using a PAT or OAuth grant.
     * All post-creation loading uses the ordinary data-source and registry path, ensuring assisted onboarding does not become a second application mode.
     * @param {"gitlab" | "codeberg"} provider Hosted provider.
     * @param {string} repositoryName New repository name.
     * @param {string} workspaceName New workspace display name.
     * @param {string} timezone IANA timezone.
     * @param {string} accessToken PAT or OAuth access token.
     * @param {boolean} remember Whether browser credential storage survives restarts.
     * @param {import("./config.js").WorkspaceCredentialRecord | null} [oauthCredential] Refreshable OAuth record, when applicable.
     * @returns {Promise<void>}
     */
    async createAndOpenWorkspace(
        provider,
        repositoryName,
        workspaceName,
        timezone,
        accessToken,
        remember,
        oauthCredential = null,
    ) {
        const placeholderUrl =
            provider === "gitlab"
                ? "https://gitlab.com/zeitplural-onboarding/placeholder"
                : "https://codeberg.org/zeitplural-onboarding/placeholder";
        const placeholderLocator = buildHostedWorkspaceLocator(provider, placeholderUrl, "main", "zeitplural.json");
        const creationConfig = configForRouteWorkspace(this.config, placeholderLocator);
        const creationSource = createHostedDataSource(creationConfig, accessToken);
        const { files, workspace } = await this.loadWorkspaceTemplateFiles(workspaceName, timezone);
        let repositoryUrl = "";
        try {
            const created = await creationSource.createPrivateRepository(repositoryName);
            repositoryUrl = created.repositoryUrl;
            const locator = buildHostedWorkspaceLocator(
                provider,
                repositoryUrl,
                "main",
                "zeitplural.json",
                workspace.workspace_id,
            );
            const initializedSource = createHostedDataSource(configForRouteWorkspace(this.config, locator), accessToken);
            await initializedSource.saveFiles(files, "Initialize zeitplural workspace");

            const connection = this.workspaceRegistry.upsert(locator, {
                displayName: workspace.name,
                expectedWorkspaceId: workspace.workspace_id,
            });
            this.workspaceRegistry.setActive(connection.id);
            this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
            if (oauthCredential) {
                this.configService.saveWorkspaceOAuthCredential(connection.id, oauthCredential, remember);
            } else {
                this.configService.saveWorkspaceCredential(connection.id, accessToken, remember);
            }
            this.activateWorkspaceConnection(connection, accessToken);
            this.pendingRoute = {
                version: 1,
                component: "time",
                panel: "main",
                workspace: connection.toLocator(),
                state: {},
            };
            this.closeWorkspaceCreateDialog();
            this.closeWorkspaceSettings("none");
            await this.connectWithToken(accessToken);
        } catch (error) {
            if (repositoryUrl) {
                throw new Error(
                    this.locale.t("workspace.createdInitializationFailed", {
                        repository: repositoryUrl,
                        error: this.locale.localizeError(error),
                    }),
                );
            }
            throw error;
        }
    }

    /**
     * Handles token-based repository creation from the modal form.
     * @param {Event} event Form submission event.
     * @returns {Promise<void>}
     */
    async handleWorkspaceCreateSubmit(event) {
        event.preventDefault();
        this.setError(this.workspaceCreateErrorEl, "");
        const token = this.workspaceCreateTokenInput.value.trim();
        if (!token) {
            this.setError(this.workspaceCreateErrorEl, this.locale.t("workspace.tokenOrOAuth"));
            return;
        }
        this.setBusy(true);
        try {
            await this.createAndOpenWorkspace(
                /** @type {"gitlab" | "codeberg"} */ (this.workspaceCreateProviderInput.value),
                this.workspaceCreateRepositoryInput.value,
                this.workspaceCreateNameInput.value,
                this.workspaceCreateTimezoneInput.value,
                token,
                this.workspaceCreateRememberInput.checked,
            );
        } catch (error) {
            this.setError(this.workspaceCreateErrorEl, safeText(error));
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * Completes a scrubbed OAuth callback by registering an existing repository or creating and initializing a new one.
     * The refreshable grant is persisted only after a concrete workspace connection id exists.
     * @param {import("./oauth.js").OAuthCallbackResult} result Validated callback result.
     * @returns {Promise<void>}
     */
    async handleOAuthCallbackResult(result) {
        const { credential, intent } = result;
        if (intent.mode === "create") {
            await this.createAndOpenWorkspace(
                credential.provider,
                intent.repositoryName || "zeitplural-data",
                intent.workspaceName || "My workspace",
                intent.timezone || "Europe/Berlin",
                credential.accessToken,
                intent.remember,
                credential,
            );
            return;
        }

        const locator = buildHostedWorkspaceLocator(
            credential.provider,
            intent.repositoryUrl,
            intent.ref,
            intent.workspacePath,
            intent.expectedWorkspaceId || "",
        );
        const connection = this.workspaceRegistry.upsert(locator);
        this.workspaceRegistry.setActive(connection.id);
        this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
        this.configService.saveWorkspaceOAuthCredential(connection.id, credential, intent.remember);
        this.activateWorkspaceConnection(connection, credential.accessToken);
        this.pendingRoute = {
            version: 1,
            component: "time",
            panel: "main",
            workspace: connection.toLocator(),
            state: {},
        };
        await this.connectWithToken(credential.accessToken);
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
            empty.textContent = this.locale.t("workspace.none");
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
                badge.textContent = this.locale.t("workspace.active");
                heading.append(badge);
            }
            const credentialBadge = document.createElement("span");
            credentialBadge.className = "workspace-credential-badge muted";
            credentialBadge.textContent = connection.provider === "local"
                ? this.locale.t("workspace.localServer")
                : hasCredential
                  ? this.locale.t("workspace.authenticated")
                  : this.locale.t("workspace.tokenRequired");
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
                    isActive && this.workspace
                        ? this.locale.t("workspace.open")
                        : hasCredential
                          ? this.locale.t("workspace.switch")
                          : this.locale.t("workspace.authenticate"),
                    "open",
                    connection.id,
                    isActive && Boolean(this.workspace),
                ),
                this.createWorkspaceActionButton(this.locale.t("workspace.earlier"), "up", connection.id, index === 0),
                this.createWorkspaceActionButton(
                    this.locale.t("workspace.later"),
                    "down",
                    connection.id,
                    index === connections.length - 1,
                ),
            );
            if (connection.provider !== "local") {
                actions.append(
                    this.createWorkspaceActionButton(this.locale.t("workspace.disconnect"), "disconnect", connection.id),
                );
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
        this.updateProviderForm(this.workspaceProviderInput, this.workspaceRepositoryInput);
        this.setError(
            this.workspaceErrorEl,
            this.locale.t("workspace.enterTokenFor", { workspace: connection.displayName }),
        );
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
        this.providerInput.value = connection.provider;
        this.repositoryInput.value = connection.repositoryUrl;
        this.refInput.value = connection.ref;
        this.updateProviderForm(this.providerInput, this.repositoryInput);
        this.rememberInput.checked = this.configService.isWorkspaceCredentialRemembered(connection.id);
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
        this.expenseView.setDraftNamespace(this.buildDraftNamespace());
    }

    /**
     * Builds the initial component route used after changing repositories.
     * Component intent is retained, while record ids, week positions, and filters are reset because they belong to the previous workspace.
     * @param {import("./config.js").WorkspaceConnection} connection Target connection.
     * @returns {import("./routing.js").AppRoute}
     */
    routeForWorkspaceConnection(connection) {
        const component =
            this.state.activeTab === "todos"
                ? "todos"
                : this.state.activeTab === "expenses"
                  ? "expenses"
                  : "time";
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
     * Loads one connection credential and refreshes an expiring public-client OAuth grant before it reaches a provider request.
     * Refreshed material is written back to the same session/remembered tier; PAT records pass through unchanged.
     * @param {import("./config.js").WorkspaceConnection} connection Workspace requiring authentication.
     * @returns {Promise<string>}
     */
    async loadUsableWorkspaceCredential(connection) {
        const credential = this.configService.loadWorkspaceCredentialRecord(connection.id);
        if (!credential) return "";
        if (credential.kind !== "oauth") return credential.accessToken;
        const refreshed = await refreshOAuthCredential(credential);
        if (refreshed.kind !== "oauth") throw new Error("The OAuth credential could not be refreshed.");
        if (
            refreshed.accessToken !== credential.accessToken ||
            refreshed.refreshToken !== credential.refreshToken ||
            refreshed.expiresAt !== credential.expiresAt
        ) {
            this.configService.saveWorkspaceOAuthCredential(
                connection.id,
                refreshed,
                this.configService.isWorkspaceCredentialRemembered(connection.id),
            );
        }
        return refreshed.accessToken;
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
        const candidateSource = createHostedDataSource(candidateConfig, token);
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
        if (this.weekView.saveInFlight || this.todoView.saveInFlight || this.expenseView.saveInFlight) {
            this.toast(this.locale.t("toast.waitSaveSwitch"), 4000);
            return;
        }
        if (connection.provider === "local") {
            await Promise.all([
                this.weekView.flushDraftWrites(),
                this.todoView.flushDraftWrites(),
                this.expenseView.flushDraftWrites(),
            ]);
            this.activateWorkspaceConnection(connection, "");
            this.pendingRoute = requestedRoute || this.routeForWorkspaceConnection(connection);
            this.dataSource = new LocalDataSource(this.config);
            this.weekView.setDataSource(this.dataSource);
            this.todoView.setDataSource(this.dataSource);
            this.expenseView.setDataSource(this.dataSource);
            this.projectDialog.setDataSource(this.dataSource);
            this.closeWorkspaceSettings("none");
            await this.reloadData();
            return;
        }
        this.setError(this.workspaceErrorEl, "");
        this.setBusy(true);
        let credential = "";
        let connectionInfo;
        try {
            credential = await this.loadUsableWorkspaceCredential(connection);
            if (!credential) {
                this.requestWorkspaceCredential(connection);
                return;
            }
            connectionInfo = await this.preflightWorkspaceConnection(connection, credential);
        } catch (error) {
            const message = this.locale.t("workspace.couldNotOpen", {
                workspace: connection.displayName,
                error: this.locale.localizeError(error),
            });
            this.setError(this.workspaceErrorEl, message);
            this.toast(message, 6000);
            return;
        } finally {
            this.setBusy(false);
        }

        await Promise.all([
            this.weekView.flushDraftWrites(),
            this.todoView.flushDraftWrites(),
            this.expenseView.flushDraftWrites(),
        ]);
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
     * Adds or re-authenticates one hosted workspace from the settings form, then opens it through the same provider-neutral switch pipeline as registry rows.
     * The new credential is persisted only in the selected browser tier and never in the registry record.
     * @param {Event} event Workspace form submission.
     * @returns {Promise<void>}
     */
    async handleWorkspaceAdd(event) {
        event.preventDefault();
        this.setError(this.workspaceErrorEl, "");

        const token = this.workspaceTokenInput.value.trim();
        if (!token) {
            this.setError(this.workspaceErrorEl, this.locale.t("toast.enterToken"));
            return;
        }
        try {
            const locator = buildHostedWorkspaceLocator(
                this.workspaceProviderInput.value,
                this.workspaceRepositoryInput.value,
                this.workspaceRefInput.value,
                this.workspacePathInput.value,
            );
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
        if (this.weekView.saveInFlight || this.todoView.saveInFlight || this.expenseView.saveInFlight) {
            this.toast(this.locale.t("toast.waitSaveDisconnect"), 4000);
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
        const repository = locator.provider === "local" ? this.locale.t("workspace.localServer") : locator.repositoryUrl;
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
            route.workspace.provider === "local" ? this.locale.t("workspace.localLocatorOnly") : "",
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
            this.toast(this.locale.t("workspace.linkCopied"), 2400, "success");
        } catch {
            window.prompt(this.locale.t("workspace.copyPrompt"), url);
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
            this.toast(this.locale.t("workspace.capabilityCopied"), 4500, "success");
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
            this.capabilityHostConfirmTextEl.textContent = this.locale.t("workspace.trustNamedHost", { host });
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
        this.setError(this.loginErrorEl, this.locale.t("workspace.notImported"));
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
            this.setError(this.capabilityImportErrorEl, this.locale.t("workspace.confirmHost"));
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
        const provider = String(this.config.provider || "github").trim();
        const repository = String(
            this.config.repositoryUrl || formatGitHubRepositoryUrl(this.config.owner, this.config.repo),
        ).trim();
        const ref = String(this.config.ref || "").trim();
        return `${provider}:${repository}@${ref}`;
    }

    /**
     * Returns the public locator for the active local folder or hosted Git repository.
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
            provider: /** @type {import("./routing.js").WorkspaceRouteLocator["provider"]} */ (
                this.config.provider || "github"
            ),
            repositoryUrl:
                this.config.repositoryUrl || formatGitHubRepositoryUrl(this.config.owner, this.config.repo),
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
        if (this.state.activeTab === "expenses") {
            return {
                version: 1,
                component: "expenses",
                panel: globalPanel || "main",
                workspace: this.getCurrentWorkspaceRouteLocator(),
                state: this.expenseView.getRouteState(),
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
     * @returns {"week" | "todos" | "expenses" | "search"}
     */
    tabForRoute(route) {
        if (route.component === "todos") return "todos";
        if (route.component === "expenses") return "expenses";
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
     * An unavailable component falls back to Time, TODOs, or Expenses in that order without leaving a broken blank surface.
     * @param {import("./routing.js").AppRoute} route Requested route.
     * @returns {import("./routing.js").AppRoute}
     */
    normalizeLoadedRoute(route) {
        if (!this.workspace || !route.component) return this.buildCurrentRoute();
        const hasTime = this.workspace.hasComponent("time_tracking");
        const hasTodos = this.workspace.hasComponent("todos");
        const hasExpenses = this.workspace.hasComponent("expenses");
        let component = route.component;
        let panel = route.panel;

        const unavailable =
            (component === "time" && !hasTime) ||
            (component === "todos" && !hasTodos) ||
            (component === "expenses" && !hasExpenses);
        if (unavailable) {
            component = hasTime ? "time" : hasTodos ? "todos" : hasExpenses ? "expenses" : "time";
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
        } else if (normalized.component === "expenses") {
            this.expenseView.restoreRouteState(normalized.state);
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
        try {
            return Boolean(
                this.activeWorkspaceConnection &&
                    workspaceRouteLocatorKey(locator) === this.activeWorkspaceConnection.id,
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
                this.toast(this.locale.t("workspace.localUnavailable"), 5000);
                return;
            }
            if (route.workspace && route.workspace.provider !== "local") {
                this.providerInput.value = route.workspace.provider;
                this.repositoryInput.value = route.workspace.repositoryUrl;
                this.refInput.value = route.workspace.ref;
                this.updateProviderForm(this.providerInput, this.repositoryInput);
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
            this.setError(this.loginErrorEl, this.locale.t("workspace.authenticateLink"));
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
        this.showLoadingScreen(this.locale.t("loading.discoverLocal"));
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
            this.expenseView.setDataSource(this.dataSource);
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
            this.setAuthStatus(this.locale.t("status.localMode"));
            await this.reloadData();
        } catch (error) {
            this.showLoadingError(safeText(error));
        }
    }

    /**
     * Boots the application and triggers the initial load flow.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<void>}
     */
    async start() {
        const initialProvider = this.activeWorkspaceConnection?.provider || this.initialRoute.workspace?.provider || this.config.provider || "github";
        const initialRepository =
            this.activeWorkspaceConnection?.repositoryUrl ||
            this.initialRoute.workspace?.repositoryUrl ||
            this.config.repositoryUrl ||
            formatGitHubRepositoryUrl(this.config.owner, this.config.repo);
        this.providerInput.value = initialProvider;
        this.repositoryInput.value = initialRepository;
        this.refInput.value = this.config.ref;
        this.updateProviderForm(this.providerInput, this.repositoryInput);
        this.rememberInput.checked = this.activeWorkspaceConnection
            ? this.configService.isWorkspaceCredentialRemembered(this.activeWorkspaceConnection.id)
            : this.configService.isTokenRemembered();
        if (this.pendingRoute) this.state.setActiveTab(this.tabForRoute(this.pendingRoute));

        this.loginForm.addEventListener("submit", (ev) => this.handleLoginSubmit(ev));
        this.providerInput.addEventListener("change", () => {
            this.updateProviderForm(this.providerInput, this.repositoryInput);
            this.refreshOAuthControls();
        });
        this.repositoryInput.addEventListener("change", () => this.inferProviderForForm(this.providerInput, this.repositoryInput));
        this.workspaceProviderInput.addEventListener("change", () => {
            this.updateProviderForm(this.workspaceProviderInput, this.workspaceRepositoryInput);
            this.refreshOAuthControls();
        });
        this.workspaceRepositoryInput.addEventListener("change", () =>
            this.inferProviderForForm(this.workspaceProviderInput, this.workspaceRepositoryInput),
        );
        this.loginOAuthBtn.addEventListener("click", () => void this.beginOAuthConnection("landing"));
        this.workspaceOAuthBtn.addEventListener("click", () => void this.beginOAuthConnection("settings"));
        this.createWorkspaceBtn.addEventListener("click", () => this.openWorkspaceCreateDialog());
        this.workspaceCreateBtn.addEventListener("click", () => this.openWorkspaceCreateDialog());
        this.workspaceCreateProviderInput.addEventListener("change", () => this.refreshOAuthControls());
        this.workspaceCreateCloseBtn.addEventListener("click", () => this.closeWorkspaceCreateDialog());
        this.workspaceCreateCancelBtn.addEventListener("click", () => this.closeWorkspaceCreateDialog());
        this.workspaceCreateDialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            this.closeWorkspaceCreateDialog();
        });
        this.workspaceCreateOAuthBtn.addEventListener("click", () => void this.beginOAuthWorkspaceCreation());
        this.workspaceCreateForm.addEventListener("submit", (event) => void this.handleWorkspaceCreateSubmit(event));
        this.clearSavedBtn.addEventListener("click", () => this.handleClearSaved());
        this.workspaceSettingsBtn.addEventListener("click", () => {
            if (this.workspaceDialog.open) this.closeWorkspaceSettings();
            else this.openWorkspaceSettings();
        });
        this.workspaceDialogCloseBtn.addEventListener("click", () => this.closeWorkspaceSettings());
        this.workspaceLanguageSelect.addEventListener("change", () =>
            this.applyLocale(this.workspaceLanguageSelect.value),
        );
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
        this.menuExpenseBtn.addEventListener("click", () => this.setTab("expenses"));
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
            if (
                this.appSection.hidden ||
                this.state.activeTab === "search" ||
                this.state.activeTab === "todos" ||
                this.state.activeTab === "expenses"
            ) {
                return;
            }
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
        this.refreshOAuthControls();
        setVisible(this.sidebarEl, false);
        setVisible(this.topbarEl, false);
        setVisible(this.loadingSection, false);

        if (this.oauthCallbackRequested) {
            this.showLoadingScreen(this.locale.t("loading.completeAuthorization"));
            try {
                const result = await this.oauthCallbackPromise;
                if (!result) throw new Error("The provider authorization callback is incomplete.");
                await this.handleOAuthCallbackResult(result);
            } catch (error) {
                this.showLoginScreen();
                this.setError(this.loginErrorEl, safeText(error));
            }
            return;
        }

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
            this.setAuthStatus(this.locale.t("status.localMode"));
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
            this.setAuthStatus(
                this.locale.t(this.token ? "status.savedConnection" : "status.notLoggedIn"),
            );
            this.showLoginScreen();
        } else if (this.token) {
            this.showLoadingScreen(
                this.locale.t("loading.connectProvider", { provider: this.providerDisplayName(initialProvider) }),
            );
            this.connectWithToken(this.token).catch((err) => {
                this.showLoginScreen();
                this.setError(this.loginErrorEl, safeText(err));
            });
        } else {
            this.setAuthStatus(this.locale.t("status.notLoggedIn"));
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
     * @param {unknown} message Error or already localized message.
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
                if (this.state.activeTab !== "todos" && this.state.activeTab !== "expenses") this.setTab("search");
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

            if (keyLower === "e") {
                ev.preventDefault();
                this.setTab("expenses");
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
        if (this.state.activeTab === "expenses" && this.expenseView.handleKeydown(ev)) return;
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
        if (this.state.activeTab === "expenses") {
            void this.expenseView.saveNow();
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
     * Validates login input and starts the selected hosted-provider connection flow.
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
            this.setError(this.loginErrorEl, this.locale.t("workspace.completeConnection"));
            return;
        }

        const expectedWorkspaceId = String(this.pendingRoute?.workspace?.expectedWorkspaceId || "");
        const workspacePath = String(this.pendingRoute?.workspace?.workspacePath || this.config.workspacePath || "zeitplural.json");
        let locator;
        try {
            locator = buildHostedWorkspaceLocator(
                this.providerInput.value,
                this.repositoryInput.value,
                ref,
                workspacePath,
                expectedWorkspaceId,
            );
        } catch (error) {
            this.setError(this.loginErrorEl, safeText(error));
            return;
        }
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
        this.expenseView.setDraftNamespace(this.buildDraftNamespace());
        this.providerInput.value = this.config.provider || "github";
        this.repositoryInput.value =
            this.config.repositoryUrl || formatGitHubRepositoryUrl(this.config.owner, this.config.repo);
        this.refInput.value = this.config.ref;
        this.updateProviderForm(this.providerInput, this.repositoryInput);
        this.tokenInput.value = "";
        this.rememberInput.checked = false;
        this.setAuthStatus(this.locale.t("status.cleared"));
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
     * @param {unknown} message Error value or already localized message.
     * @returns {void}
     */
    setError(el, message) {
        const localized = this.locale.localizeError(message);
        if (!localized) {
            el.textContent = "";
            setVisible(el, false);
            return;
        }
        el.textContent = localized;
        setVisible(el, true);
    }

    /**
     * Shows a temporary toast-style message with optional success styling.
     * Keeps the main UI flow and data loading coordinated.
     * @param {unknown} message Error or already localized message.
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
        this.setError(this.dataErrorEl, message);
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
        this.providerInput.disabled = isBusy;
        this.repositoryInput.disabled = isBusy;
        this.refInput.disabled = isBusy;
        this.tokenInput.disabled = isBusy;
        this.rememberInput.disabled = isBusy;
        this.loginOAuthBtn.disabled = isBusy || this.loginOAuthBtn.disabled;
        this.createWorkspaceBtn.disabled = isBusy;
        this.workspaceDialogCloseBtn.disabled = isBusy;
        this.workspaceProviderInput.disabled = isBusy;
        this.workspaceRepositoryInput.disabled = isBusy;
        this.workspaceRefInput.disabled = isBusy;
        this.workspacePathInput.disabled = isBusy;
        this.workspaceTokenInput.disabled = isBusy;
        this.workspaceRememberInput.disabled = isBusy;
        this.workspaceOAuthBtn.disabled = isBusy || this.workspaceOAuthBtn.disabled;
        this.workspaceCreateBtn.disabled = isBusy;
        this.workspaceCreateCloseBtn.disabled = isBusy;
        this.workspaceCreateCancelBtn.disabled = isBusy;
        this.workspaceCreateProviderInput.disabled = isBusy;
        this.workspaceCreateRepositoryInput.disabled = isBusy;
        this.workspaceCreateNameInput.disabled = isBusy;
        this.workspaceCreateTimezoneInput.disabled = isBusy;
        this.workspaceCreateTokenInput.disabled = isBusy;
        this.workspaceCreateRememberInput.disabled = isBusy;
        this.workspaceCreateOAuthBtn.disabled = isBusy || this.workspaceCreateOAuthBtn.disabled;
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
        this.menuExpenseBtn.disabled = isBusy;
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
        this.expenseView.setBusy(isBusy);
        if (!isBusy) this.refreshOAuthControls();
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
     * Synchronizes the shared search field and time-search labels with the active component and interface language.
     * Keeping this independent from tab navigation lets a locale change refresh accessible text without changing browser history or view state.
     * @returns {void}
     */
    updateSearchControls() {
        const searchesTodos = this.state.activeTab === "todos";
        const searchesExpenses = this.state.activeTab === "expenses";
        this.searchInput.value = searchesTodos
            ? this.todoView.getSearchQuery()
            : searchesExpenses
              ? this.expenseView.getSearchQuery()
              : this.searchView.getSearchQuery();
        const searchKey = searchesTodos ? "Todos" : searchesExpenses ? "Expenses" : "Time";
        this.searchInput.placeholder = this.locale.t(
            `topbar.search${searchKey}Placeholder`,
        );
        this.searchInput.setAttribute(
            "aria-label",
            this.locale.t(`topbar.search${searchKey}`),
        );
        this.globalSearchEl.title = this.locale.t(
            `topbar.search${searchKey}Title`,
        );
        this.searchFromLabelEl.textContent = this.locale.t("search.from", { timezone: this.timeContext.timeZone });
        this.searchToLabelEl.textContent = this.locale.t("search.to", { timezone: this.timeContext.timeZone });
    }

    /**
     * Switches between Week, TODO, Expenses, and Search tabs.
     * Keeps the main UI flow and data loading coordinated.
     * @param {"week" | "todos" | "expenses" | "search"} tab
     * @param {"push" | "replace" | "none"} [historyMode] Whether this navigation should create, replace, or leave browser history.
     * @returns {void}
     */
    setTab(tab, historyMode = "push") {
        const next = tab === "search" || tab === "todos" || tab === "expenses" ? tab : "week";
        this.state.setActiveTab(next);
        this.updateSearchControls();
        this.topbarEl.dataset.activeTab = next;
        for (const [button, isCurrent] of [
            [this.menuWeekBtn, next === "week"],
            [this.menuTodoBtn, next === "todos"],
            [this.menuExpenseBtn, next === "expenses"],
            [this.menuSearchBtn, next === "search"],
        ]) {
            if (!(button instanceof HTMLButtonElement)) continue;
            if (isCurrent) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        }
        this.weekView.setActive(next === "week");
        this.todoView.setActive(next === "todos");
        this.expenseView.setActive(next === "expenses");
        this.searchView.setActive(next === "search");
        setVisible(this.weekControlsEl, next === "week" && !this.topbarEl.hidden);
        setVisible(this.todoTopbarControlsEl, next === "todos" && !this.topbarEl.hidden);
        setVisible(this.expenseTopbarControlsEl, next === "expenses" && !this.topbarEl.hidden);
        setVisible(this.editorBadgeEl, (next === "week" || next === "todos" || next === "expenses") && !this.topbarEl.hidden);
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
        this.expenseView.setProjects();
        this.markSearchDirty();
    }

    /**
     * Updates the footer badge with repository and manifest info.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    refreshRepoLabel() {
        const manifest = this.store.getManifest();
        const expenseManifest = this.expenseStore.getManifest();
        const totals = [];
        if (manifest) {
            totals.push(
                this.locale.t("data.weekFiles", { count: this.locale.formatNumber(manifest.chunks.length) }),
            );
            if (typeof manifest.total_entries === "number" && Number.isFinite(manifest.total_entries)) {
                totals.push(this.locale.t("data.entries", { count: this.locale.formatNumber(manifest.total_entries) }));
            }
        }
        if (this.workspace?.hasComponent("todos")) {
            totals.push(
                this.locale.t("data.todos", { count: this.locale.formatNumber(this.todoStore.getTodos().length) }),
            );
        }
        if (this.workspace?.hasComponent("expenses")) {
            totals.push(
                this.locale.t("data.expenses", {
                    count: this.locale.formatNumber(this.expenseStore.getExpenses().length),
                }),
            );
        }
        const generatedTimestamps = [manifest?.generated_at || "", expenseManifest?.generated_at || ""].sort();
        const generatedAt = generatedTimestamps[generatedTimestamps.length - 1] || "";
        if (generatedAt) {
            totals.push(
                this.locale.t("data.manifestAt", {
                    date: this.locale.formatDate(generatedAt, this.timeContext.timeZone, {
                        dateStyle: "short",
                        timeStyle: "short",
                    }),
                }),
            );
        }

        const workspaceName = this.workspace?.name ? `${this.workspace.name} • ` : "";
        if (this.isLocalMode) {
            this.repositorySummary = `${workspaceName}${this.locale.t("data.local")} • ${totals.join(" • ")}`;
        } else {
            const repository =
                this.activeWorkspaceConnection?.repositoryUrl ||
                this.config.repositoryUrl ||
                formatGitHubRepositoryUrl(this.config.owner, this.config.repo);
            let repositoryLabel = repository;
            try {
                const url = new URL(repository);
                repositoryLabel = `${url.host}${url.pathname}`;
            } catch {
                // The locator was already validated; preserve its text if URL formatting is unavailable.
            }
            this.repositorySummary = `${workspaceName}${repositoryLabel}@${this.config.ref} • ${totals.join(" • ")}`;
        }
        this.refreshDataBadge();
    }

    /**
     * Chooses the content of the shared bottom-right overlay for the active view.
     * TODO mode shows task counts; Week and Search retain repository/manifest diagnostics.
     * @returns {void}
     */
    refreshDataBadge() {
        this.repoLabelEl.textContent =
            this.state.activeTab === "todos"
                ? this.todoSummary
                : this.state.activeTab === "expenses"
                  ? this.expenseSummary
                  : this.repositorySummary;
    }

    /**
     * Loads and installs the root zeitplural workspace configuration before component documents are requested.
     * The workspace supplies all repository paths and the shared timezone, allowing the same application build to operate against local, GitHub, and future provider-backed repositories.
     * @returns {Promise<void>}
     */
    async fetchWorkspace() {
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.workspaceLocal" : "loading.workspace"),
        );
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
        setVisible(this.menuWeekBtn, workspace.hasComponent("time_tracking"));
        setVisible(this.menuSearchBtn, workspace.hasComponent("time_tracking"));
        setVisible(this.menuTodoBtn, workspace.hasComponent("todos"));
        setVisible(this.menuExpenseBtn, workspace.hasComponent("expenses"));
        setVisible(this.projectsBtn, Boolean(workspace.resources.projects));
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
        this.expenseView.setDraftNamespace(this.buildDraftNamespace());
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
        this.setProgress(
            0,
            1,
            this.locale.t(this.isLocalMode ? "loading.projectsLocal" : "loading.projects"),
        );
        const raw = await this.dataSource.fetchProjects();
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
            const raw = await this.dataSource.fetchWeekRequirements();
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
        const raw = await this.dataSource.fetchTodos();
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
            this.dataSource.fetchExpensesText(),
            this.dataSource.fetchExpensesManifest(),
        ]);
        const manifest = ExpenseManifest.fromRaw(manifestRaw, this.dataSource.getExpensesPath());
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

    /**
     * Reloads manifest, shared projects, TODOs, requirements, and all time-entry chunks.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<boolean>}
     */
    async reloadData() {
        this.showLoadingScreen(
            this.locale.t(this.isLocalMode ? "loading.prepareLocal" : "loading.prepareRepository"),
        );
        this.setBusy(true);
        this.setError(this.dataErrorEl, "");
        this.entriesTbody.innerHTML = "";
        this.statsEl.textContent = "";
        await this.weekView.flushDraftWrites();
        await this.todoView.flushDraftWrites();
        await this.expenseView.flushDraftWrites();
        this.weekView.reset();
        this.store.clear();
        this.todoStore.clear();
        this.todoView.reset();
        this.expenseStore.clear();
        this.expenseView.reset();
        try {
            await this.fetchWorkspace();
            await this.fetchProjects();
            const componentLoads = [];
            if (this.workspace?.hasComponent("time_tracking")) {
                componentLoads.push(this.fetchManifest(), this.fetchWeekRequirements());
            }
            if (this.workspace?.hasComponent("todos")) componentLoads.push(this.fetchTodos());
            if (this.workspace?.hasComponent("expenses")) componentLoads.push(this.fetchExpenses());
            await Promise.all(componentLoads);
            if (this.workspace?.hasComponent("time_tracking")) {
                await this.loadAllChunks();
            } else {
                this.state.setWeekStart(null);
                this.state.setLatestWeekStart(null);
                this.weekView.reset();
                this.searchView.reset();
            }
            const requestedRoute = this.pendingRoute;
            if (!requestedRoute && !this.workspace?.hasComponent("time_tracking")) {
                this.state.setActiveTab(this.workspace?.hasComponent("todos") ? "todos" : "expenses");
            }
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
     * Connects to the selected Git provider using the provided credential and loads data through the common workspace pipeline.
     * Keeps the main UI flow and data loading coordinated.
     * @param {string} token
     * @param {{repoInfo: any, userInfo: any} | null} [connectionInfo] Optional successful preflight result used to avoid duplicate provider checks while switching.
     * @returns {Promise<void>}
     */
    async connectWithToken(token, connectionInfo = null) {
        const usableToken = this.activeWorkspaceConnection
            ? (await this.loadUsableWorkspaceCredential(this.activeWorkspaceConnection)) || token
            : token;
        this.token = usableToken;
        this.state.setToken(usableToken);
        this.dataSource = createHostedDataSource(this.config, usableToken);
        this.workspace = null;
        this.weekView.setDataSource(this.dataSource);
        this.weekView.setDraftNamespace(this.buildDraftNamespace());
        this.todoView.setDataSource(this.dataSource);
        this.todoView.setDraftNamespace(this.buildDraftNamespace());
        this.expenseView.setDataSource(this.dataSource);
        this.expenseView.setDraftNamespace(this.buildDraftNamespace());
        this.projectDialog.setDataSource(this.dataSource);
        this.setAuthStatus(this.locale.t("status.connecting"));
        const provider = this.activeWorkspaceConnection?.provider || this.config.provider || "custom";
        this.showLoadingScreen(
            this.locale.t("loading.connectProvider", { provider: this.providerDisplayName(provider) }),
        );
        this.setBusy(true);
        try {
            const { repoInfo, userInfo } = connectionInfo || (await this.dataSource.checkConnection());
            const repoLabel = repoInfo?.full_name
                ? repoInfo.full_name
                : this.activeWorkspaceConnection?.repositoryUrl ||
                  this.config.repositoryUrl ||
                  this.locale.t("landing.workspaceRepository");
            this.state.ghUser = userInfo;
            this.setAuthStatus(
                userInfo?.login
                    ? this.locale.t("status.loggedInAs", { user: userInfo.login })
                    : this.locale.t("status.connectedTo", { repository: repoLabel }),
            );
            setVisible(this.logoutBtn, true);
            setVisible(this.reloadDataBtn, true);
            setVisible(this.projectsBtn, true);
            await this.reloadData();
        } catch (err) {
            this.state.ghUser = null;
            this.setAuthStatus(this.locale.t("status.notLoggedIn"));
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
        this.expenseStore.clear();
        this.chunkCache.clearMemory();
        this.weekView.reset();
        this.todoView.reset();
        this.expenseView.reset();
        this.searchView.reset();
        this.searchInput.value = "";
        this.setProgress(0, 1, "");
        this.setAuthStatus(this.locale.t("status.notLoggedIn"));
        this.repositorySummary = "";
        this.todoSummary = "";
        this.expenseSummary = "";
        this.refreshDataBadge();
        this.projectDialog.close();
        this.closeWorkspaceSettings("none");
        setVisible(this.weekControlsEl, false);
        setVisible(this.todoTopbarControlsEl, false);
        setVisible(this.expenseTopbarControlsEl, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.logoutBtn, false);
        setVisible(this.projectsBtn, false);
        this.showLoginScreen();
        const activeConnection = this.activeWorkspaceConnection || this.workspaceRegistry.getActive();
        if (activeConnection) {
            this.activeWorkspaceConnection = activeConnection;
            this.config = configForRouteWorkspace(this.config, activeConnection.toLocator());
            this.state.setConfig(this.config);
            this.providerInput.value = activeConnection.provider;
            this.repositoryInput.value = activeConnection.repositoryUrl;
            this.refInput.value = activeConnection.ref;
            this.updateProviderForm(this.providerInput, this.repositoryInput);
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
void app.start();
