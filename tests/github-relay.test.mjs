import assert from "node:assert/strict";
import test from "node:test";
import relay from "../serverless/github-auth/handler.js";

const event = (body = { action: "device" }, overrides = {}) => ({ path: "/", httpMethod: "POST", headers: { origin: "https://zeitberg.io", "content-type": "application/json", "x-forwarded-for": "test-address" }, body: JSON.stringify(body), ...overrides });

test("relay only forwards fixed GitHub grants and strips unrelated response fields", async () => {
    const calls = [];
    const handle = relay.createRelay({ fetch: async (url, options) => {
        calls.push([url, Object.fromEntries(options.body), options]);
        return Response.json({ device_code: "test-device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5, unwanted: "not forwarded" });
    } });
    const result = await handle(event());
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["Access-Control-Allow-Origin"], "https://zeitberg.io");
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(JSON.parse(result.body).unwanted, undefined);
    assert.equal(calls[0][0], "https://github.com/login/device/code");
    assert.deepEqual(calls[0][1], { client_id: "Iv23liNvkhSh2mYH0oPw" });
    assert.equal(calls[0][2].redirect, "error");
});

test("relay rejects foreign origins, arbitrary targets, fields, clients, methods and oversized inputs before upstream I/O", async () => {
    const handle = relay.createRelay({ fetch: () => { throw new Error("Must not fetch"); } });
    for (const request of [event({}, { headers: { origin: "https://evil.example" } }), event({ action: "device", url: "https://evil.example" }), event({ action: "device", client_id: "other" }), event({ action: "token", device_code: "bad code" }), event({}, { path: "/other" }), event({}, { queryStringParameters: { token: "secret" } }), event({}, { httpMethod: "GET" }), event({}, { body: "x".repeat(20_000) }), event({}, { body: "{" })]) {
        assert.ok((await handle(request)).statusCode >= 400);
    }
    const denied = await handle(event({}, { headers: { origin: "null" } }));
    assert.equal(denied.headers["Access-Control-Allow-Origin"], undefined);
    assert.equal((await handle(event({}, { httpMethod: "OPTIONS" }))).statusCode, 204);
});

test("relay supports token polling and secret-free refresh without reflecting upstream errors", async () => {
    const calls = [];
    const handle = relay.createRelay({ fetch: async (url, options) => {
        calls.push([url, Object.fromEntries(options.body)]);
        return Response.json({ error: "unknown", error_description: "sensitive upstream details" });
    } });
    assert.deepEqual(JSON.parse((await handle(event({ action: "token", device_code: "test-code" }))).body), { error: "github_authentication_failed" });
    await handle(event({ action: "refresh", refresh_token: "test-refresh" }));
    assert.equal(calls[0][1].grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(calls[1][1].grant_type, "refresh_token");
    assert.equal(calls[1][1].client_secret, undefined);
});

test("relay limits upstream requests and resets ephemeral counters", async () => {
    let now = 60_000;
    let calls = 0;
    const handle = relay.createRelay({ now: () => now, fetch: async () => { calls++; return Response.json({ error: "authorization_pending" }); } });
    for (let i = 0; i < 30; i++) await handle(event());
    assert.equal((await handle(event())).statusCode, 429);
    assert.equal(calls, 30);
    now += 60_000;
    assert.equal((await handle(event())).statusCode, 200);
    assert.equal(calls, 31);
});
