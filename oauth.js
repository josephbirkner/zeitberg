import { normalizeRouteBasePath } from "./routing.js";

const OAUTH_PENDING_KEY = "zeitberg:oauth-pending:v1";
const OAUTH_PENDING_VERSION = 1;
const OAUTH_PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const OAUTH_REFRESH_SKEW_MS = 60 * 1000;
const OAUTH_CALLBACK_PARAMETERS = new Set(["code", "error", "error_description", "oauth_provider", "scope", "state"]);

// Deployment-owned endpoint only; never take an authentication relay URL from a
// workspace, capability link or stored credential, which could exfiltrate tokens.
export const GITHUB_RELAY_URL = "https://zeitbergauthjktlgxby-githubauth.functions.fnc.fr-par.scw.cloud/";
export const GITHUB_CLIENT_ID = "Iv23liNvkhSh2mYH0oPw";

/**
 * @typedef {Object} OAuthIntent
 * @description Credential-free onboarding state retained in session storage while the browser visits a provider authorization page.
 * @property {"connect" | "create" | "browse"} mode
 * @property {string} repositoryUrl
 * @property {string} ref
 * @property {string} workspacePath
 * @property {string} [expectedWorkspaceId]
 * @property {boolean} remember
 * @property {string} [repositoryName]
 * @property {string} [workspaceName]
 * @property {string} [timezone]
 * @property {string} [returnPath] Credential-free local route to restore after reconnecting a different workspace.
 */

/**
 * @typedef {Object} OAuthCredential
 * @description Public-client OAuth grant suitable for ConfigService's isolated workspace credential storage.
 * @property {"oauth"} kind
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt
 * @property {"github" | "gitlab" | "codeberg"} provider
 * @property {string} clientId
 * @property {string} redirectUri
 * @property {string} tokenType
 */

/**
 * @typedef {Object} OAuthCallbackResult
 * @description Validated callback outcome after the authorization code has been exchanged.
 * @property {OAuthCredential} credential
 * @property {OAuthIntent} intent
 */

/**
 * Returns immutable OAuth endpoint metadata for the two static public-client providers.
 * @param {string} provider Provider identifier selected by the user.
 * @returns {{provider: "gitlab" | "codeberg", authorizeUrl: string, tokenUrl: string, scope: string}}
 */
export function getOAuthProvider(provider) {
    if (provider === "gitlab") {
        return {
            provider: "gitlab",
            authorizeUrl: "https://gitlab.com/oauth/authorize",
            tokenUrl: "https://gitlab.com/oauth/token",
            scope: "api",
        };
    }
    if (provider === "codeberg") {
        return {
            provider: "codeberg",
            authorizeUrl: "https://codeberg.org/login/oauth/authorize",
            tokenUrl: "https://codeberg.org/login/oauth/access_token",
            scope: "",
        };
    }
    throw new Error("OAuth is available for GitLab.com and Codeberg only.");
}

/**
 * Reads a public OAuth application client id from first-party document metadata.
 * Client ids are public configuration, not secrets. A configured id does not imply
 * that its provider's authorization flow is implemented or browser-compatible;
 * callers must separately check supported flows before enabling OAuth controls.
 * @param {Document} documentObject Application document.
 * @param {string} provider Provider identifier.
 * @returns {string}
 */
export function readOAuthClientId(documentObject, provider) {
    const name = ["github", "gitlab", "codeberg"].includes(provider) ? `zeitberg-oauth-${provider}-client-id` : "";
    if (!name) return "";
    const element = documentObject.querySelector(`meta[name="${name}"]`);
    return element instanceof HTMLMetaElement ? element.content.trim() : "";
}

/**
 * Encodes random or digest bytes as unpadded URL-safe base64 for OAuth state and PKCE values.
 * @param {Uint8Array} bytes Binary value.
 * @returns {string}
 */
function encodeBase64Url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Generates a cryptographically random URL-safe value of the requested entropy.
 * @param {Crypto} cryptoObject Browser Web Crypto implementation.
 * @param {number} byteLength Number of random bytes.
 * @returns {string}
 */
function randomValue(cryptoObject, byteLength) {
    const bytes = new Uint8Array(byteLength);
    cryptoObject.getRandomValues(bytes);
    return encodeBase64Url(bytes);
}

