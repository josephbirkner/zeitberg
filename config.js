import { normalizeWorkspaceRouteLocator, workspaceRouteLocatorKey } from "./routing.js";

/**
 * @typedef {Object} AppConfig
 * @description Repository settings and user preferences for the viewer.
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref
 * @property {string} workspacePath
 * @property {string} [localWorkspaceId]
 * @property {"github" | "gitlab" | "codeberg" | "forgejo" | "custom" | "local"} [provider]
 * @property {string} [repositoryUrl]
 * @property {string} timezone
 * @property {number} uiZoom
 * @property {"auto" | "manual"} uiZoomMode
 * @property {"dark" | "light"} theme
 */

/**
 * @typedef {Object} WorkspaceCredentialRecord
 * @description Runtime representation of either a manually supplied provider token or a refreshable public-client OAuth grant.
 * @property {"token" | "oauth"} kind
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} [expiresAt]
 * @property {string} [provider]
 * @property {string} [clientId]
 * @property {string} [redirectUri]
 * @property {string} [tokenType]
 */

const OAUTH_CREDENTIAL_PREFIX = "oauth-v1:";

export const DEFAULT_CONFIG = {
    owner: "josephbirkner",
    repo: "zeitberg-data",
    provider: "github",
    repositoryUrl: "https://github.com/josephbirkner/zeitberg-data",
    ref: "main",
    workspacePath: "zeitberg.json",
    timezone: "Europe/Berlin",
    uiZoom: 1,
    uiZoomMode: "auto",
    theme: "dark",
};

/**
 * Infers one built-in provider from a full HTTPS repository URL.
 * Unknown hosts remain `custom` and therefore pass through explicit host trust plus GitLab/Forgejo CORS detection instead of receiving GitHub credentials accidentally.
 * @param {string} repositoryUrl User-entered repository browser URL.
 * @returns {"github" | "gitlab" | "codeberg" | "custom"}
 */
export function inferHostedProvider(repositoryUrl) {
    let url;
    try {
        url = new URL(String(repositoryUrl || "").trim());
    } catch {
        throw new Error("Enter a full HTTPS repository URL.");
    }
    if (url.protocol !== "https:") throw new Error("Repository URLs must use HTTPS.");
    const host = url.hostname.toLowerCase();
    if (host === "github.com") return "github";
    if (host === "gitlab.com") return "gitlab";
    if (host === "codeberg.org") return "codeberg";
    return "custom";
}

/**
 * Parses a GitHub repository locator into the owner and repository values used by the API data source.
 * The public connection form accepts the full HTTPS URL promised by the onboarding copy as well as the compact `owner/repo` form for experienced users.
 * Query strings, fragments, extra path segments, and non-GitHub hosts are rejected so a credential can never be redirected to an unexpected origin.
 * @param {string} value User-entered GitHub repository URL or `owner/repo` shorthand.
 * @returns {{owner: string, repo: string}}
 */
export function parseGitHubRepository(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Enter a GitHub workspace repository URL.");

    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
        let url;
        try {
            url = new URL(raw);
        } catch {
            throw new Error("Enter a valid GitHub repository URL.");
        }
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
            throw new Error("The current connector accepts HTTPS github.com repository URLs.");
        }
        if (url.search || url.hash) throw new Error("The repository URL must not contain a query or fragment.");
        path = url.pathname;
    }

    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) throw new Error("Use a repository URL such as https://github.com/you/zeitberg-data.");
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    const segmentPattern = /^[A-Za-z0-9_.-]+$/;
    if (!segmentPattern.test(owner) || !segmentPattern.test(repo) || !repo) {
        throw new Error("The GitHub owner or repository name is invalid.");
    }
    return { owner, repo };
}

/**
 * Formats stored owner/repository configuration as the standard public connection URL.
 * @param {string} owner GitHub account or organization name.
 * @param {string} repo GitHub repository name.
 * @returns {string}
 */
export function formatGitHubRepositoryUrl(owner, repo) {
    return `https://github.com/${String(owner || "").trim()}/${String(repo || "").trim()}`;
}

