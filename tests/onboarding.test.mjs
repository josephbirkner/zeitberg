import assert from "node:assert/strict";
import test from "node:test";
import { OnboardingController } from "../onboarding.js";
import { WorkspaceRegistry } from "../config.js";

test("discovery automatically consumes all pages and deduplicates repeated repositories", async () => {
    const pages = [];
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        app: { shell: { setError() {} }, locale: { t: (key) => key } },
        busy: false, scanning: false, more: {}, status: {}, page: 0, items: [], render() {}, renderGitHubAccess() {},
        discovery: { scanPage: async (page) => {
            pages.push(page);
            return { repositories: [{ repositoryUrl: "https://github.com/example/one" }, { repositoryUrl: `https://github.com/example/repo-${page}` }], hasMore: page < 3 };
        } },
    });
    await controller.scanMore();
    assert.deepEqual(pages, [1, 2, 3]);
    assert.equal(controller.items.length, 4);
    assert.equal(controller.more.hidden, true);
});

test("multi-select registers new repositories together and never overwrites existing connections", async () => {
    for (const provider of ["github", "gitlab", "codeberg"]) {
        const domain = provider === "codeberg" ? "codeberg.org" : `${provider}.com`;
        const workspaceRegistry = new WorkspaceRegistry();
        const existing = workspaceRegistry.upsert({ provider, repositoryUrl: `https://${domain}/example/personal`, ref: "main", workspacePath: "zeitberg.json" });
        const saved = [];
        let loaded;
        const items = ["personal", "trip", "family"].map((name) => ({ repositoryUrl: `https://${domain}/example/${name}`, ref: "main" }));
        const controller = Object.assign(Object.create(OnboardingController.prototype), {
            provider, busy: false, items, selectedRepositories: new Set(items.map((item) => item.repositoryUrl)),
            discovery: { cancel() {} }, remember: { checked: true }, accessToken: "fictional", credential: null,
            refreshAuthorization: async () => true, setBusy(value) { this.busy = value; }, dialog: { close() {} },
            app: { workspaceRegistry, configService: { saveWorkspaceCredential: (id) => saved.push(id), saveWorkspaceRegistry() {} },
                workspaceController: { closeWorkspaceSettings() {} }, shell: { setError: (_, error) => assert.fail(error) },
                sessions: { addConnections: async (connections) => { loaded = connections; assert.equal(workspaceRegistry.list().length, 3); } } },
        });
        await controller.connectSelected();
        assert.equal(loaded.length, 2);
        assert.equal(saved.includes(existing.id), false);
        assert.equal(workspaceRegistry.list().filter((item) => item.id === existing.id).length, 1);
        await controller.connectSelected();
        assert.equal(loaded.length, 0);
        assert.equal(saved.length, 2);
    }
});

test("repository selection closes the chooser and sends its grant through the ordinary OAuth connection path", async () => {
    const calls = [];
    const credential = { kind: "oauth", provider: "gitlab", accessToken: "test-access" };
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        busy: false, accessToken: "test-access", credential, remember: { checked: true },
        setBusy(value) { this.busy = value; },
        dialog: { close: () => calls.push("close") },
        app: { workspaceController: { handleOAuthCallbackResult: async (result) => calls.push(result) } },
    });
    await controller.connect({ repositoryUrl: "https://gitlab.com/person/space", ref: "develop" });
    assert.equal(calls[0], "close");
    assert.equal(calls[1].credential, credential);
    assert.deepEqual(calls[1].intent, { mode: "connect", repositoryUrl: "https://gitlab.com/person/space", ref: "develop", workspacePath: "zeitberg.json", remember: true });
    assert.equal(controller.busy, false);
});

test("closing a chooser discards late scan results and releases credentials", async () => {
    let finish;
    let cancelled = false;
    const discovery = { scanPage: () => new Promise((resolve) => { finish = resolve; }), cancel: () => { cancelled = true; } };
    let renders = 0;
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        app: { shell: { setError() {} }, locale: { t: (key) => key } },
        discovery, busy: false, scanning: false, more: {}, status: {}, page: 0,
        items: [], accessToken: "secret", credential: {}, token: { value: "secret" },
        list: { replaceChildren() {} }, render: () => renders++,
    });
    const scan = controller.scanMore();
    const duplicate = controller.scanMore();
    await duplicate;
    controller.clear();
    finish({ repositories: [{ repositoryUrl: "https://gitlab.com/person/repo" }], hasMore: false });
    await scan;
    assert.equal(renders, 0);
    assert.equal(controller.accessToken, "");
    assert.equal(controller.credential, null);
    assert.equal(controller.token.value, "");
    assert.equal(cancelled, true);
});

test("failed scans retain earlier choices and retry the same page without reauthorization", async () => {
    const errors = [];
    const pages = [];
    let fail = true;
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        app: { shell: { setError: (_element, text) => errors.push(text) }, locale: { t: (key) => key } },
        busy: false, scanning: false, more: {}, status: {}, page: 1,
        items: [{ repositoryUrl: "https://codeberg.org/person/one" }],
        discovery: { scanPage: async (page) => {
            pages.push(page);
            if (fail) throw new Error("Network unavailable");
            return { repositories: [{ repositoryUrl: "https://codeberg.org/person/two" }], hasMore: false };
        } },
        render() {},
    });
    await controller.scanMore();
    assert.equal(controller.page, 1);
    assert.equal(controller.items.length, 1);
    assert.equal(errors.at(-1), "Error: Network unavailable");
    fail = false;
    await controller.scanMore();
    assert.deepEqual(pages, [2, 2]);
    assert.equal(controller.items.length, 2);
    assert.equal(controller.more.hidden, true);
});

