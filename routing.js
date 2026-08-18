const ROUTE_VERSION = 1;
const STATIC_ROUTE_STORAGE_KEY = "zeitberg:static-route:v1";
const CAPABILITY_FRAGMENT_PREFIX = "#zb-cap=";
const CAPABILITY_VERSION = 1;
const MAX_CAPABILITY_PAYLOAD_LENGTH = 24_000;
const ROUTE_COMPONENTS = new Set(["time", "todos", "expenses"]);
const ROUTE_PANELS = new Set(["main", "search", "workspaces", "settings"]);
const PROVIDERS = new Set(["github", "gitlab", "codeberg", "forgejo", "custom", "local"]);

/**
 * @typedef {"time" | "todos" | "expenses"} RouteComponent
 */

/**
 * @typedef {"main" | "search" | "workspaces" | "settings"} RoutePanel
 */

/**
 * @typedef {Object} WorkspaceRouteLocator
 * @description Public, credential-free coordinates for one workspace repository.
 * @property {"github" | "gitlab" | "codeberg" | "forgejo" | "custom" | "local"} provider
 * @property {string} repositoryUrl
 * @property {string} ref
 * @property {string} workspacePath
 * @property {string} expectedWorkspaceId
 */

/**
 * @typedef {Object} AppRoute
 * @description Versioned browser route for a component, workspace locator, and component-owned view state.
 * @property {number} version
 * @property {RouteComponent | null} component
 * @property {RoutePanel} panel
 * @property {WorkspaceRouteLocator | null} workspace
 * @property {Object.<string, string | number | boolean | null>} state
 */

/**
 * @typedef {Object} CapabilityLink
 * @description A validated bearer credential and the exact non-secret route to which it is bound.
 * @property {number} version
 * @property {string} credential
 * @property {AppRoute} route
 * @property {boolean} requiresHostConfirmation
 */

/**
 * Converts arbitrary text into a bounded route value.
 * Length limits prevent malformed URLs from creating unexpectedly large in-memory state while preserving ordinary search and identifier values.
 * @param {unknown} value Candidate value from an application model or URL parameter.
 * @param {number} [maxLength] Maximum number of UTF-16 code units retained.
 * @returns {string}
 */
function boundedText(value, maxLength = 512) {
    return String(value ?? "").trim().slice(0, Math.max(0, maxLength));
}

/**
 * Normalizes an application deployment prefix into an absolute path ending in a slash.
 * The same codec therefore works at zeitberg.io, a GitHub project page, and a nested local static host.
 * @param {unknown} value Candidate deployment base path.
 * @returns {string}
 */
export function normalizeRouteBasePath(value) {
    const raw = boundedText(value || "/", 1024);
    const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
    const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
    return collapsed.endsWith("/") ? collapsed : `${collapsed}/`;
}

/**
 * Validates the repository-relative bootstrap path carried by a workspace locator.
 * This duplicates only the pre-workspace safety boundary: routing cannot import the workspace model because it must run before repository data is loaded.
 * @param {unknown} value Candidate workspace configuration path.
 * @returns {string}
 */
function normalizeWorkspacePath(value) {
    const path = boundedText(value || "zeitberg.json", 512);
    if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) {
        throw new Error("The workspace bootstrap path must be repository-relative.");
    }
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
        throw new Error("The workspace bootstrap path contains an unsafe segment.");
    }
    return parts.join("/");
}

/**
 * Validates and normalizes a credential-free workspace locator.
 * Repository URLs may identify built-in or custom HTTPS providers, but embedded credentials, query strings, and fragments are always rejected.
 * @param {unknown} value Candidate locator object.
 * @returns {WorkspaceRouteLocator | null}
 */
