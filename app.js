import { AppState } from "./appstate.js";
import { ChunkCache, DraftJournal, RemoteCache } from "./cache.js";
import {
    ConfigService,
    DEFAULT_CONFIG,
    formatGitHubRepositoryUrl,
    WorkspaceRegistry,
} from "./config.js";
import { createHostedDataSource, LocalDataSource } from "./datasource.js";
import { EntryStore, ExpenseStore, TodoStore } from "./store.js";
import { ExpenseView } from "./expense.view.js";
import { SearchView } from "./search.view.js";
import { TodoView } from "./todo.view.js";
import { WeekView } from "./week.view.js";
import { ProjectDialog } from "./project.view.js";
import {
    buildHostedWorkspaceLocator,
    buildWorkspaceDraftNamespace,
    configForRouteWorkspace,
    WorkspaceController,
    WorkspaceSetupRequiredError,
} from "./workspace.js";
import { WorkspaceLoader } from "./workspace.loader.js";
import { ShellView } from "./shell.view.js";
import {
    getRequiredElement,
    getSourceMode,
    safeText,
    setVisible,
    TimeContext,
} from "./utils.js";
import { LocaleService, resolveLocale } from "./locale.js";
import { consumeOAuthCallback } from "./oauth.js";
import {
    consumeCapabilityLink,
    getApplicationBasePath,
    RouteController,
    workspaceRouteLocatorKey,
} from "./routing.js";

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
        this.localePreference = this.configService.loadLocale();
        this.browserLanguages = Array.isArray(navigator.languages)
            ? navigator.languages
            : navigator.language
              ? [navigator.language]
              : [];
        this.locale = new LocaleService(resolveLocale(this.localePreference, this.browserLanguages));
        this.locale.applyDocument(document);
        this.isLocalMode = this.initialRoute.workspace?.provider === "local" || getSourceMode() === "local";
        const persistedConfig = this.configService.loadConfig();
        const storedConfig =
            !this.isLocalMode && persistedConfig.provider === "local"
                ? {
                      ...persistedConfig,
                      owner: DEFAULT_CONFIG.owner,
                      provider: DEFAULT_CONFIG.provider,
                      ref: DEFAULT_CONFIG.ref,
                      repo: DEFAULT_CONFIG.repo,
                      repositoryUrl: DEFAULT_CONFIG.repositoryUrl,
                      workspacePath: DEFAULT_CONFIG.workspacePath,
                  }
                : persistedConfig;
        if (this.isLocalMode) {
            this.workspaceRegistry = new WorkspaceRegistry();
        } else {
            const persistedRegistry = this.configService.loadWorkspaceRegistry(storedConfig);
            const persistedActive = persistedRegistry.getActive();
            this.workspaceRegistry = new WorkspaceRegistry(
                persistedRegistry.list().filter((connection) => connection.provider !== "local"),
                persistedActive?.provider === "local" ? "" : persistedActive?.id || "",
            );
        }
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
        this.remoteCache = new RemoteCache();
        /** @type {import("./model.js").Workspace | null} */
        this.workspace = null;
        /** @type {{reason: "missing" | "invalid_json" | "invalid", path: string, detail: string, raw: Object | null} | null} */
        this.workspaceSetup = null;
        /** @type {Object | null} */
        this.workspaceConfigBaseRaw = null;

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
        this.openSharedWorkspaceBtn = getRequiredElement("openSharedWorkspaceBtn", HTMLButtonElement);
        this.clearSavedBtn = getRequiredElement("clearSavedBtn", HTMLButtonElement);

        this.sidebarEl = getRequiredElement("appSidebar", HTMLElement);
        this.topbarEl = getRequiredElement("topbar", HTMLElement);
        this.appHomeLink = getRequiredElement("appHomeLink", HTMLAnchorElement);
        this.workspaceSettingsBtn = getRequiredElement("workspaceSettingsBtn", HTMLButtonElement);
        this.interfaceSettingsBtn = getRequiredElement("interfaceSettingsBtn", HTMLButtonElement);
        this.appLanguageLabelEl = getRequiredElement("appLanguageLabel", HTMLElement);
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
        this.landingLanguageSelect = getRequiredElement("landingLanguage", HTMLSelectElement);
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
        this.projectBindingDialog = getRequiredElement("projectBindingDialog", HTMLDialogElement);
        this.projectBindingForm = getRequiredElement("projectBindingForm", HTMLFormElement);
        this.projectBindingCloseBtn = getRequiredElement("projectBindingCloseBtn", HTMLButtonElement);
        this.projectBindingCancelBtn = getRequiredElement("projectBindingCancelBtn", HTMLButtonElement);
        this.projectBindingListEl = getRequiredElement("projectBindingList", HTMLElement);
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
        this.todoConflictDialog = getRequiredElement("todoConflictDialog", HTMLDialogElement);
        this.todoConflictCloseBtn = getRequiredElement("todoConflictCloseBtn", HTMLButtonElement);
        this.todoConflictListEl = getRequiredElement("todoConflictList", HTMLElement);

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
        this.expenseDialogErrorEl = getRequiredElement("expenseDialogError", HTMLElement);
        this.expenseCloseBtn = getRequiredElement("expenseCloseBtn", HTMLButtonElement);
        this.expenseCancelBtn = getRequiredElement("expenseCancelBtn", HTMLButtonElement);
        this.expenseDeleteBtn = getRequiredElement("expenseDeleteBtn", HTMLButtonElement);
        this.expenseSubmitBtn = getRequiredElement("expenseSubmitBtn", HTMLButtonElement);
        this.expenseDescriptionInput = getRequiredElement("expenseDescription", HTMLInputElement);
        this.expenseDateInput = getRequiredElement("expenseDate", HTMLInputElement);
        this.expenseAmountInput = getRequiredElement("expenseAmount", HTMLInputElement);
        this.expenseCurrencyInput = getRequiredElement("expenseCurrency", HTMLInputElement);
        this.expenseCategoryInput = getRequiredElement("expenseCategory", HTMLInputElement);
        this.expenseCategoryOptions = getRequiredElement("expenseCategoryOptions", HTMLDataListElement);
        this.expenseCategoryHintEl = getRequiredElement("expenseCategoryHint", HTMLElement);
        this.expensePayerSummaryBtn = getRequiredElement("expensePayerSummaryBtn", HTMLButtonElement);
        this.expensePayerSummaryEl = getRequiredElement("expensePayerSummary", HTMLElement);
        this.expensePayerSummaryMetaEl = getRequiredElement("expensePayerSummaryMeta", HTMLElement);
        this.expensePayerSelect = getRequiredElement("expensePayer", HTMLSelectElement);
        this.expensePayerPanelEl = getRequiredElement("expensePayerPanel", HTMLElement);
        this.expensePayerPanelCloseBtn = getRequiredElement("expensePayerPanelCloseBtn", HTMLButtonElement);
        this.expensePayerCustomFieldsEl = getRequiredElement("expensePayerCustomFields", HTMLElement);
        this.expensePayerRowsEl = getRequiredElement("expensePayerRows", HTMLElement);
        this.expensePayerRemainingEl = getRequiredElement("expensePayerRemaining", HTMLElement);
        this.expenseSplitSummaryBtn = getRequiredElement("expenseSplitSummaryBtn", HTMLButtonElement);
        this.expenseSplitSummaryEl = getRequiredElement("expenseSplitSummary", HTMLElement);
        this.expenseSplitSummaryMetaEl = getRequiredElement("expenseSplitSummaryMeta", HTMLElement);
        this.expenseSplitPanelEl = getRequiredElement("expenseSplitPanel", HTMLElement);
        this.expenseSplitPanelCloseBtn = getRequiredElement("expenseSplitPanelCloseBtn", HTMLButtonElement);
        this.expenseAllocationChoicesEl = getRequiredElement("expenseAllocationChoices", HTMLElement);
        this.expenseSplitRemainingEl = getRequiredElement("expenseSplitRemaining", HTMLElement);
        this.expenseOutcomeEl = getRequiredElement("expenseOutcome", HTMLElement);
        this.expenseOutcomeSummaryEl = getRequiredElement("expenseOutcomeSummary", HTMLElement);
        this.expenseOutcomeDetailsEl = getRequiredElement("expenseOutcomeDetails", HTMLElement);
        this.expenseAdvancedDetails = getRequiredElement("expenseAdvancedDetails", HTMLDetailsElement);
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
        this.expenseInventoryTitleEl = getRequiredElement("expenseInventoryTitle", HTMLElement);
        this.expenseInventoryMetaEl = getRequiredElement("expenseInventoryMeta", HTMLElement);
        this.expenseInventoryErrorEl = getRequiredElement("expenseInventoryError", HTMLElement);
        this.expenseInventoryCloseBtn = getRequiredElement("expenseInventoryCloseBtn", HTMLButtonElement);
        this.expenseInventoryCancelBtn = getRequiredElement("expenseInventoryCancelBtn", HTMLButtonElement);
        this.expenseInventorySubmitBtn = getRequiredElement("expenseInventorySubmitBtn", HTMLButtonElement);
        this.expenseAddParticipantBtn = getRequiredElement("expenseAddParticipantBtn", HTMLButtonElement);
        this.expenseAddCategoryBtn = getRequiredElement("expenseAddCategoryBtn", HTMLButtonElement);
        this.expenseParticipantListEl = getRequiredElement("expenseParticipantList", HTMLElement);
        this.expenseCategoryListEl = getRequiredElement("expenseCategoryList", HTMLElement);
        this.expenseInventoryCategoriesSectionEl = getRequiredElement("expenseInventoryCategoriesSection", HTMLElement);

        this.providerInput = getRequiredElement("providerInput", HTMLSelectElement);
        this.landingProviderStatusTextEl = getRequiredElement("landingProviderStatusText", HTMLElement);
        this.repositoryInput = getRequiredElement("repositoryInput", HTMLInputElement);
        this.refInput = getRequiredElement("refInput", HTMLInputElement);
        this.tokenInput = getRequiredElement("tokenInput", HTMLInputElement);
        this.rememberInput = getRequiredElement("rememberInput", HTMLInputElement);

        this.interfaceDialog = getRequiredElement("interfaceDialog", HTMLDialogElement);
        this.interfaceDialogCloseBtn = getRequiredElement("interfaceDialogCloseBtn", HTMLButtonElement);
        this.interfaceLanguageSelect = getRequiredElement("interfaceLanguage", HTMLSelectElement);
        this.workspaceDialog = getRequiredElement("workspaceDialog", HTMLDialogElement);
        this.workspaceDialogCloseBtn = getRequiredElement("workspaceDialogCloseBtn", HTMLButtonElement);
        this.workspaceListEl = getRequiredElement("workspaceList", HTMLElement);
        this.workspaceConfigForm = getRequiredElement("workspaceConfigForm", HTMLFormElement);
        this.workspaceConfigMetaEl = getRequiredElement("workspaceConfigMeta", HTMLElement);
        this.workspaceConfigNameInput = getRequiredElement("workspaceConfigName", HTMLInputElement);
        this.workspaceConfigIdInput = getRequiredElement("workspaceConfigId", HTMLInputElement);
        this.workspaceConfigTimezoneInput = getRequiredElement("workspaceConfigTimezone", HTMLInputElement);
        this.workspaceConfigProjectsPathInput = getRequiredElement("workspaceConfigProjectsPath", HTMLInputElement);
        this.workspaceConfigTimeEnabledInput = getRequiredElement("workspaceConfigTimeEnabled", HTMLInputElement);
        this.workspaceConfigTimeFieldsEl = getRequiredElement("workspaceConfigTimeFields", HTMLElement);
        this.workspaceConfigTimeEntriesInput = getRequiredElement("workspaceConfigTimeEntries", HTMLInputElement);
        this.workspaceConfigTimeManifestInput = getRequiredElement("workspaceConfigTimeManifest", HTMLInputElement);
        this.workspaceConfigTimeRequirementsInput = getRequiredElement("workspaceConfigTimeRequirements", HTMLInputElement);
        this.workspaceConfigTodosEnabledInput = getRequiredElement("workspaceConfigTodosEnabled", HTMLInputElement);
        this.workspaceConfigTodosFieldsEl = getRequiredElement("workspaceConfigTodosFields", HTMLElement);
        this.workspaceConfigTodosDocumentInput = getRequiredElement("workspaceConfigTodosDocument", HTMLInputElement);
        this.workspaceConfigExpensesEnabledInput = getRequiredElement("workspaceConfigExpensesEnabled", HTMLInputElement);
        this.workspaceConfigExpensesFieldsEl = getRequiredElement("workspaceConfigExpensesFields", HTMLElement);
        this.workspaceConfigExpensesDocumentInput = getRequiredElement("workspaceConfigExpensesDocument", HTMLInputElement);
        this.workspaceConfigExpensesManifestInput = getRequiredElement("workspaceConfigExpensesManifest", HTMLInputElement);
        this.workspaceConfigErrorEl = getRequiredElement("workspaceConfigError", HTMLElement);
        this.workspaceConfigSaveBtn = getRequiredElement("workspaceConfigSaveBtn", HTMLButtonElement);
        this.workspaceAddSectionEl = getRequiredElement("workspaceAddSection", HTMLElement);
        this.workspaceCapabilityForm = getRequiredElement("workspaceCapabilityForm", HTMLFormElement);
        this.workspaceCapabilityLinkInput = getRequiredElement("workspaceCapabilityLink", HTMLInputElement);
        this.workspaceCapabilityErrorEl = getRequiredElement("workspaceCapabilityError", HTMLElement);
        this.workspaceScanCapabilityBtn = getRequiredElement("workspaceScanCapabilityBtn", HTMLButtonElement);
        this.workspaceOpenCapabilityBtn = getRequiredElement("workspaceOpenCapabilityBtn", HTMLButtonElement);
        this.workspaceQrScannerEl = getRequiredElement("workspaceQrScanner", HTMLElement);
        this.workspaceQrVideoEl = getRequiredElement("workspaceQrVideo", HTMLVideoElement);
        this.workspaceQrFileInput = getRequiredElement("workspaceQrFile", HTMLInputElement);
        this.workspaceQrCloseBtn = getRequiredElement("workspaceQrCloseBtn", HTMLButtonElement);
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
        this.workspaceCopyCapabilityBtn = getRequiredElement("workspaceCopyCapabilityBtn", HTMLButtonElement);
        this.workspaceShareErrorEl = getRequiredElement("workspaceShareError", HTMLElement);

        this.weekView = new WeekView({
            store: this.store,
            chunkCache: this.chunkCache,
            draftJournal: this.draftJournal,
            draftNamespace: buildWorkspaceDraftNamespace(
                this.isLocalMode,
                this.activeWorkspaceConnection,
                this.workspace,
                this.config,
            ),
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
            onToast: (message, timeout, tone) => this.shell.toast(message, timeout, tone),
            onBusy: (busy) => this.shell.setBusy(busy),
            onSearchDirty: () => this.shell.markSearchDirty(),
            onManifestUpdated: () => this.shell.refreshRepoLabel(),
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
                this.shell.setTab("week");
                this.weekView.jumpToEntry(entry);
            },
            onStateChange: () => this.scheduleRouteReplace(),
        });

        this.todoView = new TodoView({
            store: this.todoStore,
            projectStore: this.store,
            dataSource: this.dataSource,
            draftJournal: this.draftJournal,
            remoteCache: this.remoteCache,
            draftNamespace: buildWorkspaceDraftNamespace(
                this.isLocalMode,
                this.activeWorkspaceConnection,
                this.workspace,
                this.config,
            ),
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
                todoConflictDialog: this.todoConflictDialog,
                todoConflictCloseBtn: this.todoConflictCloseBtn,
                todoConflictList: this.todoConflictListEl,
                editorBadge: this.editorBadgeEl,
            },
            onToast: (message, timeout, tone) => this.shell.toast(message, timeout, tone),
            onBusy: (busy) => this.shell.setBusy(busy),
            onSaved: () => this.shell.refreshRepoLabel(),
            onStatsChanged: (summary) => {
                this.shell.todoSummary = summary;
                this.shell.refreshDataBadge();
            },
            onStateChange: () => this.scheduleRouteReplace(),
        });

        this.expenseView = new ExpenseView({
            store: this.expenseStore,
            projectStore: this.store,
            dataSource: this.dataSource,
            draftJournal: this.draftJournal,
            draftNamespace: buildWorkspaceDraftNamespace(
                this.isLocalMode,
                this.activeWorkspaceConnection,
                this.workspace,
                this.config,
            ),
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
                expenseDialogError: this.expenseDialogErrorEl,
                expenseCloseBtn: this.expenseCloseBtn,
                expenseCancelBtn: this.expenseCancelBtn,
                expenseDeleteBtn: this.expenseDeleteBtn,
                expenseSubmitBtn: this.expenseSubmitBtn,
                expenseDescription: this.expenseDescriptionInput,
                expenseDate: this.expenseDateInput,
                expenseAmount: this.expenseAmountInput,
                expenseCurrency: this.expenseCurrencyInput,
                expenseCategory: this.expenseCategoryInput,
                expenseCategoryOptions: this.expenseCategoryOptions,
                expenseCategoryHint: this.expenseCategoryHintEl,
                expensePayerSummaryBtn: this.expensePayerSummaryBtn,
                expensePayerSummary: this.expensePayerSummaryEl,
                expensePayerSummaryMeta: this.expensePayerSummaryMetaEl,
                expensePayer: this.expensePayerSelect,
                expensePayerPanel: this.expensePayerPanelEl,
                expensePayerPanelCloseBtn: this.expensePayerPanelCloseBtn,
                expensePayerCustomFields: this.expensePayerCustomFieldsEl,
                expensePayerRows: this.expensePayerRowsEl,
                expensePayerRemaining: this.expensePayerRemainingEl,
                expenseSplitSummaryBtn: this.expenseSplitSummaryBtn,
                expenseSplitSummary: this.expenseSplitSummaryEl,
                expenseSplitSummaryMeta: this.expenseSplitSummaryMetaEl,
                expenseSplitPanel: this.expenseSplitPanelEl,
                expenseSplitPanelCloseBtn: this.expenseSplitPanelCloseBtn,
                expenseAllocationChoices: this.expenseAllocationChoicesEl,
                expenseSplitRemaining: this.expenseSplitRemainingEl,
                expenseOutcome: this.expenseOutcomeEl,
                expenseOutcomeSummary: this.expenseOutcomeSummaryEl,
                expenseOutcomeDetails: this.expenseOutcomeDetailsEl,
                expenseAdvancedDetails: this.expenseAdvancedDetails,
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
                expenseInventoryTitle: this.expenseInventoryTitleEl,
                expenseInventoryMeta: this.expenseInventoryMetaEl,
                expenseInventoryError: this.expenseInventoryErrorEl,
                expenseInventoryCloseBtn: this.expenseInventoryCloseBtn,
                expenseInventoryCancelBtn: this.expenseInventoryCancelBtn,
                expenseInventorySubmitBtn: this.expenseInventorySubmitBtn,
                expenseAddParticipantBtn: this.expenseAddParticipantBtn,
                expenseAddCategoryBtn: this.expenseAddCategoryBtn,
                expenseParticipantList: this.expenseParticipantListEl,
                expenseCategoryList: this.expenseCategoryListEl,
                expenseInventoryCategoriesSection: this.expenseInventoryCategoriesSectionEl,
            },
            onToast: (message, timeout, tone) => this.shell.toast(message, timeout, tone),
            onBusy: (busy) => this.shell.setBusy(busy),
            onSaved: () => this.shell.refreshRepoLabel(),
            onStatsChanged: (summary) => {
                this.shell.expenseSummary = summary;
                this.shell.refreshDataBadge();
            },
            onStateChange: () => this.scheduleRouteReplace(),
        });

        this.projectDialog = new ProjectDialog({
            store: this.store,
            todoStore: this.todoStore,
            dataSource: this.dataSource,
            locale: this.locale,
            elements: {
                dialog: this.projectsDialog,
                form: this.projectsForm,
                closeBtn: this.projectsCloseBtn,
                cancelBtn: this.projectsCancelBtn,
                addBtn: this.addProjectBtn,
                list: this.projectsList,
                bindingDialog: this.projectBindingDialog,
                bindingForm: this.projectBindingForm,
                bindingCloseBtn: this.projectBindingCloseBtn,
                bindingCancelBtn: this.projectBindingCancelBtn,
                bindingList: this.projectBindingListEl,
            },
            onToast: (message, timeout, tone) => this.shell.toast(message, timeout, tone),
            onBusy: (busy) => this.shell.setBusy(busy),
            onProjectsSaved: (projectList) => this.handleProjectsSaved(projectList),
            onTodosSaved: async ({ reloadGitHub }) => {
                if (!this.workspace?.hasComponent("todos")) return;
                if (reloadGitHub) await this.todoView.loadGitHubIssues();
                await this.todoView.acceptExternallySavedState();
                this.todoView.setProjects();
                this.shell.refreshRepoLabel();
            },
            hasUnsavedTodos: () =>
                this.workspace?.hasComponent("todos") === true && this.todoView.hasBlockingProjectMigrationChanges(),
        });

        const application = this;
        const workspaceRuntime = {
            get activeGlobalPanel() {
                return application.activeGlobalPanel;
            },
            set activeGlobalPanel(value) {
                application.activeGlobalPanel = value;
            },
            get activeWorkspaceConnection() {
                return application.activeWorkspaceConnection;
            },
            set activeWorkspaceConnection(value) {
                application.activeWorkspaceConnection = value;
            },
            get capabilityImport() {
                return application.capabilityImport;
            },
            set capabilityImport(value) {
                application.capabilityImport = value;
            },
            get config() {
                return application.config;
            },
            set config(value) {
                application.config = value;
            },
            get dataSource() {
                return application.dataSource;
            },
            set dataSource(value) {
                application.dataSource = value;
            },
            get pendingRoute() {
                return application.pendingRoute;
            },
            set pendingRoute(value) {
                application.pendingRoute = value;
            },
            get routeRestoreInProgress() {
                return application.routeRestoreInProgress;
            },
            set routeRestoreInProgress(value) {
                application.routeRestoreInProgress = value;
            },
            get token() {
                return application.token;
            },
            set token(value) {
                application.token = value;
            },
            get workspace() {
                return application.workspace;
            },
            set workspace(value) {
                application.workspace = value;
            },
            get workspaceConfigBaseRaw() {
                return application.workspaceConfigBaseRaw;
            },
            set workspaceConfigBaseRaw(value) {
                application.workspaceConfigBaseRaw = value;
            },
            get workspaceRegistry() {
                return application.workspaceRegistry;
            },
            set workspaceRegistry(value) {
                application.workspaceRegistry = value;
            },
            get workspaceSetup() {
                return application.workspaceSetup;
            },
            set workspaceSetup(value) {
                application.workspaceSetup = value;
            },
        };
        this.workspaceController = new WorkspaceController({
            runtime: workspaceRuntime,
            isLocalMode: this.isLocalMode,
            configService: this.configService,
            locale: this.locale,
            routeController: this.routeController,
            state: this.state,
            weekView: this.weekView,
            todoView: this.todoView,
            expenseView: this.expenseView,
            projectDialog: this.projectDialog,
            elements: {
                landingProviderStatusTextEl: this.landingProviderStatusTextEl,
                loginErrorEl: this.loginErrorEl,
                loginOAuthBtn: this.loginOAuthBtn,
                providerInput: this.providerInput,
                repositoryInput: this.repositoryInput,
                refInput: this.refInput,
                rememberInput: this.rememberInput,
                workspaceSettingsBtn: this.workspaceSettingsBtn,
                workspaceDialog: this.workspaceDialog,
                workspaceListEl: this.workspaceListEl,
                workspaceConfigForm: this.workspaceConfigForm,
                workspaceConfigMetaEl: this.workspaceConfigMetaEl,
                workspaceConfigNameInput: this.workspaceConfigNameInput,
                workspaceConfigIdInput: this.workspaceConfigIdInput,
                workspaceConfigTimezoneInput: this.workspaceConfigTimezoneInput,
                workspaceConfigProjectsPathInput: this.workspaceConfigProjectsPathInput,
                workspaceConfigTimeEnabledInput: this.workspaceConfigTimeEnabledInput,
                workspaceConfigTimeFieldsEl: this.workspaceConfigTimeFieldsEl,
                workspaceConfigTimeEntriesInput: this.workspaceConfigTimeEntriesInput,
                workspaceConfigTimeManifestInput: this.workspaceConfigTimeManifestInput,
                workspaceConfigTimeRequirementsInput: this.workspaceConfigTimeRequirementsInput,
                workspaceConfigTodosEnabledInput: this.workspaceConfigTodosEnabledInput,
                workspaceConfigTodosFieldsEl: this.workspaceConfigTodosFieldsEl,
                workspaceConfigTodosDocumentInput: this.workspaceConfigTodosDocumentInput,
                workspaceConfigExpensesEnabledInput: this.workspaceConfigExpensesEnabledInput,
                workspaceConfigExpensesFieldsEl: this.workspaceConfigExpensesFieldsEl,
                workspaceConfigExpensesDocumentInput: this.workspaceConfigExpensesDocumentInput,
                workspaceConfigExpensesManifestInput: this.workspaceConfigExpensesManifestInput,
                workspaceConfigErrorEl: this.workspaceConfigErrorEl,
                workspaceConfigSaveBtn: this.workspaceConfigSaveBtn,
                workspaceAddSectionEl: this.workspaceAddSectionEl,
                workspaceCapabilityForm: this.workspaceCapabilityForm,
                workspaceCapabilityLinkInput: this.workspaceCapabilityLinkInput,
                workspaceCapabilityErrorEl: this.workspaceCapabilityErrorEl,
                workspaceScanCapabilityBtn: this.workspaceScanCapabilityBtn,
                workspaceOpenCapabilityBtn: this.workspaceOpenCapabilityBtn,
                workspaceQrScannerEl: this.workspaceQrScannerEl,
                workspaceQrVideoEl: this.workspaceQrVideoEl,
                workspaceQrFileInput: this.workspaceQrFileInput,
                workspaceQrCloseBtn: this.workspaceQrCloseBtn,
                workspaceAddForm: this.workspaceAddForm,
                workspaceProviderInput: this.workspaceProviderInput,
                workspaceRepositoryInput: this.workspaceRepositoryInput,
                workspaceRefInput: this.workspaceRefInput,
                workspacePathInput: this.workspacePathInput,
                workspaceTokenInput: this.workspaceTokenInput,
                workspaceRememberInput: this.workspaceRememberInput,
                workspaceErrorEl: this.workspaceErrorEl,
                workspaceShareBtn: this.workspaceShareBtn,
                workspaceOAuthBtn: this.workspaceOAuthBtn,
                workspaceCreateDialog: this.workspaceCreateDialog,
                workspaceCreateProviderInput: this.workspaceCreateProviderInput,
                workspaceCreateRepositoryInput: this.workspaceCreateRepositoryInput,
                workspaceCreateNameInput: this.workspaceCreateNameInput,
                workspaceCreateTimezoneInput: this.workspaceCreateTimezoneInput,
                workspaceCreateTokenInput: this.workspaceCreateTokenInput,
                workspaceCreateRememberInput: this.workspaceCreateRememberInput,
                workspaceCreateProviderNoteEl: this.workspaceCreateProviderNoteEl,
                workspaceCreateErrorEl: this.workspaceCreateErrorEl,
                workspaceCreateOAuthBtn: this.workspaceCreateOAuthBtn,
                workspaceShareDialog: this.workspaceShareDialog,
                workspaceShareDetailsEl: this.workspaceShareDetailsEl,
                workspaceCopyLocatorBtn: this.workspaceCopyLocatorBtn,
                workspaceCopyCapabilityBtn: this.workspaceCopyCapabilityBtn,
                workspaceShareErrorEl: this.workspaceShareErrorEl,
            },
            onError: (element, message) => this.shell.setError(element, message),
            onToast: (message, timeout, tone) => this.shell.toast(message, timeout, tone),
            onBusy: (busy) => this.shell.setBusy(busy),
            onShowLogin: () => this.shell.showLoginScreen(),
            onRefreshNavigation: () => this.refreshSidebarNavigation(),
            onReload: () => this.reloadData(),
            onConnect: (token, connectionInfo) => this.connectWithToken(token, connectionInfo),
            onWriteRoute: (mode) => this.writeCurrentRoute(mode),
            buildCurrentRoute: () => this.buildCurrentRoute(),
            onLogout: (clearCredential) => this.logout(clearCredential),
        });
        this.workspaceLoader = new WorkspaceLoader({
            runtime: workspaceRuntime,
            isLocalMode: this.isLocalMode,
            configService: this.configService,
            state: this.state,
            store: this.store,
            todoStore: this.todoStore,
            expenseStore: this.expenseStore,
            chunkCache: this.chunkCache,
            locale: this.locale,
            timeContext: this.timeContext,
            weekView: this.weekView,
            searchView: this.searchView,
            todoView: this.todoView,
            expenseView: this.expenseView,
            workspaceController: this.workspaceController,
            onProgress: (loaded, total, label) => this.shell.setProgress(loaded, total, label),
            onToast: (message, timeout, tone) => this.shell.toast(message, timeout, tone),
            onSearchDirty: () => this.shell.markSearchDirty(),
            onRepositorySummaryChanged: () => this.shell.refreshRepoLabel(),
            onNavigationChanged: () => this.refreshSidebarNavigation(),
        });
        this.shell = new ShellView({
            runtime: workspaceRuntime,
            isLocalMode: this.isLocalMode,
            configService: this.configService,
            locale: this.locale,
            state: this.state,
            timeContext: this.timeContext,
            store: this.store,
            todoStore: this.todoStore,
            expenseStore: this.expenseStore,
            weekView: this.weekView,
            searchView: this.searchView,
            todoView: this.todoView,
            expenseView: this.expenseView,
            workspaceController: this.workspaceController,
            elements: {
                addProjectBtn: this.addProjectBtn,
                appSection: this.appSection,
                appThemeToggleBtn: this.appThemeToggleBtn,
                appZoomInBtn: this.appZoomInBtn,
                appZoomLabelEl: this.appZoomLabelEl,
                appZoomOutBtn: this.appZoomOutBtn,
                appZoomResetBtn: this.appZoomResetBtn,
                authStatusEl: this.authStatusEl,
                createWorkspaceBtn: this.createWorkspaceBtn,
                dataErrorEl: this.dataErrorEl,
                editorBadgeEl: this.editorBadgeEl,
                expenseTopbarControlsEl: this.expenseTopbarControlsEl,
                fromDateInput: this.fromDateInput,
                globalSearchEl: this.globalSearchEl,
                interfaceDialog: this.interfaceDialog,
                interfaceSettingsBtn: this.interfaceSettingsBtn,
                landingThemeToggleBtn: this.landingThemeToggleBtn,
                latestWeekBtn: this.latestWeekBtn,
                loadProgressEl: this.loadProgressEl,
                loadProgressLabelEl: this.loadProgressLabelEl,
                loadingActionsEl: this.loadingActionsEl,
                loadingErrorEl: this.loadingErrorEl,
                loadingLogoutBtn: this.loadingLogoutBtn,
                loadingRetryBtn: this.loadingRetryBtn,
                loadingSection: this.loadingSection,
                loginOAuthBtn: this.loginOAuthBtn,
                loginSection: this.loginSection,
                logoutBtn: this.logoutBtn,
                maxRowsInput: this.maxRowsInput,
                menuExpenseBtn: this.menuExpenseBtn,
                menuSearchBtn: this.menuSearchBtn,
                menuTodoBtn: this.menuTodoBtn,
                menuWeekBtn: this.menuWeekBtn,
                nextWeekBtn: this.nextWeekBtn,
                openSharedWorkspaceBtn: this.openSharedWorkspaceBtn,
                prevWeekBtn: this.prevWeekBtn,
                projectBindingCancelBtn: this.projectBindingCancelBtn,
                projectBindingCloseBtn: this.projectBindingCloseBtn,
                projectBindingDialog: this.projectBindingDialog,
                projectSelect: this.projectSelect,
                projectsBtn: this.projectsBtn,
                projectsCancelBtn: this.projectsCancelBtn,
                projectsCloseBtn: this.projectsCloseBtn,
                projectsList: this.projectsList,
                projectsOkBtn: this.projectsOkBtn,
                providerInput: this.providerInput,
                refInput: this.refInput,
                reloadDataBtn: this.reloadDataBtn,
                rememberInput: this.rememberInput,
                repoLabelEl: this.repoLabelEl,
                repositoryInput: this.repositoryInput,
                searchFiltersPanelEl: this.searchFiltersPanelEl,
                searchFromLabelEl: this.searchFromLabelEl,
                searchInput: this.searchInput,
                searchToLabelEl: this.searchToLabelEl,
                sidebarEl: this.sidebarEl,
                sortSelect: this.sortSelect,
                toDateInput: this.toDateInput,
                todoTopbarControlsEl: this.todoTopbarControlsEl,
                tokenInput: this.tokenInput,
                topbarEl: this.topbarEl,
                weekControlsEl: this.weekControlsEl,
                weekReqBtn: this.weekReqBtn,
                weekReqCancelBtn: this.weekReqCancelBtn,
                weekReqCloseBtn: this.weekReqCloseBtn,
                weekReqComment: this.weekReqComment,
                weekReqHours: this.weekReqHours,
                weekReqOkBtn: this.weekReqOkBtn,
                workspaceConfigExpensesEnabledInput: this.workspaceConfigExpensesEnabledInput,
                workspaceConfigIdInput: this.workspaceConfigIdInput,
                workspaceConfigNameInput: this.workspaceConfigNameInput,
                workspaceConfigProjectsPathInput: this.workspaceConfigProjectsPathInput,
                workspaceConfigSaveBtn: this.workspaceConfigSaveBtn,
                workspaceConfigTimeEnabledInput: this.workspaceConfigTimeEnabledInput,
                workspaceConfigTimezoneInput: this.workspaceConfigTimezoneInput,
                workspaceConfigTodosEnabledInput: this.workspaceConfigTodosEnabledInput,
                workspaceCapabilityLinkInput: this.workspaceCapabilityLinkInput,
                workspaceCopyCapabilityBtn: this.workspaceCopyCapabilityBtn,
                workspaceCopyLocatorBtn: this.workspaceCopyLocatorBtn,
                workspaceCreateBtn: this.workspaceCreateBtn,
                workspaceCreateCancelBtn: this.workspaceCreateCancelBtn,
                workspaceCreateCloseBtn: this.workspaceCreateCloseBtn,
                workspaceCreateNameInput: this.workspaceCreateNameInput,
                workspaceCreateOAuthBtn: this.workspaceCreateOAuthBtn,
                workspaceCreateProviderInput: this.workspaceCreateProviderInput,
                workspaceCreateRememberInput: this.workspaceCreateRememberInput,
                workspaceCreateRepositoryInput: this.workspaceCreateRepositoryInput,
                workspaceCreateTimezoneInput: this.workspaceCreateTimezoneInput,
                workspaceCreateTokenInput: this.workspaceCreateTokenInput,
                workspaceDialogCloseBtn: this.workspaceDialogCloseBtn,
                workspaceOpenCapabilityBtn: this.workspaceOpenCapabilityBtn,
                workspaceOAuthBtn: this.workspaceOAuthBtn,
                workspacePathInput: this.workspacePathInput,
                workspaceProviderInput: this.workspaceProviderInput,
                workspaceRefInput: this.workspaceRefInput,
                workspaceRememberInput: this.workspaceRememberInput,
                workspaceRepositoryInput: this.workspaceRepositoryInput,
                workspaceSettingsBtn: this.workspaceSettingsBtn,
                workspaceScanCapabilityBtn: this.workspaceScanCapabilityBtn,
                workspaceShareBtn: this.workspaceShareBtn,
                workspaceShareCloseBtn: this.workspaceShareCloseBtn,
                workspaceQrCloseBtn: this.workspaceQrCloseBtn,
                workspaceQrFileInput: this.workspaceQrFileInput,
                workspaceTokenInput: this.workspaceTokenInput,
                zoomInput: this.zoomInput,
            },
            hasResumableWorkspace: () => this.hasResumableWorkspace(),
            onNavigationChanged: () => this.refreshSidebarNavigation(),
            onWriteRoute: (mode) => this.writeCurrentRoute(mode),
        });
        this.shell.initializeAppearance();
        this.applyLocale(this.localePreference, false);
    }

    /**
     * Applies one interface language across declarative markup, dynamic views, formatters, and accessibility labels.
     * The preference is browser-local and never written into a workspace repository; changing it preserves all selected records and route state.
     * Automatic mode resolves the effective language from the browser every time the application starts, while explicit choices override it.
     * @param {unknown} locale Requested language preference (`auto`, `en`, or `de`).
     * @param {boolean} [shouldPersist] Whether ConfigService should retain the selection for later visits.
     * @returns {void}
     */
    applyLocale(locale, shouldPersist = true) {
        const requested = String(locale || "").trim().toLowerCase();
        this.localePreference = requested === "en" || requested === "de" ? requested : "auto";
        this.locale.setLocale(resolveLocale(this.localePreference, this.browserLanguages));
        if (shouldPersist) this.configService.saveLocale(this.localePreference);
        this.locale.applyDocument(document);
        this.landingLanguageSelect.value = this.localePreference;
        this.interfaceLanguageSelect.value = this.localePreference;
        this.appLanguageLabelEl.textContent = this.locale.locale.toUpperCase();
        this.shell.setTheme(this.shell.theme, false);
        this.shell.setAppZoom(this.shell.uiZoom, false, this.shell.uiZoomMode);
        this.workspaceController.updateProviderForm(this.providerInput, this.repositoryInput);
        this.workspaceController.updateProviderForm(this.workspaceProviderInput, this.workspaceRepositoryInput);
        this.workspaceController.refreshOAuthControls();
        this.shell.updateSearchControls();
        this.projectDialog.refreshLocale();
        this.weekView.refreshLocale();
        this.searchView.refreshLocale();
        this.todoView.refreshLocale();
        this.expenseView.refreshLocale();
        this.workspaceController.renderWorkspaceRegistry();
        this.shell.refreshRepoLabel();
    }

    /**
     * Captures the active component and all navigation-relevant view state in the route model.
     * Time search shares one route state with the week timeline, while TODO filters remain wholly owned by TodoView.
     * @returns {import("./routing.js").AppRoute}
     */
    buildCurrentRoute() {
        const globalPanel =
            this.activeGlobalPanel === "workspaces" || this.activeGlobalPanel === "settings"
                ? this.activeGlobalPanel
                : null;
        if (this.state.activeTab === "todos") {
            return {
                version: 1,
                component: "todos",
                panel: globalPanel || "main",
                workspace: this.workspaceController.getCurrentWorkspaceRouteLocator(),
                state: this.todoView.getRouteState(),
            };
        }
        if (this.state.activeTab === "expenses") {
            return {
                version: 1,
                component: "expenses",
                panel: globalPanel || "main",
                workspace: this.workspaceController.getCurrentWorkspaceRouteLocator(),
                state: this.expenseView.getRouteState(),
            };
        }

        const underlyingPanel = this.state.activeTab === "search" ? "search" : "main";
        const panel = globalPanel || underlyingPanel;
        return {
            version: 1,
            component: "time",
            panel,
            workspace: this.workspaceController.getCurrentWorkspaceRouteLocator(),
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
            (route.panel === "search" ||
                ((route.panel === "workspaces" || route.panel === "settings") && route.state.returnPanel === "search"))
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
        this.shell.setTab(tab, "none");
        if (normalized.component === "time") {
            this.weekView.restoreRouteState(normalized.state);
            if (tab === "search") this.searchView.restoreRouteState(normalized.state);
        } else if (normalized.component === "todos") {
            this.todoView.restoreRouteState(normalized.state);
        } else if (normalized.component === "expenses") {
            this.expenseView.restoreRouteState(normalized.state);
        }
        if (normalized.panel === "workspaces") {
            this.shell.closeInterfaceSettings("none");
            this.workspaceController.openWorkspaceSettings("none");
        } else if (normalized.panel === "settings") {
            this.workspaceController.closeWorkspaceSettings("none");
            this.shell.openInterfaceSettings("none");
        } else {
            this.workspaceController.closeWorkspaceSettings("none");
            this.shell.closeInterfaceSettings("none");
        }

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
            this.pendingRoute = null;
            this.shell.showLoginScreen();
            return;
        }

        this.pendingRoute = route;
        if (!this.routeTargetsCurrentConnection(route.workspace)) {
            if (this.isLocalMode && route.workspace?.provider === "local") {
                const localConnection = this.workspaceRegistry.findByLocator(route.workspace);
                if (localConnection) {
                    await this.workspaceController.switchWorkspace(localConnection.id, route);
                    return;
                }
                this.routeController.write(this.buildCurrentRoute(), "replace");
                this.shell.toast(this.locale.t("workspace.localUnavailable"), 5000);
                return;
            }
            if (route.workspace && route.workspace.provider !== "local") {
                this.providerInput.value = route.workspace.provider;
                this.repositoryInput.value = route.workspace.repositoryUrl;
                this.refInput.value = route.workspace.ref;
                this.workspaceController.updateProviderForm(this.providerInput, this.repositoryInput);
                const registered = this.workspaceRegistry.findByLocator(route.workspace);
                if (registered) {
                    const credential = this.configService.loadWorkspaceCredential(registered.id);
                    this.rememberInput.checked = this.configService.isWorkspaceCredentialRemembered(registered.id);
                    if (credential && this.workspace && !this.appSection.hidden) {
                        await this.workspaceController.switchWorkspace(registered.id, route);
                        return;
                    }
                } else {
                    this.rememberInput.checked = false;
                }
            }
            this.shell.showLoginScreen();
            this.shell.setError(this.loginErrorEl, this.locale.t("workspace.authenticateLink"));
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
                this.shell.setError(this.loginErrorEl, safeText(error));
            }
        } else {
            this.shell.showLoginScreen();
        }
    }

    /**
     * Discovers every repository exposed by server.py and builds a local workspace registry from their public ids.
     * The server remains the sole authority over filesystem paths; browser routes and persisted records contain only workspace_id, display name, and bootstrap path.
     * @returns {Promise<void>}
     */
    async initializeLocalMode() {
        this.shell.showLoadingScreen(this.locale.t("loading.discoverLocal"));
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
            this.workspaceController.activateWorkspaceConnection(selected, "");
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
            this.shell.setAuthStatus(this.locale.t("status.localMode"));
            await this.reloadData();
        } catch (error) {
            this.shell.showLoadingError(safeText(error));
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
        this.workspaceController.updateProviderForm(this.providerInput, this.repositoryInput);
        this.rememberInput.checked = this.activeWorkspaceConnection
            ? this.configService.isWorkspaceCredentialRemembered(this.activeWorkspaceConnection.id)
            : this.configService.isTokenRemembered();
        if (this.pendingRoute) this.state.setActiveTab(this.tabForRoute(this.pendingRoute));

        this.loginForm.addEventListener("submit", (ev) => this.handleLoginSubmit(ev));
        this.providerInput.addEventListener("change", () => {
            this.workspaceController.updateProviderForm(this.providerInput, this.repositoryInput);
            this.workspaceController.refreshOAuthControls();
        });
        this.repositoryInput.addEventListener("change", () => this.workspaceController.inferProviderForForm(this.providerInput, this.repositoryInput));
        this.workspaceProviderInput.addEventListener("change", () => {
            this.workspaceController.updateProviderForm(this.workspaceProviderInput, this.workspaceRepositoryInput);
            this.workspaceController.refreshOAuthControls();
        });
        this.workspaceRepositoryInput.addEventListener("change", () =>
            this.workspaceController.inferProviderForForm(this.workspaceProviderInput, this.workspaceRepositoryInput),
        );
        this.loginOAuthBtn.addEventListener("click", () => void this.workspaceController.beginOAuthConnection("landing"));
        this.workspaceOAuthBtn.addEventListener("click", () => void this.workspaceController.beginOAuthConnection("settings"));
        this.createWorkspaceBtn.addEventListener("click", () => this.workspaceController.openWorkspaceCreateDialog());
        this.openSharedWorkspaceBtn.addEventListener("click", () => this.workspaceController.openWorkspaceSettings("none"));
        this.workspaceCreateBtn.addEventListener("click", () => this.workspaceController.openWorkspaceCreateDialog());
        this.workspaceCreateProviderInput.addEventListener("change", () => this.workspaceController.refreshOAuthControls());
        this.workspaceCreateCloseBtn.addEventListener("click", () => this.workspaceController.closeWorkspaceCreateDialog());
        this.workspaceCreateCancelBtn.addEventListener("click", () => this.workspaceController.closeWorkspaceCreateDialog());
        this.workspaceCreateDialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            this.workspaceController.closeWorkspaceCreateDialog();
        });
        this.workspaceCreateOAuthBtn.addEventListener("click", () => void this.workspaceController.beginOAuthWorkspaceCreation());
        this.workspaceCreateForm.addEventListener("submit", (event) => void this.workspaceController.handleWorkspaceCreateSubmit(event));
        this.clearSavedBtn.addEventListener("click", () => this.handleClearSaved());
        this.landingLanguageSelect.addEventListener("change", () =>
            this.applyLocale(this.landingLanguageSelect.value),
        );
        this.workspaceSettingsBtn.addEventListener("click", () => {
            if (this.workspaceDialog.open) this.workspaceController.closeWorkspaceSettings();
            else this.workspaceController.openWorkspaceSettings();
        });
        this.appHomeLink.addEventListener("click", (event) => {
            event.preventDefault();
            this.pendingRoute = null;
            this.workspaceController.closeWorkspaceSettings("none");
            this.shell.closeInterfaceSettings("none");
            this.routeController.write(
                { version: 1, component: null, panel: "main", workspace: null, state: {} },
                "push",
            );
            this.shell.showLoginScreen();
        });
        this.workspaceDialogCloseBtn.addEventListener("click", () => this.workspaceController.closeWorkspaceSettings());
        this.workspaceDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.workspaceController.closeWorkspaceSettings();
        });
        this.interfaceSettingsBtn.addEventListener("click", () => {
            if (this.interfaceDialog.open) this.shell.closeInterfaceSettings();
            else this.shell.openInterfaceSettings();
        });
        this.interfaceDialogCloseBtn.addEventListener("click", () => this.shell.closeInterfaceSettings());
        this.interfaceLanguageSelect.addEventListener("change", () =>
            this.applyLocale(this.interfaceLanguageSelect.value),
        );
        this.interfaceDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.shell.closeInterfaceSettings();
        });
        this.workspaceAddForm.addEventListener("submit", (ev) => void this.workspaceController.handleWorkspaceAdd(ev));
        this.workspaceCapabilityForm.addEventListener("submit", (event) =>
            void this.workspaceController.handleCapabilityLinkImport(event),
        );
        this.workspaceScanCapabilityBtn.addEventListener("click", () =>
            void this.workspaceController.startCapabilityScanner(),
        );
        this.workspaceQrCloseBtn.addEventListener("click", () => this.workspaceController.closeCapabilityScanner());
        this.workspaceQrFileInput.addEventListener("change", () =>
            void this.workspaceController.scanCapabilityImage(this.workspaceQrFileInput.files?.[0] || null),
        );
        this.workspaceConfigForm.addEventListener("submit", (event) =>
            void this.workspaceController.handleWorkspaceConfigurationSubmit(event),
        );
        for (const toggle of [
            this.workspaceConfigTimeEnabledInput,
            this.workspaceConfigTodosEnabledInput,
            this.workspaceConfigExpensesEnabledInput,
        ]) {
            toggle.addEventListener("change", () => this.workspaceController.refreshWorkspaceComponentFields());
        }
        this.workspaceListEl.addEventListener("click", (ev) => void this.workspaceController.handleWorkspaceListClick(ev));
        this.workspaceShareBtn.addEventListener("click", () => this.workspaceController.openWorkspaceShareDialog());
        this.workspaceShareCloseBtn.addEventListener("click", () => this.workspaceController.closeWorkspaceShareDialog());
        this.workspaceShareDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.workspaceController.closeWorkspaceShareDialog();
        });
        this.workspaceCopyLocatorBtn.addEventListener("click", () => void this.workspaceController.copyActiveWorkspaceLink());
        this.workspaceCopyCapabilityBtn.addEventListener("click", () => void this.workspaceController.copyActiveCapabilityLink());
        this.menuWeekBtn.addEventListener("click", () => void this.navigateToTab("week"));
        this.menuTodoBtn.addEventListener("click", () => void this.navigateToTab("todos"));
        this.menuExpenseBtn.addEventListener("click", () => void this.navigateToTab("expenses"));
        this.menuSearchBtn.addEventListener("click", () => {
            void this.navigateToTab("search");
        });
        this.appZoomOutBtn.addEventListener("click", () => this.shell.nudgeAppZoom(-1));
        this.appZoomResetBtn.addEventListener("click", () => this.shell.setAutomaticAppZoom());
        this.appZoomInBtn.addEventListener("click", () => this.shell.nudgeAppZoom(1));
        this.appThemeToggleBtn.addEventListener("click", () => this.shell.toggleTheme());
        this.landingThemeToggleBtn.addEventListener("click", () => this.shell.toggleTheme());
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
            if (this.searchInput.value.trim()) this.shell.setTab("search");
        });
        this.loadingRetryBtn.addEventListener("click", () => void this.reloadData());
        this.loadingLogoutBtn.addEventListener("click", () => this.logout());
        this.editorBadgeEl.addEventListener("click", () => this.saveActiveView());

        document.addEventListener("keydown", (ev) => this.handleGlobalKeydown(ev));
        window.addEventListener("resize", () => this.shell.handleResize());
        this.routeController.start((route) => void this.handleRouteNavigation(route));

        this.shell.setProgress(0, 1, "");
        this.workspaceController.refreshOAuthControls();
        setVisible(this.sidebarEl, false);
        setVisible(this.topbarEl, false);
        setVisible(this.loadingSection, false);

        if (this.oauthCallbackRequested) {
            this.shell.showLoadingScreen(this.locale.t("loading.completeAuthorization"));
            try {
                const result = await this.oauthCallbackPromise;
                if (!result) throw new Error("The provider authorization callback is incomplete.");
                await this.workspaceController.handleOAuthCallbackResult(result);
            } catch (error) {
                this.shell.showLoginScreen();
                this.shell.setError(this.loginErrorEl, safeText(error));
            }
            return;
        }

        if (this.capabilityImportStartupError) {
            this.shell.showLoginScreen();
            this.shell.setError(this.loginErrorEl, this.capabilityImportStartupError);
            return;
        }
        if (this.capabilityImport) {
            try {
                await this.workspaceController.importCapability();
            } catch (error) {
                this.shell.showLoginScreen();
                this.shell.setError(this.loginErrorEl, safeText(error));
            }
            return;
        }

        if (this.isLocalMode) {
            this.shell.setAuthStatus(this.locale.t("status.localMode"));
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
            this.shell.setAuthStatus(
                this.locale.t(this.token ? "status.savedConnection" : "status.notLoggedIn"),
            );
            this.shell.showLoginScreen();
        } else if (this.token) {
            this.shell.showLoadingScreen(
                this.locale.t("loading.connectProvider", { provider: this.workspaceController.providerDisplayName(initialProvider) }),
            );
            this.connectWithToken(this.token).catch((err) => {
                this.shell.showLoginScreen();
                this.shell.setError(this.loginErrorEl, safeText(err));
            });
        } else {
            this.shell.setAuthStatus(this.locale.t("status.notLoggedIn"));
            this.shell.showLoginScreen();
        }
    }

    /**
     * Reports whether the public landing page can offer an authenticated route back into a registered workspace.
     * A loaded local workspace or a hosted registry row with an available credential is sufficient; a full data reload is deferred until the user chooses an app.
     * @returns {boolean}
     */
    hasResumableWorkspace() {
        if (this.workspace) return true;
        if (this.isLocalMode) return Boolean(this.activeWorkspaceConnection);
        if (!this.activeWorkspaceConnection) return false;
        return Boolean(this.token || this.configService.loadWorkspaceCredential(this.activeWorkspaceConnection.id));
    }

    /**
     * Synchronizes sidebar visibility and component actions with loaded, resumable, and setup-only states.
     * Before configuration is known, supported app buttons act as resume targets; during explicit setup they are all hidden until a valid zeitberg.json has been persisted.
     * @returns {void}
     */
    refreshSidebarNavigation() {
        const resumable = this.hasResumableWorkspace();
        const hasWorkspace = Boolean(this.workspace);
        const showUnresolvedApps = resumable && !hasWorkspace && !this.workspaceSetup;
        setVisible(this.menuWeekBtn, hasWorkspace ? this.workspace.hasComponent("time_tracking") : showUnresolvedApps);
        setVisible(this.menuSearchBtn, hasWorkspace ? this.workspace.hasComponent("time_tracking") : showUnresolvedApps);
        setVisible(this.menuTodoBtn, hasWorkspace ? this.workspace.hasComponent("todos") : showUnresolvedApps);
        setVisible(this.menuExpenseBtn, hasWorkspace ? this.workspace.hasComponent("expenses") : showUnresolvedApps);
        setVisible(this.projectsBtn, Boolean(this.workspace?.resources.projects));
        setVisible(this.reloadDataBtn, resumable && !this.workspaceSetup);
        setVisible(this.logoutBtn, !this.isLocalMode && resumable);
    }

    /**
     * Opens a component from either an initialized application or the authenticated landing page.
     * Landing-page resumes reconstruct the requested route and run the ordinary connection pipeline, while already loaded workspaces switch immediately without another download.
     * @param {"week" | "todos" | "expenses" | "search"} tab Requested application tab.
     * @returns {Promise<void>}
     */
    async navigateToTab(tab) {
        if (this.workspaceSetup) return;
        this.state.setActiveTab(tab);
        if (this.workspace) {
            if (this.appSection.hidden) {
                this.shell.showApplicationScreen();
                this.writeCurrentRoute("push");
            } else {
                this.shell.setTab(tab);
            }
            if (tab === "search") queueMicrotask(() => this.searchInput.focus());
            return;
        }

        const connection = this.activeWorkspaceConnection || this.workspaceRegistry.getActive();
        if (!connection) {
            this.shell.showLoginScreen();
            return;
        }
        try {
            const credential = connection.provider === "local" ? "" : await this.workspaceController.loadUsableWorkspaceCredential(connection);
            if (connection.provider !== "local" && !credential) {
                this.shell.showLoginScreen();
                this.shell.setError(this.loginErrorEl, this.locale.t("workspace.enterTokenFor", { workspace: connection.displayName }));
                return;
            }
            this.workspaceController.activateWorkspaceConnection(connection, credential);
            this.pendingRoute = this.workspaceController.routeForWorkspaceConnection(connection);
            if (connection.provider === "local") {
                await this.reloadData();
            } else {
                await this.connectWithToken(credential);
            }
        } catch (error) {
            this.shell.showLoginScreen();
            this.shell.setError(this.loginErrorEl, safeText(error));
        }
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
                if (this.state.activeTab !== "todos" && this.state.activeTab !== "expenses") this.shell.setTab("search");
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
                this.shell.setTab("todos");
                return;
            }

            if (keyLower === "e") {
                ev.preventDefault();
                this.shell.setTab("expenses");
                return;
            }

            if (keyLower === "g" || keyLower === "w") {
                ev.preventDefault();
                this.shell.setTab("week");
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
     * Validates login input and starts the selected hosted-provider connection flow.
     * Keeps the main UI flow and data loading coordinated.
     * @param {Event} ev
     * @returns {Promise<void>}
     */
    async handleLoginSubmit(ev) {
        ev.preventDefault();
        this.shell.setError(this.loginErrorEl, "");

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
            this.shell.setError(this.loginErrorEl, this.locale.t("workspace.completeConnection"));
            return;
        }

        const expectedWorkspaceId = String(this.pendingRoute?.workspace?.expectedWorkspaceId || "");
        const workspacePath = String(this.pendingRoute?.workspace?.workspacePath || this.config.workspacePath || "zeitberg.json");
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
            this.shell.setError(this.loginErrorEl, safeText(error));
            return;
        }
        const connection = this.workspaceRegistry.upsert(locator, { expectedWorkspaceId });
        this.workspaceRegistry.setActive(connection.id);
        this.configService.saveWorkspaceRegistry(this.workspaceRegistry);
        this.configService.saveWorkspaceCredential(connection.id, tok, remember);
        this.workspaceController.activateWorkspaceConnection(connection, tok);
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
            this.shell.setError(this.loginErrorEl, safeText(err));
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
        this.remoteCache.clearAll();
        this.token = "";
        this.state.setToken("");
        this.config = { ...DEFAULT_CONFIG };
        this.workspaceRegistry = this.configService.loadWorkspaceRegistry(this.config);
        this.activeWorkspaceConnection = null;
        this.workspace = null;
        this.workspaceSetup = null;
        this.workspaceConfigBaseRaw = null;
        this.state.setConfig(this.config);
        this.shell.setTheme(this.config.theme, false);
        this.shell.setAutomaticAppZoom(false);
        this.weekView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.todoView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.expenseView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.providerInput.value = this.config.provider || "github";
        this.repositoryInput.value =
            this.config.repositoryUrl || formatGitHubRepositoryUrl(this.config.owner, this.config.repo);
        this.refInput.value = this.config.ref;
        this.workspaceController.updateProviderForm(this.providerInput, this.repositoryInput);
        this.tokenInput.value = "";
        this.rememberInput.checked = false;
        this.shell.setAuthStatus(this.locale.t("status.cleared"));
        this.pendingRoute = null;
        this.shell.showLoginScreen();
        this.routeController.write({ version: 1, component: null, panel: "main", workspace: null, state: {} }, "replace");
    }

    /**
     * Applies a newly saved project list to the UI.
     * Keeps the main UI flow and data loading coordinated.
     * @param {import("./model.js").ProjectList} projectList
     * @returns {void}
     */
    handleProjectsSaved(projectList) {
        this.weekView.setProjects(projectList);
        this.todoView.setProjects();
        this.expenseView.setProjects();
        this.shell.markSearchDirty();
    }

    /**
     * Reloads manifest, shared projects, TODOs, requirements, and all time-entry chunks.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {Promise<boolean>}
     */
    async reloadData() {
        this.shell.showLoadingScreen(
            this.locale.t(this.isLocalMode ? "loading.prepareLocal" : "loading.prepareRepository"),
        );
        this.shell.setBusy(true);
        this.shell.setError(this.dataErrorEl, "");
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
            try {
                await this.workspaceLoader.fetchWorkspace();
            } catch (error) {
                if (error instanceof WorkspaceSetupRequiredError) {
                    this.workspaceController.enterWorkspaceSetup(error);
                    return true;
                }
                throw error;
            }
            await this.workspaceLoader.fetchProjects();
            const componentLoads = [];
            if (this.workspace?.hasComponent("time_tracking")) {
                componentLoads.push(
                    this.workspaceLoader.fetchManifest(),
                    this.workspaceLoader.fetchWeekRequirements(),
                );
            }
            if (this.workspace?.hasComponent("todos")) componentLoads.push(this.workspaceLoader.fetchTodos());
            if (this.workspace?.hasComponent("expenses")) componentLoads.push(this.workspaceLoader.fetchExpenses());
            await Promise.all(componentLoads);
            if (this.workspace?.hasComponent("time_tracking")) {
                await this.workspaceLoader.loadAllChunks();
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
            this.shell.showApplicationScreen();
            if (requestedRoute) {
                this.pendingRoute = null;
                this.applyLoadedRoute(requestedRoute);
            } else {
                this.routeController.write(this.buildCurrentRoute(), "replace");
            }
            return true;
        } catch (err) {
            this.shell.showLoadingError(safeText(err));
            return false;
        } finally {
            this.shell.setBusy(false);
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
            ? (await this.workspaceController.loadUsableWorkspaceCredential(this.activeWorkspaceConnection)) || token
            : token;
        this.token = usableToken;
        this.state.setToken(usableToken);
        this.dataSource = createHostedDataSource(this.config, usableToken);
        this.workspace = null;
        this.workspaceSetup = null;
        this.workspaceConfigBaseRaw = null;
        this.weekView.setDataSource(this.dataSource);
        this.weekView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.todoView.setDataSource(this.dataSource);
        this.todoView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.expenseView.setDataSource(this.dataSource);
        this.expenseView.setDraftNamespace(this.workspaceController.buildDraftNamespace());
        this.projectDialog.setDataSource(this.dataSource);
        this.shell.setAuthStatus(this.locale.t("status.connecting"));
        const provider = this.activeWorkspaceConnection?.provider || this.config.provider || "custom";
        this.shell.showLoadingScreen(
            this.locale.t("loading.connectProvider", { provider: this.workspaceController.providerDisplayName(provider) }),
        );
        this.shell.setBusy(true);
        try {
            const { repoInfo, userInfo } = connectionInfo || (await this.dataSource.checkConnection());
            const repoLabel = repoInfo?.full_name
                ? repoInfo.full_name
                : this.activeWorkspaceConnection?.repositoryUrl ||
                  this.config.repositoryUrl ||
                  this.locale.t("landing.workspaceRepository");
            this.state.ghUser = userInfo;
            this.shell.setAuthStatus(
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
            this.shell.setAuthStatus(this.locale.t("status.notLoggedIn"));
            this.shell.showLoginScreen();
            throw err;
        } finally {
            this.shell.setBusy(false);
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
        this.workspaceSetup = null;
        this.workspaceConfigBaseRaw = null;
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
        this.shell.setProgress(0, 1, "");
        this.shell.setAuthStatus(this.locale.t("status.notLoggedIn"));
        this.shell.repositorySummary = "";
        this.shell.todoSummary = "";
        this.shell.expenseSummary = "";
        this.shell.refreshDataBadge();
        this.projectDialog.close();
        this.workspaceController.closeWorkspaceSettings("none");
        this.shell.closeInterfaceSettings("none");
        setVisible(this.weekControlsEl, false);
        setVisible(this.todoTopbarControlsEl, false);
        setVisible(this.expenseTopbarControlsEl, false);
        setVisible(this.reloadDataBtn, false);
        setVisible(this.logoutBtn, false);
        setVisible(this.projectsBtn, false);
        this.shell.showLoginScreen();
        const activeConnection = this.activeWorkspaceConnection || this.workspaceRegistry.getActive();
        if (activeConnection) {
            this.activeWorkspaceConnection = activeConnection;
            this.config = configForRouteWorkspace(this.config, activeConnection.toLocator());
            this.state.setConfig(this.config);
            this.providerInput.value = activeConnection.provider;
            this.repositoryInput.value = activeConnection.repositoryUrl;
            this.refInput.value = activeConnection.ref;
            this.workspaceController.updateProviderForm(this.providerInput, this.repositoryInput);
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
