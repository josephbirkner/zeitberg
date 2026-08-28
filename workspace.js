import {
    formatGitHubRepositoryUrl,
    inferHostedProvider,
    parseGitHubRepository,
} from "./config.js";
import { CapabilityScanner } from "./capability-scanner.js";
import { createHostedDataSource, LocalDataSource } from "./datasource.js";
import { createDefaultExpenseCategories, ExpenseDocument, ExpenseManifest, Workspace } from "./model.js";
import { readOAuthClientId, refreshOAuthCredential, startOAuthAuthorization } from "./oauth.js";
import {
    formatAppRoute,
    formatCapabilityLink,
    normalizeWorkspaceRouteLocator,
    parseCapabilityLink,
} from "./routing.js";
import { cloneJson, safeText, setVisible } from "./utils.js";

/**
 * Carries a repository bootstrap problem from the loading pipeline into the workspace editor.
 * Provider authentication and transport failures never use this type, so callers can safely offer a write-based repair only after repository access itself has succeeded.
 */
export class WorkspaceSetupRequiredError extends Error {
    /**
     * Creates a setup-state payload with any parseable source fields retained for form defaults.
     * @param {"missing" | "invalid_json" | "invalid"} reason Machine-readable setup reason.
     * @param {string} path Repository-relative workspace configuration path.
     * @param {unknown} detail Human-readable validation diagnostic.
     * @param {Object | null} [raw] Parseable but invalid workspace object, when available.
     */
    constructor(reason, path, detail, raw = null) {
        super(safeText(detail));
        this.name = "WorkspaceSetupRequiredError";
        this.reason = reason;
        this.path = String(path || "zeitberg.json");
        this.raw = raw ? cloneJson(raw) : null;
    }
}

/**
 * Applies a credential-free route locator to the active provider configuration.
 * GitHub retains owner/repo fields for its REST and GraphQL endpoints; every provider also receives the full normalized repository URL used by the shared data-source factory.
 * @param {import("./config.js").AppConfig} config Existing application configuration.
 * @param {import("./routing.js").WorkspaceRouteLocator | null} locator Parsed route locator.
 * @returns {import("./config.js").AppConfig}
 */
export function configForRouteWorkspace(config, locator) {
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
export function buildHostedWorkspaceLocator(provider, repositoryValue, ref, workspacePath, expectedWorkspaceId = "") {
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
        workspacePath: String(workspacePath || "zeitberg.json").trim(),
        expectedWorkspaceId: String(expectedWorkspaceId || "").trim(),
    });
    if (!locator || locator.provider === "local") throw new Error("Select a supported hosted Git provider.");
    return locator;
}

/**
 * Builds the IndexedDB namespace that isolates unsaved drafts by local workspace or hosted repository connection.
 * This standalone form is available during application composition, before the WorkspaceController can receive its view collaborators.
 * @param {boolean} isLocalMode Whether repository access uses the local development server.
 * @param {import("./config.js").WorkspaceConnection | null} activeConnection Active registry connection, when known.
 * @param {Workspace | null} workspace Loaded workspace model, when initialization has completed.
 * @param {import("./config.js").AppConfig} config Current provider configuration.
 * @returns {string}
 */
export function buildWorkspaceDraftNamespace(isLocalMode, activeConnection, workspace, config) {
    if (isLocalMode) {
        return `local:${activeConnection?.expectedWorkspaceId || workspace?.workspace_id || "default"}`;
    }
    if (activeConnection) return `workspace:${activeConnection.id}`;
    const provider = String(config.provider || "github").trim();
    const repository = String(
        config.repositoryUrl || formatGitHubRepositoryUrl(config.owner, config.repo),
    ).trim();
    const ref = String(config.ref || "").trim();
    return `${provider}:${repository}@${ref}`;
}


/**
 * @typedef {Object} WorkspaceRuntime
 * @description Mutable application session shared with the workspace component through explicit accessors.
 * @property {string | null} activeGlobalPanel
 * @property {import("./config.js").WorkspaceConnection | null} activeWorkspaceConnection
 * @property {import("./routing.js").CapabilityLink | null} capabilityImport
 * @property {import("./config.js").AppConfig} config
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {import("./routing.js").AppRoute | null} pendingRoute
 * @property {boolean} routeRestoreInProgress
 * @property {string} token
 * @property {Workspace | null} workspace
 * @property {Object | null} workspaceConfigBaseRaw
 * @property {import("./config.js").WorkspaceRegistry} workspaceRegistry
 * @property {{reason: "missing" | "invalid_json" | "invalid", path: string, detail: string, raw: Object | null} | null} workspaceSetup
 */

