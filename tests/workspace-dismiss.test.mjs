import assert from "node:assert/strict";
import test from "node:test";

import { formatAppRoute, RouteController } from "../routing.js";
import { WorkspaceController } from "../workspace.js";

const basePath = "/zeitberg/";
const locator = {
    provider: "github",
    repositoryUrl: "https://github.com/example/workspace",
    ref: "release/data",
    workspacePath: "zeitberg.json",
    expectedWorkspaceId: "workspace-45",
};

function element() {
    return {
        attributes: new Map(),
        value: "",
        hidden: false,
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); },
    };
}

function harness(t, { component = "time", panel = "main", setup = false, connected = true } = {}) {
    const location = new URL("https://example.test/zeitberg/");
    const writes = [];
    const listeners = new Map();
    const timers = new Map();
    let nextTimer = 0;
    const forbidden = () => assert.fail("Dismissal must not navigate, reload, save, or replace the mounted app");
    const browser = {
        location,
        history: {
            back: forbidden,
            forward: forbidden,
            go: forbidden,
            pushState(_state, _title, url) {
                writes.push(["push", url]);
                location.href = new URL(url, location).href;
            },
            replaceState(_state, _title, url) {
                writes.push(["replace", url]);
                location.href = new URL(url, location).href;
            },
        },
        addEventListener(type, callback) { listeners.set(type, callback); },
        removeEventListener(type) { listeners.delete(type); },
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
    };
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else delete globalThis.window;
    });
    const routeController = new RouteController(browser, basePath);
    routeController.start(forbidden);
    t.after(() => routeController.stop());
    const pendingEdits = { description: "Unsaved work", dirty: true };
    const runtime = {
        workspace: connected && !setup ? { workspace_id: locator.expectedWorkspaceId, pendingEdits } : null,
        workspaceSetup: setup ? { reason: "missing", path: "zeitberg.json", raw: null } : null,
        workspaceConfigBaseRaw: { name: "Unsaved setup" },
        activeWorkspaceConnection: connected ? { id: "connection-45" } : null,
        activeGlobalPanel: null,
        routeRestoreInProgress: false,
    };
    const state = component === "time"
        ? { weekStart: "2026-09-14", selectedEntryId: 45, zoom: 1.75, scrollMinutes: 490,
            ...(panel === "search" ? { query: "pending edits", project: "release" } : {}) }
        : component === "todos"
          ? { selectedTodoId: "todo-45", query: "pending", openOnly: false, allWorkspaces: true }
          : { selectedExpenseId: "expense-45", query: "pending" };
    const buildCurrentRoute = () => ({
        version: 1, component, panel: runtime.activeGlobalPanel || panel,
        workspace: connected ? locator : null,
        state: { ...state, ...(runtime.activeGlobalPanel && panel === "search" ? { returnPanel: "search" } : {}) },
    });
    const elements = {
        workspaceEditDialog: {
            open: false,
            close() { this.open = false; },
        },
        workspaceDialog: {
            open: false,
            closes: 0,
            showModal() { this.open = true; },
            close() { this.open = false; this.closes++; },
        },
        workspaceSettingsBtn: element(),
        workspaceCapabilityLinkInput: element(),
        workspaceCapabilityErrorEl: element(),
        workspaceErrorEl: element(),
        workspaceQrScannerEl: element(),
        workspaceQrFileInput: element(),
        workspaceQrVideoEl: element(),
    };
    const controller = new WorkspaceController({
        runtime, elements, routeController, buildCurrentRoute,
        state: { activeTab: component },
        weekView: { pendingEdits }, todoView: { pendingEdits }, expenseView: { pendingEdits },
        onError() {},
        onShowLogin: forbidden, onReload: forbidden, onConnect: forbidden, onLogout: forbidden,
        // Match App.writeCurrentRoute: setup has no loaded workspace and skips ordinary writes.
        onWriteRoute(mode) {
            if (runtime.routeRestoreInProgress || !runtime.workspace) return;
            routeController.write(buildCurrentRoute(), mode);
        },
    });
    controller.renderWorkspaceRegistry = () => {};
    return { controller, routeController, runtime, elements, location, writes, timers, buildCurrentRoute, pendingEdits };
}