/**
 * Returns the default application zoom for automatic mode.
 * Browser and operating-system page zoom already express the user's preferred physical size, so automatic mode deliberately leaves the application at its natural 100% scale on every viewport.
 * @returns {number}
 */
export function getRecommendedUiZoom() {
    return 1;
}

/**
 * Returns the horizontal CSS space available after applying the application's layout-affecting zoom.
 * Native media queries continue to see the unzoomed viewport, so this derived width is the shared breakpoint input for JavaScript and class-driven responsive styles.
 * @param {number} viewportWidth Width of the layout viewport in CSS pixels.
 * @param {number} uiZoom Current application zoom factor.
 * @returns {number}
 */
export function getEffectiveUiViewportWidth(viewportWidth, uiZoom) {
    const width = Number(viewportWidth);
    const zoom = Number(uiZoom);
    if (!Number.isFinite(width) || width <= 0) return 0;
    if (!Number.isFinite(zoom) || zoom <= 0) return width;
    return width / zoom;
}

const STORAGE_KEYS = {
    config: "zeitberg:config:v1",
    token: "zeitberg:token:v1",
    tokenRemembered: "zeitberg:token-remembered:v1",
    workspaceRegistry: "zeitberg:workspace-registry:v1",
    rememberedWorkspaceCredentials: "zeitberg:workspace-credentials:local:v1",
    sessionWorkspaceCredentials: "zeitberg:workspace-credentials:session:v1",
    locale: "zeitberg:locale:v1",
};

/**
 * @typedef {Object} WorkspaceConnectionMetadata
 * @description Optional user-facing metadata learned after a workspace repository has been opened.
 * @property {string} [displayName]
 * @property {string} [expectedWorkspaceId]
 */

/**
 * Represents one credential-free connection in the browser's workspace registry.
 * Its stable id derives only from provider/repository/ref/bootstrap coordinates; tokens are stored by ConfigService in a separate map keyed by that id.
 */
export class WorkspaceConnection {
    /**
     * Creates a normalized connection record.
     * Callers normally use fromLocator() or fromRaw() so repository and path validation remains centralized in the route locator model.
     * @param {import("./routing.js").WorkspaceRouteLocator} locator Public workspace coordinates.
     * @param {string} displayName Human-readable label shown in Workspace settings.
     * @param {number} order Persisted user-defined ordering index.
     */
    constructor(locator, displayName, order) {
        const normalized = normalizeWorkspaceRouteLocator(locator);
        if (!normalized) throw new Error("A valid workspace locator is required.");
        this.id = workspaceRouteLocatorKey(normalized);
        this.provider = normalized.provider;
        this.repositoryUrl = normalized.repositoryUrl;
        this.ref = normalized.ref;
        this.workspacePath = normalized.workspacePath;
        this.expectedWorkspaceId = normalized.expectedWorkspaceId;
        this.displayName = String(displayName || WorkspaceConnection.defaultDisplayName(normalized)).trim();
        this.order = Math.max(0, Math.round(Number(order) || 0));
    }

    /**
     * Derives a concise fallback label before zeitberg.json supplies the workspace's own name.
     * @param {import("./routing.js").WorkspaceRouteLocator} locator Validated locator.
     * @returns {string}
     */
    static defaultDisplayName(locator) {
        if (locator.provider === "local") return "Local workspace";
        try {
            const url = new URL(locator.repositoryUrl);
            return url.pathname.replace(/^\/+|\/+$/g, "") || url.hostname;
        } catch {
            return "Workspace";
        }
    }

    /**
     * Creates a registry record from a validated locator and optional learned metadata.
     * @param {import("./routing.js").WorkspaceRouteLocator} locator Public workspace coordinates.
     * @param {WorkspaceConnectionMetadata} [metadata] Display name and verified workspace identity.
     * @param {number} [order] Persisted ordering index.
     * @returns {WorkspaceConnection}
     */
    static fromLocator(locator, metadata = {}, order = 0) {
        const normalized = normalizeWorkspaceRouteLocator({
            ...locator,
            expectedWorkspaceId: metadata.expectedWorkspaceId ?? locator.expectedWorkspaceId,
        });
        if (!normalized) throw new Error("A valid workspace locator is required.");
        return new WorkspaceConnection(normalized, metadata.displayName || "", order);
    }

