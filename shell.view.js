import {
    formatGitHubRepositoryUrl,
    getEffectiveUiViewportWidth,
    getRecommendedUiZoom,
} from "./config.js";
import { setVisible } from "./utils.js";

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
 * @typedef {Object} ShellRuntime
 * @description Mutable application values reflected by global chrome without transferring business-data ownership to the shell.
 * @property {string | null} activeGlobalPanel
 * @property {import("./config.js").WorkspaceConnection | null} activeWorkspaceConnection
 * @property {import("./config.js").AppConfig} config
 * @property {boolean} routeRestoreInProgress
 * @property {import("./model.js").Workspace | null} workspace
 */

/**
 * @typedef {Object} ShellElements
 * @description DOM controlled by global navigation, loading, appearance, status, and busy-state behavior.
 * @property {HTMLButtonElement} addProjectBtn
 * @property {HTMLElement} appSection
 * @property {HTMLButtonElement} appThemeToggleBtn
 * @property {HTMLButtonElement} appZoomInBtn
 * @property {HTMLElement} appZoomLabelEl
 * @property {HTMLButtonElement} appZoomOutBtn
 * @property {HTMLButtonElement} appZoomResetBtn
 * @property {HTMLElement} authStatusEl
 * @property {HTMLInputElement} capabilityHostConfirmInput
 * @property {HTMLButtonElement} capabilityImportCancelBtn
 * @property {HTMLButtonElement} capabilityImportOpenBtn
 * @property {HTMLInputElement} capabilityRememberInput
 * @property {HTMLButtonElement} createWorkspaceBtn
 * @property {HTMLElement} dataErrorEl
 * @property {HTMLButtonElement} editorBadgeEl
 * @property {HTMLElement} expenseTopbarControlsEl
 * @property {HTMLInputElement} fromDateInput
 * @property {HTMLElement} globalSearchEl
 * @property {HTMLDialogElement} interfaceDialog
 * @property {HTMLButtonElement} interfaceSettingsBtn
 * @property {HTMLButtonElement} landingThemeToggleBtn
 * @property {HTMLButtonElement} latestWeekBtn
 * @property {HTMLProgressElement} loadProgressEl
 * @property {HTMLElement} loadProgressLabelEl
 * @property {HTMLElement} loadingActionsEl
 * @property {HTMLElement} loadingErrorEl
 * @property {HTMLButtonElement} loadingLogoutBtn
 * @property {HTMLButtonElement} loadingRetryBtn
 * @property {HTMLElement} loadingSection
 * @property {HTMLButtonElement} loginOAuthBtn
 * @property {HTMLElement} loginSection
 * @property {HTMLButtonElement} logoutBtn
 * @property {HTMLInputElement} maxRowsInput
 * @property {HTMLButtonElement} menuExpenseBtn
 * @property {HTMLButtonElement} menuSearchBtn
 * @property {HTMLButtonElement} menuTodoBtn
 * @property {HTMLButtonElement} menuWeekBtn
 * @property {HTMLButtonElement} nextWeekBtn
 * @property {HTMLButtonElement} prevWeekBtn
 * @property {HTMLButtonElement} projectBindingCancelBtn
 * @property {HTMLButtonElement} projectBindingCloseBtn
 * @property {HTMLDialogElement} projectBindingDialog
 * @property {HTMLSelectElement} projectSelect
 * @property {HTMLButtonElement} projectsBtn
 * @property {HTMLButtonElement} projectsCancelBtn
 * @property {HTMLButtonElement} projectsCloseBtn
 * @property {HTMLElement} projectsList
 * @property {HTMLButtonElement} projectsOkBtn
 * @property {HTMLSelectElement} providerInput
 * @property {HTMLInputElement} refInput
 * @property {HTMLButtonElement} reloadDataBtn
 * @property {HTMLInputElement} rememberInput
 * @property {HTMLElement} repoLabelEl
 * @property {HTMLInputElement} repositoryInput
 * @property {HTMLDetailsElement} searchFiltersPanelEl
 * @property {HTMLElement} searchFromLabelEl
 * @property {HTMLInputElement} searchInput
 * @property {HTMLElement} searchToLabelEl
 * @property {HTMLElement} sidebarEl
 * @property {HTMLSelectElement} sortSelect
 * @property {HTMLInputElement} toDateInput
 * @property {HTMLElement} todoTopbarControlsEl
 * @property {HTMLInputElement} tokenInput
 * @property {HTMLElement} topbarEl
 * @property {HTMLElement} weekControlsEl
 * @property {HTMLButtonElement} weekReqBtn
 * @property {HTMLButtonElement} weekReqCancelBtn
 * @property {HTMLButtonElement} weekReqCloseBtn
 * @property {HTMLTextAreaElement} weekReqComment
 * @property {HTMLInputElement} weekReqHours
 * @property {HTMLButtonElement} weekReqOkBtn
 * @property {HTMLInputElement} workspaceConfigExpensesEnabledInput
 * @property {HTMLInputElement} workspaceConfigIdInput
 * @property {HTMLInputElement} workspaceConfigNameInput
 * @property {HTMLInputElement} workspaceConfigProjectsPathInput
 * @property {HTMLButtonElement} workspaceConfigSaveBtn
 * @property {HTMLInputElement} workspaceConfigTimeEnabledInput
 * @property {HTMLInputElement} workspaceConfigTimezoneInput
 * @property {HTMLInputElement} workspaceConfigTodosEnabledInput
 * @property {HTMLButtonElement} workspaceCopyCapabilityBtn
 * @property {HTMLButtonElement} workspaceCopyLocatorBtn
 * @property {HTMLButtonElement} workspaceCreateBtn
 * @property {HTMLButtonElement} workspaceCreateCancelBtn
 * @property {HTMLButtonElement} workspaceCreateCloseBtn
 * @property {HTMLInputElement} workspaceCreateNameInput
 * @property {HTMLButtonElement} workspaceCreateOAuthBtn
 * @property {HTMLSelectElement} workspaceCreateProviderInput
 * @property {HTMLInputElement} workspaceCreateRememberInput
 * @property {HTMLInputElement} workspaceCreateRepositoryInput
 * @property {HTMLInputElement} workspaceCreateTimezoneInput
 * @property {HTMLInputElement} workspaceCreateTokenInput
 * @property {HTMLButtonElement} workspaceDialogCloseBtn
 * @property {HTMLButtonElement} workspaceOAuthBtn
 * @property {HTMLInputElement} workspacePathInput
 * @property {HTMLSelectElement} workspaceProviderInput
 * @property {HTMLInputElement} workspaceRefInput
 * @property {HTMLInputElement} workspaceRememberInput
 * @property {HTMLInputElement} workspaceRepositoryInput
 * @property {HTMLButtonElement} workspaceSettingsBtn
 * @property {HTMLButtonElement} workspaceShareBtn
 * @property {HTMLButtonElement} workspaceShareCloseBtn
 * @property {HTMLInputElement} workspaceShareTokenInput
 * @property {HTMLInputElement} workspaceTokenInput
 * @property {HTMLInputElement} zoomInput
 */