for (const [component, panel] of [["time", "main"], ["time", "search"], ["todos", "main"], ["expenses", "main"]]) {
    for (const entry of ["push", "direct", "history"]) {
        test(`${component}/${panel}: ${entry} settings dismissal preserves app state and pending edits`, (t) => {
            const h = harness(t, { component, panel });
            const workspace = h.runtime.workspace;
            if (entry !== "push") {
                // Direct/history entries have no known safe predecessor to traverse.
                h.routeController.write({ ...h.buildCurrentRoute(), panel: "workspaces" }, "replace");
            }
            h.controller.openWorkspaceSettings(entry === "push" ? "push" : "none");
            h.elements.workspaceCapabilityLinkInput.value = "transient bearer link";
            h.elements.workspaceQrFileInput.value = "qr.png";
            let scannerDestroyed = false;
            h.controller.capabilityScanner.scanner = { destroy() { scannerDestroyed = true; } };
            const beforeClose = h.writes.length;

            h.controller.closeWorkspaceSettings();

            assert.equal(h.elements.workspaceDialog.open, false);
            assert.equal(h.elements.workspaceDialog.closes, 1);
            assert.equal(h.runtime.activeGlobalPanel, null);
            assert.equal(h.elements.workspaceSettingsBtn.attributes.has("aria-current"), false);
            assert.equal(h.elements.workspaceCapabilityLinkInput.value, "");
            assert.equal(h.elements.workspaceQrFileInput.value, "");
            assert.equal(h.elements.workspaceQrScannerEl.hidden, true);
            assert.equal(scannerDestroyed, true);
            assert.deepEqual(h.writes.slice(beforeClose), [["replace", formatAppRoute(h.buildCurrentRoute(), basePath)]]);
            assert.equal(h.routeController.read().panel, panel);
            assert.equal(h.runtime.workspace, workspace);
            assert.equal(workspace.pendingEdits, h.pendingEdits);
            assert.deepEqual(h.pendingEdits, { description: "Unsaved work", dirty: true });
            h.controller.closeWorkspaceSettings();
            assert.equal(h.writes.length, beforeClose + 1, "Repeated dismissal is history-neutral");
        });
    }
}

test("setup dismissal normalizes a direct settings URL even when ordinary route writes are guarded", (t) => {
    const h = harness(t, { setup: true });
    const setup = h.runtime.workspaceSetup;
    const draft = h.runtime.workspaceConfigBaseRaw;
    h.routeController.write({ ...h.buildCurrentRoute(), panel: "workspaces" }, "replace");
    h.controller.openWorkspaceSettings();
    h.controller.closeWorkspaceSettings();
    assert.equal(h.elements.workspaceDialog.open, false);
    assert.equal(h.routeController.read().panel, "main");
    assert.equal(h.runtime.workspaceSetup, setup);
    assert.equal(h.runtime.workspaceConfigBaseRaw, draft);
    assert.equal(draft.name, "Unsaved setup");
    assert.deepEqual(h.writes.map(([mode]) => mode), ["replace", "replace"]);
});

test("legacy back close and repeated open/close cycles never traverse history", (t) => {
    const h = harness(t);
    for (let i = 0; i < 3; i++) {
        h.controller.openWorkspaceSettings();
        h.controller.closeWorkspaceSettings("back");
        assert.equal(h.routeController.read().panel, "main");
    }
    assert.deepEqual(h.writes.map(([mode]) => mode), ["push", "replace", "push", "replace", "push", "replace"]);
});

test("dismissal cancels a queued route replacement that could reopen the settings URL", (t) => {
    const h = harness(t);
    h.controller.openWorkspaceSettings();
    const staleRoute = h.buildCurrentRoute();
    h.routeController.scheduleReplace(() => staleRoute);
    assert.equal(h.timers.size, 1);
    h.controller.closeWorkspaceSettings();
    assert.equal(h.timers.size, 0);
    assert.equal(h.routeController.replaceTimer, 0);
    assert.equal(h.routeController.read().panel, "main");
});

for (const mode of ["none", "restoring"]) {
    test(`${mode}: route-driven dismissal leaves URL ownership to the caller`, (t) => {
        const h = harness(t);
        h.controller.openWorkspaceSettings();
        const beforeClose = h.writes.length;
        h.runtime.routeRestoreInProgress = mode === "restoring";
        h.controller.closeWorkspaceSettings(mode === "none" ? "none" : undefined);
        assert.equal(h.elements.workspaceDialog.open, false);
        assert.equal(h.runtime.activeGlobalPanel, null);
        assert.equal(h.writes.length, beforeClose);
    });
}

test("landing-page dismissal without a workspace does not manufacture an app route", (t) => {
    const h = harness(t, { connected: false });
    h.controller.openWorkspaceSettings();
    h.controller.closeWorkspaceSettings();
    assert.equal(h.elements.workspaceDialog.open, false);
    assert.equal(h.location.pathname, basePath);
    assert.deepEqual(h.writes, []);
});