export function normalizeWorkspaceRouteLocator(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = /** @type {Record<string, unknown>} */ (value);
    const provider = boundedText(candidate.provider, 32).toLowerCase();
    if (!PROVIDERS.has(provider)) return null;

    const workspacePath = normalizeWorkspacePath(candidate.workspacePath || "zeitberg.json");
    const expectedWorkspaceId = boundedText(candidate.expectedWorkspaceId, 128);
    if (expectedWorkspaceId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(expectedWorkspaceId)) {
        throw new Error("The expected workspace identifier is invalid.");
    }

    if (provider === "local") {
        return {
            provider: "local",
            repositoryUrl: "",
            ref: "",
            workspacePath,
            expectedWorkspaceId,
        };
    }

    let repositoryUrl;
    try {
        repositoryUrl = new URL(boundedText(candidate.repositoryUrl, 2048));
    } catch {
        throw new Error("The workspace repository URL is invalid.");
    }
    if (
        repositoryUrl.protocol !== "https:" ||
        repositoryUrl.username ||
        repositoryUrl.password ||
        repositoryUrl.search ||
        repositoryUrl.hash
    ) {
        throw new Error("Workspace repository URLs must use HTTPS and contain no credentials, query, or fragment.");
    }
    const expectedHost = provider === "github" ? "github.com" : provider === "gitlab" ? "gitlab.com" : provider === "codeberg" ? "codeberg.org" : "";
    if (expectedHost && repositoryUrl.hostname.toLowerCase() !== expectedHost) {
        throw new Error(`The ${provider} provider requires a ${expectedHost} repository URL.`);
    }
    const repositoryParts = repositoryUrl.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .map((part) => {
            try {
                return decodeURIComponent(part);
            } catch {
                throw new Error("The workspace repository URL contains an invalid path escape.");
            }
        });
    if (repositoryParts.length) {
        repositoryParts[repositoryParts.length - 1] = repositoryParts[repositoryParts.length - 1].replace(/\.git$/i, "");
    }
    const exactlyTwoParts = provider === "github" || provider === "codeberg" || provider === "forgejo";
    if (
        repositoryParts.length < 2 ||
        (exactlyTwoParts && repositoryParts.length !== 2) ||
        repositoryParts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
    ) {
        const shape = exactlyTwoParts ? "exactly one owner and repository" : "a namespace and repository";
        throw new Error(`The ${provider} repository URL must identify ${shape}.`);
    }
    repositoryUrl.pathname = `/${repositoryParts.map((part) => encodeURIComponent(part)).join("/")}`;
    const ref = boundedText(candidate.ref || "main", 256);
    if (!ref) throw new Error("The workspace ref must not be empty.");

    return {
        provider: /** @type {WorkspaceRouteLocator["provider"]} */ (provider),
        repositoryUrl: repositoryUrl.toString().replace(/\/$/, ""),
        ref,
        workspacePath,
        expectedWorkspaceId,
    };
}

/**
 * Builds a stable non-secret identity for a workspace locator.
 * Registry, credential, draft, and cache layers use this key without ever incorporating a PAT or OAuth token.
 * @param {WorkspaceRouteLocator} locator Validated locator.
 * @returns {string}
 */
export function workspaceRouteLocatorKey(locator) {
    const normalized = normalizeWorkspaceRouteLocator(locator);
    if (!normalized) throw new Error("A valid workspace locator is required.");
    if (normalized.provider === "local") {
        return `local:${normalized.expectedWorkspaceId || "default"}:${normalized.workspacePath}`;
    }
    return [
        normalized.provider,
        normalized.repositoryUrl.toLowerCase(),
        normalized.ref,
        normalized.workspacePath,
    ].join(":");
}

/**
 * Returns the component panel represented by a path suffix.
 * Search belongs only to Time, while global Workspace and Interface settings remain nested beneath whichever component was active.
 * @param {RouteComponent} component Parsed component.
 * @param {unknown} value Candidate panel segment.
 * @returns {RoutePanel}
 */
function normalizePanel(component, value) {
    const panel = boundedText(value, 32).toLowerCase();
    if (!ROUTE_PANELS.has(panel)) return "main";
    if (panel === "search" && component !== "time") return "main";
    return /** @type {RoutePanel} */ (panel);
}

/**
 * Parses a bounded finite number from a query parameter.
 * Invalid values are omitted instead of poisoning the rest of an otherwise usable route.
 * @param {URLSearchParams} params Route query parameters.
 * @param {string} key Parameter name.
 * @param {number} minimum Inclusive lower bound.
 * @param {number} maximum Inclusive upper bound.
 * @returns {number | null}
 */