    /**
     * Parses one untrusted persisted registry row.
     * The stored id is intentionally ignored and recomputed, preventing stale or hand-edited ids from crossing credential namespaces.
     * @param {unknown} raw Candidate serialized row.
     * @returns {WorkspaceConnection}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workspace connection must be an object.");
        const value = /** @type {Record<string, unknown>} */ (raw);
        return WorkspaceConnection.fromLocator(
            {
                provider: /** @type {import("./routing.js").WorkspaceRouteLocator["provider"]} */ (value.provider),
                repositoryUrl: String(value.repository_url || ""),
                ref: String(value.ref || ""),
                workspacePath: String(value.workspace_path || "zeitberg.json"),
                expectedWorkspaceId: String(value.expected_workspace_id || ""),
            },
            { displayName: String(value.display_name || "") },
            Number(value.order),
        );
    }

    /**
     * Returns the credential-free locator consumed by routing and data-source selection.
     * @returns {import("./routing.js").WorkspaceRouteLocator}
     */
    toLocator() {
        return {
            provider: this.provider,
            repositoryUrl: this.repositoryUrl,
            ref: this.ref,
            workspacePath: this.workspacePath,
            expectedWorkspaceId: this.expectedWorkspaceId,
        };
    }

    /**
     * Serializes a registry row without credential material.
     * @returns {Object}
     */
    toObject() {
        return {
            display_name: this.displayName,
            expected_workspace_id: this.expectedWorkspaceId,
            id: this.id,
            order: this.order,
            provider: this.provider,
            ref: this.ref,
            repository_url: this.repositoryUrl,
            workspace_path: this.workspacePath,
        };
    }
}

/**
 * Models the ordered set of workspaces connected in one browser profile.
 * The registry is application-local configuration: it selects repositories but is never written into any workspace repository.
 */
export class WorkspaceRegistry {
    /**
     * Creates a normalized registry and resolves its active connection.
     * @param {WorkspaceConnection[]} connections Valid connection rows.
     * @param {string} activeWorkspaceId Selected connection id.
     */
    constructor(connections = [], activeWorkspaceId = "") {
        const deduplicated = new Map();
        for (const connection of connections) deduplicated.set(connection.id, connection);
        this.connections = Array.from(deduplicated.values()).sort(
            (left, right) => left.order - right.order || left.displayName.localeCompare(right.displayName),
        );
        this.reindex();
        this.activeWorkspaceId = this.connections.some((connection) => connection.id === activeWorkspaceId)
            ? activeWorkspaceId
            : this.connections[0]?.id || "";
        this.schemaVersion = 1;
    }