/**
 * @typedef {Object} ShellViewOptions
 * @description Services, component views, owned DOM, and navigation callbacks used by the application shell.
 * @property {ShellRuntime} runtime
 * @property {boolean} isLocalMode
 * @property {import("./config.js").ConfigService} configService
 * @property {import("./locale.js").LocaleService} locale
 * @property {import("./appstate.js").AppState} state
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {import("./store.js").EntryStore} store
 * @property {import("./store.js").TodoStore} todoStore
 * @property {import("./store.js").ExpenseStore} expenseStore
 * @property {import("./week.view.js").WeekView} weekView
 * @property {import("./search.view.js").SearchView} searchView
 * @property {import("./todo.view.js").TodoView} todoView
 * @property {import("./expense.view.js").ExpenseView} expenseView
 * @property {import("./workspace.js").WorkspaceController} workspaceController
 * @property {ShellElements} elements
 * @property {() => boolean} hasResumableWorkspace
 * @property {() => void} onNavigationChanged
 * @property {(mode?: "push" | "replace") => void} onWriteRoute
 */

/**
 * Owns the application chrome shared by every sub-app.
 * Appearance, responsive layout, global panels, loading surfaces, busy state, tab presentation, search labels, and status overlays stay here while App retains route and workflow orchestration.
 */