function numberParameter(params, key, minimum, maximum) {
    if (!params.has(key)) return null;
    const value = Number(params.get(key));
    if (!Number.isFinite(value)) return null;
    return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Parses a bounded integer query parameter.
 * @param {URLSearchParams} params Route query parameters.
 * @param {string} key Parameter name.
 * @param {number} minimum Inclusive lower bound.
 * @param {number} maximum Inclusive upper bound.
 * @returns {number | null}
 */
function integerParameter(params, key, minimum, maximum) {
    const value = numberParameter(params, key, minimum, maximum);
    return value === null ? null : Math.round(value);
}

/**
 * Parses an explicit boolean query parameter.
 * Only `1` and `0` are accepted so malformed links cannot silently invert filter state.
 * @param {URLSearchParams} params Route query parameters.
 * @param {string} key Parameter name.
 * @returns {boolean | null}
 */
function booleanParameter(params, key) {
    const value = params.get(key);
    if (value === "1") return true;
    if (value === "0") return false;
    return null;
}

/**
 * Reads one non-empty bounded string parameter.
 * @param {URLSearchParams} params Route query parameters.
 * @param {string} key Parameter name.
 * @param {number} [maxLength] Maximum retained length.
 * @returns {string | null}
 */
function stringParameter(params, key, maxLength = 512) {
    if (!params.has(key)) return null;
    const value = boundedText(params.get(key), maxLength);
    return value || null;
}

/**
 * Parses component-owned state from a normalized route query.
 * Unknown parameters are ignored, making routes forward-compatible without allowing arbitrary data into view controllers.
 * @param {RouteComponent} component Active component.
 * @param {RoutePanel} panel Active panel.
 * @param {URLSearchParams} params Query parameters.
 * @returns {Object.<string, string | number | boolean | null>}
 */
function parseViewState(component, panel, params) {
    /** @type {Object.<string, string | number | boolean | null>} */
    const state = {};
    const returnPanel = panel === "workspaces" || panel === "settings" ? stringParameter(params, "under", 32) : null;
    if (component === "time" && returnPanel === "search") state.returnPanel = "search";
    if (component === "time") {
        const weekStart = stringParameter(params, "week", 10);
        if (weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart)) state.weekStart = weekStart;
        const dayWindowStart = integerParameter(params, "day", 0, 6);
        if (dayWindowStart !== null) state.dayWindowStart = dayWindowStart;
        const selectedEntryId = integerParameter(params, "entry", 1, Number.MAX_SAFE_INTEGER);
        if (selectedEntryId !== null) state.selectedEntryId = selectedEntryId;
        const zoom = numberParameter(params, "zoom", 1, 4);
        if (zoom !== null) state.zoom = zoom;
        const scrollMinutes = numberParameter(params, "scroll", 0, 1440);
        if (scrollMinutes !== null) state.scrollMinutes = scrollMinutes;

        if (panel === "search" || state.returnPanel === "search") {
            const query = stringParameter(params, "q", 1024);
            const project = stringParameter(params, "project", 256);
            const from = stringParameter(params, "from", 10);
            const to = stringParameter(params, "to", 10);
            const maxRows = integerParameter(params, "limit", 50, 10000);
            const sort = stringParameter(params, "sort", 4);
            if (query) state.query = query;
            if (project) state.project = project;
            if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) state.from = from;
            if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) state.to = to;
            if (maxRows !== null) state.maxRows = maxRows;
            if (sort === "asc" || sort === "desc") state.sort = sort;
        }
    } else if (component === "todos") {
        const query = stringParameter(params, "q", 1024);
        const project = stringParameter(params, "project", 256);
        const selectedTodoId = stringParameter(params, "todo", 256);
        const currentOnly = booleanParameter(params, "current");
        const openOnly = booleanParameter(params, "open");
        if (query) state.query = query;
        if (project) state.project = project;
        if (selectedTodoId) state.selectedTodoId = selectedTodoId;
        if (currentOnly !== null) state.currentOnly = currentOnly;
        if (openOnly !== null) state.openOnly = openOnly;
    } else if (component === "expenses") {
        const ledger = stringParameter(params, "ledger", 256);
        const category = stringParameter(params, "category", 256);
        const query = stringParameter(params, "q", 1024);
        const selectedExpenseId = stringParameter(params, "expense", 256);
        if (ledger) state.ledger = ledger;
        if (category) state.category = category;
        if (query) state.query = query;
        if (selectedExpenseId) state.selectedExpenseId = selectedExpenseId;
    }
    return state;
}