    /**
     * Parses the persisted registry, dropping malformed individual rows while preserving every valid connection.
     * @param {unknown} raw Candidate registry object.
     * @returns {WorkspaceRegistry}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new WorkspaceRegistry();
        const value = /** @type {Record<string, unknown>} */ (raw);
        if (Number(value.schema_version) !== 1) return new WorkspaceRegistry();
        const connections = [];
        for (const candidate of Array.isArray(value.workspaces) ? value.workspaces : []) {
            try {
                connections.push(WorkspaceConnection.fromRaw(candidate));
            } catch {
                // One malformed browser record must not make every other workspace unavailable.
            }
        }
        return new WorkspaceRegistry(connections, String(value.active_workspace_id || ""));
    }

    /**
     * Reassigns contiguous order values after insertion, removal, or movement.
     * @returns {void}
     */
    reindex() {
        this.connections.forEach((connection, index) => {
            connection.order = index;
        });
    }

    /**
     * Returns connections in their persisted display order.
     * @returns {WorkspaceConnection[]}
     */
    list() {
        return this.connections.slice();
    }

    /**
     * Finds a connection by its internal credential namespace id.
     * @param {string} id Connection id.
     * @returns {WorkspaceConnection | null}
     */
    getById(id) {
        return this.connections.find((connection) => connection.id === id) || null;
    }

    /**
     * Finds a registered connection with exactly the same provider/repository/ref/bootstrap coordinates.
     * Expected workspace identity is verification metadata and therefore does not alter locator matching.
     * @param {import("./routing.js").WorkspaceRouteLocator | null} locator Candidate route locator.
     * @returns {WorkspaceConnection | null}
     */
    findByLocator(locator) {
        if (!locator) return null;
        let key;
        try {
            key = workspaceRouteLocatorKey(
                locator.provider === "local" ? locator : { ...locator, expectedWorkspaceId: "" },
            );
        } catch {
            return null;
        }
        return this.connections.find((connection) => connection.id === key) || null;
    }

    /**
     * Returns the selected connection, if any.
     * @returns {WorkspaceConnection | null}
     */
    getActive() {
        return this.getById(this.activeWorkspaceId);
    }

    /**
     * Inserts a locator or updates metadata for its existing connection.
     * @param {import("./routing.js").WorkspaceRouteLocator} locator Public workspace coordinates.
     * @param {WorkspaceConnectionMetadata} [metadata] Newly learned name and identity.
     * @returns {WorkspaceConnection}
     */
    upsert(locator, metadata = {}) {
        const existing = this.findByLocator(locator);
        if (existing) {
            if (metadata.displayName) existing.displayName = String(metadata.displayName).trim();
            if (metadata.expectedWorkspaceId) existing.expectedWorkspaceId = String(metadata.expectedWorkspaceId).trim();
            return existing;
        }
        const connection = WorkspaceConnection.fromLocator(locator, metadata, this.connections.length);
        this.connections.push(connection);
        this.reindex();
        if (!this.activeWorkspaceId) this.activeWorkspaceId = connection.id;
        return connection;
    }

    /**
     * Selects a registered connection.
     * @param {string} id Connection id.
     * @returns {boolean} Whether the requested connection exists.
     */
    setActive(id) {
        if (!this.getById(id)) return false;
        this.activeWorkspaceId = id;
        return true;
    }

    /**
     * Removes a connection while leaving credentials to ConfigService's explicit cleanup step.
     * @param {string} id Connection id.
     * @returns {WorkspaceConnection | null} Removed connection.
     */
    remove(id) {
        const index = this.connections.findIndex((connection) => connection.id === id);
        if (index < 0) return null;
        const [removed] = this.connections.splice(index, 1);
        this.reindex();
        if (this.activeWorkspaceId === id) this.activeWorkspaceId = this.connections[0]?.id || "";
        return removed;
    }

    /**
     * Moves one connection one slot up or down in the registry.
     * @param {string} id Connection id.
     * @param {-1 | 1} direction Requested movement.
     * @returns {boolean} Whether ordering changed.
     */
    move(id, direction) {
        const index = this.connections.findIndex((connection) => connection.id === id);
        const target = index + (direction < 0 ? -1 : 1);
        if (index < 0 || target < 0 || target >= this.connections.length) return false;
        const [connection] = this.connections.splice(index, 1);
        this.connections.splice(target, 0, connection);
        this.reindex();
        return true;
    }

    /**
     * Serializes the browser registry without credentials.
     * @returns {Object}
     */
    toObject() {
        return {
            active_workspace_id: this.activeWorkspaceId,
            schema_version: this.schemaVersion,
            workspaces: this.connections.map((connection) => connection.toObject()),
        };
    }
}

/**
 * Manages local/session storage for config and tokens.
 * Keeps persistence concerns out of the main app controller.
 */
export class ConfigService {
    constructor() {
        this.storageKeys = { ...STORAGE_KEYS };
    }

    /**
     * Loads the application language preference independently from workspace and credential state.
     * Automatic mode follows the browser language and is represented by an absent storage record so first visits need no migration.
     * @returns {"auto" | "en" | "de"}
     */
    loadLocale() {
        const locale = String(localStorage.getItem(this.storageKeys.locale) || "").trim().toLowerCase();
        return locale === "en" || locale === "de" ? locale : "auto";
    }

    /**
     * Persists one explicit interface language or restores automatic browser-language selection.
     * The preference never enters workspace data; automatic mode removes the storage record and can therefore follow later browser changes.
     * @param {unknown} locale Requested language preference.
     * @returns {void}
     */
    saveLocale(locale) {
        const normalized = String(locale || "").trim().toLowerCase();
        if (normalized === "auto") {
            localStorage.removeItem(this.storageKeys.locale);
            return;
        }
        if (normalized !== "en" && normalized !== "de") throw new Error("Unsupported interface language.");
        localStorage.setItem(this.storageKeys.locale, normalized);
    }