/**
 * Compares OAuth state without returning early on the first differing character.
 * @param {string} left Expected state.
 * @param {string} right Callback state.
 * @returns {boolean}
 */
function equalState(left, right) {
    const expected = String(left || "");
    const actual = String(right || "");
    let difference = expected.length ^ actual.length;
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
        difference |= (expected.charCodeAt(index) || 0) ^ (actual.charCodeAt(index) || 0);
    }
    return difference === 0;
}

/**
 * Validates and bounds the non-secret onboarding intent stored across an OAuth redirect.
 * @param {unknown} value Candidate intent.
 * @returns {OAuthIntent}
 */
function normalizeOAuthIntent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OAuth onboarding state is missing.");
    const raw = /** @type {Record<string, unknown>} */ (value);
    const mode = raw.mode === "create" ? "create" : raw.mode === "connect" ? "connect" : raw.mode === "browse" ? "browse" : "";
    const repositoryUrl = String(raw.repositoryUrl || "").trim().slice(0, 2048);
    const ref = String(raw.ref || "main").trim().slice(0, 256);
    const workspacePath = String(raw.workspacePath || "zeitberg.json").trim().slice(0, 512);
    const returnPath = String(raw.returnPath || "").slice(0, 8192);
    if (returnPath && (!returnPath.startsWith("/") || returnPath.startsWith("//") || returnPath.includes("\\") || returnPath.includes("#"))) {
        throw new Error("OAuth return route must be a local credential-free path.");
    }
    if (!mode || !ref || !workspacePath) throw new Error("OAuth onboarding state is incomplete.");
    if (mode === "connect" && !repositoryUrl) throw new Error("OAuth onboarding state has no repository.");
    return {
        mode: /** @type {"connect" | "create" | "browse"} */ (mode),
        repositoryUrl,
        ref,
        workspacePath,
        expectedWorkspaceId: String(raw.expectedWorkspaceId || "").trim().slice(0, 128),
        remember: Boolean(raw.remember),
        repositoryName: String(raw.repositoryName || "").trim().slice(0, 128),
        workspaceName: String(raw.workspaceName || "").trim().slice(0, 128),
        timezone: String(raw.timezone || "").trim().slice(0, 128),
        returnPath,
    };
}

/**
 * Returns the one exact same-origin callback URI registered with the public OAuth application.
 * @param {Location} location Browser location.
 * @param {string} basePath Deployment root containing index.html.
 * @param {string} provider Provider marker retained across the external redirect.
 * @returns {string}
 */
function buildRedirectUri(location, basePath, provider) {
    const url = new URL(normalizeRouteBasePath(basePath), location.origin);
    url.searchParams.set("oauth_provider", provider);
    return url.toString();
}

/**
 * Starts an Authorization Code + PKCE redirect and stores only short-lived, credential-free state in session storage.
 * @param {Window} browserWindow Active browser window.
 * @param {string} provider GitLab or Codeberg.
 * @param {string} clientId Public OAuth application id configured by the deployment.
 * @param {OAuthIntent} intent Connection or repository-creation intent.
 * @param {string} [basePath] Deployment root containing index.html.
 * @returns {Promise<void>}
 */
export async function startOAuthAuthorization(browserWindow, provider, clientId, intent, basePath = "/") {
    const oauthProvider = getOAuthProvider(provider);
    const publicClientId = String(clientId || "").trim();
    if (!publicClientId || publicClientId.length > 512) {
        throw new Error(`${oauthProvider.provider} OAuth is not configured for this zeitberg deployment.`);
    }
    const normalizedIntent = normalizeOAuthIntent(intent);
    const state = randomValue(browserWindow.crypto, 32);
    const verifier = randomValue(browserWindow.crypto, 64);
    const digest = await browserWindow.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = encodeBase64Url(new Uint8Array(digest));
    const redirectUri = buildRedirectUri(browserWindow.location, basePath, oauthProvider.provider);
    const pending = {
        client_id: publicClientId,
        created_at: Date.now(),
        intent: normalizedIntent,
        provider: oauthProvider.provider,
        redirect_uri: redirectUri,
        state,
        verifier,
        version: OAUTH_PENDING_VERSION,
    };
    browserWindow.sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending));

    const authorizationUrl = new URL(oauthProvider.authorizeUrl);
    authorizationUrl.searchParams.set("client_id", publicClientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    if (oauthProvider.scope) authorizationUrl.searchParams.set("scope", oauthProvider.scope);
    browserWindow.location.assign(authorizationUrl.toString());
}