test("returning from GitHub access settings refreshes once, only while the chooser is open", () => {
    let refreshes = 0;
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        accessPending: true, busy: false, dialog: { open: true }, repositories: { hidden: false },
        browse() { refreshes++; },
    });
    controller.refreshAfterAccess();
    controller.refreshAfterAccess();
    assert.equal(refreshes, 1);
    controller.accessPending = true;
    controller.dialog.open = false;
    controller.refreshAfterAccess();
    assert.equal(refreshes, 1);
});

test("a replaced discovery cannot append stale results or clear the new scan's busy state", async () => {
    let finish;
    const oldDiscovery = { scanPage: () => new Promise((resolve) => { finish = resolve; }) };
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        app: { shell: { setError() {} }, locale: { t: (key) => key } },
        discovery: oldDiscovery, busy: false, scanning: false, more: {}, status: {}, page: 0, items: [],
        render() { assert.fail("Stale results rendered"); },
    });
    const pending = controller.scanMore();
    await Promise.resolve();
    controller.discovery = {};
    controller.scanning = true;
    finish({ repositories: [{ repositoryUrl: "https://github.com/person/stale" }], hasMore: false });
    await pending;
    assert.equal(controller.items.length, 0);
    assert.equal(controller.scanning, true);
    assert.equal(controller.page, 0);
});

test("provider discovery reuses only OAuth grants for the same provider and application", () => {
    const records = {
        pat: { kind: "token", accessToken: "fictional-pat" },
        foreign: { kind: "oauth", provider: "github", clientId: "another-app" },
        github: { kind: "oauth", provider: "github", clientId: "Iv23liNvkhSh2mYH0oPw" },
    };
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        provider: "github",
        app: {
            workspaceRegistry: { list: () => Object.keys(records).map((id) => ({ id, provider: "github" })) },
            configService: { loadWorkspaceCredentialRecord: (id) => records[id] },
        },
    });
    assert.equal(controller.findAuthorizationConnection().id, "github");
    delete records.github;
    assert.equal(controller.findAuthorizationConnection(), null);
});

test("reused OAuth discovery refreshes the shared grant and preserves its persistence choice", async () => {
    const connection = { id: "existing", displayName: "Personal" };
    let refreshed = false;
    const record = { kind: "oauth", provider: "github", accessToken: "rotated-test-token", grantId: "shared" };
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        provider: "github", authorizationRevision: 1, remember: {}, authorizeForm: {}, sessionPanel: {}, sessionNote: {},
        findAuthorizationConnection: () => connection,
        app: {
            locale: { t: (key) => key },
            configService: {
                isWorkspaceCredentialRemembered: () => false,
                loadWorkspaceCredentialRecord: () => { assert.equal(refreshed, true); return record; },
            },
            workspaceController: { loadUsableWorkspaceCredential: async (owner) => {
                assert.equal(owner, connection); refreshed = true; return record.accessToken;
            } },
        },
        async browse() {
            assert.equal(this.credential, record);
            assert.equal(this.accessToken, record.accessToken);
        },
    });
    await controller.reuseAuthorization();
    assert.equal(controller.authorizeForm.hidden, true);
    assert.equal(controller.sessionPanel.hidden, false);
    assert.equal(controller.remember.checked, false);
});

test("a failed shared-grant refresh offers authorization without deleting connected credentials", async () => {
    let message;
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        provider: "github", authorizationRevision: 1, remember: {}, authorizeForm: {}, sessionPanel: {}, sessionNote: {},
        findAuthorizationConnection: () => ({ id: "existing", displayName: "Personal" }),
        app: {
            locale: { t: (key) => key }, shell: { setError: (_, text) => { message = text; } },
            configService: { isWorkspaceCredentialRemembered: () => true },
            workspaceController: { loadUsableWorkspaceCredential: async () => { throw new Error("Session expired"); } },
        },
        browse() { assert.fail("A failed refresh must not scan"); },
    });
    await controller.reuseAuthorization();
    assert.equal(controller.authorizeForm.hidden, false);
    assert.equal(controller.authorizationConnection, null);
    assert.match(message, /Session expired/);
});

test("closing during a grant refresh cannot restore credentials or start discovery", async () => {
    let finish;
    const controller = Object.assign(Object.create(OnboardingController.prototype), {
        authorizationConnection: { id: "existing" }, authorizationRevision: 1,
        app: { workspaceController: { loadUsableWorkspaceCredential: () => new Promise((resolve) => { finish = resolve; }) } },
        token: {}, list: { replaceChildren() {} }, accessToken: "", credential: null,
    });
    const pending = controller.refreshAuthorization();
    controller.clear();
    finish("late-test-token");
    assert.equal(await pending, false);
    assert.equal(controller.accessToken, "");
    assert.equal(controller.credential, null);
});

test("repository URLs entered from management fill that form, not the hidden welcome form", () => {
    const field = () => ({ value: "" });
    const app = { workspaceDialog: { open: true },
        workspaceProviderInput: field(), workspaceRepositoryInput: field(), workspaceRefInput: field(), workspacePathInput: field(),
        providerInput: field(), repositoryInput: field(), refInput: field(), loginWorkspacePathInput: field() };
    const controller = Object.assign(Object.create(OnboardingController.prototype), { app });
    const locator = { provider: "codeberg", repositoryUrl: "https://codeberg.org/example/workspace", ref: "develop", workspacePath: "zeitberg.json" };
    controller.fillConnection(locator);
    assert.equal(app.workspaceRepositoryInput.value, locator.repositoryUrl);
    assert.equal(app.workspaceRefInput.value, "develop");
    assert.equal(app.repositoryInput.value, "");
    app.workspaceDialog.open = false;
    controller.fillConnection(locator);
    assert.equal(app.repositoryInput.value, locator.repositoryUrl);
    assert.equal(app.providerInput.value, "codeberg");
});