    /**
     * Parses one credential map from browser storage.
     * Corrupt values are treated as empty and never leak into connection or route metadata.
     * @param {Storage} storage Browser storage area.
     * @param {string} key Storage key.
     * @returns {Object.<string, string>}
     */
    readCredentialMap(storage, key) {
        try {
            const parsed = JSON.parse(storage.getItem(key) || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            /** @type {Object.<string, string>} */
            const result = {};
            for (const [connectionId, credential] of Object.entries(parsed)) {
                if (typeof credential === "string" && credential) result[connectionId] = credential;
            }
            return result;
        } catch {
            return {};
        }
    }

    /**
     * Writes a credential map or removes its storage record when empty.
     * @param {Storage} storage Browser storage area.
     * @param {string} key Storage key.
     * @param {Object.<string, string>} credentials Credential values keyed by connection id.
     * @returns {void}
     */
    writeCredentialMap(storage, key, credentials) {
        if (Object.keys(credentials).length) storage.setItem(key, JSON.stringify(credentials));
        else storage.removeItem(key);
    }

    /**
     * Loads the browser's ordered workspace registry and upgrades a single-workspace configuration into one registry row when necessary.
     * Repository config becomes a row only when config or token state actually exists, so a first-time visitor is not connected to the developer's default workspace.
     * @param {AppConfig} [fallbackConfig] Already loaded single-workspace configuration.
     * @returns {WorkspaceRegistry}
     */
    loadWorkspaceRegistry(fallbackConfig = DEFAULT_CONFIG) {
        try {
            const raw = localStorage.getItem(this.storageKeys.workspaceRegistry);
            if (raw !== null) return WorkspaceRegistry.fromRaw(JSON.parse(raw));
        } catch {
            return new WorkspaceRegistry();
        }

        const hasSingleWorkspaceState =
            localStorage.getItem(this.storageKeys.config) !== null ||
            localStorage.getItem(this.storageKeys.token) !== null ||
            sessionStorage.getItem(this.storageKeys.token) !== null;
        if (!hasSingleWorkspaceState) return new WorkspaceRegistry();

        const config = { ...DEFAULT_CONFIG, ...fallbackConfig };
        const registry = new WorkspaceRegistry();
        const connection = registry.upsert({
            provider: "github",
            repositoryUrl: formatGitHubRepositoryUrl(config.owner, config.repo),
            ref: config.ref,
            workspacePath: config.workspacePath,
            expectedWorkspaceId: "",
        });
        registry.setActive(connection.id);
        this.saveWorkspaceRegistry(registry);

        const singleWorkspaceToken = this.loadToken();
        if (singleWorkspaceToken) {
            this.saveWorkspaceCredential(connection.id, singleWorkspaceToken, this.isTokenRemembered());
        }
        return registry;
    }

    /**
     * Persists the complete credential-free workspace registry.
     * @param {WorkspaceRegistry} registry Registry model to save.
     * @returns {void}
     */
    saveWorkspaceRegistry(registry) {
        localStorage.setItem(this.storageKeys.workspaceRegistry, JSON.stringify(registry.toObject()));
    }

    /**
     * Parses one stored credential value without exposing it to route or registry models.
     * Legacy/plain strings remain ordinary PAT records, while malformed OAuth envelopes are treated as absent instead of accidentally being sent as bearer tokens.
     * @param {string} storedValue Value from a credential map.
     * @returns {WorkspaceCredentialRecord | null}
     */
    parseWorkspaceCredential(storedValue) {
        const value = String(storedValue || "");
        if (!value) return null;
        if (!value.startsWith(OAUTH_CREDENTIAL_PREFIX)) return { kind: "token", accessToken: value };
        try {
            const parsed = JSON.parse(value.slice(OAUTH_CREDENTIAL_PREFIX.length));
            const accessToken = String(parsed?.access_token || "");
            const provider = String(parsed?.provider || "");
            const clientId = String(parsed?.client_id || "");
            const redirectUri = String(parsed?.redirect_uri || "");
            if (!accessToken || !provider || !clientId || !redirectUri) return null;
            return {
                kind: "oauth",
                accessToken,
                refreshToken: String(parsed?.refresh_token || ""),
                expiresAt: Number.isFinite(Number(parsed?.expires_at)) ? Number(parsed.expires_at) : 0,
                provider,
                clientId,
                redirectUri,
                tokenType: String(parsed?.token_type || "Bearer"),
            };
        } catch {
            return null;
        }
    }

    /**
     * Serializes one validated OAuth grant for the existing per-workspace credential map.
     * The envelope remains exclusively in browser credential storage and is never included in workspace metadata, routes, cache keys, or repository files.
     * @param {WorkspaceCredentialRecord} credential OAuth credential to persist.
     * @returns {string}
     */
    serializeWorkspaceOAuthCredential(credential) {
        if (credential.kind !== "oauth" || !credential.accessToken || !credential.provider || !credential.clientId || !credential.redirectUri) {
            throw new Error("The OAuth credential is incomplete.");
        }
        return `${OAUTH_CREDENTIAL_PREFIX}${JSON.stringify({
            access_token: credential.accessToken,
            client_id: credential.clientId,
            expires_at: Number(credential.expiresAt) || 0,
            provider: credential.provider,
            redirect_uri: credential.redirectUri,
            refresh_token: credential.refreshToken || "",
            token_type: credential.tokenType || "Bearer",
        })}`;
    }

    /**
     * Loads the complete session or remembered credential record for one connection.
     * Session storage wins when both tiers contain a value, mirroring temporary re-authentication behavior for plain tokens.
     * @param {string} connectionId Registry connection id.
     * @returns {WorkspaceCredentialRecord | null}
     */
    loadWorkspaceCredentialRecord(connectionId) {
        const id = String(connectionId || "");
        if (!id) return null;
        const sessionCredentials = this.readCredentialMap(sessionStorage, this.storageKeys.sessionWorkspaceCredentials);
        const rememberedCredentials = this.readCredentialMap(localStorage, this.storageKeys.rememberedWorkspaceCredentials);
        return this.parseWorkspaceCredential(sessionCredentials[id] || rememberedCredentials[id] || "");
    }

    /**
     * Loads the session or remembered credential for one workspace connection.
     * Session storage wins if both maps contain a value, matching an explicit temporary re-authentication.
     * @param {string} connectionId Registry connection id.
     * @returns {string}
     */
    loadWorkspaceCredential(connectionId) {
        return this.loadWorkspaceCredentialRecord(connectionId)?.accessToken || "";
    }

    /**
     * Stores one workspace credential in exactly one browser persistence tier.
     * @param {string} connectionId Registry connection id.
     * @param {string} credential PAT or provider token.
     * @param {boolean} remember Whether the credential should survive browser restarts.
     * @returns {void}
     */
    saveWorkspaceCredential(connectionId, credential, remember) {
        const id = String(connectionId || "");
        if (!id) throw new Error("A workspace connection id is required to store a credential.");
        const value = String(credential || "");
        const sessionCredentials = this.readCredentialMap(sessionStorage, this.storageKeys.sessionWorkspaceCredentials);
        const rememberedCredentials = this.readCredentialMap(localStorage, this.storageKeys.rememberedWorkspaceCredentials);
        delete sessionCredentials[id];
        delete rememberedCredentials[id];
        if (value) {
            if (remember) rememberedCredentials[id] = value;
            else sessionCredentials[id] = value;
        }
        this.writeCredentialMap(sessionStorage, this.storageKeys.sessionWorkspaceCredentials, sessionCredentials);
        this.writeCredentialMap(localStorage, this.storageKeys.rememberedWorkspaceCredentials, rememberedCredentials);
    }

    /**
     * Stores a refreshable OAuth grant in the same isolated persistence tier as a PAT connection.
     * Reusing the credential maps keeps disconnect/logout semantics identical across authentication methods.
     * @param {string} connectionId Registry connection id.
     * @param {WorkspaceCredentialRecord} credential OAuth grant returned or refreshed by the provider.
     * @param {boolean} remember Whether the grant should survive browser restarts.
     * @returns {void}
     */
    saveWorkspaceOAuthCredential(connectionId, credential, remember) {
        this.saveWorkspaceCredential(connectionId, this.serializeWorkspaceOAuthCredential(credential), remember);
    }

    /**
     * Reports whether one connection's credential is persisted beyond the current browser session.
     * @param {string} connectionId Registry connection id.
     * @returns {boolean}
     */
    isWorkspaceCredentialRemembered(connectionId) {
        const rememberedCredentials = this.readCredentialMap(localStorage, this.storageKeys.rememberedWorkspaceCredentials);
        return Boolean(rememberedCredentials[String(connectionId || "")]);
    }

    /**
     * Removes one connection's credentials from both persistence tiers.
     * @param {string} connectionId Registry connection id.
     * @returns {void}
     */
    clearWorkspaceCredential(connectionId) {
        const id = String(connectionId || "");
        if (!id) return;
        const sessionCredentials = this.readCredentialMap(sessionStorage, this.storageKeys.sessionWorkspaceCredentials);
        const rememberedCredentials = this.readCredentialMap(localStorage, this.storageKeys.rememberedWorkspaceCredentials);
        delete sessionCredentials[id];
        delete rememberedCredentials[id];
        this.writeCredentialMap(sessionStorage, this.storageKeys.sessionWorkspaceCredentials, sessionCredentials);
        this.writeCredentialMap(localStorage, this.storageKeys.rememberedWorkspaceCredentials, rememberedCredentials);
    }

    /**
     * Loads persisted config, falling back to defaults when missing or invalid.
     * Keeps storage logic separated from the UI.
     * @returns {AppConfig}
     */
    loadConfig() {
        try {
            const raw = localStorage.getItem(this.storageKeys.config);
            if (!raw) {
                return { ...DEFAULT_CONFIG };
            }
            return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    }

    /**
     * Persists config overrides to local storage.
     * Keeps storage logic separated from the UI.
     * @param {AppConfig} config
     * @returns {void}
     */
    saveConfig(config) {
        localStorage.setItem(this.storageKeys.config, JSON.stringify(config));
    }

    /**
     * Loads the stored token, respecting the remember flag.
     * Keeps storage logic separated from the UI.
     * @returns {string}
     */
    loadToken() {
        const remembered = this.isTokenRemembered();
        if (remembered) {
            return localStorage.getItem(this.storageKeys.token) || "";
        }
        return sessionStorage.getItem(this.storageKeys.token) || "";
    }

    /**
     * Stores the token in either localStorage or sessionStorage.
     * Keeps storage logic separated from the UI.
     * @param {string} token
     * @param {boolean} remember
     * @returns {void}
     */
    saveToken(token, remember) {
        localStorage.setItem(this.storageKeys.tokenRemembered, remember ? "1" : "0");
        if (remember) {
            localStorage.setItem(this.storageKeys.token, token);
            sessionStorage.removeItem(this.storageKeys.token);
        } else {
            sessionStorage.setItem(this.storageKeys.token, token);
            localStorage.removeItem(this.storageKeys.token);
        }
    }

    /**
     * Returns true when the token is stored in localStorage.
     * Keeps storage logic separated from the UI.
     * @returns {boolean}
     */
    isTokenRemembered() {
        return localStorage.getItem(this.storageKeys.tokenRemembered) === "1";
    }

    /**
     * Clears repository connections, credentials, and UI config from storage.
     * The dedicated interface language is a device preference rather than workspace/authentication state, so logout deliberately preserves it.
     * @returns {void}
     */
    clearSaved() {
        localStorage.removeItem(this.storageKeys.config);
        localStorage.removeItem(this.storageKeys.token);
        localStorage.removeItem(this.storageKeys.tokenRemembered);
        localStorage.removeItem(this.storageKeys.workspaceRegistry);
        localStorage.removeItem(this.storageKeys.rememberedWorkspaceCredentials);
        sessionStorage.removeItem(this.storageKeys.token);
        sessionStorage.removeItem(this.storageKeys.sessionWorkspaceCredentials);
    }
}
