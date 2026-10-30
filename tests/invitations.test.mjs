import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { InvitationService, INVITATION_LIFETIME_MS, parseInvitationLink, consumeInvitationLink } from "../invitations.js";
import { formatCapabilityLink } from "../routing.js";
import { MemoryStorage } from "../demo.js";
const { createInvitationHandler } = createRequire(import.meta.url)("../serverless/invitations/handler.js");

test("default invitation transport does not bind browser fetch to the service", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function () {
        assert.ok(this === undefined || this === globalThis);
        return Promise.resolve(new Response('{}', { status: 200 }));
    };
    try {
        const service = new InvitationService({ endpoint: "https://invites.example/" });
        assert.deepEqual(await service.call({ action: "resolve", id: "a".repeat(32) }), {});
    } finally {
        globalThis.fetch = originalFetch;
    }
});

/** Builds the real encryption + handler pipeline with isolated, inspectable storage. */
function fixture() {
    let time = Date.now();
    const records = new Map();
    const requests = [];
    const store = { get: async (id) => records.get(id), put: async (id, value) => records.set(id, value),
        remove: async (id) => records.delete(id), count: async () => records.size };
    const handler = createInvitationHandler({ store, now: () => time });
    const event = (body, overrides = {}) => ({ httpMethod: "POST", path: "/", headers: {
        origin: "https://zeitberg.io", "content-type": "application/json", "x-forwarded-for": "test-client" }, body: JSON.stringify(body), ...overrides });
    const storage = new MemoryStorage();
    const service = new InvitationService({ endpoint: "https://invites.example/", storage, now: () => time,
        request: async (_url, options) => {
            requests.push(JSON.parse(options.body));
            const result = await handler(event(JSON.parse(options.body)));
            return new Response(result.body, { status: result.statusCode, headers: result.headers });
        } });
    const capability = formatCapabilityLink({ version: 1, component: "expenses", panel: "main", state: {},
        workspace: { provider: "github", repositoryUrl: "https://github.com/example/private", ref: "main", workspacePath: "zeitberg.json" } }, "fictional-secret", "https://zeitberg.io", "/");
    return { records, requests, handler, event, service, storage, capability, advance: (amount) => { time += amount; } };
}

test("encrypted invitations round-trip without uploading tokens, capability URLs or keys", async () => {
    const f = fixture();
    const url = await f.service.create(f.capability, "connection");
    assert.match(url, /^https:\/\/zeitberg.io\/join\/[a-f0-9]{32}#k=[\w-]{43}$/);
    const invitation = parseInvitationLink(url);
    const result = await f.service.resolve(invitation);
    assert.equal(result.credential, "fictional-secret");
    assert.equal(result.route.workspace.repositoryUrl, "https://github.com/example/private");
    const transmitted = JSON.stringify([...f.requests, ...f.records.values()]);
    for (const secret of ["fictional-secret", invitation.key, f.capability, "github.com/example/private"]) assert.equal(transmitted.includes(secret), false);
    assert.equal(f.records.get(invitation.id).revokeToken, undefined);
    assert.deepEqual(f.requests[1], { action: "resolve", id: invitation.id });
    await f.service.revoke(invitation.id);
    assert.equal(f.service.receipts().length, 0);
    await assert.rejects(f.service.resolve(invitation), /expired or was revoked/);
});

test("wrong key, tampered ciphertext and authenticated expiry fail closed", async () => {
    const f = fixture();
    const invitation = parseInvitationLink(await f.service.create(f.capability, "a"));
    await assert.rejects(f.service.resolve({ ...invitation, key: "A".repeat(43) }), /invalid, altered/);
    const record = f.records.get(invitation.id);
    const original = record.ciphertext;
    record.ciphertext = (original[0] === "A" ? "B" : "A") + original.slice(1);
    await assert.rejects(f.service.resolve(invitation), /invalid, altered/);
    record.ciphertext = original;
    f.advance(INVITATION_LIFETIME_MS + 1);
    await assert.rejects(f.service.resolve(invitation), /expired or was revoked/);
    record.expiresAt += INVITATION_LIFETIME_MS;
    await assert.rejects(f.service.resolve(invitation), /invalid, altered/);
});

test("invitation fragments are scrubbed before validation, including malformed links", () => {
    let scrubbed;
    const browser = { location: new URL("https://zeitberg.io/join/bad#k=secret"), history: { replaceState: (_state, _title, path) => { scrubbed = path; } } };
    assert.throws(() => consumeInvitationLink(browser), /Invalid/);
    assert.equal(scrubbed, "/");
    assert.equal(parseInvitationLink("https://zeitberg.io/expenses"), null);
    assert.throws(() => parseInvitationLink(`https://evil.example/join/${"a".repeat(32)}#k=${"A".repeat(43)}`), /origin/);
});

test("invitation API strictly rejects arbitrary fields, foreign origins and wrong revocation tokens", async () => {
    const f = fixture();
    assert.equal((await f.handler(f.event({}, { headers: { origin: "https://evil.example" } }))).statusCode, 403);
    assert.equal((await f.handler(f.event({}, { httpMethod: "OPTIONS" }))).statusCode, 204);
    assert.equal((await f.handler(f.event({ action: "resolve", id: "a".repeat(32), endpoint: "https://evil.example" }))).statusCode, 400);
    assert.equal((await f.handler(f.event({ action: "create", version: 1, iv: "x", ciphertext: "x" }))).statusCode, 400);
    const invitation = parseInvitationLink(await f.service.create(f.capability, "a"));
    assert.equal((await f.handler(f.event({ action: "revoke", id: invitation.id, revokeToken: "A".repeat(43) }))).statusCode, 403);
    assert.equal(f.records.size, 1);
});

test("creation has a small storage ceiling and per-client quota; storage errors reveal no details", async () => {
    const f = fixture();
    const input = { action: "create", version: 1, iv: "A".repeat(16), ciphertext: "A".repeat(24) };
    for (let index = 0; index < 5; index++) assert.equal((await f.handler(f.event(input))).statusCode, 201);
    assert.equal((await f.handler(f.event(input))).statusCode, 429);
    const full = createInvitationHandler({ store: { count: async () => 1000 } });
    assert.equal((await full(f.event(input))).statusCode, 429);
    const broken = createInvitationHandler({ store: { count: async () => { throw new Error("secret-provider-detail"); } } });
    const result = await broken(f.event(input));
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.includes("secret-provider-detail"), false);
});

test("failed receipt storage revokes the uploaded invitation", async () => {
    const f = fixture();
    let writes = 0;
    const original = f.storage.setItem.bind(f.storage);
    f.storage.setItem = (...args) => { if (++writes === 2) throw new Error("Full"); original(...args); };
    await assert.rejects(f.service.create(f.capability, "a"), /invitation was revoked/);
    assert.equal(f.records.size, 0);
});
