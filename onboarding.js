import { inferHostedProvider } from "./config.js";
import { RepositoryDiscovery } from "./repository.discovery.js";
import { GITHUB_CLIENT_ID, GITHUB_RELAY_URL, GitHubDeviceFlow, readOAuthClientId, startOAuthAuthorization } from "./oauth.js";
import { parseAppRoute } from "./routing.js";
import { createMaterialIcon, getRequiredElement, safeText } from "./utils.js";
import { buildHostedWorkspaceLocator } from "./workspace.js";

/**
 * Owns provider-first welcome actions and the repository chooser. Authorization is
 * held in memory until a concrete connection is selected, or borrowed from an
 * existing connection through the shared refresh pipeline. Repository writes and
 * workspace loading remain with the existing workspace controller.
 */
export class OnboardingController {
    /**
     * Binds the welcome cards and chooser to the composed application.
     * @param {import("./app.js").App} app Application facade supplying connection, locale, and shell services.
     */
    constructor(app) {
        this.app = app;
        this.dialog = getRequiredElement("providerChooser", HTMLDialogElement);
        this.error = getRequiredElement("providerChooserError", HTMLElement);
        this.title = getRequiredElement("providerChooserTitle", HTMLElement);
        this.authorizeForm = getRequiredElement("providerAuthorizeForm", HTMLFormElement);
        this.token = getRequiredElement("providerToken", HTMLInputElement);
        this.remember = getRequiredElement("providerRemember", HTMLInputElement);
        this.repositories = getRequiredElement("providerRepositories", HTMLElement);
        this.search = getRequiredElement("providerRepositorySearch", HTMLInputElement);
        this.onlyWorkspaces = getRequiredElement("providerWorkspacesOnly", HTMLInputElement);
        this.list = getRequiredElement("providerRepositoryList", HTMLElement);
        this.status = getRequiredElement("providerScanStatus", HTMLElement);
        this.sessionPanel = getRequiredElement("providerSession", HTMLElement);
        this.sessionNote = getRequiredElement("providerSessionNote", HTMLElement);
        this.more = getRequiredElement("providerLoadMore", HTMLButtonElement);
        this.addSelected = getRequiredElement("providerAddSelected", HTMLButtonElement);
        /** @type {Set<string>} Canonical repository/ref locators selected across scan pages. */
        this.selectedRepositories = new Set();
        this.createForm = getRequiredElement("providerCreateForm", HTMLFormElement);
        this.newButton = getRequiredElement("providerNewWorkspace", HTMLButtonElement);
        this.githubAccess = getRequiredElement("providerGitHubAccess", HTMLElement);
        this.githubAccessNote = getRequiredElement("providerGitHubAccessNote", HTMLElement);
        this.accessPending = false;
        this.linkDialog = getRequiredElement("workspaceLinkDialog", HTMLDialogElement);
        this.linkValue = getRequiredElement("workspaceLinkValue", HTMLInputElement);
        this.linkError = getRequiredElement("workspaceLinkError", HTMLElement);
        this.provider = "";
        this.accessToken = "";
        /** @type {import("./oauth.js").OAuthCredential | null} */
        this.credential = null;
        /** @type {RepositoryDiscovery | null} */
        this.discovery = null;
        /** @type {import("./repository.discovery.js").DiscoveredRepository[]} */
        this.items = [];
        this.page = 0;
        this.busy = false;
        this.scanning = false;
        /** @type {AbortController | null} */
        this.deviceAuthorization = null;
        /** @type {import("./oauth.js").OAuthIntent | null} */
        this.connectionIntent = null;
        /** @type {import("./config.js").WorkspaceConnection | null} Existing grant owner, never a copied refresh token. */
        this.authorizationConnection = null;
        this.authorizationRevision = 0;
        this.devicePanel = getRequiredElement("githubDevicePanel", HTMLElement);
        this.deviceCode = getRequiredElement("githubDeviceCode", HTMLInputElement);
        getRequiredElement("githubDeviceCopy", HTMLButtonElement).addEventListener("click", () => {
            void navigator.clipboard.writeText(this.deviceCode.value).catch(() => { this.deviceCode.focus(); this.deviceCode.select(); });
        });

        this.mountConnectionCards();
        for (const dialog of document.querySelectorAll(".connection-dialog")) {
            if (!(dialog instanceof HTMLDialogElement)) continue;
            dialog.querySelector("[data-connection-close]")?.addEventListener("click", () => dialog.close());
        }
        getRequiredElement("workspaceQrDialog", HTMLDialogElement).addEventListener("close", () => {
            this.app.workspaceController.closeCapabilityScanner();
        });
        getRequiredElement("providerSwitchAccount", HTMLButtonElement).addEventListener("click", () => {
            this.open(this.provider, null, false);
        });
        getRequiredElement("workspaceLinkClose", HTMLButtonElement).addEventListener("click", () => this.linkDialog.close());
        this.linkDialog.addEventListener("close", () => { this.linkValue.value = ""; });
        getRequiredElement("workspaceLinkForm", HTMLFormElement).addEventListener("submit", (event) => {
            event.preventDefault();
            void this.openLink();
        });
        getRequiredElement("providerChooserClose", HTMLButtonElement).addEventListener("click", () => this.dialog.close());
        this.dialog.addEventListener("cancel", (event) => { if (this.busy) event.preventDefault(); });
        this.dialog.addEventListener("close", () => this.clear());
        this.authorizeForm.addEventListener("submit", (event) => { event.preventDefault(); void this.authorize(); });
        this.search.addEventListener("input", () => this.render());
        this.onlyWorkspaces.addEventListener("change", () => this.render());
        this.more.addEventListener("click", () => void this.scanMore());
        this.addSelected.addEventListener("click", () => void this.connectSelected());
        getRequiredElement("providerRefresh", HTMLButtonElement).addEventListener("click", () => void this.browse());
        getRequiredElement("providerGitHubInstall", HTMLAnchorElement).addEventListener("click", () => { this.accessPending = true; });
        window.addEventListener("focus", () => this.refreshAfterAccess());
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") this.refreshAfterAccess();
        });
        this.newButton.addEventListener("click", () => {
            this.repositories.hidden = true;
            this.createForm.hidden = false;
            this.title.textContent = this.app.locale.t("workspace.createTitle");
            getRequiredElement("providerChooserNote", HTMLElement).textContent = this.app.locale.t("onboarding.createNote");
            getRequiredElement("providerRepositoryName", HTMLInputElement).focus();
        });
        getRequiredElement("providerCreateBack", HTMLButtonElement).addEventListener("click", () => {
            this.createForm.hidden = true;
            this.repositories.hidden = false;
            this.title.textContent = this.app.locale.t(`onboarding.${this.provider}`);
            getRequiredElement("providerChooserNote", HTMLElement).textContent = this.app.locale.t("onboarding.chooserNote");
            this.app.shell.setError(this.error, "");
            this.search.focus();
        });
        this.createForm.addEventListener("submit", (event) => { event.preventDefault(); void this.create(); });
    }

    /** Releases chooser credentials and invalidates outstanding read-only scans. @returns {void} */
    clear() {
        this.authorizationRevision = (this.authorizationRevision || 0) + 1;
        this.authorizationConnection = null;
        this.deviceAuthorization?.abort();
        this.deviceAuthorization = null;
        this.connectionIntent = null;
        this.accessPending = false;
        if (this.devicePanel) this.devicePanel.hidden = true;
        if (this.deviceCode) this.deviceCode.value = "";
        this.discovery?.cancel();
        this.discovery = null;
        this.scanning = false;
        this.credential = null;
        this.accessToken = "";
        this.token.value = "";
        this.items = [];
        this.selectedRepositories?.clear();
        this.list.replaceChildren();
    }

    /**
     * Opens a provider-specific explanation before leaving the app for consent.
     * GitHub uses device authorization when its deployment relay is configured;
     * the advanced connection form remains available for repository-scoped PATs.
     * @param {string} provider Public provider identifier.
     * @param {import("./oauth.js").OAuthIntent | null} [intent] Optional existing connection to reconnect instead of browsing.
     * @param {boolean} [reuseAuthorization] Reuse a connected workspace's OAuth grant; explicit reconnect/account changes bypass reuse.
     * @returns {void}
     */
    open(provider, intent = null, reuseAuthorization = true) {
        this.clear();
        this.connectionIntent = intent;
        this.provider = provider;
        this.page = 0;
        this.search.value = "";
        this.remember.checked = intent?.remember || false;
        this.onlyWorkspaces.checked = true;
        this.authorizeForm.hidden = false;
        this.repositories.hidden = true;
        this.createForm.hidden = true;
        this.app.shell.setError(this.error, "");
        this.title.textContent = this.app.locale.t(`onboarding.${provider}`);
        getRequiredElement("providerChooserNote", HTMLElement).textContent = this.app.locale.t("onboarding.chooserNote");
        const isGitHub = provider === "github";
        const useToken = isGitHub && !GITHUB_RELAY_URL;
        getRequiredElement("providerTokenField", HTMLElement).hidden = !useToken;
        this.token.required = useToken;
        getRequiredElement("providerAuthorizeNote", HTMLElement).textContent = this.app.locale.t(isGitHub ? useToken ? "onboarding.githubHelp" : "onboarding.githubDeviceHelp" : provider === "codeberg" ? "workspace.codebergScope" : "workspace.gitlabScope");
        getRequiredElement("providerAuthorize", HTMLButtonElement).textContent = this.app.locale.t(useToken ? "onboarding.scanRepos" : "onboarding.authorize");
        this.newButton.hidden = useToken;
        this.githubAccess.hidden = true;
        this.sessionPanel.hidden = true;
        getRequiredElement("providerWorkspaceName", HTMLInputElement).value = this.app.locale.t("onboarding.newName");
        getRequiredElement("providerTimezone", HTMLInputElement).value = this.app.config.timezone || "Europe/Berlin";
        this.setBusy(false);
        if (!this.dialog.open) this.dialog.showModal();
        if (useToken) this.token.focus();
        else getRequiredElement("providerAuthorize", HTMLButtonElement).focus();
        if (reuseAuthorization && !intent) void this.reuseAuthorization();
    }

    /**
     * Finds an OAuth authorization belonging to this public provider and application.
     * PATs and self-hosted connections are deliberately excluded; repository-scoped
     * credentials must not silently become provider-wide discovery credentials.
     * @returns {import("./config.js").WorkspaceConnection | null} First matching registered grant owner.
     */
    findAuthorizationConnection() {
        const clientId = this.provider === "github" ? GITHUB_CLIENT_ID : readOAuthClientId(document, this.provider);
        return this.app.workspaceRegistry.list().find((connection) => {
            if (connection.provider !== this.provider) return false;
            const record = this.app.configService.loadWorkspaceCredentialRecord(connection.id);
            return record?.kind === "oauth" && record.provider === this.provider && record.clientId === clientId;
        }) || null;
    }

    /**
     * Refreshes a reused authorization through the same serialized grant store as
     * workspace loading. Late results cannot repopulate a closed/replaced chooser.
     * @returns {Promise<boolean>} Whether the current chooser still owns a usable authorization.
     */
    async refreshAuthorization() {
        const connection = this.authorizationConnection;
        if (!connection) return true;
        const revision = this.authorizationRevision;
        const token = await this.app.workspaceController.loadUsableWorkspaceCredential(connection);
        if (revision !== this.authorizationRevision) return false;
        const record = this.app.configService.loadWorkspaceCredentialRecord(connection.id);
        if (!token || record?.kind !== "oauth" || record.provider !== this.provider) {
            throw new Error(this.app.locale.t("onboarding.sessionUnavailable"));
        }
        this.credential = /** @type {import("./oauth.js").OAuthCredential} */ (record);
        this.accessToken = token;
        return true;
    }

    /**
     * Opens discovery using an existing grant without a new consent round trip.
     * Refresh failures leave an explicit authorization action and do not discard
     * credentials belonging to other workspace connections.
     * @returns {Promise<void>}
     */
    async reuseAuthorization() {
        const connection = this.findAuthorizationConnection();
        if (!connection) return;
        const revision = this.authorizationRevision;
        this.authorizationConnection = connection;
        this.remember.checked = this.app.configService.isWorkspaceCredentialRemembered(connection.id);
        this.authorizeForm.hidden = true;
        const panel = this.sessionPanel;
        const note = this.sessionNote;
        panel.hidden = false;
        note.textContent = this.app.locale.t("onboarding.reusingSession", { workspace: connection.displayName });
        try {
            if (!await this.refreshAuthorization()) return;
            await this.browse();
        } catch (error) {
            if (revision !== this.authorizationRevision) return;
            this.authorizationConnection = null;
            this.credential = null;
            this.accessToken = "";
            panel.hidden = true;
            this.authorizeForm.hidden = false;
            this.app.shell.setError(this.error, safeText(error));
        }
    }

    /**
     * Reuses the welcome cards' markup and handlers in workspace management.
     * Clones omit the welcome-only playground and carry no duplicate IDs; both surfaces keep identical labels, logos,
     * keyboard behavior, and provider workflows as the welcome screen evolves.
     * @returns {void}
     */
    mountConnectionCards() {
        const welcome = getRequiredElement("setupCards", HTMLElement);
        const management = getRequiredElement("workspaceSetupCards", HTMLElement);
        const copy = /** @type {HTMLElement} */ (welcome.cloneNode(true));
        copy.querySelector(".setup-playground")?.remove();
        for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
        management.replaceChildren(...copy.childNodes);
        for (const surface of [welcome, management]) {
            surface.addEventListener("click", (event) => {
                const button = event.target instanceof Element ? event.target.closest("button") : null;
                if (!button) return;
                if (button.dataset.provider) this.open(button.dataset.provider);
                else if (button.dataset.setupAction === "custom") this.showCustom();
                else if (button.dataset.setupAction === "link") {
                    this.app.shell.setError(this.linkError, "");
                    this.linkDialog.showModal();
                    this.linkValue.focus();
                } else if (button.dataset.setupAction === "scan") {
                    void this.app.workspaceController.startCapabilityScanner();
                }
            });
        }
    }

    /**
     * Starts PKCE with a repository-free intent, or scans using a supplied GitHub PAT.
     * @returns {Promise<void>}
     */
    async authorize() {
        if (this.deviceAuthorization) return;
        this.app.shell.setError(this.error, "");
        try {
            if (this.provider === "github" && GITHUB_RELAY_URL) {
                const authorization = new AbortController();
                this.deviceAuthorization = authorization;
                const intent = this.connectionIntent;
                const remember = this.remember.checked;
                this.authorizeForm.hidden = true;
                this.devicePanel.hidden = false;
                this.deviceCode.value = "";
                this.devicePanel.setAttribute("aria-busy", "true");
                getRequiredElement("githubDeviceControls", HTMLElement).hidden = true;
                getRequiredElement("githubDeviceStatus", HTMLElement).textContent = this.app.locale.t("onboarding.deviceStarting");
                try {
                    const credential = await new GitHubDeviceFlow().authorize((code) => {
                        this.deviceCode.value = code;
                        this.devicePanel.setAttribute("aria-busy", "false");
                        getRequiredElement("githubDeviceControls", HTMLElement).hidden = false;
                        getRequiredElement("githubDeviceStatus", HTMLElement).textContent = this.app.locale.t("onboarding.deviceWaiting");
                        getRequiredElement("githubDeviceOpen", HTMLAnchorElement).focus();
                    }, authorization.signal);
                    if (this.deviceAuthorization !== authorization || authorization.signal.aborted) return;
                    this.deviceAuthorization = null;
                    this.devicePanel.hidden = true;
                    this.deviceCode.value = "";
                    if (intent) {
                        this.dialog.close();
                        await this.app.workspaceController.handleOAuthCallbackResult({ credential, intent: { ...intent, remember } });
                    } else {
                        this.credential = credential;
                        this.accessToken = credential.accessToken;
                        await this.browse();
                    }
                } catch (error) {
                    if (authorization.signal.aborted) return;
                    if (this.deviceAuthorization === authorization) {
                        this.deviceAuthorization = null;
                        this.devicePanel.hidden = true;
                        this.deviceCode.value = "";
                        this.authorizeForm.hidden = false;
                    }
                    throw error;
                }
            } else if (this.provider === "github") {
                this.accessToken = this.token.value.trim();
                this.token.value = "";
                await this.browse();
            } else {
                if ([...this.app.sessions.sessions.values()].some((session) => session.dirty || session.saving)) {
                    throw new Error(this.app.locale.t("workspace.saveBeforeReconnect"));
                }
                await startOAuthAuthorization(window, this.provider, readOAuthClientId(document, this.provider), {
                    mode: "browse", repositoryUrl: "", ref: "main", workspacePath: "zeitberg.json", remember: this.remember.checked,
                }, this.app.routeController.basePath);
            }
        } catch (error) {
            this.app.shell.setError(this.error, safeText(error));
        }
    }

    /**
     * Resumes provider-first onboarding after OAuth has validated and scrubbed the callback.
     * @param {import("./oauth.js").OAuthCallbackResult} result Scrubbed OAuth result.
     * @returns {Promise<void>}
     */
    async resume(result) {
        this.app.shell.showLoginScreen();
        this.open(result.credential.provider, null, false);
        this.credential = result.credential;
        this.accessToken = result.credential.accessToken;
        this.remember.checked = result.intent.remember;
        await this.browse();
    }

    /** Starts a fresh paged scan with the just-authorized in-memory credential. @returns {Promise<void>} */
    async browse() {
        if (this.busy || !this.accessToken) return;
        this.discovery?.cancel();
        this.page = 0;
        this.items = [];
        this.list.replaceChildren();
        this.scanning = false;
        this.authorizeForm.hidden = true;
        this.repositories.hidden = false;
        this.discovery = new RepositoryDiscovery(this.app.config, this.provider, this.accessToken, this.credential?.provider === "github");
        this.renderGitHubAccess();
        await this.scanMore();
    }

    /** Restarts discovery after returning from explicit GitHub access setup, without reauthorizing. @returns {void} */
    refreshAfterAccess() {
        if (!this.accessPending || !this.dialog.open || this.busy || this.repositories.hidden) return;
        this.accessPending = false;
        void this.browse();
    }

    /** Explains installation access independently of authorization and repository filtering. @returns {void} */
    renderGitHubAccess() {
        if (!this.githubAccess) return;
        const github = this.credential?.provider === "github";
        this.githubAccess.hidden = !github;
        if (!github) return;
        const count = this.discovery?.installations?.length;
        this.githubAccessNote.textContent = this.app.locale.t(count === 0 ? "onboarding.githubInstallNeeded" : "onboarding.githubAccessHelp");
        this.newButton.disabled = this.busy || count === undefined || count === 0;
    }

    /**
     * Scans all remaining pages automatically with bounded probe concurrency.
     * Errors stop the loop and offer an explicit retry without losing selections;
     * closing, adding, or replacing the chooser discards late results.
     * @returns {Promise<void>}
     */
    async scanMore() {
        const discovery = this.discovery;
        if (!discovery || this.busy || this.scanning) return;
        this.scanning = true;
        this.app.shell.setError(this.error, "");
        this.more.disabled = true;
        this.more.hidden = true;
        try {
            let hasMore = true;
            while (hasMore && this.discovery === discovery && !this.busy) {
                this.status.textContent = this.app.locale.t("onboarding.scanningCount", { count: this.items.length });
                if (!await this.refreshAuthorization() || this.discovery !== discovery) return;
                discovery.token = this.accessToken;
                const result = await discovery.scanPage(this.page + 1);
                if (this.discovery !== discovery) return;
                this.page++;
                const known = new Set(this.items.map((item) => item.repositoryUrl));
                this.items.push(...result.repositories.filter((item) => !known.has(item.repositoryUrl)));
                hasMore = result.hasMore;
                this.render();
                this.renderGitHubAccess();
            }
        } catch (error) {
            if (this.discovery !== discovery) return;
            this.app.shell.setError(this.error, safeText(error));
            this.status.textContent = this.app.locale.t("onboarding.scanFailed");
            this.more.hidden = false;
        } finally {
            if (this.discovery === discovery) {
                this.scanning = false;
                this.more.disabled = this.busy;
                if (this.more.hidden) this.render();
            }
        }
    }

    /** Filters loaded choices locally, retaining status icons and readable diagnostics. @returns {void} */
    render() {
        const focusedRepository = this.list.contains(document.activeElement) && document.activeElement instanceof HTMLElement
            ? document.activeElement.dataset.repository : "";
        const query = this.search.value.trim().toLocaleLowerCase();
        const visible = this.items.filter((item) => (!this.onlyWorkspaces.checked || item.status !== "missing") &&
            `${item.name} ${item.detail}`.toLocaleLowerCase().includes(query));
        this.list.replaceChildren();
        this.status.textContent = this.app.locale.t(this.scanning ? "onboarding.scanningCount" : "onboarding.results", { count: this.items.length, shown: visible.length, total: this.items.length });
        if (!visible.length) {
            const empty = document.createElement("p");
            empty.className = "muted";
            empty.textContent = this.app.locale.t("onboarding.empty");
            this.list.append(empty);
        }
        for (const item of visible) {
            const button = document.createElement("label");
            button.className = "provider-repository";
            const locator = buildHostedWorkspaceLocator(this.provider, item.repositoryUrl, item.ref, "zeitberg.json");
            const connected = Boolean(this.app.workspaceRegistry.findByLocator(locator));
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = connected || this.selectedRepositories.has(item.repositoryUrl);
            checkbox.disabled = connected || this.busy;
            checkbox.dataset.connected = String(connected);
            checkbox.dataset.repository = item.repositoryUrl;
            checkbox.setAttribute("aria-label", item.name);
            const icon = createMaterialIcon(item.status === "ready" ? "check_circle" : item.status === "attention" ? "warning" : "add");
            icon.classList.add(item.status === "ready" ? "is-ok" : "needs-attention");
            const text = document.createElement("span");
            const name = document.createElement("strong");
            name.textContent = item.name;
            const detail = document.createElement("small");
            detail.textContent = `${connected ? this.app.locale.t("onboarding.alreadyAdded") + " · " : ""}${item.ref} · ${item.detail || this.app.locale.t("onboarding.needsSetup")}`;
            text.append(name, detail);
            button.append(checkbox, icon, text);
            button.classList.toggle("is-connected", connected);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) this.selectedRepositories.add(item.repositoryUrl);
                else this.selectedRepositories.delete(item.repositoryUrl);
                this.renderSelection();
            });
            this.list.append(button);
            if (focusedRepository === item.repositoryUrl) checkbox.focus({ preventScroll: true });
        }
        this.renderSelection();
    }

    /** Updates the batch action without replacing the focused repository checkbox. @returns {void} */
    renderSelection() {
        const count = this.items.filter((item) => this.selectedRepositories.has(item.repositoryUrl) &&
            !this.app.workspaceRegistry.findByLocator(buildHostedWorkspaceLocator(this.provider, item.repositoryUrl, item.ref, "zeitberg.json"))).length;
        this.addSelected.disabled = this.busy || count === 0;
        this.addSelected.textContent = this.app.locale.t(count ? "onboarding.addCount" : "onboarding.addSelected", { count });
    }

    /**
     * Registers the complete selection before loading anything. Existing connections
     * and their credentials are untouched; new connections borrow the shared grant.
     * Loading uses isolated sessions rather than overwriting the mounted document.
     * @returns {Promise<void>}
     */
    async connectSelected() {
        if (this.busy) return;
        this.setBusy(true);
        const discovery = this.discovery;
        this.discovery = null;
        discovery?.cancel();
        this.scanning = false;
        try {
            if (!await this.refreshAuthorization()) return;
            const connections = [];
            for (const item of this.items) {
                if (!this.selectedRepositories.has(item.repositoryUrl)) continue;
                const locator = buildHostedWorkspaceLocator(this.provider, item.repositoryUrl, item.ref, "zeitberg.json");
                if (this.app.workspaceRegistry.findByLocator(locator)) continue;
                const connection = this.app.workspaceRegistry.upsert(locator);
                if (this.credential) this.app.configService.saveWorkspaceOAuthCredential(connection.id, this.credential, this.remember.checked);
                else this.app.configService.saveWorkspaceCredential(connection.id, this.accessToken, this.remember.checked);
                connections.push(connection);
            }
            this.app.configService.saveWorkspaceRegistry(this.app.workspaceRegistry);
            this.dialog.close();
            this.app.workspaceController.closeWorkspaceSettings("none");
            await this.app.sessions.addConnections(connections);
        } catch (error) {
            if (!this.dialog.open) this.dialog.showModal();
            this.app.shell.setError(this.error, safeText(error));
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * Prevents duplicate repository writes and accidental dismissal during a write.
     * Read-only scanning keeps the close action available.
     * @param {boolean} busy Whether a create/connect action is running.
     * @returns {void}
     */
    setBusy(busy) {
        this.busy = busy;
        for (const element of this.dialog.querySelectorAll("button, input")) {
            if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) element.disabled = busy || element.dataset.connected === "true";
        }
        this.dialog.setAttribute("aria-busy", String(busy));
        this.renderGitHubAccess();
        this.renderSelection();
    }

    /**
     * Registers a selected repository through the canonical authentication/load pipeline.
     * @param {import("./repository.discovery.js").DiscoveredRepository} item Selected repository.
     * @returns {Promise<void>}
     */
    async connect(item) {
        if (this.busy) return;
        this.setBusy(true);
        try {
            if (!await this.refreshAuthorization()) return;
            const token = this.accessToken;
            const credential = this.credential;
            const remember = this.remember.checked;
            // Close before loading so the aggregate loading screen and setup dialogs are unobscured.
            this.dialog.close();
            if (credential) {
                await this.app.workspaceController.handleOAuthCallbackResult({ credential, intent: {
                    mode: "connect", repositoryUrl: item.repositoryUrl, ref: item.ref, workspacePath: "zeitberg.json", remember,
                } });
            } else {
                const locator = buildHostedWorkspaceLocator(this.provider, item.repositoryUrl, item.ref, "zeitberg.json");
                const connection = this.app.workspaceRegistry.upsert(locator);
                this.app.configService.saveWorkspaceCredential(connection.id, token, remember);
                this.app.configService.saveWorkspaceRegistry(this.app.workspaceRegistry);
                await this.app.workspaceController.switchWorkspace(connection.id);
            }
        } catch (error) {
            this.app.shell.showLoginScreen();
            this.app.shell.setError(this.app.loginErrorEl, safeText(error));
        } finally {
            this.setBusy(false);
        }
    }

    /** Creates a private workspace with the same grant, without asking for a token again. @returns {Promise<void>} */
    async create() {
        if (this.busy || !this.credential) return;
        this.setBusy(true);
        this.app.shell.setError(this.error, "");
        const previousProgress = this.app.workspaceController.creationProgress;
        const progress = getRequiredElement("providerCreateStatus", HTMLElement);
        this.app.workspaceController.creationProgress = (message) => { progress.textContent = message; };
        try {
            if (!await this.refreshAuthorization()) return;
            await this.app.workspaceController.createAndOpenWorkspace(
                this.credential.provider,
                getRequiredElement("providerRepositoryName", HTMLInputElement).value,
                getRequiredElement("providerWorkspaceName", HTMLInputElement).value,
                getRequiredElement("providerTimezone", HTMLInputElement).value,
                this.accessToken, this.remember.checked, this.credential,
                [...this.createForm.querySelectorAll("input[name='component']:checked")].map((input) => /** @type {HTMLInputElement} */ (input).value),
            );
            this.dialog.close();
        } catch (error) {
            this.app.shell.setError(this.error, safeText(error));
        } finally {
            this.app.workspaceController.creationProgress = previousProgress;
            this.setBusy(false);
        }
    }

    /** Opens the existing connection form in its own modal, retaining the underlying surface. @returns {void} */
    showCustom() {
        if (this.app.workspaceDialog.open) {
            getRequiredElement("workspaceManualConnection", HTMLDialogElement).showModal();
            this.app.workspaceRepositoryInput.focus();
            return;
        }
        getRequiredElement("customConnection", HTMLDialogElement).showModal();
        this.app.repositoryInput.focus();
    }

    /**
     * Routes invitation URLs through the existing capability parser; plain repo URLs
     * fill the advanced form without navigating to an arbitrary pasted website.
     * @returns {Promise<void>}
     */
    async openLink() {
        const candidate = this.linkValue.value.trim();
        this.linkValue.value = "";
        this.app.shell.setError(this.linkError, "");
        try {
            const url = new URL(candidate);
            if (parseInvitationLink(candidate, this.app.routeController.basePath, window.location.origin)) {
                this.linkDialog.close();
                this.app.workspaceController.openWorkspaceSettings("none");
                await this.app.workspaceController.importCapabilityValue(candidate);
                return;
            }
            const route = parseAppRoute(url, this.app.routeController.basePath);
            if (route.workspace) {
                if (url.hash) {
                    this.linkDialog.close();
                    this.app.workspaceController.openWorkspaceSettings("none");
                    await this.app.workspaceController.importCapabilityValue(candidate);
                } else {
                    this.app.pendingRoute = route;
                    this.fillConnection(route.workspace);
                    this.app.workspaceController.refreshOAuthControls();
                    this.linkDialog.close();
                    this.showCustom();
                }
                return;
            }
            const provider = inferHostedProvider(candidate);
            buildHostedWorkspaceLocator(provider, candidate, "main", "zeitberg.json");
            this.app.pendingRoute = null;
            this.fillConnection({ provider, repositoryUrl: candidate, ref: "main", workspacePath: "zeitberg.json" });
            this.app.workspaceController.refreshOAuthControls();
            this.linkDialog.close();
            this.showCustom();
        } catch (error) {
            this.app.shell.setError(this.linkError, safeText(error));
        }
    }

    /**
     * Fills the manual form on the surface that opened the URL dialog, so adding
     * a repository inside the app never focuses controls on the hidden welcome page.
     * @param {{provider: string, repositoryUrl: string, ref: string, workspacePath: string}} locator Validated repository locator.
     * @returns {void}
     */
    fillConnection(locator) {
        const settings = this.app.workspaceDialog.open;
        (settings ? this.app.workspaceProviderInput : this.app.providerInput).value = locator.provider;
        (settings ? this.app.workspaceRepositoryInput : this.app.repositoryInput).value = locator.repositoryUrl;
        (settings ? this.app.workspaceRefInput : this.app.refInput).value = locator.ref;
        (settings ? this.app.workspacePathInput : this.app.loginWorkspacePathInput).value = locator.workspacePath;
    }
}
import { parseInvitationLink } from "./invitations.js";
