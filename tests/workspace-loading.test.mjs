import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceLoader } from "../workspace.loader.js";
import { WorkspaceSessions } from "../workspace.sessions.js";
import { WorkspaceController } from "../workspace.js";
import { WorkspaceRegistry } from "../config.js";

test("connection summaries use only the requested workspace's loaded stores", () => {
    const session = {
        runtime: { workspace: { hasComponent: (name) => name === "expenses" } },
        store: { getManifest: () => null },
        todoStore: { getTodos: () => [] },
        expenseStore: { getManifest: () => null, getExpenses: () => [{}, {}] },
    };
    const sessions = Object.assign(Object.create(WorkspaceSessions.prototype), {
        sessions: new Map([["trip", session], ["pending", { runtime: { workspace: null } }]]),
        app: {
            activeWorkspaceConnection: { id: "personal" },
            workspace: { hasComponent: () => true },
            locale: { t: (key, values) => `${key}:${values.count}`, formatNumber: String },
        },
    });
    assert.equal(sessions.describeConnection("trip"), "data.expenses:2");
    assert.equal(sessions.describeConnection("pending"), "");
    assert.equal(sessions.describeConnection("unknown"), "");
});

test("adding multiple repositories retains the mounted workspace, stores and unsaved history", async () => {
    const history = [{ edit: "unsaved" }];
    const current = { id: "personal", history, runtime: { workspace: { name: "Personal" } } };
    const connections = [{ id: "trip" }, { id: "family" }];
    const events = [];
    const sessions = Object.assign(Object.create(WorkspaceSessions.prototype), {
        current, generation: 1, beginLoading() { this.initializing = true; }, reportLoadingProgress() {}, render() {},
        app: { workspaceRegistry: { list: () => [{ id: "personal" }, ...connections] }, locale: { t: (key) => key },
            shell: { showLoadingScreen: () => events.push("loading"), showApplicationScreen: () => events.push("visible") },
            workspaceController: { renderWorkspaceRegistry() {} } },
        open: async (connection) => { assert.equal(sessions.initializing, true); events.push(connection.id); },
    });
    await sessions.addConnections(connections);
    assert.equal(sessions.current, current);
    assert.equal(sessions.current.history, history);
    assert.deepEqual(events, ["loading", "trip", "family", "visible"]);
});

test("OAuth connection while mounted uses the isolated switch, never the initial-login loader", async () => {
    const workspaceRegistry = new WorkspaceRegistry();
    const current = { id: "personal", runtime: { workspace: { name: "Personal" } } };
    const switches = [];
    const controller = Object.assign(Object.create(WorkspaceController.prototype), {
        runtime: { workspaceRegistry, sessions: { current } },
        configService: { saveWorkspaceRegistry() {}, saveWorkspaceOAuthCredential() {} },
        switchWorkspace: async (id) => switches.push(id),
        activateWorkspaceConnection() { assert.fail("Must not overwrite the mounted identity"); },
        connectWithToken() { assert.fail("Must not reuse the mounted stores"); },
    });
    await controller.handleOAuthCallbackResult({ credential: { provider: "github", accessToken: "fictional" },
        intent: { mode: "connect", repositoryUrl: "https://github.com/example/trip", ref: "main", workspacePath: "zeitberg.json" } });
    assert.equal(switches.length, 1);
    assert.equal(current.runtime.workspace.name, "Personal");
});

test("first-time batch onboarding attempts every repository before mounting a usable one", async () => {
    const events = [];
    const good = { id: "good", ready: true };
    const sessions = Object.assign(Object.create(WorkspaceSessions.prototype), {
        current: null, sessions: new Map(), generation: 0, beginLoading() { this.initializing = true; },
        reportLoadingProgress() {}, render() {},
        app: { state: { activeTab: "expenses" }, logoutBtn: {}, reloadDataBtn: {}, projectsBtn: {},
            workspaceRegistry: { list: () => [{ id: "bad" }, { id: "good" }] }, locale: { t: (key) => key },
            shell: { showLoadingScreen: () => events.push("loading"), showApplicationScreen: () => assert.fail("No partial UI") },
            workspaceController: { renderWorkspaceRegistry() {} } },
        async open(connection) {
            events.push(connection.id);
            if (connection.id === "good") this.sessions.set("good", good);
        },
        mount(session) { assert.equal(this.initializing, false); assert.equal(session, good); events.push("mount"); },
    });
    await sessions.addConnections([{ id: "bad" }, { id: "good" }]);
    assert.deepEqual(events, ["loading", "bad", "good", "mount"]);
    assert.equal(sessions.started, true);
});

