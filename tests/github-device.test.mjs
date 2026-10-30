import assert from "node:assert/strict";
import test from "node:test";
import { GITHUB_CLIENT_ID, GITHUB_RELAY_URL, GitHubDeviceFlow, refreshOAuthCredential } from "../oauth.js";

const device = { device_code: "test-device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 };

test("device flow respects pending, slow_down and relay throttling before returning the common OAuth credential", async (context) => {
    const responses = [device, { error: "authorization_pending" }, { error: "slow_down" }, { error: "rate_limited" }, { access_token: "test-token", refresh_token: "test-refresh", expires_in: 28800 }];
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body), options });
        return Response.json(responses.shift());
    });
    let time = 0;
    const waits = [];
    const flow = new GitHubDeviceFlow("https://relay.example/", { now: () => time, wait: async (delay) => { waits.push(delay); time += delay; } });
    const shown = [];
    const result = await flow.authorize((code) => shown.push(code), new AbortController().signal);
    assert.deepEqual(shown, ["ABCD-EFGH"]);
    assert.deepEqual(waits, [5000, 5000, 10000, 60000]);
    assert.equal(result.provider, "github");
    assert.equal(result.clientId, GITHUB_CLIENT_ID);
    assert.equal(result.accessToken, "test-token");
    assert.equal(result.refreshToken, "test-refresh");
    assert.equal(result.redirectUri, "https://github.com/login/device");
    assert.ok(calls.every(({ url, options }) => url === "https://relay.example/" && options.credentials === "omit" && options.redirect === "error" && options.cache === "no-store"));
    assert.deepEqual(calls[0].body, { action: "device" });
    assert.deepEqual(calls[1].body, { action: "token", device_code: "test-device" });
});

test("device flow expires without polling past the code lifetime", async (context) => {
    let calls = 0;
    context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ ...device, expires_in: 5 }); });
    let time = 0;
    const flow = new GitHubDeviceFlow("https://relay.example/", { now: () => time, wait: async (delay) => { time += delay; } });
    await assert.rejects(flow.authorize(() => {}, new AbortController().signal), /expired/);
    assert.equal(calls, 1);
});

test("closing the device dialog prevents later polls and never returns a grant", async (context) => {
    let calls = 0;
    context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(device); });
    const controller = new AbortController();
    const flow = new GitHubDeviceFlow("https://relay.example/", { wait: async () => controller.abort() });
    await assert.rejects(flow.authorize(() => {}, controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
});

test("device authorization rejects a foreign verification link before showing a code", async (context) => {
    context.mock.method(globalThis, "fetch", async () => Response.json({ ...device, verification_uri: "https://evil.example/" }));
    const flow = new GitHubDeviceFlow("https://relay.example/");
    await assert.rejects(flow.authorize(() => assert.fail("must not display untrusted code"), new AbortController().signal), /could not be started/);
});

test("GitHub refresh rejects an unknown app before making a network request", async (context) => {
    context.mock.method(globalThis, "fetch", () => assert.fail("must not send refresh token"));
    await assert.rejects(refreshOAuthCredential({ kind: "oauth", provider: "github", clientId: "other-app", accessToken: "old", refreshToken: "refresh", expiresAt: 1, redirectUri: "https://evil.example/" }), /Unknown GitHub/);
});

test("GitHub refresh only uses the deployment relay, not a URL supplied by stored credentials", async (context) => {
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return Response.json({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 28800 });
    });
    const result = await refreshOAuthCredential({ kind: "oauth", provider: "github", clientId: GITHUB_CLIENT_ID, accessToken: "old", refreshToken: "old-refresh", expiresAt: 1, redirectUri: "https://evil.example/" });
    assert.deepEqual(calls, [{ url: GITHUB_RELAY_URL, body: { action: "refresh", refresh_token: "old-refresh" } }]);
    assert.equal(result.accessToken, "new-token");
    assert.equal(result.refreshToken, "new-refresh");
    assert.equal(result.redirectUri, "https://github.com/login/device");
});

test("GitHub device denial and upstream failures never expose response details", async (context) => {
    let replies = [device, { error: "access_denied", error_description: "secret response details" }];
    context.mock.method(globalThis, "fetch", async () => Response.json(replies.shift()));
    const flow = new GitHubDeviceFlow("https://relay.example/", { wait: async () => {} });
    await assert.rejects(flow.authorize(() => {}, new AbortController().signal), /declined/);
    replies = [device, { error: "unknown", error_description: "secret response details" }];
    await assert.rejects(flow.authorize(() => {}, new AbortController().signal), /authorization failed/);
});