/**
 * Parses a URL into the versioned application route model.
 * The parser is deliberately tolerant of unknown paths and malformed optional state: such links fall back to the public root or omit only the invalid field.
 * @param {string | URL} value Absolute or relative URL to parse.
 * @param {string} [basePath] Deployment path containing index.html.
 * @returns {AppRoute}
 */
export function parseAppRoute(value, basePath = "/") {
    const normalizedBase = normalizeRouteBasePath(basePath);
    let url;
    try {
        url = value instanceof URL ? new URL(value.toString()) : new URL(String(value), "https://zeitberg.invalid");
    } catch {
        return { version: ROUTE_VERSION, component: null, panel: "main", workspace: null, state: {} };
    }

    if (!url.pathname.startsWith(normalizedBase)) {
        return { version: ROUTE_VERSION, component: null, panel: "main", workspace: null, state: {} };
    }
    const encodedVersion = url.searchParams.get("v");
    if (encodedVersion && encodedVersion !== String(ROUTE_VERSION)) {
        return { version: ROUTE_VERSION, component: null, panel: "main", workspace: null, state: {} };
    }
    const routePath = url.pathname.slice(normalizedBase.length).replace(/^\/+|\/+$/g, "");
    if (!routePath) {
        return { version: ROUTE_VERSION, component: null, panel: "main", workspace: null, state: {} };
    }
    const segments = routePath.split("/").map((segment) => {
        try {
            return decodeURIComponent(segment);
        } catch {
            return "";
        }
    });
    const componentText = boundedText(segments[0], 32).toLowerCase();
    if (!ROUTE_COMPONENTS.has(componentText)) {
        return { version: ROUTE_VERSION, component: null, panel: "main", workspace: null, state: {} };
    }
    const component = /** @type {RouteComponent} */ (componentText);
    const panel = normalizePanel(component, segments[1] || url.searchParams.get("panel") || "main");

    let workspace = null;
    try {
        if (url.searchParams.get("source") === "local") {
            workspace = normalizeWorkspaceRouteLocator({
                provider: "local",
                workspacePath: url.searchParams.get("config") || "zeitberg.json",
                expectedWorkspaceId: url.searchParams.get("workspace") || "",
            });
        } else if (url.searchParams.has("provider") || url.searchParams.has("repo")) {
            workspace = normalizeWorkspaceRouteLocator({
                provider: url.searchParams.get("provider"),
                repositoryUrl: url.searchParams.get("repo"),
                ref: url.searchParams.get("ref"),
                workspacePath: url.searchParams.get("config"),
                expectedWorkspaceId: url.searchParams.get("workspace"),
            });
        }
    } catch {
        workspace = null;
    }

    return {
        version: ROUTE_VERSION,
        component,
        panel,
        workspace,
        state: parseViewState(component, panel, url.searchParams),
    };
}

/**
 * Writes a non-empty state value into a URL query using a compact stable key.
 * @param {URLSearchParams} params Destination query.
 * @param {string} key Query key.
 * @param {unknown} value Candidate state value.
 * @returns {void}
 */
function setStateParameter(params, key, value) {
    if (value === null || value === undefined || value === "") return;
    if (typeof value === "boolean") {
        params.set(key, value ? "1" : "0");
        return;
    }
    if (typeof value === "number") {
        if (Number.isFinite(value)) params.set(key, String(value));
        return;
    }
    params.set(key, boundedText(value, 1024));
}

/**
 * Serializes one normalized route into a deployment-relative browser URL.
 * Credentials are not part of AppRoute and therefore cannot accidentally enter the ordinary path or query string.
 * @param {AppRoute} route Route model to serialize.
 * @param {string} [basePath] Deployment path containing index.html.
 * @returns {string}
 */