/**
 * @typedef {Object} WorkspaceElements
 * @description DOM owned by workspace connection, setup, creation, and sharing flows.
 * @property {HTMLElement} landingProviderStatusTextEl
 * @property {HTMLElement} loginErrorEl
 * @property {HTMLButtonElement} loginOAuthBtn
 * @property {HTMLSelectElement} providerInput
 * @property {HTMLInputElement} repositoryInput
 * @property {HTMLInputElement} refInput
 * @property {HTMLInputElement} rememberInput
 * @property {HTMLButtonElement} workspaceSettingsBtn
 * @property {HTMLDialogElement} workspaceDialog
 * @property {HTMLElement} workspaceListEl
 * @property {HTMLFormElement} workspaceConfigForm
 * @property {HTMLElement} workspaceConfigMetaEl
 * @property {HTMLInputElement} workspaceConfigNameInput
 * @property {HTMLInputElement} workspaceConfigIdInput
 * @property {HTMLInputElement} workspaceConfigTimezoneInput
 * @property {HTMLInputElement} workspaceConfigProjectsPathInput
 * @property {HTMLInputElement} workspaceConfigTimeEnabledInput
 * @property {HTMLElement} workspaceConfigTimeFieldsEl
 * @property {HTMLInputElement} workspaceConfigTimeEntriesInput
 * @property {HTMLInputElement} workspaceConfigTimeManifestInput
 * @property {HTMLInputElement} workspaceConfigTimeRequirementsInput
 * @property {HTMLInputElement} workspaceConfigTodosEnabledInput
 * @property {HTMLElement} workspaceConfigTodosFieldsEl
 * @property {HTMLInputElement} workspaceConfigTodosDocumentInput
 * @property {HTMLInputElement} workspaceConfigExpensesEnabledInput
 * @property {HTMLElement} workspaceConfigExpensesFieldsEl
 * @property {HTMLInputElement} workspaceConfigExpensesDocumentInput
 * @property {HTMLInputElement} workspaceConfigExpensesManifestInput
 * @property {HTMLElement} workspaceConfigErrorEl
 * @property {HTMLButtonElement} workspaceConfigSaveBtn
 * @property {HTMLElement} workspaceAddSectionEl
 * @property {HTMLFormElement} workspaceCapabilityForm
 * @property {HTMLInputElement} workspaceCapabilityLinkInput
 * @property {HTMLElement} workspaceCapabilityErrorEl
 * @property {HTMLButtonElement} workspaceScanCapabilityBtn
 * @property {HTMLButtonElement} workspaceOpenCapabilityBtn
 * @property {HTMLElement} workspaceQrScannerEl
 * @property {HTMLVideoElement} workspaceQrVideoEl
 * @property {HTMLInputElement} workspaceQrFileInput
 * @property {HTMLButtonElement} workspaceQrCloseBtn
 * @property {HTMLFormElement} workspaceAddForm
 * @property {HTMLSelectElement} workspaceProviderInput
 * @property {HTMLInputElement} workspaceRepositoryInput
 * @property {HTMLInputElement} workspaceRefInput
 * @property {HTMLInputElement} workspacePathInput
 * @property {HTMLInputElement} workspaceTokenInput
 * @property {HTMLInputElement} workspaceRememberInput
 * @property {HTMLElement} workspaceErrorEl
 * @property {HTMLButtonElement} workspaceShareBtn
 * @property {HTMLButtonElement} workspaceOAuthBtn
 * @property {HTMLDialogElement} workspaceCreateDialog
 * @property {HTMLSelectElement} workspaceCreateProviderInput
 * @property {HTMLInputElement} workspaceCreateRepositoryInput
 * @property {HTMLInputElement} workspaceCreateNameInput
 * @property {HTMLInputElement} workspaceCreateTimezoneInput
 * @property {HTMLInputElement} workspaceCreateTokenInput
 * @property {HTMLInputElement} workspaceCreateRememberInput
 * @property {HTMLElement} workspaceCreateProviderNoteEl
 * @property {HTMLElement} workspaceCreateErrorEl
 * @property {HTMLButtonElement} workspaceCreateOAuthBtn
 * @property {HTMLDialogElement} workspaceShareDialog
 * @property {HTMLElement} workspaceShareDetailsEl
 * @property {HTMLButtonElement} workspaceCopyLocatorBtn
 * @property {HTMLButtonElement} workspaceCopyCapabilityBtn
 * @property {HTMLElement} workspaceShareErrorEl
 */

/**
 * @typedef {Object} WorkspaceControllerOptions
 * @description Dependencies and application-level transitions required by the workspace component.
 * @property {WorkspaceRuntime} runtime
 * @property {boolean} isLocalMode
 * @property {import("./config.js").ConfigService} configService
 * @property {import("./locale.js").LocaleService} locale
 * @property {import("./routing.js").RouteController} routeController
 * @property {import("./appstate.js").AppState} state
 * @property {import("./week.view.js").WeekView} weekView
 * @property {import("./todo.view.js").TodoView} todoView
 * @property {import("./expense.view.js").ExpenseView} expenseView
 * @property {import("./project.view.js").ProjectDialog} projectDialog
 * @property {WorkspaceElements} elements
 * @property {(element: HTMLElement, message: unknown) => void} onError
 * @property {(message: string, timeout?: number, tone?: "error" | "success") => void} onToast
 * @property {(isBusy: boolean) => void} onBusy
 * @property {() => void} onShowLogin
 * @property {() => void} onRefreshNavigation
 * @property {() => Promise<boolean>} onReload
 * @property {(token: string, connectionInfo?: {repoInfo: any, userInfo: any} | null) => Promise<void>} onConnect
 * @property {(mode?: "push" | "replace") => void} onWriteRoute
 * @property {() => import("./routing.js").AppRoute} buildCurrentRoute
 * @property {(clearCredential?: boolean) => void} onLogout
 */

/**
 * Owns repository connections and every workspace-specific dialog and workflow.
 * The controller keeps provider authentication, repository setup, registry switching, and share links cohesive while delegating only application-wide screen and route transitions through callbacks.
 */
