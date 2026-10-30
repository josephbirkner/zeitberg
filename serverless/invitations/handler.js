const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ORIGINS = new Set(["https://zeitberg.io", "http://localhost:8000", "http://127.0.0.1:8000"]);

/** Computes a fixed-size digest for revocation credentials; raw values are never persisted.
 * @param {string} value High-entropy revocation token.
 * @returns {Buffer} SHA-256 digest.
 */
const digest = (value) => createHash("sha256").update(value).digest();

/**
 * Stores opaque invitation records in one private Paris bucket. The IAM principal
 * must be restricted to this bucket; there is no public bucket access or listing.
 * @returns {{get: Function, put: Function, remove: Function, count: Function}} Bounded storage adapter.
 */
function createObjectStore() {
    const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
    const Bucket = process.env.INVITATIONS_BUCKET;
    if (!Bucket) throw new Error("Invitation storage is not configured.");
    const client = new S3Client({ region: "fr-par", endpoint: "https://s3.fr-par.scw.cloud", maxAttempts: 2 });
    /** Sends one fixed-bucket operation with a short upstream timeout.
     * @param {any} command S3 operation built by this adapter.
     * @returns {Promise<any>} SDK result.
     */
    const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(8000) });
    return {
        /** Reads a bounded encrypted record; absence is not an exception.
         * @param {string} id Validated invitation ID.
         * @returns {Promise<Object | null>} Stored ciphertext envelope.
         */
        async get(id) {
            try {
                const result = await send(new GetObjectCommand({ Bucket, Key: `invitations/${id}.json` }));
                if (result.ContentLength > 32768) throw new Error("Oversized record");
                return JSON.parse(await result.Body.transformToString());
            } catch (error) {
                if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
                throw error;
            }
        },
        /** Persists one encrypted envelope under a server-generated, unguessable ID.
         * @param {string} id Random server ID.
         * @param {Object} record Opaque ciphertext and expiry metadata.
         * @returns {Promise<void>}
         */
        async put(id, record) {
            await send(new PutObjectCommand({ Bucket, Key: `invitations/${id}.json`, Body: JSON.stringify(record),
                ContentType: "application/json", CacheControl: "no-store" }));
        },
        /** Deletes only the explicitly authorized invitation.
         * @param {string} id Validated invitation ID.
         * @returns {Promise<void>}
         */
        async remove(id) { await send(new DeleteObjectCommand({ Bucket, Key: `invitations/${id}.json` })); },
        /** Enforces a small global storage ceiling; includes expired objects awaiting lifecycle cleanup.
         * @returns {Promise<number>} At most 1000 object count; a full page closes creation.
         */
        async count() {
            const result = await send(new ListObjectsV2Command({ Bucket, Prefix: "invitations/", MaxKeys: 1000 }));
            return result.IsTruncated ? 1000 : result.KeyCount || 0;
        },
    };
}

/**
 * Creates the encrypted-blob API independently of the stateless authentication
 * relay. Strict schemas, bounded ciphertext, short timeouts and warm-instance
 * quotas reduce abuse. Neither CORS nor these quotas are authentication or a
 * hard spending cap. No request body, token, ID, IP, or ciphertext is logged.
 * @param {{store: {get: Function, put: Function, remove: Function, count: Function}, now?: () => number}} dependencies Private storage and test clock.
 * @returns {(event: any) => Promise<{statusCode: number, headers: Object, body: string}>} Scaleway handler.
 */