export class ShellView {
    /**
     * Initializes shell-local presentation state and captures explicit collaborators.
     * Call initializeAppearance() after construction to apply persisted theme and zoom once every view is available.
     * @param {ShellViewOptions} options Shell dependencies supplied by the application composition root.
     */
    constructor(options) {
        this.runtime = options.runtime;
        this.isLocalMode = options.isLocalMode;
        this.configService = options.configService;
        this.locale = options.locale;
        this.state = options.state;
        this.timeContext = options.timeContext;
        this.store = options.store;
        this.todoStore = options.todoStore;
        this.expenseStore = options.expenseStore;
        this.weekView = options.weekView;
        this.searchView = options.searchView;
        this.todoView = options.todoView;
        this.expenseView = options.expenseView;
        this.workspaceController = options.workspaceController;
        this.elements = options.elements;
        this.hasResumableWorkspace = options.hasResumableWorkspace;
        this.refreshSidebarNavigation = options.onNavigationChanged;
        this.writeCurrentRoute = options.onWriteRoute;
        this.toastTimer = 0;
        this.resizeRaf = 0;
        this.searchFiltersNarrow = false;
        this.interfaceDialogOpenedByPush = false;
        /** @type {"auto" | "manual"} */
        this.uiZoomMode = this.runtime.config.uiZoomMode === "manual" ? "manual" : "auto";
        const initialZoom = this.uiZoomMode === "auto" ? this.getRecommendedAppZoom() : this.runtime.config.uiZoom;
        this.uiZoom = this.normalizeAppZoom(initialZoom);
        /** @type {"dark" | "light"} */
        this.theme = this.runtime.config.theme === "light" ? "light" : "dark";
        this.repositorySummary = "";
        this.todoSummary = "";
        this.expenseSummary = "";
    }

    /**
     * Applies persisted appearance after all view collaborators have been composed.
     * @returns {void}
     */
    initializeAppearance() {
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
        this.runtime.config = { ...this.runtime.config, theme: this.theme };
        this.state.setConfig(this.runtime.config);
        document.documentElement.dataset.theme = this.theme;

        const useLight = this.theme === "dark";
        const actionLabel = this.locale.t(useLight ? "nav.useLightTheme" : "nav.useDarkTheme");
        for (const button of [this.elements.appThemeToggleBtn, this.elements.landingThemeToggleBtn]) {
            button.title = actionLabel;
            button.setAttribute("aria-label", actionLabel);
            button.setAttribute("aria-pressed", this.theme === "light" ? "true" : "false");
        }
        const landingLabel = this.elements.landingThemeToggleBtn.querySelector("span");
        if (landingLabel) landingLabel.textContent = this.locale.t(useLight ? "nav.light" : "nav.dark");

        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta instanceof HTMLMetaElement) {
            themeMeta.content = this.theme === "dark" ? "#17191f" : "#f7f7f4";
        }
        if (shouldPersist) this.configService.saveConfig(this.runtime.config);
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
            this.elements.searchFiltersPanelEl.open = !searchFiltersNarrow;
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
        this.elements.appZoomLabelEl.textContent = `${zoomPercent}%`;
        this.elements.appZoomResetBtn.title =
            this.uiZoomMode === "auto"
                ? this.locale.t("nav.zoomAutomatic", { percent: zoomPercent })
                : this.locale.t("nav.zoomRestoreAutomatic", { percent: zoomPercent });
        this.elements.appZoomOutBtn.disabled = this.uiZoom <= MIN_APP_ZOOM;
        this.elements.appZoomInBtn.disabled = this.uiZoom >= MAX_APP_ZOOM;
        this.runtime.config = { ...this.runtime.config, uiZoom: this.uiZoom, uiZoomMode: this.uiZoomMode };
        this.state.setConfig(this.runtime.config);
        this.updateResponsiveLayout();
        if (shouldPersist) this.configService.saveConfig(this.runtime.config);
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
     * Opens device-local Interface settings over the active component and records the modal in browser history.
     * Language changes take effect immediately and never modify workspace data.
     * @param {"push" | "none"} [historyMode] Whether opening should create a browser-history entry.
     * @returns {void}
     */
    openInterfaceSettings(historyMode = "push") {
        if (this.elements.appSection.hidden || !this.runtime.workspace) return;
        this.runtime.activeGlobalPanel = "settings";
        this.interfaceDialogOpenedByPush = historyMode === "push";
        this.elements.interfaceSettingsBtn.setAttribute("aria-current", "page");
        if (!this.elements.interfaceDialog.open) this.elements.interfaceDialog.showModal();
        if (historyMode === "push") this.writeCurrentRoute("push");
    }