export class WorkspaceController {
    /**
     * Captures workspace services, view collaborators, mutable session accessors, and owned DOM.
     * No network operation occurs until an explicit controller method is invoked.
     * @param {WorkspaceControllerOptions} options Constructor dependencies supplied by the application composition root.
     */
    constructor(options) {
        this.runtime = options.runtime;
        this.isLocalMode = options.isLocalMode;
        this.configService = options.configService;
        this.locale = options.locale;
        this.routeController = options.routeController;
        this.state = options.state;
        this.weekView = options.weekView;
        this.todoView = options.todoView;
        this.expenseView = options.expenseView;
        this.projectDialog = options.projectDialog;
        this.elements = options.elements;
        this.setError = options.onError;
        this.toast = options.onToast;
        this.setBusy = options.onBusy;
        this.showLoginScreen = options.onShowLogin;
        this.refreshSidebarNavigation = options.onRefreshNavigation;
        this.reloadData = options.onReload;
        this.connectWithToken = options.onConnect;
        this.writeCurrentRoute = options.onWriteRoute;
        this.buildCurrentRoute = options.buildCurrentRoute;
        this.logout = options.onLogout;
        this.workspaceDialogOpenedByPush = false;
        this.capabilityScanner = new CapabilityScanner({
            elements: {
                container: this.elements.workspaceQrScannerEl,
                fileInput: this.elements.workspaceQrFileInput,
                video: this.elements.workspaceQrVideoEl,
            },
            onResult: (value) => this.importCapabilityValue(value),
            onError: (kind, error) => {
                const key =
                    kind === "unavailable"
                        ? "workspace.qrUnavailable"
                        : kind === "image"
                          ? "workspace.qrImageError"
                          : "workspace.qrCameraError";
                const message =
                    kind === "unavailable"
                        ? this.locale.t(key)
                        : this.locale.t(key, { error: this.locale.localizeError(error) });
                this.setError(this.elements.workspaceCapabilityErrorEl, message);
            },
            onClearError: () => this.setError(this.elements.workspaceCapabilityErrorEl, ""),
        });
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
            github: "https://github.com/you/zeitberg-data",
            gitlab: "https://gitlab.com/you/zeitberg-data",
            codeberg: "https://codeberg.org/you/zeitberg-data",
            forgejo: "https://git.example.org/you/zeitberg-data",
            custom: "https://git.example.org/you/zeitberg-data",
        };
        repositoryInput.placeholder = placeholders[provider] || placeholders.custom;
        if (providerInput === this.elements.providerInput) {
            this.elements.landingProviderStatusTextEl.textContent = `${this.providerDisplayName(provider)} API`;
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
        configure(this.elements.loginOAuthBtn, this.elements.providerInput.value);
        configure(this.elements.workspaceOAuthBtn, this.elements.workspaceProviderInput.value);
        configure(this.elements.workspaceCreateOAuthBtn, this.elements.workspaceCreateProviderInput.value);
        this.elements.workspaceCreateProviderNoteEl.textContent =
            this.elements.workspaceCreateProviderInput.value === "codeberg"
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
        const providerInput = isSettings ? this.elements.workspaceProviderInput : this.elements.providerInput;
        const repositoryInput = isSettings ? this.elements.workspaceRepositoryInput : this.elements.repositoryInput;
        const refInput = isSettings ? this.elements.workspaceRefInput : this.elements.refInput;
        const pathInput = isSettings ? this.elements.workspacePathInput : null;
        const rememberInput = isSettings ? this.elements.workspaceRememberInput : this.elements.rememberInput;
        const errorElement = isSettings ? this.elements.workspaceErrorEl : this.elements.loginErrorEl;
        this.setError(errorElement, "");
        try {
            const locator = buildHostedWorkspaceLocator(
                providerInput.value,
                repositoryInput.value,
                refInput.value,
                pathInput?.value || this.runtime.pendingRoute?.workspace?.workspacePath || this.runtime.config.workspacePath,
                this.runtime.pendingRoute?.workspace?.expectedWorkspaceId || "",
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
        this.elements.workspaceCreateTokenInput.value = "";
        this.elements.workspaceCreateRememberInput.checked = false;
        this.elements.workspaceCreateTimezoneInput.value = this.runtime.workspace?.timezone || this.runtime.config.timezone || "Europe/Berlin";
        this.setError(this.elements.workspaceCreateErrorEl, "");
        this.refreshOAuthControls();
        if (!this.elements.workspaceCreateDialog.open) this.elements.workspaceCreateDialog.showModal();
    }

    /**
     * Closes repository creation and clears any unsubmitted token from the DOM.
     * @returns {void}
     */
    closeWorkspaceCreateDialog() {
        this.elements.workspaceCreateTokenInput.value = "";
        this.setError(this.elements.workspaceCreateErrorEl, "");
        if (this.elements.workspaceCreateDialog.open) this.elements.workspaceCreateDialog.close();
    }

    /**
     * Starts OAuth authorization for private repository creation.
     * Repository and workspace names remain short-lived session intent until the provider returns consent.
     * @returns {Promise<void>}
     */
    async beginOAuthWorkspaceCreation() {
        this.setError(this.elements.workspaceCreateErrorEl, "");
        const provider = this.elements.workspaceCreateProviderInput.value;
        try {
            await startOAuthAuthorization(
                window,
                provider,
                readOAuthClientId(document, provider),
                {
                    mode: "create",
                    repositoryUrl: "",
                    ref: "main",
                    workspacePath: "zeitberg.json",
                    expectedWorkspaceId: "",
                    remember: this.elements.workspaceCreateRememberInput.checked,
                    repositoryName: this.elements.workspaceCreateRepositoryInput.value,
                    workspaceName: this.elements.workspaceCreateNameInput.value,
                    timezone: this.elements.workspaceCreateTimezoneInput.value,
                },
                this.routeController.basePath,
            );
        } catch (error) {
            this.setError(this.elements.workspaceCreateErrorEl, safeText(error));
        }
    }

    /**
     * Maps the checked-in empty-document templates onto one validated workspace's configured paths.
     * The workspace descriptor is deliberately emitted last: providers without atomic multi-file commits cannot expose component paths before their seed documents exist.
     * @param {Workspace} workspace Validated workspace whose components should be initialized.
     * @param {string} workspacePath Repository-relative path of the bootstrap descriptor.
     * @param {boolean} [includeReadme] Whether provider-assisted repository creation should also install the template README.
     * @returns {Promise<import("./datasource.js").SaveFile[]>}
     */
    async buildWorkspaceInitializationFiles(workspace, workspacePath, includeReadme = false) {
        const templatePaths = [
            "README.md",
            "data/projects.json",
            "data/todos.json",
            "data/expenses.json",
            "data/week-requirements.json",
            "data/index/entries-manifest.json",
        ];
        const templates = new Map(
            await Promise.all(
                templatePaths.map(async (path) => {
                    const response = await fetch(new URL(`./workspace-template/${path}`, import.meta.url), {
                        cache: "no-store",
                    });
                    if (!response.ok) throw new Error(`Could not load workspace template file ${path}.`);
                    return /** @type {[string, string]} */ ([path, await response.text()]);
                }),
            ),
        );
        /**
         * Returns one required template document or fails before any repository write begins.
         * @param {string} path Canonical path inside workspace-template.
         * @returns {string}
         */
        const templateText = (path) => {
            const content = templates.get(path);
            if (typeof content !== "string") throw new Error(`The workspace template is missing ${path}.`);
            return content;
        };

        /** @type {import("./datasource.js").SaveFile[]} */
        const files = [];
        if (includeReadme) files.push({ path: "README.md", content: templateText("README.md") });
        files.push({ path: workspace.getResourcePath("projects"), content: templateText("data/projects.json") });

        if (workspace.hasComponent("time_tracking")) {
            const manifestRaw = JSON.parse(templateText("data/index/entries-manifest.json"));
            manifestRaw.timezone = workspace.timezone;
            files.push(
                {
                    path: workspace.getComponentPath("time_tracking", "manifest"),
                    content: `${JSON.stringify(manifestRaw, null, 2)}\n`,
                },
                {
                    path: workspace.getComponentPath("time_tracking", "week_requirements"),
                    content: templateText("data/week-requirements.json"),
                },
            );
        }
        if (workspace.hasComponent("todos")) {
            files.push({
                path: workspace.getComponentPath("todos", "document"),
                content: templateText("data/todos.json"),
            });
        }
        if (workspace.hasComponent("expenses")) {
            const expensePath = workspace.getComponentPath("expenses", "document");
            const expenseRaw = JSON.parse(templateText("data/expenses.json"));
            if (!Array.isArray(expenseRaw.categories) || !expenseRaw.categories.length) {
                expenseRaw.categories = createDefaultExpenseCategories();
            }
            const expenseDocument = ExpenseDocument.fromRaw(expenseRaw);
            const expenseContent = expenseDocument.toJson();
            const expenseManifest = ExpenseManifest.fromDocument(expenseDocument, expensePath, expenseContent, "");
            files.push(
                { path: expensePath, content: expenseContent },
                {
                    path: workspace.getComponentPath("expenses", "manifest"),
                    content: expenseManifest.toJson(),
                },
            );
        }
        files.push({ path: workspacePath, content: workspace.toJson() });
        return files;
    }

    /**
     * Creates a canonical workspace model and its complete repository seed for provider-assisted repository creation.
     * This shares the exact same initialization builder as adoption of an existing repository, preventing the two onboarding paths from drifting.
     * @param {string} workspaceName Human-readable workspace name.
     * @param {string} timezone IANA timezone identifier.
     * @returns {Promise<{files: import("./datasource.js").SaveFile[], workspace: Workspace}>}
     */
    async loadWorkspaceTemplateFiles(workspaceName, timezone) {
        const workspace = Workspace.createDefault(
            crypto.randomUUID(),
            String(workspaceName || "").trim(),
            String(timezone || "").trim(),
        );
        const files = await this.buildWorkspaceInitializationFiles(workspace, "zeitberg.json", true);
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
                ? "https://gitlab.com/zeitberg-onboarding/placeholder"
                : "https://codeberg.org/zeitberg-onboarding/placeholder";
        const placeholderLocator = buildHostedWorkspaceLocator(provider, placeholderUrl, "main", "zeitberg.json");
        const creationConfig = configForRouteWorkspace(this.runtime.config, placeholderLocator);
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
                "zeitberg.json",
                workspace.workspace_id,
            );
            const initializedSource = createHostedDataSource(configForRouteWorkspace(this.runtime.config, locator), accessToken);
            await initializedSource.saveFiles(files, "Initialize zeitberg workspace");

            const connection = this.runtime.workspaceRegistry.upsert(locator, {
                displayName: workspace.name,
                expectedWorkspaceId: workspace.workspace_id,
            });
            this.runtime.workspaceRegistry.setActive(connection.id);
            this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
            if (oauthCredential) {
                this.configService.saveWorkspaceOAuthCredential(connection.id, oauthCredential, remember);
            } else {
                this.configService.saveWorkspaceCredential(connection.id, accessToken, remember);
            }
            this.activateWorkspaceConnection(connection, accessToken);
            this.runtime.pendingRoute = {
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
        this.setError(this.elements.workspaceCreateErrorEl, "");
        const token = this.elements.workspaceCreateTokenInput.value.trim();
        if (!token) {
            this.setError(this.elements.workspaceCreateErrorEl, this.locale.t("workspace.tokenOrOAuth"));
            return;
        }
        this.setBusy(true);
        try {
            await this.createAndOpenWorkspace(
                /** @type {"gitlab" | "codeberg"} */ (this.elements.workspaceCreateProviderInput.value),
                this.elements.workspaceCreateRepositoryInput.value,
                this.elements.workspaceCreateNameInput.value,
                this.elements.workspaceCreateTimezoneInput.value,
                token,
                this.elements.workspaceCreateRememberInput.checked,
            );
        } catch (error) {
            this.setError(this.elements.workspaceCreateErrorEl, safeText(error));
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
                intent.repositoryName || "zeitberg-data",
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
        const connection = this.runtime.workspaceRegistry.upsert(locator);
        this.runtime.workspaceRegistry.setActive(connection.id);
        this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
        this.configService.saveWorkspaceOAuthCredential(connection.id, credential, intent.remember);
        this.activateWorkspaceConnection(connection, credential.accessToken);
        this.runtime.pendingRoute = {
            version: 1,
            component: "time",
            panel: "main",
            workspace: connection.toLocator(),
            state: {},
        };
        await this.connectWithToken(credential.accessToken);
    }

    /**
     * Finds the first component of a given type in a raw workspace object while retaining its stable instance id.
     * Setup drafts use this tolerant lookup before full model validation so incomplete configurations can still seed meaningful form values.
     * @param {Object | null} raw Candidate workspace object.
     * @param {string} type Component type such as time_tracking, todos, or expenses.
     * @returns {{id: string, component: Object} | null}
     */
    findRawWorkspaceComponent(raw, type) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const components = raw.components;
        if (!components || typeof components !== "object" || Array.isArray(components)) return null;
        for (const [id, component] of Object.entries(components)) {
            if (
                component &&
                typeof component === "object" &&
                !Array.isArray(component) &&
                String(component.type || "") === type
            ) {
                return { id, component };
            }
        }
        return null;
    }

    /**
     * Derives a concise initial workspace name from the active registry row or repository URL.
     * @returns {string}
     */
    getDefaultWorkspaceName() {
        const connection = this.runtime.activeWorkspaceConnection;
        if (connection?.displayName) return connection.displayName;
        if (connection?.repositoryUrl) {
            try {
                const parts = new URL(connection.repositoryUrl).pathname.split("/").filter(Boolean);
                if (parts.length) return parts[parts.length - 1].replace(/\.git$/i, "");
            } catch {
                // The normalized connection URL is already safe; a generic label is sufficient if parsing is unavailable.
            }
        }
        return "My workspace";
    }

    /**
     * Produces a complete editable draft from a missing or parseable-but-invalid workspace document.
     * Valid primitive fields and known component paths are retained, while unsafe identities and absent required paths receive canonical defaults so the form can always produce a valid model.
     * @param {Object | null} raw Parseable source object, when available.
     * @returns {Object}
     */
    createWorkspaceConfigurationDraft(raw) {
        let timezone = this.runtime.config.timezone || "Europe/Berlin";
        try {
            timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
        } catch {
            // Keep the configured fallback when the browser cannot resolve a timezone.
        }
        const expectedId = String(this.runtime.activeWorkspaceConnection?.expectedWorkspaceId || "").trim();
        const defaultId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(expectedId)
            ? expectedId
            : crypto.randomUUID();
        const defaults = Workspace.createDefault(defaultId, this.getDefaultWorkspaceName(), timezone).toObject();
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;

        const candidate = raw;
        const workspaceId = String(candidate.workspace_id || "").trim();
        if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspaceId)) defaults.workspace_id = workspaceId;
        const name = String(candidate.name || "").trim();
        if (name) defaults.name = name;
        const candidateTimezone = String(candidate.timezone || "").trim();
        if (candidateTimezone) {
            try {
                new Intl.DateTimeFormat("en", { timeZone: candidateTimezone }).format();
                defaults.timezone = candidateTimezone;
            } catch {
                // Invalid timezone text is replaced because the readonly setup identity must remain saveable.
            }
        }
        if (typeof candidate.$schema === "string" && candidate.$schema.trim()) {
            defaults.$schema = candidate.$schema.trim();
        }
        if (
            candidate.resources &&
            typeof candidate.resources === "object" &&
            !Array.isArray(candidate.resources) &&
            typeof candidate.resources.projects === "string" &&
            candidate.resources.projects.trim()
        ) {
            defaults.resources.projects = candidate.resources.projects.trim();
        }

        const supportedComponents = [
            ["time_tracking", "time"],
            ["todos", "tasks"],
            ["expenses", "expenses"],
        ];
        const discovered = supportedComponents
            .map(([type, fallbackId]) => ({ fallbackId, match: this.findRawWorkspaceComponent(candidate, type), type }))
            .filter((item) => item.match);
        if (discovered.length) {
            defaults.components = {};
            for (const item of discovered) {
                const fallback = Workspace.createDefault("draft", "Draft", defaults.timezone).getComponent(item.type);
                const component = item.match?.component || {};
                const rawPaths =
                    component.paths && typeof component.paths === "object" && !Array.isArray(component.paths)
                        ? component.paths
                        : {};
                const paths = { ...fallback.paths };
                for (const [key, value] of Object.entries(rawPaths)) {
                    if (typeof value === "string" && value.trim()) paths[key] = value.trim();
                }
                const id = /^[a-z][a-z0-9_-]*$/.test(item.match?.id || "") ? item.match.id : item.fallbackId;
                defaults.components[id] = { paths, type: item.type };
            }
        }
        return defaults;
    }

