import { normalizeRouteBasePath, parseCapabilityLink } from "./routing.js";

// Deployment-owned endpoint only. A workspace or invitation cannot choose where
// encrypted records or revocation credentials are sent.
export const INVITATION_SERVICE_URL = "https://zeitbergauthjktlgxby-invitations.functions.fnc.fr-par.scw.cloud/";
export const INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = "zeitberg:invitation-revocations:v1";
const AAD = new TextEncoder().encode("zeitberg-invitation-v1");

/** Encodes binary material without URL punctuation or padding.
 * @param {Uint8Array} bytes Binary input.
 * @returns {string} Base64url representation.
 */
function encode(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes a bounded, canonical base64url field before cryptographic use.
 * @param {string} value Encoded bytes.
 * @param {number} maxBytes Maximum permitted decoded size.
 * @returns {Uint8Array<ArrayBuffer>} Validated binary input.
 */
function decode(value, maxBytes) {
    if (typeof value !== "string" || !/^[\w-]+$/.test(value) || value.length > Math.ceil(maxBytes * 4 / 3)) throw new Error("Invalid invitation data.");
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    if (bytes.length > maxBytes || encode(bytes) !== value) throw new Error("Invalid invitation data.");
    return bytes;
}

/**
 * Browser-side invitation encryption and fixed-endpoint transport. Only ciphertext
 * is uploaded; the random AES key stays in the URL fragment. Browser storage keeps
 * revocation receipts, not invitation keys or a second copy of provider tokens.
 */
export class InvitationService {
    /**
     * Injects testable transport/storage while production uses only the fixed deployment.
     * @param {{endpoint?: string, request?: typeof fetch, storage?: Storage | null, now?: () => number}} [options] Local dependencies.
     */
    constructor({ endpoint = INVITATION_SERVICE_URL, request = (input, init) => fetch(input, init), storage = null, now = Date.now } = {}) {
        this.endpoint = endpoint;
        this.request = request;
        this.storage = storage;
        this.now = now;
    }

    /**
     * Exchanges a bounded JSON request without cookies, redirects or response caching.
     * Provider secrets and URL fragment keys are never included in these requests.
     * @param {Object} payload Strict service operation.
     * @returns {Promise<any>} Validated JSON response; raw upstream errors are not exposed.
     */
    async call(payload) {
        if (!this.endpoint) throw new Error("Encrypted invitation sharing is not configured yet.");
        const response = await this.request(this.endpoint, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(response.status === 404 || response.status === 410 ? "This invitation expired or was revoked."
            : response.status === 429 ? "Too many invitation requests. Try again later." : "The invitation service is unavailable. Try again later.");
        const text = await response.text();
        if (text.length > 32768) throw new Error("Invalid invitation response.");
        return JSON.parse(text);
    }

    /**
     * Encrypts a validated capability with a fresh 256-bit key and 96-bit IV.
     * The authenticated plaintext also carries an expiry, preventing a modified
     * storage response from extending the invitation's original lifetime.
     * @param {string} capability Existing validated bearer URL.
     * @param {string} connectionId Browser connection owning the revocation receipt.
     * @param {string} basePath Application deployment prefix.
     * @returns {Promise<string>} Short URL containing only an ID and fragment key.
     */
    async create(capability, connectionId, basePath = "/") {
        parseCapabilityLink(capability, basePath);
        if (!this.storage) throw new Error("Browser storage is required to retain invitation revocation controls.");
        // Verify storage before uploading; users must be able to revoke what they create.
        this.storage.setItem(STORAGE_KEY, JSON.stringify(this.receipts()));
        const expiresAt = this.now() + INVITATION_LIFETIME_MS;
        const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, capability, expiresAt }));
        if (plaintext.length > 16384) throw new Error("This workspace link is too large to shorten.");
        const keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, key, plaintext);
        const result = await this.call({ action: "create", version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) });
        if (!/^[a-f0-9]{32}$/.test(result.id) || !/^[\w-]{43}$/.test(result.revokeToken)) throw new Error("Invalid invitation response.");
        const receipt = { id: result.id, revokeToken: result.revokeToken, connectionId, expiresAt };
        try { this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.receipts(), receipt])); }
        catch {
            await this.call({ action: "revoke", id: receipt.id, revokeToken: receipt.revokeToken });
            throw new Error("Could not retain revocation controls; the invitation was revoked.");
        }
        const url = new URL(`${normalizeRouteBasePath(basePath)}join/${result.id}`, new URL(capability).origin);
        url.hash = `k=${encode(keyBytes)}`;
        return url.toString();
    }

    /**
     * Resolves ciphertext and authenticates it locally before handing the decoded
     * capability to the existing provider/locator validator. No provider request
     * happens on a malformed, tampered, revoked, or expired invitation.
     * @param {{id: string, key: string}} invitation Scrubbed short-link fields.
     * @param {string} basePath Application deployment prefix.
     * @returns {Promise<import("./routing.js").CapabilityLink>} Validated original capability.
     */
    async resolve(invitation, basePath = "/") {
        if (!/^[a-f0-9]{32}$/.test(invitation.id)) throw new Error("Invalid invitation link.");
        const keyBytes = decode(invitation.key, 32);
        if (keyBytes.length !== 32) throw new Error("Invalid invitation key.");
        const result = await this.call({ action: "resolve", id: invitation.id });
        try {
            if (result.version !== 1 || result.expiresAt <= this.now()) throw new Error();
            const iv = decode(result.iv, 12);
            if (iv.length !== 12) throw new Error();
            const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
            const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, key, decode(result.ciphertext, 16400));
            const payload = JSON.parse(new TextDecoder().decode(plaintext));
            if (payload.version !== 1 || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= this.now()) throw new Error();
            const capability = parseCapabilityLink(payload.capability, basePath);
            // Revalidation below preserves the usual supported-provider and route rules.
            return capability;
        } catch { throw new Error("This invitation is invalid, altered, or expired."); }
    }

    /** Reads bounded, unexpired revocation receipts without exposing invitation keys.
     * @returns {{id: string, revokeToken: string, connectionId: string, expiresAt: number}[]} Browser-local receipts.
     */
    receipts() {
        try {
            const values = JSON.parse(this.storage?.getItem(STORAGE_KEY) || "[]");
            return Array.isArray(values) ? values.filter((item) => item && /^[a-f0-9]{32}$/.test(item.id) && /^[\w-]{43}$/.test(item.revokeToken)
                && typeof item.connectionId === "string" && item.expiresAt > this.now()).slice(-1000) : [];
        } catch { return []; }
    }

    /** Revokes a stored invitation lookup; already-imported provider access is unaffected.
     * @param {string} id Invitation ID created by this browser.
     * @returns {Promise<void>}
     */
    async revoke(id) {
        const receipt = this.receipts().find((item) => item.id === id);
        if (!receipt) throw new Error("No revocation receipt is available in this browser.");
        await this.call({ action: "revoke", id, revokeToken: receipt.revokeToken });
        this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.receipts().filter((item) => item.id !== id)));
    }
}