    /**
     * Closes Interface settings and restores the component route beneath it.
     * A close after an in-app open uses browser Back; direct settings URLs are normalized in place.
     * @param {"back" | "replace" | "none"} [historyMode] Route behavior used while closing.
     * @returns {void}
     */
    closeInterfaceSettings(historyMode = "back") {
        const wasOpen = this.elements.interfaceDialog.open;
        if (wasOpen) this.elements.interfaceDialog.close();
        if (this.runtime.activeGlobalPanel === "settings") this.runtime.activeGlobalPanel = null;
        this.elements.interfaceSettingsBtn.removeAttribute("aria-current");
        if (!wasOpen || historyMode === "none" || this.runtime.routeRestoreInProgress) {
            if (historyMode === "none") this.interfaceDialogOpenedByPush = false;
            return;
        }
        if (historyMode === "back" && this.interfaceDialogOpenedByPush) {
            this.interfaceDialogOpenedByPush = false;
            window.history.back();
            return;
        }
        this.interfaceDialogOpenedByPush = false;
        this.writeCurrentRoute("replace");
    }

    /**
     * Shows the login form and hides both initialized and loading application surfaces.
     * This is the stable unauthenticated state used at startup, after connection failures, and after logout.
     * @returns {void}
     */
    showLoginScreen() {
        const showSidebar = this.hasResumableWorkspace();
        document.body.classList.toggle("app-ready", showSidebar);
        setVisible(this.elements.sidebarEl, showSidebar);
        setVisible(this.elements.topbarEl, false);
        setVisible(this.elements.loadingSection, false);
        setVisible(this.elements.appSection, false);
        setVisible(this.elements.loginSection, true);
        this.setAppMode(false);
        this.refreshSidebarNavigation();
    }

    /**
     * Shows the dedicated initialization surface while repository data is being loaded.
     * Progress and recoverable errors remain isolated here so the compact top bar only represents a ready application.
     * @param {string} label
     * @returns {void}
     */
    showLoadingScreen(label) {
        document.body.classList.remove("app-ready");
        setVisible(this.elements.sidebarEl, false);
        setVisible(this.elements.topbarEl, false);
        setVisible(this.elements.loginSection, false);
        setVisible(this.elements.appSection, false);
        setVisible(this.elements.loadingSection, true);
        setVisible(this.elements.loadingActionsEl, false);
        this.setError(this.elements.loadingErrorEl, "");
        this.elements.loadingSection.setAttribute("aria-busy", "true");
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
        setVisible(this.elements.loginSection, false);
        setVisible(this.elements.loadingSection, false);
        setVisible(this.elements.sidebarEl, true);
        setVisible(this.elements.topbarEl, true);
        setVisible(this.elements.appSection, true);
        this.elements.loadingSection.setAttribute("aria-busy", "false");
        this.setAppMode(true);
        this.refreshSidebarNavigation();
        this.setTab(this.state.activeTab, "none");
    }