    /**
     * Enables or disables path controls to match the three component toggles.
     * Disabled inputs are excluded from native form validation, allowing a component to be turned off without erasing its remembered path values.
     * @returns {void}
     */
    refreshWorkspaceComponentFields() {
        /** @type {Array<[HTMLInputElement, HTMLElement]>} */
        const groups = [
            [this.elements.workspaceConfigTimeEnabledInput, this.elements.workspaceConfigTimeFieldsEl],
            [this.elements.workspaceConfigTodosEnabledInput, this.elements.workspaceConfigTodosFieldsEl],
            [this.elements.workspaceConfigExpensesEnabledInput, this.elements.workspaceConfigExpensesFieldsEl],
        ];
        for (const [toggle, container] of groups) {
            const enabled = toggle.checked && !this.elements.workspaceConfigSaveBtn.disabled;
            container.closest(".workspace-component")?.classList.toggle("is-disabled", !toggle.checked);
            for (const input of container.querySelectorAll("input")) {
                if (input instanceof HTMLInputElement) input.disabled = !enabled;
            }
        }
    }

    /**
     * Populates the structured zeitberg.json editor from either the loaded workspace or the retained setup draft.
     * @returns {void}
     */
    renderWorkspaceConfiguration() {
        const source = this.runtime.workspace?.toObject() || this.runtime.workspaceConfigBaseRaw;
        if (!source) {
            this.elements.workspaceConfigForm.hidden = true;
            return;
        }
        this.elements.workspaceConfigForm.hidden = false;
        this.elements.workspaceConfigMetaEl.textContent = this.runtime.workspaceSetup
            ? this.locale.t(
                  this.runtime.workspaceSetup.reason === "missing"
                      ? "workspace.setupMissingMeta"
                      : "workspace.setupInvalidMeta",
                  { path: this.runtime.workspaceSetup.path },
              )
            : this.locale.t("workspace.configureMeta");
        this.elements.workspaceConfigNameInput.value = String(source.name || "");
        this.elements.workspaceConfigIdInput.value = String(source.workspace_id || "");
        this.elements.workspaceConfigTimezoneInput.value = String(source.timezone || "");
        this.elements.workspaceConfigProjectsPathInput.value = String(source.resources?.projects || "");

        const time = this.findRawWorkspaceComponent(source, "time_tracking");
        const todos = this.findRawWorkspaceComponent(source, "todos");
        const expenses = this.findRawWorkspaceComponent(source, "expenses");
        this.elements.workspaceConfigTimeEnabledInput.checked = Boolean(time);
        this.elements.workspaceConfigTimeEntriesInput.value = String(time?.component?.paths?.entries || "data/entries");
        this.elements.workspaceConfigTimeManifestInput.value = String(
            time?.component?.paths?.manifest || "data/index/entries-manifest.json",
        );
        this.elements.workspaceConfigTimeRequirementsInput.value = String(
            time?.component?.paths?.week_requirements || "data/week-requirements.json",
        );
        this.elements.workspaceConfigTodosEnabledInput.checked = Boolean(todos);
        this.elements.workspaceConfigTodosDocumentInput.value = String(todos?.component?.paths?.document || "data/todos.json");
        this.elements.workspaceConfigExpensesEnabledInput.checked = Boolean(expenses);
        this.elements.workspaceConfigExpensesDocumentInput.value = String(
            expenses?.component?.paths?.document || "data/expenses.json",
        );
        this.elements.workspaceConfigExpensesManifestInput.value = String(
            expenses?.component?.paths?.manifest || "data/index/expenses-manifest.json",
        );
        this.setError(this.elements.workspaceConfigErrorEl, this.runtime.workspaceSetup?.detail || "");
        this.refreshWorkspaceComponentFields();
    }