/**
 * Extracts a concise token-endpoint error without retaining authorization codes or response bodies.
 * @param {Response} response Failed response.
 * @param {string} provider Provider label.
 * @returns {Promise<Error>}
 */
async function buildTokenError(response, provider) {
    let detail = "";
    try {
        const payload = await response.json();
        detail = String(payload?.error_description || payload?.error || "").replace(/\s+/g, " ").trim().slice(0, 300);
    } catch {
        // Numeric status remains sufficient and avoids reflecting arbitrary HTML error pages.
    }
    return new Error(`${provider} OAuth token exchange failed (${response.status})${detail ? `: ${detail}` : "."}`);
}

/**
 * Converts one provider token response into the storage model shared by initial grants and refreshes.
 * @param {any} payload Provider response JSON.
 * @param {"github" | "gitlab" | "codeberg"} provider Provider identifier.
 * @param {string} clientId Public OAuth application id.
 * @param {string} redirectUri Registered callback URI.
 * @param {string} [fallbackRefreshToken] Existing refresh token when a refresh response omits it.
 * @returns {OAuthCredential}
 */
function normalizeTokenResponse(payload, provider, clientId, redirectUri, fallbackRefreshToken = "") {
    const accessToken = String(payload?.access_token || "");
    if (!accessToken || accessToken.length > 8192) throw new Error(`${provider} returned an invalid OAuth access token.`);
    const expiresIn = Number(payload?.expires_in);
    return {
        kind: "oauth",
        accessToken,
        refreshToken: String(payload?.refresh_token || fallbackRefreshToken || ""),
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
        provider,
        clientId,
        redirectUri,
        tokenType: String(payload?.token_type || "Bearer"),
    };
}

/**
 * Exchanges a validated authorization code using the PKCE verifier and no client secret.
 * @param {any} pending Validated session record.
 * @param {string} code Authorization code from the scrubbed callback.
 * @returns {Promise<OAuthCredential>}
 */
async function exchangeAuthorizationCode(pending, code) {
    const provider = getOAuthProvider(pending.provider);
    const body = new URLSearchParams({
        client_id: pending.client_id,
        code,
        code_verifier: pending.verifier,
        grant_type: "authorization_code",
        redirect_uri: pending.redirect_uri,
    });
    let response;
    try {
        response = await fetch(provider.tokenUrl, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            body,
            cache: "no-store",
        });
    } catch {
        throw new Error(`${provider.provider} OAuth token exchange was blocked by the browser or network.`);
    }
    if (!response.ok) throw await buildTokenError(response, provider.provider);
    return normalizeTokenResponse(
        await response.json(),
        provider.provider,
        pending.client_id,
        pending.redirect_uri,
    );
}

/**
 * Consumes an OAuth callback, scrubbing its code/state query before validation or token exchange.
 * The callback must exactly match the registered same-origin deployment root and a fresh session-bound state record.
 * @param {Window} browserWindow Active browser window.
 * @param {string} [basePath] Deployment root containing index.html.
 * @returns {Promise<OAuthCallbackResult | null>}
 */