export function formatAppRoute(route, basePath = "/") {
    const base = normalizeRouteBasePath(basePath);
    const componentText = boundedText(route?.component, 32).toLowerCase();
    if (!ROUTE_COMPONENTS.has(componentText)) return base;
    const component = /** @type {RouteComponent} */ (componentText);
    const panel = normalizePanel(component, route?.panel || "main");
    const path = `${base}${component}`.replace(/\/{2,}/g, "/");
    const params = new URLSearchParams();
    params.set("v", String(ROUTE_VERSION));
    if (panel !== "main") params.set("panel", panel);

    let workspace = null;
    try {
        workspace = normalizeWorkspaceRouteLocator(route?.workspace);
    } catch {
        workspace = null;
    }
    if (workspace?.provider === "local") {
        params.set("source", "local");
        if (workspace.workspacePath !== "zeitberg.json") params.set("config", workspace.workspacePath);
        if (workspace.expectedWorkspaceId) params.set("workspace", workspace.expectedWorkspaceId);
    } else if (workspace) {
        params.set("provider", workspace.provider);
        params.set("repo", workspace.repositoryUrl);
        params.set("ref", workspace.ref);
        if (workspace.workspacePath !== "zeitberg.json") params.set("config", workspace.workspacePath);
        if (workspace.expectedWorkspaceId) params.set("workspace", workspace.expectedWorkspaceId);
    }

    const state = route?.state || {};
    if ((panel === "workspaces" || panel === "settings") && component === "time" && state.returnPanel === "search") {
        params.set("under", "search");
    }
    if (component === "time") {
        setStateParameter(params, "week", state.weekStart);
        setStateParameter(params, "day", state.dayWindowStart);
        setStateParameter(params, "entry", state.selectedEntryId);
        setStateParameter(params, "zoom", state.zoom);
        setStateParameter(params, "scroll", state.scrollMinutes);
        if (panel === "search" || state.returnPanel === "search") {
            setStateParameter(params, "q", state.query);
            setStateParameter(params, "project", state.project);
            setStateParameter(params, "from", state.from);
            setStateParameter(params, "to", state.to);
            setStateParameter(params, "limit", state.maxRows);
            setStateParameter(params, "sort", state.sort);
        }
    } else if (component === "todos") {
        setStateParameter(params, "q", state.query);
        setStateParameter(params, "project", state.project);
        setStateParameter(params, "todo", state.selectedTodoId);
        setStateParameter(params, "current", state.currentOnly);
        setStateParameter(params, "open", state.openOnly);
    } else if (component === "expenses") {
        setStateParameter(params, "ledger", state.ledger);
        setStateParameter(params, "category", state.category);
        setStateParameter(params, "q", state.query);
        setStateParameter(params, "expense", state.selectedExpenseId);
    }

    const query = params.toString();
    return query ? `${path}?${query}` : path;
}

/**
 * Encodes UTF-8 text as unpadded URL-safe base64 without relying on provider or third-party libraries.
 * @param {string} value Plain JSON text.
 * @returns {string}
 */
function encodeBase64Url(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Decodes bounded URL-safe base64 into UTF-8 text and rejects malformed alphabets before allocation.
 * @param {string} value Encoded payload text.
 * @returns {string}
 */
function decodeBase64Url(value) {
    const encoded = String(value || "");
    if (!encoded || encoded.length > MAX_CAPABILITY_PAYLOAD_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
        throw new Error("The capability payload is malformed.");
    }
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    let binary;
    try {
        binary = atob(padded);
    } catch {
        throw new Error("The capability payload is malformed.");
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error("The capability payload is malformed.");
    }
}

/**
 * Re-encodes and parses a route to remove unknown fields and enforce all ordinary locator and view-state validation.
 * @param {AppRoute} route Candidate capability route.
 * @param {string} pageOrigin Origin hosting the application.
 * @param {string} basePath Deployment path containing index.html.
 * @returns {AppRoute}
 */
function normalizeCapabilityRoute(route, pageOrigin, basePath) {
    const routePath = formatAppRoute(route, basePath);
    const normalized = parseAppRoute(new URL(routePath, pageOrigin), basePath);
    if (!normalized.component || !normalized.workspace || normalized.workspace.provider === "local") {
        throw new Error("Capability links require one hosted workspace route.");
    }
    return normalized;
}

/**
 * Creates a versioned bearer-capability URL whose secret exists only in the fragment.
 * The ordinary path/query remains a complete credential-free locator and view route, allowing the fragment to be scrubbed before any provider request.
 * @param {AppRoute} route Workspace-bound application route.
 * @param {string} credential Dedicated provider credential to convey.
 * @param {string} pageOrigin Public application origin.
 * @param {string} [basePath] Deployment path containing index.html.
 * @returns {string}
 */
export function formatCapabilityLink(route, credential, pageOrigin, basePath = "/") {
    const token = String(credential || "").trim();
    if (!token || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token)) {
        throw new Error("Enter a valid shareable repository credential.");
    }
    const origin = new URL(pageOrigin).origin;
    const normalizedRoute = normalizeCapabilityRoute(route, origin, basePath);
    const payload = {
        credential: token,
        route: normalizedRoute,
        version: CAPABILITY_VERSION,
    };
    const url = new URL(formatAppRoute(normalizedRoute, basePath), origin);
    url.hash = `${CAPABILITY_FRAGMENT_PREFIX.slice(1)}${encodeBase64Url(JSON.stringify(payload))}`;
    return url.toString();
}

