import assert from "node:assert/strict";
import test from "node:test";
import { AutosaveTimer } from "../autosave.js";
import { WorkspaceSessions } from "../workspace.sessions.js";
import { ProviderApiError } from "../datasource.js";

/**
 * Creates a clock-driven scheduler whose owner mirrors the browser's dirty/save lifecycle.
 * @param {import("node:test").TestContext} context Test owning the fake timers.
 * @returns {object} Mutable fixture with no network or repository side effects.
 */
function fixture(context) {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
    const owner = { pending: false, saving: false, attempts: 0, errors: [], operation: async () => { owner.pending = false; } };
    const timer = new AutosaveTimer(async () => {
        owner.attempts++;
        owner.saving = true;
        timer.update(owner.pending, owner.saving);
        try { await owner.operation(); }
        finally { owner.saving = false; }
    }, () => timer.update(owner.pending, owner.saving), (error) => owner.errors.push(error));
    context.after(() => timer.reset());
    return { owner, timer, edit: () => { owner.pending = true; timer.update(true, owner.saving); timer.edited(); } };
}

test("autosave restarts after edits, not renders, and clean state cancels its countdown", async (context) => {
    const { owner, timer, edit } = fixture(context);
    timer.update(false, false);
    context.mock.timers.tick(120000);
    assert.equal(owner.attempts, 0);
    edit();
    context.mock.timers.tick(30000);
    assert.equal(timer.seconds, 30);
    timer.update(true, false);
    assert.equal(timer.seconds, 30);
    edit();
    assert.equal(timer.seconds, 60);
    context.mock.timers.tick(59000);
    assert.equal(owner.attempts, 0);
    context.mock.timers.tick(1000);
    await new Promise(setImmediate);
    assert.equal(owner.attempts, 1);
    assert.equal(timer.deadline, 0);
    edit();
    owner.pending = false;
    timer.update(false, false);
    context.mock.timers.tick(60000);
    assert.equal(owner.attempts, 1);
});

test("manual save consumes the deadline; failures retry after a full idle interval", async (context) => {
    const { owner, timer, edit } = fixture(context);
    edit();
    context.mock.timers.tick(15000);
    timer.beginSave();
    owner.saving = true;
    timer.update(true, true);
    context.mock.timers.tick(60000);
    assert.equal(owner.attempts, 0);
    owner.saving = false;
    timer.update(true, false);
    assert.equal(timer.seconds, 60);
    owner.operation = async () => { throw new Error("offline"); };
    context.mock.timers.tick(60000);
    await new Promise(setImmediate);
    assert.equal(owner.attempts, 1);
    assert.equal(owner.errors.length, 1);
    assert.equal(timer.seconds, 60);
    owner.operation = async () => { owner.pending = false; };
    context.mock.timers.tick(60000);
    await new Promise(setImmediate);
    assert.equal(owner.attempts, 2);
    assert.equal(timer.deadline, 0);
});

test("new edits retain their deadline while saving, without overlapping a long write", async (context) => {
    const { owner, timer, edit } = fixture(context);
    let release;
    owner.operation = () => new Promise((resolve) => { release = resolve; });
    edit();
    context.mock.timers.tick(60000);
    assert.equal(owner.attempts, 1);
    context.mock.timers.tick(20000);
    edit();
    context.mock.timers.tick(10000);
    assert.equal(timer.seconds, 50);
    context.mock.timers.tick(60000);
    assert.equal(owner.attempts, 1);
    assert.equal(timer.seconds, 0);
    owner.operation = async () => { owner.pending = false; };
    release();
    await new Promise(setImmediate);
    context.mock.timers.tick(0);
    await new Promise(setImmediate);
    assert.equal(owner.attempts, 2);
});

test("logout cancels idle work and invalidates callbacks from an older session", async (context) => {
    const { owner, timer, edit } = fixture(context);
    let release;
    owner.operation = () => new Promise((resolve) => { release = resolve; });
    edit();
    context.mock.timers.tick(60000);
    timer.reset();
    release();
    await new Promise(setImmediate);
    assert.equal(timer.deadline, 0);
    context.mock.timers.tick(120000);
    assert.equal(owner.attempts, 1);
    timer.tick();
    assert.equal(owner.attempts, 1);
});

test("authentication failures stop automatic attempts for that workspace without blocking other saves", async () => {
    const auth = {
        ready: true, dirty: true, saving: null, needsReconnect: false, saveError: "",
        runtime: { dataSource: { saveFiles: async () => { throw new ProviderApiError("GitHub", 401, "Bad credentials"); } }, activeWorkspaceConnection: { id: "auth" } },
    };
    const healthy = { ready: true, dirty: true, saving: null, needsReconnect: false };
    const manager = {
        sessions: new Map([["auth", auth], ["healthy", healthy]]), queuedSources: new WeakSet(),
        autosave: { beginSave() {} }, renderSaveState() {},
        app: { workspaceController: { openWorkspaceSettings() {}, requestWorkspaceCredential(connection) { requested = connection.id; } } },
        saveSession: async (session) => { saved.push(session); },
    };
    let requested = "";
    const saved = [];
    WorkspaceSessions.prototype.queueWrites.call(manager, auth);
    await assert.rejects(auth.runtime.dataSource.saveFiles([], "test"), /401/);
    assert.equal(auth.needsReconnect, true);
    await WorkspaceSessions.prototype.saveAll.call(manager, true);
    assert.deepEqual(saved, [healthy]);
    assert.equal(requested, "");
    await WorkspaceSessions.prototype.saveAll.call(manager);
    assert.equal(requested, "auth");
    assert.equal(auth.dirty, true);
});