    /**
     * Keeps the loading screen visible and presents retry controls after initialization fails.
     * GitHub mode also offers a route back to login, while local mode can only retry the local server request.
     * @param {unknown} message Error or already localized message.
     * @returns {void}
     */
    showLoadingError(message) {
        this.elements.loadingSection.setAttribute("aria-busy", "false");
        this.setError(this.elements.loadingErrorEl, message);
        setVisible(this.elements.loadingActionsEl, true);
        setVisible(this.elements.loadingLogoutBtn, !this.isLocalMode);
        queueMicrotask(() => this.elements.loadingRetryBtn.focus());
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
     * Updates the authentication status display.
     * Keeps the main UI flow and data loading coordinated.
     * @param {string} text
     * @returns {void}
     */
    setAuthStatus(text) {
        this.elements.authStatusEl.textContent = text;
        this.elements.authStatusEl.title = text;
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
            this.elements.dataErrorEl.classList.remove("is-success");
            this.setError(this.elements.dataErrorEl, "");
            return;
        }
        this.elements.dataErrorEl.classList.toggle("is-success", tone === "success");
        this.setError(this.elements.dataErrorEl, message);
        this.toastTimer = window.setTimeout(() => {
            this.elements.dataErrorEl.classList.remove("is-success");
            this.setError(this.elements.dataErrorEl, "");
        }, Math.max(400, timeoutMs));
    }