    /**
     * Converts the structured workspace form into the validated provider-neutral model.
     * Unknown future component types and extra resources are retained only when editing an already valid workspace, avoiding accidental data loss without carrying malformed setup fragments forward.
     * @returns {Workspace}
     */
    readWorkspaceConfigurationForm() {
        if (
            !this.elements.workspaceConfigTimeEnabledInput.checked &&
            !this.elements.workspaceConfigTodosEnabledInput.checked &&
            !this.elements.workspaceConfigExpensesEnabledInput.checked
        ) {
            throw new Error(this.locale.t("workspace.enableComponent"));
        }
        const base = this.runtime.workspace?.toObject() || this.runtime.workspaceConfigBaseRaw || {};
        /** @type {Object.<string, import("./model.js").WorkspaceComponentRaw>} */
        const components = {};
        if (this.runtime.workspace) {
            for (const [id, component] of Object.entries(this.runtime.workspace.components)) {
                if (!["time_tracking", "todos", "expenses"].includes(component.type)) {
                    components[id] = cloneJson(component);
                }
            }
        }

        const timeId = this.findRawWorkspaceComponent(base, "time_tracking")?.id || "time";
        if (this.elements.workspaceConfigTimeEnabledInput.checked) {
            components[timeId] = {
                type: "time_tracking",
                paths: {
                    entries: this.elements.workspaceConfigTimeEntriesInput.value.trim(),
                    manifest: this.elements.workspaceConfigTimeManifestInput.value.trim(),
                    week_requirements: this.elements.workspaceConfigTimeRequirementsInput.value.trim(),
                },
            };
        }
        const todosId = this.findRawWorkspaceComponent(base, "todos")?.id || "tasks";
        if (this.elements.workspaceConfigTodosEnabledInput.checked) {
            components[todosId] = {
                type: "todos",
                paths: { document: this.elements.workspaceConfigTodosDocumentInput.value.trim() },
            };
        }
        const expensesId = this.findRawWorkspaceComponent(base, "expenses")?.id || "expenses";
        if (this.elements.workspaceConfigExpensesEnabledInput.checked) {
            components[expensesId] = {
                type: "expenses",
                paths: {
                    document: this.elements.workspaceConfigExpensesDocumentInput.value.trim(),
                    manifest: this.elements.workspaceConfigExpensesManifestInput.value.trim(),
                },
            };
        }

        const resources = this.runtime.workspace ? cloneJson(this.runtime.workspace.resources) : {};
        resources.projects = this.elements.workspaceConfigProjectsPathInput.value.trim();
        return Workspace.fromRaw({
            ...(typeof base.$schema === "string" && base.$schema.trim()
                ? { $schema: base.$schema.trim() }
                : { $schema: "https://zeitberg.io/schema/workspace-v1.schema.json" }),
            components,
            name: this.elements.workspaceConfigNameInput.value.trim(),
            resources,
            schema_version: 1,
            timezone: this.elements.workspaceConfigTimezoneInput.value.trim(),
            workspace_id: this.elements.workspaceConfigIdInput.value.trim(),
        });
    }