test("empty entry manifests initialize today's editable calendar after restoring drafts", async () => {
    const calls = [];
    const loader = Object.assign(Object.create(WorkspaceLoader.prototype), {
        weekView: { restoreDrafts: async () => calls.push("drafts"), setLatestWeekStart() {},
            focusTodayLastEntry: (force) => calls.push(["today", force]) },
        state: { setLatestWeekStart() {}, latestWeekStart: null },
        store: { recomputeNextEntryId() {}, getLatestWeekStart: () => null },
        searchView: { markDirty() {}, applyFiltersAndRender() {} },
    });
    await loader.finalizeLoadedEntries();
    assert.deepEqual(calls, ["drafts", ["today", true]]);
});

test("loading progress is aggregate and monotonic, never reset by a repository's next stage", () => {
    const reports = [];
    const sessions = Object.assign(Object.create(WorkspaceSessions.prototype), {
        initializing: true, loadProgress: new Map([["a", 0], ["b", 0]]),
        app: { shell: { setProgress: (...values) => reports.push(values) }, locale: { t: (_key, values) => JSON.stringify(values) } },
    });
    sessions.reportLoadingProgress("a", 1, 1);
    sessions.reportLoadingProgress("b", 1, 2);
    sessions.reportLoadingProgress("b", 0, 1);
    sessions.reportLoadingProgress("b", 1, 1);
    assert.deepEqual(reports.map(([done, total]) => [done, total]), [[1, 2], [1.5, 2], [1.5, 2], [2, 2]]);
});

test("reconnect prefill refreshes OAuth availability without mounting another document", () => {
    let refreshed = false;
    const disclosure = { open: false, showModal() { this.open = true; } };
    const field = () => ({ value: "", checked: true, focus() {}, closest: () => disclosure });
    const controller = Object.assign(Object.create(WorkspaceController.prototype), {
        elements: { workspaceProviderInput: field(), workspaceRepositoryInput: field(), workspaceRefInput: field(),
            workspacePathInput: field(), workspaceTokenInput: field(), workspaceRememberInput: field() },
        updateProviderForm() {}, refreshOAuthControls() { refreshed = true; }, setError() {}, locale: { t: () => "Reconnect" },
    });
    controller.requestWorkspaceCredential({ provider: "codeberg", repositoryUrl: "https://codeberg.org/test/test", ref: "main", workspacePath: "zeitberg.json", displayName: "Test" });
    assert.equal(refreshed, true);
    assert.equal(controller.elements.workspaceProviderInput.value, "codeberg");
    assert.equal(disclosure.open, true);
});

test("initialization does not settle until every registered connection has been attempted", async () => {
    const events = [];
    let finish;
    const current = { id: "a", runtime: {}, ready: true };
    const sessions = Object.assign(Object.create(WorkspaceSessions.prototype), {
        current, sessions: new Map([["a", current]]), selected: new Map(), started: false, generation: 0,
        app: { workspace: {}, activeWorkspaceConnection: { id: "a" }, state: { activeTab: "week" },
            workspaceRegistry: { list: () => [{ id: "a" }, { id: "b" }, { id: "c" }] } },
        render() {}, reportLoadingProgress() {},
        open: async (connection) => {
            events.push(connection.id);
            if (connection.id === "b") await new Promise((resolve) => { finish = resolve; });
            return null;
        },
    });
    let settled = false;
    const loading = sessions.loaded().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(sessions.initializing, true);
    assert.deepEqual(events, ["b"]);
    finish();
    await loading;
    assert.deepEqual(events, ["b", "c"]);
    assert.equal(sessions.initializing, false);
});

test("reconnecting a ready background session preserves current document and history", async () => {
    const source = { setToken(token) { this.token = token; } };
    const history = [{ description: "unsaved edit" }];
    const background = { ready: true, runtime: { dataSource: source }, state: { setToken() {} }, history,
        needsReconnect: true, saveError: "Unauthorized" };
    const current = { id: "current" };
    const sessions = Object.assign(Object.create(WorkspaceSessions.prototype), {
        current, sessions: new Map([["other", background]]), unavailable: new Map([["other", "Unauthorized"]]),
        app: { workspaceController: { loadUsableWorkspaceCredential: async () => "replacement" } }, render() {},
    });
    await sessions.reconnect({ id: "other" });
    assert.equal(sessions.current, current);
    assert.equal(background.history, history);
    assert.equal(background.needsReconnect, false);
    assert.equal(source.token, "replacement");
    assert.equal(sessions.unavailable.size, 0);
});
