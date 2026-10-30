import assert from "node:assert/strict";
import test from "node:test";
import { TodoView } from "../todo.view.js";
import { WorkspaceSessions } from "../workspace.sessions.js";

test("new tasks use today in the workspace timezone, while leaving the date editable", () => {
    const field = () => ({ value: "", focus() {} });
    const view = Object.assign(Object.create(TodoView.prototype), {
        busy: false, locale: { t: (key) => key }, dialogTitleEl: {}, dialogMetaEl: {},
        contentInput: field(), descriptionInput: field(), dueDateInput: field(), dueTimeInput: field(),
        recurrenceInput: field(), prioritySelect: field(), labelsInput: field(),
        projectFilterKey: "*", populateProjectControls() {}, syncDialogDetails() {},
        timeContext: { formatDate(now) { assert.ok(now instanceof Date); return "2026-10-29"; } },
        dialog: { open: false, showModal() { this.open = true; } },
    });
    view.openCreateDialog();
    assert.equal(view.dueDateInput.value, "2026-10-29");
    assert.deepEqual(view.originalDueFields, { date: "", time: "" });
    assert.equal(view.originalDue, null);
    view.dueDateInput.value = "";
    assert.equal(view.dueDateInput.value, "");
});

test("save background follows the existing deadline and clears on saving, reconnection, and saved state", (context) => {
    context.mock.method(Date, "now", () => 100000);
    const properties = {};
    const children = { ".save-label": {}, ".save-countdown": { toggleAttribute() {} } };
    const badge = {
        classList: { toggle() {}, remove() {}, add() {} }, dataset: {},
        style: { setProperty(name, value) { properties[name] = value; } },
        setAttribute() {}, querySelector: (selector) => children[selector],
    };
    const session = { dirty: true, ready: true, views: { weekView: {}, todoView: {}, expenseView: {} }, name: "Test" };
    const owner = Object.assign(Object.create(WorkspaceSessions.prototype), {
        current: session, sessions: new Map([["one", session]]),
        app: { editorBadgeEl: badge, locale: { t: (key) => key } },
        autosave: { deadline: 130000, delay: 60000, seconds: 30, update() {} },
    });
    owner.renderSaveState();
    assert.equal(properties["--autosave-progress"], "50%");
    owner.autosave.deadline = 160000;
    owner.renderSaveState();
    assert.equal(properties["--autosave-progress"], "0%");
    owner.autosave.deadline = 130000;
    session.saveError = "Offline";
    owner.renderSaveState();
    assert.equal(properties["--autosave-progress"], "50%");
    session.saving = true;
    owner.renderSaveState();
    assert.equal(properties["--autosave-progress"], "0%");
    session.saving = false;
    session.needsReconnect = true;
    owner.renderSaveState();
    assert.equal(properties["--autosave-progress"], "0%");
    session.dirty = false;
    owner.renderSaveState();
    assert.equal(badge.dataset.state, "saved");
    assert.equal(properties["--autosave-progress"], "0%");
});

