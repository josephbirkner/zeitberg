import assert from "node:assert/strict";
import test from "node:test";

import {
    consumeOAuthCallback,
    OAUTH_PENDING_KEY,
    refreshOAuthCredential,
    startOAuthAuthorization,
} from "../oauth.js";

/**
 * Minimal Storage implementation used to verify that OAuth state remains session-scoped.
 */
class MemoryStorage {
    constructor() {
        this.values = new Map();
    }

    /** @param {string} key @returns {string | null} */
    getItem(key) {
        return this.values.get(key) ?? null;
    }

    /** @param {string} key @param {string} value @returns {void} */
    setItem(key, value) {
        this.values.set(key, String(value));
    }

    /** @param {string} key @returns {void} */
    removeItem(key) {
        this.values.delete(key);
    }
}

test("GitLab OAuth uses S256 PKCE and restores a session-bound onboarding intent", async (context) => {
    const sessionStorage = new MemoryStorage();
    let authorizationUrl = "";
    const startWindow = {
        crypto: globalThis.crypto,
        location: {
            origin: "https://zeitberg.io",
            assign(value) {
                authorizationUrl = String(value);
            },
        },
        sessionStorage,
    };
    const intent = {
        mode: "connect",
        repositoryUrl: "https://gitlab.com/person/workspace",
        ref: "main",
        workspacePath: "zeitberg.json",
        remember: false,
    };

    await startOAuthAuthorization(/** @type {any} */ (startWindow), "gitlab", "public-client-id", intent);

    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.origin, "https://gitlab.com");
    assert.equal(authorization.pathname, "/oauth/authorize");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("scope"), "api");
    const redirectUri = new URL(String(authorization.searchParams.get("redirect_uri")));
    assert.equal(redirectUri.toString(), "https://zeitberg.io/?oauth_provider=gitlab");

    const pending = JSON.parse(sessionStorage.getItem(OAUTH_PENDING_KEY));
    const callbackLocation = new URL(redirectUri);
    callbackLocation.searchParams.set("code", "one-time-code");
    callbackLocation.searchParams.set("state", pending.state);
    let scrubbed = false;
    const callbackWindow = {
        history: {
            replaceState(_state, _title, value) {
                scrubbed = true;
                callbackLocation.href = new URL(value, callbackLocation).href;
            },
        },
        location: callbackLocation,
        sessionStorage,
    };
    context.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(scrubbed, true);
        assert.equal(String(url), "https://gitlab.com/oauth/token");
        assert.equal(options.method, "POST");
        assert.equal(options.body.get("code_verifier"), pending.verifier);
        assert.equal(options.body.get("client_secret"), null);
        return new Response(
            JSON.stringify({
                access_token: "oauth-access",
                refresh_token: "oauth-refresh",
                expires_in: 7200,
                token_type: "Bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    });

    const result = await consumeOAuthCallback(/** @type {any} */ (callbackWindow));

    assert.equal(callbackLocation.toString(), "https://zeitberg.io/");
    assert.equal(sessionStorage.getItem(OAUTH_PENDING_KEY), null);
    assert.deepEqual(result?.intent, {
        ...intent,
        expectedWorkspaceId: "",
        repositoryName: "",
        workspaceName: "",
        timezone: "",
    });
    assert.equal(result?.credential.accessToken, "oauth-access");
    assert.equal(result?.credential.refreshToken, "oauth-refresh");
    assert.equal(result?.credential.provider, "gitlab");
    assert.ok(Number(result?.credential.expiresAt) > Date.now());
});

test("OAuth callbacks scrub authorization data before rejecting a state mismatch", async (context) => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(
        OAUTH_PENDING_KEY,
        JSON.stringify({
            client_id: "public-client-id",
            created_at: Date.now(),
            intent: {
                mode: "connect",
                repositoryUrl: "https://codeberg.org/person/workspace",
                ref: "main",
                workspacePath: "zeitberg.json",
                remember: false,
            },
            provider: "codeberg",
            redirect_uri: "https://zeitberg.io/?oauth_provider=codeberg",
            state: "expected-state",
            verifier: "v".repeat(86),
            version: 1,
        }),
    );
    const location = new URL(
        "https://zeitberg.io/?oauth_provider=codeberg&code=secret-code&state=attacker-state",
    );
    let fetchCalled = false;
    context.mock.method(globalThis, "fetch", async () => {
        fetchCalled = true;
        return new Response();
    });
    const browser = {
        history: {
            replaceState(_state, _title, value) {
                location.href = new URL(value, location).href;
            },
        },
        location,
        sessionStorage,
    };

    await assert.rejects(() => consumeOAuthCallback(/** @type {any} */ (browser)), /state does not match/);
    assert.equal(location.toString(), "https://zeitberg.io/");
    assert.equal(sessionStorage.getItem(OAUTH_PENDING_KEY), null);
    assert.equal(fetchCalled, false);
});

test("expiring OAuth credentials refresh without a client secret", async (context) => {
    context.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(String(url), "https://gitlab.com/oauth/token");
        assert.equal(options.body.get("grant_type"), "refresh_token");
        assert.equal(options.body.get("refresh_token"), "old-refresh");
        assert.equal(options.body.get("client_secret"), null);
        return new Response(
            JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    });

    const refreshed = await refreshOAuthCredential({
        kind: "oauth",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1,
        provider: "gitlab",
        clientId: "public-client-id",
        redirectUri: "https://zeitberg.io/?oauth_provider=gitlab",
        tokenType: "Bearer",
    });

    assert.equal(refreshed.accessToken, "new-access");
    assert.equal(refreshed.refreshToken, "new-refresh");
});