/**
 * Recognizes only this application's short-link route and validates its opaque
 * fields. Pasted links may use the deployed origin or the current local origin;
 * no service endpoint is ever taken from the pasted URL.
 * @param {string} value Candidate URL.
 * @param {string} basePath Application deployment prefix.
 * @param {string} origin Current page origin.
 * @returns {{id: string, key: string} | null} Parsed invitation, or an ordinary URL.
 */
export function parseInvitationLink(value, basePath = "/", origin = "https://zeitberg.io") {
    const url = new URL(value);
    const prefix = `${normalizeRouteBasePath(basePath)}join/`;
    if (!url.pathname.startsWith(prefix)) return null;
    if (![origin, "https://zeitberg.io"].includes(url.origin) || url.search || url.username || url.password) throw new Error("Invalid invitation origin.");
    const id = url.pathname.slice(prefix.length);
    const match = url.hash.match(/^#k=([\w-]{43})$/);
    if (!/^[a-f0-9]{32}$/.test(id) || !match) throw new Error("Invalid invitation link.");
    return { id, key: match[1] };
}

/** Scrubs a short-link fragment synchronously before any startup requests or UI.
 * @param {Window} browserWindow Current browser window.
 * @param {string} basePath Deployment prefix.
 * @returns {{id: string, key: string} | null} In-memory lookup fields.
 */
export function consumeInvitationLink(browserWindow, basePath = "/") {
    const prefix = `${normalizeRouteBasePath(basePath)}join/`;
    if (!browserWindow.location.pathname.startsWith(prefix)) return null;
    const original = browserWindow.location.href;
    browserWindow.history.replaceState(null, "", basePath);
    return parseInvitationLink(original, basePath, browserWindow.location.origin);
}
