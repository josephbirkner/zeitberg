import assert from "node:assert/strict";
import test from "node:test";

import {
    ConfigService,
    DEFAULT_CONFIG,
    WorkspaceConnection,
    WorkspaceRegistry,
} from "../config.js";

class MemoryStorage {
    constructor() {
        this.values = new Map();
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(String(key), String(value));
    }

    removeItem(key) {
        this.values.delete(String(key));
    }
}

function installBrowserStorage(testContext) {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const originalLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
    testContext.after(() => {
        if (originalLocal) Object.defineProperty(globalThis, "localStorage", originalLocal);
        else delete globalThis.localStorage;
        if (originalSession) Object.defineProperty(globalThis, "sessionStorage", originalSession);
        else delete globalThis.sessionStorage;
    });
    return { local, session };
}

function githubLocator(repository, ref = "main") {
    return {
        provider: "github",
        repositoryUrl: `https://github.com/example/${repository}`,
        ref,
        workspacePath: "zeitberg.json",
        expectedWorkspaceId: "",
    };
}

test("workspace registry keeps ordered credential-free connection records", () => {
    const registry = new WorkspaceRegistry();
    const personal = registry.upsert(githubLocator("personal"), {
        displayName: "Personal",
        expectedWorkspaceId: "personal-id",
    });
    const shared = registry.upsert(githubLocator("shared"), { displayName: "Shared" });

    assert.equal(registry.getActive()?.id, personal.id);
    assert.equal(registry.setActive(shared.id), true);
    assert.equal(registry.move(shared.id, -1), true);
    assert.deepEqual(registry.list().map((connection) => connection.displayName), ["Shared", "Personal"]);

    const serialized = JSON.stringify(registry.toObject());
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.deepEqual(
        WorkspaceRegistry.fromRaw(JSON.parse(serialized)).list().map((connection) => connection.id),
        registry.list().map((connection) => connection.id),
    );

    assert.equal(registry.remove(shared.id)?.id, shared.id);
    assert.equal(registry.getActive()?.id, personal.id);
});

test("workspace connection ids ignore learned display metadata and expected identity", () => {
    const locator = githubLocator("personal", "release/data");
    const before = WorkspaceConnection.fromLocator(locator, { displayName: "Before" });
    const after = WorkspaceConnection.fromLocator(
        { ...locator, expectedWorkspaceId: "verified-id" },
        { displayName: "After", expectedWorkspaceId: "verified-id" },
    );

    assert.equal(before.id, after.id);
    assert.equal(after.displayName, "After");
    assert.equal(after.expectedWorkspaceId, "verified-id");
});

test("ConfigService isolates session and remembered credentials by workspace", (testContext) => {
    const { local, session } = installBrowserStorage(testContext);
    const service = new ConfigService();
    const personal = WorkspaceConnection.fromLocator(githubLocator("personal"));
    const shared = WorkspaceConnection.fromLocator(githubLocator("shared"));

    service.saveWorkspaceCredential(personal.id, "session-secret", false);
    service.saveWorkspaceCredential(shared.id, "remembered-secret", true);

    assert.equal(service.loadWorkspaceCredential(personal.id), "session-secret");
    assert.equal(service.loadWorkspaceCredential(shared.id), "remembered-secret");
    assert.equal(service.isWorkspaceCredentialRemembered(personal.id), false);
    assert.equal(service.isWorkspaceCredentialRemembered(shared.id), true);
    assert.equal(local.getItem("zeitberg:workspace-registry:v1"), null);
    assert.match(session.getItem("zeitberg:workspace-credentials:session:v1") || "", /session-secret/);

    service.clearWorkspaceCredential(personal.id);
    assert.equal(service.loadWorkspaceCredential(personal.id), "");
    assert.equal(service.loadWorkspaceCredential(shared.id), "remembered-secret");
});

test("ConfigService persists interface language independently from workspace logout", (testContext) => {
    installBrowserStorage(testContext);
    const service = new ConfigService();

    assert.equal(service.loadLocale(), "auto");
    service.saveLocale("de");
    assert.equal(service.loadLocale(), "de");
    assert.throws(() => service.saveLocale("fr"), /Unsupported interface language/);

    service.clearSaved();
    assert.equal(service.loadLocale(), "de");
    service.saveLocale("auto");
    assert.equal(service.loadLocale(), "auto");
});

test("ConfigService preserves refreshable OAuth grants without exposing them through the registry", (testContext) => {
    const { local } = installBrowserStorage(testContext);
    const service = new ConfigService();
    const connection = WorkspaceConnection.fromLocator({
        provider: "gitlab",
        repositoryUrl: "https://gitlab.com/example/workspace",
        ref: "main",
        workspacePath: "zeitberg.json",
        expectedWorkspaceId: "",
    });
    const credential = {
        kind: "oauth",
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        expiresAt: 123456789,
        provider: "gitlab",
        clientId: "public-client-id",
        redirectUri: "https://zeitberg.io/?oauth_provider=gitlab",
        tokenType: "Bearer",
    };

    service.saveWorkspaceOAuthCredential(connection.id, credential, true);

    assert.equal(service.loadWorkspaceCredential(connection.id), "oauth-access");
    assert.deepEqual(service.loadWorkspaceCredentialRecord(connection.id), credential);
    assert.equal(service.isWorkspaceCredentialRemembered(connection.id), true);
    assert.match(local.getItem("zeitberg:workspace-credentials:local:v1") || "", /oauth-v1/);
    assert.equal(JSON.stringify(connection.toObject()).includes("oauth-access"), false);
});

test("single-workspace storage upgrades once into the registry", (testContext) => {
    const { local } = installBrowserStorage(testContext);
    local.setItem(
        "zeitberg:config:v1",
        JSON.stringify({ ...DEFAULT_CONFIG, owner: "example", repo: "legacy-data", ref: "archive" }),
    );
    local.setItem("zeitberg:token:v1", "single-workspace-secret");
    local.setItem("zeitberg:token-remembered:v1", "1");

    const service = new ConfigService();
    const registry = service.loadWorkspaceRegistry(service.loadConfig());
    const connection = registry.getActive();

    assert.equal(connection?.repositoryUrl, "https://github.com/example/legacy-data");
    assert.equal(connection?.ref, "archive");
    assert.equal(service.loadWorkspaceCredential(connection?.id || ""), "single-workspace-secret");
    assert.equal(JSON.parse(local.getItem("zeitberg:workspace-registry:v1")).schema_version, 1);
});