    /**
     * Enables or disables UI controls during network work.
     * Keeps the main UI flow and data loading coordinated.
     * @param {boolean} isBusy
     * @returns {void}
     */
    setBusy(isBusy) {
        this.elements.logoutBtn.disabled = isBusy;
        this.elements.reloadDataBtn.disabled = isBusy;
        this.elements.projectsBtn.disabled = isBusy;
        this.elements.workspaceSettingsBtn.disabled = isBusy;
        this.elements.providerInput.disabled = isBusy;
        this.elements.repositoryInput.disabled = isBusy;
        this.elements.refInput.disabled = isBusy;
        this.elements.tokenInput.disabled = isBusy;
        this.elements.rememberInput.disabled = isBusy;
        this.elements.loginOAuthBtn.disabled = isBusy || this.elements.loginOAuthBtn.disabled;
        this.elements.createWorkspaceBtn.disabled = isBusy;
        this.elements.workspaceDialogCloseBtn.disabled = isBusy;
        this.elements.workspaceConfigSaveBtn.disabled = isBusy;
        this.elements.workspaceConfigNameInput.disabled = isBusy;
        this.elements.workspaceConfigIdInput.disabled = isBusy;
        this.elements.workspaceConfigTimezoneInput.disabled = isBusy;
        this.elements.workspaceConfigProjectsPathInput.disabled = isBusy;
        this.elements.workspaceConfigTimeEnabledInput.disabled = isBusy;
        this.elements.workspaceConfigTodosEnabledInput.disabled = isBusy;
        this.elements.workspaceConfigExpensesEnabledInput.disabled = isBusy;
        this.elements.workspaceProviderInput.disabled = isBusy;
        this.elements.workspaceRepositoryInput.disabled = isBusy;
        this.elements.workspaceRefInput.disabled = isBusy;
        this.elements.workspacePathInput.disabled = isBusy;
        this.elements.workspaceTokenInput.disabled = isBusy;
        this.elements.workspaceRememberInput.disabled = isBusy;
        this.elements.workspaceOAuthBtn.disabled = isBusy || this.elements.workspaceOAuthBtn.disabled;
        this.elements.workspaceCreateBtn.disabled = isBusy;
        this.elements.workspaceCreateCloseBtn.disabled = isBusy;
        this.elements.workspaceCreateCancelBtn.disabled = isBusy;
        this.elements.workspaceCreateProviderInput.disabled = isBusy;
        this.elements.workspaceCreateRepositoryInput.disabled = isBusy;
        this.elements.workspaceCreateNameInput.disabled = isBusy;
        this.elements.workspaceCreateTimezoneInput.disabled = isBusy;
        this.elements.workspaceCreateTokenInput.disabled = isBusy;
        this.elements.workspaceCreateRememberInput.disabled = isBusy;
        this.elements.workspaceCreateOAuthBtn.disabled = isBusy || this.elements.workspaceCreateOAuthBtn.disabled;
        this.elements.workspaceShareBtn.disabled = isBusy || !this.runtime.workspace;
        this.elements.workspaceShareCloseBtn.disabled = isBusy;
        this.elements.workspaceCopyLocatorBtn.disabled = isBusy;
        this.elements.workspaceShareTokenInput.disabled = isBusy || this.isLocalMode;
        this.elements.workspaceCopyCapabilityBtn.disabled = isBusy || this.isLocalMode;
        this.elements.capabilityRememberInput.disabled = isBusy;
        this.elements.capabilityHostConfirmInput.disabled = isBusy;
        this.elements.capabilityImportCancelBtn.disabled = isBusy;
        this.elements.capabilityImportOpenBtn.disabled = isBusy;
        this.elements.menuWeekBtn.disabled = isBusy;
        this.elements.menuTodoBtn.disabled = isBusy;
        this.elements.menuExpenseBtn.disabled = isBusy;
        this.elements.menuSearchBtn.disabled = isBusy;
        this.elements.prevWeekBtn.disabled = isBusy;
        this.elements.nextWeekBtn.disabled = isBusy;
        this.elements.latestWeekBtn.disabled = isBusy;
        this.elements.zoomInput.disabled = isBusy;
        this.elements.weekReqBtn.disabled = isBusy;
        this.elements.searchInput.disabled = isBusy;
        this.elements.projectSelect.disabled = isBusy;
        this.elements.fromDateInput.disabled = isBusy;
        this.elements.toDateInput.disabled = isBusy;
        this.elements.maxRowsInput.disabled = isBusy;
        this.elements.sortSelect.disabled = isBusy;
        this.elements.projectsCloseBtn.disabled = isBusy;
        this.elements.projectsCancelBtn.disabled = isBusy;
        this.elements.projectsOkBtn.disabled = isBusy;
        this.elements.addProjectBtn.disabled = isBusy;
        this.elements.projectBindingCloseBtn.disabled = isBusy;
        this.elements.projectBindingCancelBtn.disabled = isBusy;
        for (const control of this.elements.projectBindingDialog.querySelectorAll("button, select")) {
            if (control instanceof HTMLButtonElement || control instanceof HTMLSelectElement) control.disabled = isBusy;
        }
        for (const control of this.elements.projectsList.querySelectorAll("button, input, select")) {
            if (
                control instanceof HTMLButtonElement ||
                control instanceof HTMLInputElement ||
                control instanceof HTMLSelectElement
            ) {
                control.disabled = isBusy;
            }
        }
        this.workspaceController.refreshWorkspaceComponentFields();
        if (!isBusy) {
            for (const row of this.elements.projectsList.querySelectorAll(".section-row")) {
                const useColor = row.querySelector(".section-use-color");
                const color = row.querySelector(".section-color");
                if (useColor instanceof HTMLInputElement && color instanceof HTMLInputElement) {
                    color.disabled = !useColor.checked;
                }
            }
        }
        this.elements.weekReqCloseBtn.disabled = isBusy;
        this.elements.weekReqCancelBtn.disabled = isBusy;
        this.elements.weekReqOkBtn.disabled = isBusy;
        this.elements.weekReqHours.disabled = isBusy;
        this.elements.weekReqComment.disabled = isBusy;
        this.weekView.setBusy(isBusy);
        this.todoView.setBusy(isBusy);
        this.expenseView.setBusy(isBusy);
        if (!isBusy) this.workspaceController.refreshOAuthControls();
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
        this.elements.loadProgressEl.max = max;
        this.elements.loadProgressEl.value = Math.min(Math.max(0, loaded), max);
        this.elements.loadProgressLabelEl.textContent = label || "";
    }