    /**
     * Saves zeitberg.json and seeds only selected component documents that do not already exist.
     * Every provider uses the ordinary multi-file save pipeline; a successful write immediately reloads the workspace so navigation reflects the newly enabled components.
     * @param {Event} event Workspace configuration form submission.
     * @returns {Promise<void>}
     */
    async handleWorkspaceConfigurationSubmit(event) {
        event.preventDefault();
        this.setError(this.elements.workspaceConfigErrorEl, "");
        let workspace;
        try {
            workspace = this.readWorkspaceConfigurationForm();
        } catch (error) {
            this.setError(this.elements.workspaceConfigErrorEl, safeText(error));
            return;
        }

        this.setBusy(true);
        try {
            const files = await this.buildWorkspaceInitializationFiles(
                workspace,
                this.runtime.dataSource.getWorkspaceConfigPath(),
            );
            const workspaceFile = files[files.length - 1];
            const seedFiles = files.slice(0, -1);
            const existing = await Promise.all(
                seedFiles.map((file) => this.runtime.dataSource.repositoryFileExists(file.path)),
            );
            const missingFiles = seedFiles.filter((_file, index) => !existing[index]);
            await this.runtime.dataSource.saveFiles(
                [...missingFiles, workspaceFile],
                this.locale.t("workspace.savingConfiguration"),
            );

            this.runtime.workspaceSetup = null;
            this.runtime.workspaceConfigBaseRaw = workspace.toObject();
            this.closeWorkspaceSettings("none");
            const loaded = await this.reloadData();
            if (loaded && this.runtime.workspace) {
                this.toast(this.locale.t("workspace.configurationSaved"), 3200, "success");
            }
        } catch (error) {
            this.setError(this.elements.workspaceConfigErrorEl, safeText(error));
        } finally {
            this.setBusy(false);
            this.refreshWorkspaceComponentFields();
        }
    }

    /**
     * Replaces the failed loading surface with an authenticated workspace-setup state.
     * Component navigation remains hidden until a valid descriptor has been saved and reloaded, while repository and credential controls stay available in the sidebar.
     * @param {WorkspaceSetupRequiredError} error Recoverable bootstrap failure.
     * @returns {void}
     */
    enterWorkspaceSetup(error) {
        this.runtime.dataSource.clearWorkspace();
        this.runtime.workspace = null;
        this.runtime.workspaceSetup = {
            reason: error.reason,
            path: error.path,
            detail: error.message,
            raw: error.raw,
        };
        this.runtime.workspaceConfigBaseRaw = this.createWorkspaceConfigurationDraft(error.raw);
        this.showLoginScreen();
        this.refreshSidebarNavigation();
        this.renderWorkspaceRegistry();
        this.openWorkspaceSettings("none");
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
        this.elements.workspaceListEl.innerHTML = "";
        this.elements.workspaceAddSectionEl.hidden = this.isLocalMode || Boolean(this.runtime.workspaceSetup);
        this.elements.workspaceShareBtn.disabled = !this.runtime.workspace;
        this.renderWorkspaceConfiguration();

        const connections = this.runtime.workspaceRegistry.list();
        if (!connections.length) {
            const empty = document.createElement("p");
            empty.className = "workspace-empty muted";
            empty.textContent = this.locale.t("workspace.none");
            this.elements.workspaceListEl.append(empty);
            return;
        }

        connections.forEach((connection, index) => {
            const isActive = connection.id === this.runtime.activeWorkspaceConnection?.id;
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
            credentialBadge.textContent =
                isActive && this.runtime.workspaceSetup
                    ? this.locale.t("workspace.needsSetup")
                    : connection.provider === "local"
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
                    isActive && (this.runtime.workspace || this.runtime.workspaceSetup)
                        ? this.locale.t("workspace.open")
                        : hasCredential
                          ? this.locale.t("workspace.switch")
                          : this.locale.t("workspace.authenticate"),
                    "open",
                    connection.id,
                    isActive && Boolean(this.runtime.workspace || this.runtime.workspaceSetup),
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
            this.elements.workspaceListEl.append(row);
        });
    }

    /**
     * Opens Workspace settings as a modal global panel and optionally records that navigation in browser history.
     * The underlying component remains mounted, allowing Back or dialog close to return to its exact view state.
     * @param {"push" | "none"} [historyMode] Whether opening should create a browser-history entry.
     * @returns {void}
     */
    openWorkspaceSettings(historyMode = "push") {
        const hasRoutableWorkspace = Boolean(
            this.runtime.workspace || this.runtime.workspaceSetup || this.runtime.activeWorkspaceConnection,
        );
        this.runtime.activeGlobalPanel = "workspaces";
        this.workspaceDialogOpenedByPush = historyMode === "push" && hasRoutableWorkspace;
        this.elements.workspaceSettingsBtn.setAttribute("aria-current", "page");
        this.setError(this.elements.workspaceErrorEl, "");
        this.setError(this.elements.workspaceCapabilityErrorEl, "");
        this.renderWorkspaceRegistry();
        if (!this.elements.workspaceDialog.open) this.elements.workspaceDialog.showModal();
        if (this.workspaceDialogOpenedByPush) this.writeCurrentRoute("push");
    }