export async function consumeOAuthCallback(browserWindow, basePath = "/") {
    const callbackUrl = new URL(browserWindow.location.href);
    if (!callbackUrl.searchParams.has("oauth_provider")) return null;
    const callbackProvider = String(callbackUrl.searchParams.get("oauth_provider") || "");
    const redirectUri = buildRedirectUri(browserWindow.location, basePath, callbackProvider);
    const expectedUrl = new URL(redirectUri);
    browserWindow.history.replaceState(null, "", expectedUrl.pathname);

    if (callbackUrl.origin !== expectedUrl.origin || callbackUrl.pathname !== expectedUrl.pathname || callbackUrl.hash) {
        throw new Error("The OAuth callback did not use the registered zeitberg redirect URI.");
    }
    for (const key of callbackUrl.searchParams.keys()) {
        if (!OAUTH_CALLBACK_PARAMETERS.has(key)) throw new Error("The OAuth callback contains unsupported parameters.");
        if (callbackUrl.searchParams.getAll(key).length !== 1) {
            throw new Error("The OAuth callback contains duplicate parameters.");
        }
    }

    const stored = browserWindow.sessionStorage.getItem(OAUTH_PENDING_KEY);
    browserWindow.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    let pending;
    try {
        pending = JSON.parse(stored || "null");
    } catch {
        pending = null;
    }
    if (!pending || Number(pending.version) !== OAUTH_PENDING_VERSION) throw new Error("No matching OAuth authorization session was found.");
    if (Date.now() - Number(pending.created_at) > OAUTH_PENDING_MAX_AGE_MS || Number(pending.created_at) > Date.now() + 60_000) {
        throw new Error("The OAuth authorization session expired. Start it again.");
    }
    const provider = callbackProvider;
    if (provider !== pending.provider || !equalState(String(pending.state || ""), String(callbackUrl.searchParams.get("state") || ""))) {
        throw new Error("The OAuth callback state does not match this browser session.");
    }
    if (String(pending.redirect_uri || "") !== redirectUri) throw new Error("The OAuth callback redirect URI does not match this deployment.");
    const providerError = String(callbackUrl.searchParams.get("error") || "");
    if (providerError) throw new Error(`${provider} authorization was not granted (${providerError.slice(0, 80)}).`);
    const code = String(callbackUrl.searchParams.get("code") || "");
    if (!code || code.length > 4096) throw new Error("The OAuth callback did not contain a valid authorization code.");

    return {
        credential: await exchangeAuthorizationCode(pending, code),
        intent: normalizeOAuthIntent(pending.intent),
    };
}

/**
 * Refreshes an expiring OAuth credential when it is within one minute of expiry.
 * Non-expiring grants and still-valid access tokens are returned unchanged; a provider rejection requires explicit re-authentication.
 * @param {import("./config.js").WorkspaceCredentialRecord} credential Stored credential record.
 * @returns {Promise<import("./config.js").WorkspaceCredentialRecord>}
 */
export async function refreshOAuthCredential(credential) {
    if (credential.kind !== "oauth") return credential;
    const expiresAt = Number(credential.expiresAt) || 0;
    if (!expiresAt || expiresAt - Date.now() > OAUTH_REFRESH_SKEW_MS) return credential;
    if (!credential.refreshToken || !credential.provider || !credential.clientId || !credential.redirectUri) {
        throw new Error("The OAuth session expired and cannot be refreshed. Authenticate again.");
    }
    if (credential.provider === "github") {
        if (credential.clientId !== GITHUB_CLIENT_ID) throw new Error("Unknown GitHub OAuth application. Authenticate again.");
        const payload = await requestGitHubRelay(GITHUB_RELAY_URL, { action: "refresh", refresh_token: credential.refreshToken });
        if (payload.error) throw new Error("The GitHub session could not be refreshed. Authenticate again.");
        return normalizeTokenResponse(payload, "github", GITHUB_CLIENT_ID, "https://github.com/login/device", credential.refreshToken);
    }
    const provider = getOAuthProvider(credential.provider);
    const body = new URLSearchParams({
        client_id: credential.clientId,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        redirect_uri: credential.redirectUri,
    });
    let response;
    try {
        response = await fetch(provider.tokenUrl, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            body,
            cache: "no-store",
        });
    } catch {
        throw new Error(`${provider.provider} OAuth refresh was blocked by the browser or network.`);
    }
    if (!response.ok) throw await buildTokenError(response, provider.provider);
    return normalizeTokenResponse(
        await response.json(),
        provider.provider,
        credential.clientId,
        credential.redirectUri,
        credential.refreshToken,
    );
}

export { OAUTH_PENDING_KEY };

/**
 * Sends one bounded request to the deployment's relay. Tokens stay in POST bodies
 * and no cookies, redirects or cached responses are used. Error bodies are never
 * reflected into the UI because an intermediary may include sensitive details.
 * @param {string} relayUrl Trusted first-party deployment configuration.
 * @param {Record<string, string>} body Fixed device, token or refresh request.
 * @param {AbortSignal} [signal] Cancellation when the login dialog closes.
 * @returns {Promise<any>}
 */