    /**
     * Synchronizes the shared search field and time-search labels with the active component and interface language.
     * Keeping this independent from tab navigation lets a locale change refresh accessible text without changing browser history or view state.
     * @returns {void}
     */
    updateSearchControls() {
        const searchesTodos = this.state.activeTab === "todos";
        const searchesExpenses = this.state.activeTab === "expenses";
        this.elements.searchInput.value = searchesTodos
            ? this.todoView.getSearchQuery()
            : searchesExpenses
              ? this.expenseView.getSearchQuery()
              : this.searchView.getSearchQuery();
        const searchKey = searchesTodos ? "Todos" : searchesExpenses ? "Expenses" : "Time";
        this.elements.searchInput.placeholder = this.locale.t(
            `topbar.search${searchKey}Placeholder`,
        );
        this.elements.searchInput.setAttribute(
            "aria-label",
            this.locale.t(`topbar.search${searchKey}`),
        );
        this.elements.globalSearchEl.title = this.locale.t(
            `topbar.search${searchKey}Title`,
        );
        this.elements.searchFromLabelEl.textContent = this.locale.t("search.from", { timezone: this.timeContext.timeZone });
        this.elements.searchToLabelEl.textContent = this.locale.t("search.to", { timezone: this.timeContext.timeZone });
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
        this.elements.topbarEl.dataset.activeTab = next;
        for (const [button, isCurrent] of [
            [this.elements.menuWeekBtn, next === "week"],
            [this.elements.menuTodoBtn, next === "todos"],
            [this.elements.menuExpenseBtn, next === "expenses"],
            [this.elements.menuSearchBtn, next === "search"],
        ]) {
            if (!(button instanceof HTMLButtonElement)) continue;
            if (isCurrent) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        }
        this.weekView.setActive(next === "week");
        this.todoView.setActive(next === "todos");
        this.expenseView.setActive(next === "expenses");
        this.searchView.setActive(next === "search");
        setVisible(this.elements.weekControlsEl, next === "week" && !this.elements.topbarEl.hidden);
        setVisible(this.elements.todoTopbarControlsEl, next === "todos" && !this.elements.topbarEl.hidden);
        setVisible(this.elements.expenseTopbarControlsEl, next === "expenses" && !this.elements.topbarEl.hidden);
        setVisible(this.elements.editorBadgeEl, (next === "week" || next === "todos" || next === "expenses") && !this.elements.topbarEl.hidden);
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
        if (this.runtime.workspace?.hasComponent("todos")) {
            totals.push(
                this.locale.t("data.todos", { count: this.locale.formatNumber(this.todoStore.getTodos().length) }),
            );
        }
        if (this.runtime.workspace?.hasComponent("expenses")) {
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

        const workspaceName = this.runtime.workspace?.name ? `${this.runtime.workspace.name} • ` : "";
        if (this.isLocalMode) {
            this.repositorySummary = `${workspaceName}${this.locale.t("data.local")} • ${totals.join(" • ")}`;
        } else {
            const repository =
                this.runtime.activeWorkspaceConnection?.repositoryUrl ||
                this.runtime.config.repositoryUrl ||
                formatGitHubRepositoryUrl(this.runtime.config.owner, this.runtime.config.repo);
            let repositoryLabel = repository;
            try {
                const url = new URL(repository);
                repositoryLabel = `${url.host}${url.pathname}`;
            } catch {
                // The locator was already validated; preserve its text if URL formatting is unavailable.
            }
            this.repositorySummary = `${workspaceName}${repositoryLabel}@${this.runtime.config.ref} • ${totals.join(" • ")}`;
        }
        this.refreshDataBadge();
    }

    /**
     * Chooses the content of the shared bottom-right overlay for the active view.
     * TODO mode shows task counts; Week and Search retain repository/manifest diagnostics.
     * @returns {void}
     */
    refreshDataBadge() {
        this.elements.repoLabelEl.textContent =
            this.state.activeTab === "todos"
                ? this.todoSummary
                : this.state.activeTab === "expenses"
                  ? this.expenseSummary
                  : this.repositorySummary;
    }

}
