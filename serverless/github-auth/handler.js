const { createHash } = require("node:crypto");

const CLIENT_ID = "Iv23liNvkhSh2mYH0oPw";
const ORIGINS = new Set(["https://zeitberg.io", "http://localhost:8000", "http://127.0.0.1:8000"]);
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Creates a narrowly scoped GitHub device-flow relay. All credentials exist only
 * for the duration of a request. No logs, cookies, persistence or arbitrary URLs
 * are used. CORS is a browser policy, not authentication: warm-instance limits
 * provide best-effort abuse protection, not a durable quota or spending cap.
 * @param {{fetch?: typeof fetch, now?: () => number}} [dependencies] Testable I/O and clock.
 * @returns {(event: any) => Promise<{statusCode: number, headers: Object, body: string}>}
 */
function createRelay({ fetch: request = fetch, now = Date.now } = {}) {
    const buckets = new Map();
    let windowStart = 0;
    let requestCount = 0;

    /**
     * Applies a bounded, in-memory rate limit before any GitHub traffic. Hashed IP
     * counters expire after a minute and are never logged or written to disk.
     * @param {string} ip Provider-forwarded client address (not an identity guarantee).
     * @returns {boolean} Whether this request may reach GitHub.
     */
    function allow(ip) {
        const time = now();
        if (time - windowStart >= 60_000) {
            windowStart = time;
            requestCount = 0;
            buckets.clear();
        }
        if (++requestCount > 120) return false;
        const key = createHash("sha256").update(ip).digest("hex");
        const count = (buckets.get(key) || 0) + 1;
        buckets.set(key, count);
        return count <= 30;
    }

    /**
     * Handles one Scaleway HTTP event. A fixed action map prevents SSRF and open
     * proxy use; strict fields prevent unrelated grants, scopes or client IDs.
     * @param {any} event Scaleway Node HTTP event.
     * @returns {Promise<{statusCode: number, headers: Object, body: string}>}
     */
    return async function handle(event) {
        const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
        const origin = headers.origin || "";
        const allowed = ORIGINS.has(origin);
        /** Builds a non-cacheable JSON response without reflecting request secrets. @param {number} statusCode HTTP status. @param {Object} payload Safe response fields. @returns {{statusCode: number, headers: Object, body: string}} */
        const reply = (statusCode, payload) => ({
            statusCode,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
                "X-Content-Type-Options": "nosniff",
                "Vary": "Origin",
                ...(allowed ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" } : {}),
                ...(statusCode === 429 ? { "Retry-After": "60" } : {}),
            },
            body: statusCode === 204 ? "" : JSON.stringify(payload),
        });
        if (!allowed) return reply(403, { error: "origin_not_allowed" });
        if (event.path !== "/" || Object.keys(event.queryStringParameters || {}).length) return reply(400, { error: "invalid_request" });
        if (event.httpMethod === "OPTIONS") return reply(204, {});
        if (event.httpMethod !== "POST") return reply(405, { error: "method_not_allowed" });
        if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] || "")) return reply(415, { error: "unsupported_media_type" });
        if (typeof event.body !== "string" || event.body.length > 16_384) return reply(413, { error: "request_too_large" });
        let input;
        try {
            input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
        } catch {
            return reply(400, { error: "invalid_request" });
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) return reply(400, { error: "invalid_request" });
        const fields = input.action === "device" ? ["action"] : input.action === "token" ? ["action", "device_code"] : input.action === "refresh" ? ["action", "refresh_token"] : [];
        if (!fields.length || Object.keys(input).some((key) => !fields.includes(key))) return reply(400, { error: "invalid_request" });
        const body = new URLSearchParams({ client_id: CLIENT_ID });
        if (input.action !== "device") {
            const name = input.action === "token" ? "device_code" : "refresh_token";
            if (typeof input[name] !== "string" || !/^[A-Za-z0-9_.-]{1,8192}$/.test(input[name])) return reply(400, { error: "invalid_request" });
            body.set(name, input[name]);
            body.set("grant_type", input.action === "token" ? DEVICE_GRANT : "refresh_token");
        }
        if (!allow(headers["x-forwarded-for"] || "unknown")) return reply(429, { error: "rate_limited" });
        const endpoint = input.action === "device" ? "https://github.com/login/device/code" : "https://github.com/login/oauth/access_token";
        try {
            const response = await request(endpoint, {
                method: "POST", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
                body, signal: AbortSignal.timeout(10_000),
            });
            const payload = await response.json();
            if (payload.error) {
                const known = ["authorization_pending", "slow_down", "expired_token", "access_denied", "incorrect_device_code", "incorrect_client_credentials", "device_flow_disabled", "bad_refresh_token"];
                const error = known.includes(payload.error) ? payload.error : "github_authentication_failed";
                return reply(response.status === 429 ? 429 : 200, { error });
            }
            if (!response.ok) return reply(502, { error: "github_unavailable" });
            const names = input.action === "device"
                ? ["device_code", "user_code", "verification_uri", "expires_in", "interval"]
                : ["access_token", "refresh_token", "expires_in", "refresh_token_expires_in", "token_type", "scope"];
            const result = Object.fromEntries(names.filter((key) => typeof payload[key] === "string" || typeof payload[key] === "number").map((key) => [key, payload[key]]));
            if (input.action === "device" ? !result.device_code || !result.user_code || result.verification_uri !== "https://github.com/login/device" : !result.access_token) {
                return reply(502, { error: "invalid_github_response" });
            }
            return reply(200, result);
        } catch {
            return reply(502, { error: "github_unavailable" });
        }
    };
}

module.exports = { handle: createRelay(), createRelay };