async function requestGitHubRelay(relayUrl, body, signal) {
    if (!relayUrl || new URL(relayUrl).protocol !== "https:") throw new Error("GitHub authorization relay is not configured.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new DOMException("Authorization cancelled", "AbortError");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 20_000);
    try {
        const response = await fetch(relayUrl, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal,
        });
        if (response.status === 429) return { error: "rate_limited" };
        if (!response.ok) throw new Error("GitHub authorization relay is unavailable. Please try again.");
        const result = await response.json();
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid GitHub authorization response.");
        return result;
    } catch (error) {
        if (signal?.aborted) throw new DOMException("Authorization cancelled", "AbortError");
        throw new Error("GitHub authorization could not reach the relay. Please try again.");
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

/**
 * Waits between polls without blocking the UI; cancellation clears the timer and
 * listener immediately so closing the dialog cannot leave hidden polling behind.
 * @param {number} milliseconds Provider-directed polling delay.
 * @param {AbortSignal} signal Dialog lifetime.
 * @returns {Promise<void>}
 */
function waitForDevicePoll(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException("Authorization cancelled", "AbortError")); return; }
        const abort = () => { clearTimeout(timer); reject(new DOMException("Authorization cancelled", "AbortError")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
        signal.addEventListener("abort", abort, { once: true });
    });
}

/**
 * Performs GitHub device authorization through the small CORS relay, then returns
 * the same credential model as PKCE. Pending device codes stay in memory only.
 * The caller displays the user code and an explicit link to GitHub; no popup or
 * redirect is required. Respect slow_down, rate limits, expiry and cancellation.
 */
export class GitHubDeviceFlow {
    /**
     * Binds trusted deployment settings and injectable timing for deterministic tests.
     * @param {string} [relayUrl] Relay URL from source-controlled deployment config.
     * @param {{now?: () => number, wait?: (ms: number, signal: AbortSignal) => Promise<void>}} [timing] Test clock and delay.
     */
    constructor(relayUrl = GITHUB_RELAY_URL, { now = Date.now, wait = waitForDevicePoll } = {}) {
        this.relayUrl = relayUrl;
        this.now = now;
        this.wait = wait;
    }

    /**
     * Starts one grant and polls until explicitly authorized, denied, expired or cancelled.
     * @param {(code: string) => void} showCode Displays the public one-time user verification code.
     * @param {AbortSignal} signal Dialog lifecycle cancellation signal.
     * @returns {Promise<OAuthCredential>}
     */
    async authorize(showCode, signal) {
        const device = await requestGitHubRelay(this.relayUrl, { action: "device" }, signal);
        if (device.error || device.verification_uri !== "https://github.com/login/device" ||
            typeof device.device_code !== "string" || !/^[A-Za-z0-9_.-]{1,8192}$/.test(device.device_code) ||
            typeof device.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/.test(device.user_code) ||
            !Number.isFinite(device.expires_in) || device.expires_in <= 0) {
            throw new Error("GitHub device authorization could not be started. Please try again.");
        }
        const expires = this.now() + Math.min(device.expires_in, 900) * 1000;
        let interval = Math.max(5, Number(device.interval) || 5) * 1000;
        if (signal.aborted) throw new DOMException("Authorization cancelled", "AbortError");
        showCode(device.user_code);
        while (this.now() < expires) {
            await this.wait(Math.min(interval, expires - this.now()), signal);
            if (signal.aborted) throw new DOMException("Authorization cancelled", "AbortError");
            if (this.now() >= expires) break;
            const payload = await requestGitHubRelay(this.relayUrl, { action: "token", device_code: device.device_code }, signal);
            if (payload.error === "authorization_pending") continue;
            if (payload.error === "slow_down") { interval += 5000; continue; }
            if (payload.error === "rate_limited") { interval = Math.max(interval, 60_000); continue; }
            if (payload.error === "access_denied") throw new Error("GitHub authorization was declined.");
            if (payload.error === "expired_token") break;
            if (payload.error) throw new Error("GitHub authorization failed. Please start again.");
            if (signal.aborted) throw new DOMException("Authorization cancelled", "AbortError");
            return normalizeTokenResponse(payload, "github", GITHUB_CLIENT_ID, "https://github.com/login/device");
        }
        throw new Error("The GitHub authorization code expired. Please start again.");
    }
}