/**
 * Validates and decodes a capability URL without mutating browser history.
 * The duplicated public route and secret payload route must normalize identically, preventing a credential from being redirected to a query-string host chosen by an attacker.
 * @param {string | URL} value Capability URL.
 * @param {string} [basePath] Deployment path containing index.html.
 * @returns {CapabilityLink}
 */
export function parseCapabilityLink(value, basePath = "/") {
    const url = value instanceof URL ? new URL(value.toString()) : new URL(String(value));
    if (!url.hash.startsWith(CAPABILITY_FRAGMENT_PREFIX)) throw new Error("No capability payload was found.");
    const encoded = url.hash.slice(CAPABILITY_FRAGMENT_PREFIX.length);
    let payload;
    try {
        payload = JSON.parse(decodeBase64Url(encoded));
    } catch {
        throw new Error("The capability payload is invalid.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Number(payload.version) !== CAPABILITY_VERSION) {
        throw new Error("The capability payload version is unsupported.");
    }
    const credential = String(payload.credential || "").trim();
    if (!credential || credential.length > 8192 || /[\u0000-\u001f\u007f]/.test(credential)) {
        throw new Error("The capability credential is invalid.");
    }
    const route = normalizeCapabilityRoute(payload.route, url.origin, basePath);
    const publicRoute = normalizeCapabilityRoute(parseAppRoute(url, basePath), url.origin, basePath);
    if (formatAppRoute(route, basePath) !== formatAppRoute(publicRoute, basePath)) {
        throw new Error("The capability route does not match its public workspace locator.");
    }
    const provider = route.workspace?.provider || "custom";
    return {
        version: CAPABILITY_VERSION,
        credential,
        route,
        requiresHostConfirmation: !["github", "gitlab", "codeberg"].includes(provider),
    };
}

/**
 * Removes a capability fragment from the address bar before decoding returns to application startup.
 * Scrubbing occurs even for malformed payloads, ensuring a broken bearer link cannot survive in browser history, screenshots, copied addresses, or later diagnostics.
 * @param {Window} browserWindow Active browser window.
 * @param {string} [basePath] Deployment path containing index.html.
 * @returns {CapabilityLink | null}
 */
export function consumeCapabilityLink(browserWindow, basePath = "/") {
    if (!browserWindow.location.hash.startsWith(CAPABILITY_FRAGMENT_PREFIX)) return null;
    const originalUrl = browserWindow.location.href;
    browserWindow.history.replaceState(
        null,
        "",
        `${browserWindow.location.pathname}${browserWindow.location.search}`,
    );
    try {
        return parseCapabilityLink(originalUrl, basePath);
    } catch {
        throw new Error("This capability link is invalid or has been altered. Its credential fragment was removed.");
    }
}

/**
 * Discovers the application's deployment base from the module script URL.
 * Unlike location.pathname, the script remains anchored to the application root even while a nested client-side route is active.
 * @param {Document} documentObject Active document.
 * @returns {string}
 */
export function getApplicationBasePath(documentObject) {
    const scripts = Array.from(documentObject?.querySelectorAll?.("script[src]") || []);
    const appScript = scripts.find((script) => {
        const source = script instanceof Element ? script.getAttribute("src") || "" : "";
        return /(?:^|\/)app\.js(?:[?#].*)?$/.test(source);
    });
    if (!appScript) return "/";
    try {
        const sourceUrl = new URL(appScript.getAttribute("src") || "", documentObject.baseURI);
        return normalizeRouteBasePath(sourceUrl.pathname.replace(/[^/]*$/, ""));
    } catch {
        return "/";
    }
}

/**
 * Coordinates History API updates and the GitHub Pages 404 handoff.
 * Meaningful navigation uses pushState, while high-frequency view state is coalesced into replaceState so browser history stays useful.
 */
export class RouteController {
    /**
     * Creates a controller around a browser-like Window object.
     * A browser object is injected so codec/history behavior can be tested without loading the complete application DOM.
     * @param {Window} browserWindow Active browser window.
     * @param {string} [basePath] Application deployment prefix.
     */
    constructor(browserWindow, basePath = "/") {
        this.window = browserWindow;
        this.basePath = normalizeRouteBasePath(basePath);
        this.replaceTimer = 0;
        this.popHandler = null;
    }

    /**
     * Restores a route captured by the static 404 handoff and removes its temporary session record.
     * Only same-origin paths beneath this application base are accepted, preventing unrelated session data from steering navigation.
     * @returns {boolean} Whether a route was restored.
     */
    restoreStaticRoute() {
        let stored = "";
        try {
            stored = this.window.sessionStorage.getItem(STATIC_ROUTE_STORAGE_KEY) || "";
            this.window.sessionStorage.removeItem(STATIC_ROUTE_STORAGE_KEY);
        } catch {
            return false;
        }
        if (!stored) return false;
        try {
            const restored = new URL(stored, this.window.location.origin);
            if (restored.origin !== this.window.location.origin || !restored.pathname.startsWith(this.basePath)) return false;
            this.window.history.replaceState(null, "", `${restored.pathname}${restored.search}${restored.hash}`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Parses the browser's current address after any static-route restoration.
     * @returns {AppRoute}
     */
    read() {
        return parseAppRoute(this.window.location.href, this.basePath);
    }

    /**
     * Starts Back/Forward observation and returns a cleanup callback.
     * @param {(route: AppRoute) => void} onRoute Callback invoked after popstate.
     * @returns {() => void}
     */
    start(onRoute) {
        this.stop();
        this.popHandler = () => onRoute(this.read());
        this.window.addEventListener("popstate", this.popHandler);
        return () => this.stop();
    }

    /**
     * Removes history listeners and any pending high-frequency replacement.
     * @returns {void}
     */
    stop() {
        if (this.popHandler) this.window.removeEventListener("popstate", this.popHandler);
        this.popHandler = null;
        if (this.replaceTimer) this.window.clearTimeout(this.replaceTimer);
        this.replaceTimer = 0;
    }

    /**
     * Writes a route immediately through pushState or replaceState.
     * @param {AppRoute} route Route to write.
     * @param {"push" | "replace"} [mode] History mutation kind.
     * @returns {string} Written deployment-relative URL.
     */
    write(route, mode = "replace") {
        if (this.replaceTimer) this.window.clearTimeout(this.replaceTimer);
        this.replaceTimer = 0;
        const url = formatAppRoute(route, this.basePath);
        if (mode === "push") this.window.history.pushState(null, "", url);
        else this.window.history.replaceState(null, "", url);
        return url;
    }

    /**
     * Coalesces rapid view-state changes into one replaceState operation.
     * Scroll and zoom can update many times per second and should never create one browser-history entry per frame.
     * @param {() => AppRoute} routeFactory Lazily captures the latest view state when the debounce expires.
     * @param {number} [delayMs] Debounce delay in milliseconds.
     * @returns {void}
     */
    scheduleReplace(routeFactory, delayMs = 180) {
        if (this.replaceTimer) this.window.clearTimeout(this.replaceTimer);
        this.replaceTimer = this.window.setTimeout(() => {
            this.replaceTimer = 0;
            this.write(routeFactory(), "replace");
        }, Math.max(0, Number(delayMs) || 0));
    }
}

export {
    CAPABILITY_FRAGMENT_PREFIX,
    CAPABILITY_VERSION,
    ROUTE_VERSION,
    STATIC_ROUTE_STORAGE_KEY,
};