function createInvitationHandler({ store, now = Date.now }) {
    let windowStart = 0;
    let total = 0;
    const clients = new Map();
    // Serialize create/count in the configured single instance to enforce capacity.
    let writes = Promise.resolve();
    /** Processes one operation, never accepting arbitrary storage paths or upstream URLs.
     * @param {any} event Scaleway HTTP event.
     * @returns {Promise<{statusCode: number, headers: Object, body: string}>} Safe response.
     */
    return async (event) => {
        const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
        const origin = headers.origin || "";
        const allowed = ORIGINS.has(origin);
        /** Returns only explicitly constructed, non-cacheable fields.
         * @param {number} statusCode HTTP status.
         * @param {Object} body Safe payload.
         * @returns {{statusCode: number, headers: Object, body: string}}
         */
        const reply = (statusCode, body) => ({ statusCode, headers: {
            "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Origin",
            ...(allowed ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } : {}),
            ...(statusCode === 429 ? { "Retry-After": "60" } : {}),
        }, body: statusCode === 204 ? "" : JSON.stringify(body) });
        if (!allowed) return reply(403, { error: "origin_not_allowed" });
        if (event.path !== "/" || Object.keys(event.queryStringParameters || {}).length) return reply(400, { error: "invalid_request" });
        if (event.httpMethod === "OPTIONS") return reply(204, {});
        if (event.httpMethod !== "POST") return reply(405, { error: "method_not_allowed" });
        if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] || "")) return reply(415, { error: "unsupported_media_type" });
        if (typeof event.body !== "string" || event.body.length > 32768) return reply(413, { error: "request_too_large" });
        let input;
        try { input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body); }
        catch { return reply(400, { error: "invalid_request" }); }
        if (!input || Array.isArray(input) || typeof input !== "object") return reply(400, { error: "invalid_request" });
        const fields = input.action === "create" ? ["action", "version", "iv", "ciphertext"]
            : input.action === "resolve" ? ["action", "id"] : input.action === "revoke" ? ["action", "id", "revokeToken"] : [];
        if (!fields.length || Object.keys(input).some((key) => !fields.includes(key))) return reply(400, { error: "invalid_request" });
        if (input.action === "create") {
            if (input.version !== 1 || !/^[\w-]{16}$/.test(input.iv) || typeof input.ciphertext !== "string" || !/^[\w-]{22,21867}$/.test(input.ciphertext)) return reply(400, { error: "invalid_request" });
        } else if (!/^[a-f0-9]{32}$/.test(input.id) || (input.action === "revoke" && !/^[\w-]{43}$/.test(input.revokeToken))) return reply(400, { error: "invalid_request" });
        const time = now();
        if (time - windowStart >= 60000) { windowStart = time; clients.clear(); total = 0; }
        const ip = digest(headers["x-forwarded-for"] || "unknown").toString("hex");
        const client = clients.get(ip) || { requests: 0, creates: 0 };
        client.requests++;
        if (input.action === "create") client.creates++;
        if (++total > 120 || client.requests > 30 || client.creates > 5) return reply(429, { error: "rate_limited" });
        clients.set(ip, client);
        try {
            if (input.action === "create") {
                const operation = writes.then(async () => {
                    if (await store.count() >= 1000) return reply(429, { error: "capacity_reached" });
                    const id = randomBytes(16).toString("hex");
                    const revokeToken = randomBytes(32).toString("base64url");
                    const expiresAt = now() + LIFETIME_MS;
                    await store.put(id, { version: 1, iv: input.iv, ciphertext: input.ciphertext, expiresAt, revokeHash: digest(revokeToken).toString("hex") });
                    return reply(201, { id, revokeToken, expiresAt });
                });
                writes = operation.then(() => {}, () => {});
                return await operation;
            }
            const record = await store.get(input.id);
            if (!record) return input.action === "revoke" ? reply(200, { revoked: true }) : reply(404, { error: "unavailable" });
            if (record.expiresAt <= now()) return reply(410, { error: "unavailable" });
            if (input.action === "resolve") return reply(200, { version: 1, iv: record.iv, ciphertext: record.ciphertext, expiresAt: record.expiresAt });
            const expected = Buffer.from(record.revokeHash, "hex");
            if (expected.length !== 32 || !timingSafeEqual(expected, digest(input.revokeToken))) return reply(403, { error: "not_authorized" });
            await store.remove(input.id);
            return reply(200, { revoked: true });
        } catch { return reply(503, { error: "storage_unavailable" }); }
    };
}

let deployedHandler;
/** Lazily constructs the private storage client; no secrets are evaluated at module import in tests.
 * @param {any} event Scaleway HTTP event.
 * @returns {Promise<Object>} Operation result.
 */
async function handle(event) {
    if (!deployedHandler) deployedHandler = createInvitationHandler({ store: createObjectStore() });
    return deployedHandler(event);
}
module.exports = { handle, createInvitationHandler };