    /**
     * Closes Workspace settings and restores the route beneath it.
     * A panel opened by an in-app push returns through browser history; a directly loaded settings URL is normalized in place.
     * @param {"back" | "replace" | "none"} [historyMode] Route behavior used while closing.
     * @returns {void}
     */
    closeWorkspaceSettings(historyMode = "back") {
        this.closeCapabilityScanner();
        this.elements.workspaceCapabilityLinkInput.value = "";
        const wasOpen = this.elements.workspaceDialog.open;
        if (wasOpen) this.elements.workspaceDialog.close();
        if (this.runtime.activeGlobalPanel === "workspaces") this.runtime.activeGlobalPanel = null;
        this.elements.workspaceSettingsBtn.removeAttribute("aria-current");
        if (!wasOpen || historyMode === "none" || this.runtime.routeRestoreInProgress) {
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
            if (this.runtime.workspaceRegistry.move(connectionId, action === "up" ? -1 : 1)) {
                this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
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
        this.elements.workspaceProviderInput.value = connection.provider;
        this.elements.workspaceRepositoryInput.value = connection.repositoryUrl;
        this.elements.workspaceRefInput.value = connection.ref;
        this.elements.workspacePathInput.value = connection.workspacePath;
        this.elements.workspaceTokenInput.value = "";
        this.elements.workspaceRememberInput.checked = false;
        this.updateProviderForm(this.elements.workspaceProviderInput, this.elements.workspaceRepositoryInput);
        this.setError(
            this.elements.workspaceErrorEl,
            this.locale.t("workspace.enterTokenFor", { workspace: connection.displayName }),
        );
        queueMicrotask(() => this.elements.workspaceTokenInput.focus());
    }

    /**
     * Applies a registered GitHub connection to all runtime configuration holders without loading its documents.
     * Callers preflight first when another usable workspace is mounted, then connect through the ordinary shared load pipeline.
     * @param {import("./config.js").WorkspaceConnection} connection Connection becoming active.
     * @param {string} token Credential scoped to that connection id.
     * @returns {void}
     */
    activateWorkspaceConnection(connection, token) {
        this.runtime.workspaceRegistry.setActive(connection.id);
        this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
        this.runtime.activeWorkspaceConnection = connection;
        this.runtime.config =
            connection.provider === "local"
                ? {
                      ...this.runtime.config,
                      workspacePath: connection.workspacePath,
                      localWorkspaceId: connection.expectedWorkspaceId,
                  }
                : configForRouteWorkspace(this.runtime.config, connection.toLocator());
        this.configService.saveConfig(this.runtime.config);
        this.state.setConfig(this.runtime.config);
        this.runtime.token = token;
        this.state.setToken(token);
        this.elements.providerInput.value = connection.provider;
        this.elements.repositoryInput.value = connection.repositoryUrl;
        this.elements.refInput.value = connection.ref;
        this.updateProviderForm(this.elements.providerInput, this.elements.repositoryInput);
        this.elements.rememberInput.checked = this.configService.isWorkspaceCredentialRemembered(connection.id);
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
        const candidateConfig = configForRouteWorkspace(this.runtime.config, connection.toLocator());
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
        const connection = this.runtime.workspaceRegistry.getById(connectionId);
        if (!connection) return;
        if (connection.id === this.runtime.activeWorkspaceConnection?.id && this.runtime.workspace) {
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
            this.runtime.pendingRoute = requestedRoute || this.routeForWorkspaceConnection(connection);
            this.runtime.dataSource = new LocalDataSource(this.runtime.config);
            this.weekView.setDataSource(this.runtime.dataSource);
            this.todoView.setDataSource(this.runtime.dataSource);
            this.expenseView.setDataSource(this.runtime.dataSource);
            this.projectDialog.setDataSource(this.runtime.dataSource);
            this.closeWorkspaceSettings("none");
            await this.reloadData();
            return;
        }
        this.setError(this.elements.workspaceErrorEl, "");
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
            this.setError(this.elements.workspaceErrorEl, message);
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
        this.runtime.pendingRoute = requestedRoute || this.routeForWorkspaceConnection(connection);
        this.closeWorkspaceSettings("none");
        try {
            await this.connectWithToken(credential, connectionInfo);
        } catch (error) {
            this.setError(this.elements.loginErrorEl, safeText(error));
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
        this.setError(this.elements.workspaceErrorEl, "");

        const token = this.elements.workspaceTokenInput.value.trim();
        if (!token) {
            this.setError(this.elements.workspaceErrorEl, this.locale.t("toast.enterToken"));
            return;
        }
        try {
            const locator = buildHostedWorkspaceLocator(
                this.elements.workspaceProviderInput.value,
                this.elements.workspaceRepositoryInput.value,
                this.elements.workspaceRefInput.value,
                this.elements.workspacePathInput.value,
            );
            const connection = this.runtime.workspaceRegistry.upsert(locator);
            this.configService.saveWorkspaceCredential(connection.id, token, this.elements.workspaceRememberInput.checked);
            this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
            this.elements.workspaceTokenInput.value = "";
            this.renderWorkspaceRegistry();
            await this.switchWorkspace(connection.id);
        } catch (error) {
            this.setError(this.elements.workspaceErrorEl, safeText(error));
        }
    }

    /**
     * Handles submission of the compact capability-link form in Workspace settings.
     * Pressing Enter and activating the Open link button both enter the same parser and connection pipeline used by QR results and startup capability URLs.
     * @param {Event} event Capability form submission.
     * @returns {Promise<void>}
     */
    async handleCapabilityLinkImport(event) {
        event.preventDefault();
        await this.importCapabilityValue(this.elements.workspaceCapabilityLinkInput.value);
    }

    /**
     * Starts the embedded QR camera surface after an explicit user action.
     * Any stale pasted bearer link is cleared first, while an unavailable camera leaves the local image-decoding fallback visible.
     * @returns {Promise<void>}
     */
    async startCapabilityScanner() {
        this.elements.workspaceCapabilityLinkInput.value = "";
        await this.capabilityScanner.start();
    }

    /**
     * Stops camera and worker activity and returns Workspace settings to its ordinary add form.
     * @returns {void}
     */
    closeCapabilityScanner() {
        this.capabilityScanner.close();
    }

    /**
     * Decodes a QR image selected from the embedded fallback control.
     * The decoded text is never rendered; it is handed directly to importCapabilityValue() and then removed with the file input value.
     * @param {File | null} file User-selected image, or null after picker cancellation.
     * @returns {Promise<void>}
     */
    async scanCapabilityImage(file) {
        await this.capabilityScanner.scanFile(file);
    }

    /**
     * Parses one pasted or scanned bearer link and imports it through the ordinary capability connection workflow.
     * Raw link text is removed from the DOM before validation or network access, preventing the credential fragment from lingering in controls, screenshots, or later diagnostics.
     * @param {unknown} value Candidate capability URL.
     * @returns {Promise<boolean>} Whether a valid capability reached the workspace connection pipeline.
     */
    async importCapabilityValue(value) {
        const candidate = String(value || "").trim();
        this.elements.workspaceCapabilityLinkInput.value = "";
        this.closeCapabilityScanner();
        this.setError(this.elements.workspaceCapabilityErrorEl, "");
        if (!candidate) {
            this.setError(this.elements.workspaceCapabilityErrorEl, this.locale.t("workspace.capabilityRequired"));
            return false;
        }
        if (this.weekView.saveInFlight || this.todoView.saveInFlight || this.expenseView.saveInFlight) {
            this.setError(this.elements.workspaceCapabilityErrorEl, this.locale.t("toast.waitSaveSwitch"));
            return false;
        }
        try {
            this.runtime.capabilityImport = parseCapabilityLink(candidate, this.routeController.basePath);
            return await this.importCapability();
        } catch (error) {
            this.runtime.capabilityImport = null;
            this.setError(this.elements.workspaceCapabilityErrorEl, safeText(error));
            return false;
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
        const wasActive = connectionId === this.runtime.activeWorkspaceConnection?.id;
        const removed = this.runtime.workspaceRegistry.remove(connectionId);
        if (!removed) return;
        this.configService.clearWorkspaceCredential(connectionId);
        this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
        if (!wasActive) {
            this.renderWorkspaceRegistry();
            return;
        }
        this.runtime.activeWorkspaceConnection = null;
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
        if (!this.runtime.workspace) return;
        const route = this.buildWorkspaceShareRoute();
        if (!route.workspace) return;
        this.closeWorkspaceSettings("replace");
        this.elements.workspaceShareDetailsEl.textContent = this.describeWorkspaceLocator(route.workspace);
        this.elements.workspaceCopyCapabilityBtn.disabled = route.workspace.provider === "local";
        this.setError(
            this.elements.workspaceShareErrorEl,
            route.workspace.provider === "local" ? this.locale.t("workspace.localLocatorOnly") : "",
        );
        if (!this.elements.workspaceShareDialog.open) this.elements.workspaceShareDialog.showModal();
    }

    /**
     * Closes the share dialog and clears transient error feedback.
     * @returns {void}
     */
    closeWorkspaceShareDialog() {
        this.setError(this.elements.workspaceShareErrorEl, "");
        if (this.elements.workspaceShareDialog.open) this.elements.workspaceShareDialog.close();
    }

    /**
     * Copies a credential-free route to the active workspace and underlying component state.
     * @returns {Promise<void>}
     */
    async copyActiveWorkspaceLink() {
        if (!this.runtime.workspace) return;
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
     * Creates and copies a bearer-capability link with the active workspace credential already held by this browser.
     * OAuth credentials are refreshed through the ordinary credential service before encoding, while local workspaces remain ineligible because they do not represent transferable repository authority.
     * Clipboard failure never falls back to a visible prompt, avoiding accidental on-screen disclosure of the encoded bearer payload.
     * @returns {Promise<void>}
     */
    async copyActiveCapabilityLink() {
        this.setError(this.elements.workspaceShareErrorEl, "");
        try {
            const connection = this.runtime.activeWorkspaceConnection;
            if (!connection || connection.provider === "local") {
                throw new Error(this.locale.t("workspace.capabilityHostedOnly"));
            }
            const token = (await this.loadUsableWorkspaceCredential(connection)) || this.runtime.token;
            if (!token) throw new Error(this.locale.t("workspace.capabilityCredentialMissing"));
            const link = formatCapabilityLink(
                this.buildWorkspaceShareRoute(),
                token,
                window.location.origin,
                this.routeController.basePath,
            );
            await navigator.clipboard.writeText(link);
            this.toast(this.locale.t("workspace.capabilityCopied"), 4500, "success");
        } catch (error) {
            this.setError(this.elements.workspaceShareErrorEl, safeText(error));
        }
    }

    /**
     * Imports a scrubbed capability without interrupting the recipient with a confirmation dialog.
     * The validated locator enters the ordinary workspace registry, its bearer credential is remembered on this device, and the requested component route is restored through the shared connection pipeline.
     * Responsibility for choosing a dedicated, appropriately scoped token remains with the person who creates and shares the capability link.
     * @returns {Promise<boolean>} Whether a capability was available and handed to the connection pipeline.
     */
    async importCapability() {
        const capability = this.runtime.capabilityImport;
        const locator = capability?.route.workspace || null;
        if (!capability || !locator) return false;
        const connection = this.runtime.workspaceRegistry.upsert(locator, {
            expectedWorkspaceId: locator.expectedWorkspaceId,
        });
        this.configService.saveWorkspaceCredential(connection.id, capability.credential, true);
        this.configService.saveWorkspaceRegistry(this.runtime.workspaceRegistry);
        const connectionInfo = this.runtime.workspace
            ? await this.preflightWorkspaceConnection(connection, capability.credential)
            : null;
        await Promise.all([
            this.weekView.flushDraftWrites(),
            this.todoView.flushDraftWrites(),
            this.expenseView.flushDraftWrites(),
        ]);
        this.activateWorkspaceConnection(connection, capability.credential);
        this.runtime.pendingRoute = capability.route;
        this.runtime.capabilityImport = null;
        this.closeWorkspaceSettings("none");
        await this.connectWithToken(this.runtime.token, connectionInfo);
        return true;
    }

    /**
     * Builds the IndexedDB namespace used for unsaved week drafts.
     * Browser origins already isolate local servers, while GitHub mode additionally separates owner, repository, and branch.
     * @returns {string}
     */
    buildDraftNamespace() {
        return buildWorkspaceDraftNamespace(
            this.isLocalMode,
            this.runtime.activeWorkspaceConnection,
            this.runtime.workspace,
            this.runtime.config,
        );
    }

    /**
     * Returns the public locator for the active local folder or hosted Git repository.
     * The expected workspace id is included only after zeitberg.json has loaded; credentials are held separately and can never enter this object.
     * @returns {import("./routing.js").WorkspaceRouteLocator}
     */
    getCurrentWorkspaceRouteLocator() {
        if (this.isLocalMode) {
            return {
                provider: "local",
                repositoryUrl: "",
                ref: "",
                workspacePath: this.runtime.config.workspacePath || "zeitberg.json",
                expectedWorkspaceId:
                    this.runtime.workspace?.workspace_id ||
                    this.runtime.activeWorkspaceConnection?.expectedWorkspaceId ||
                    String(this.runtime.config.localWorkspaceId || ""),
            };
        }
        if (this.runtime.activeWorkspaceConnection) {
            return {
                ...this.runtime.activeWorkspaceConnection.toLocator(),
                expectedWorkspaceId: this.runtime.workspace?.workspace_id || this.runtime.activeWorkspaceConnection.expectedWorkspaceId || "",
            };
        }
        return {
            provider: /** @type {import("./routing.js").WorkspaceRouteLocator["provider"]} */ (
                this.runtime.config.provider || "github"
            ),
            repositoryUrl:
                this.runtime.config.repositoryUrl || formatGitHubRepositoryUrl(this.runtime.config.owner, this.runtime.config.repo),
            ref: this.runtime.config.ref,
            workspacePath: this.runtime.config.workspacePath || "zeitberg.json",
            expectedWorkspaceId: this.runtime.workspace?.workspace_id || "",
        };
    }

}
