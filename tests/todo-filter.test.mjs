import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { LocaleService } from "../locale.js";
import { ProjectList, Todo, TodoList } from "../model.js";
import { EntryStore, TodoStore } from "../store.js";
import { TodoView } from "../todo.view.js";
import { TimeContext } from "../utils.js";
import { CombinedTodos } from "../workspace.todos.js";

beforeEach((context) => {
    context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-15T12:00:00Z") });
});

/**
 * Creates a real TODO model with stable defaults and optional due/status/assignment overrides.
 * @param {string} id Stable task identity.
 * @param {Partial<import("../model.js").TodoRaw>} [overrides] Fixture changes.
 * @returns {Todo}
 */
function todo(id, overrides = {}) {
    return new Todo({
        id, content: id, project_key: "alpha", section_key: null,
        due: null, priority: 1, order: 0, ...overrides,
    });
}

/**
 * Uses production stores, models and date formatting without binding browser event handlers.
 * @param {Todo[]} todos Fixture tasks.
 * @returns {TodoView}
 */
function makeView(todos) {
    const timeContext = new TimeContext("Europe/Berlin");
    const projectStore = new EntryStore(timeContext);
    projectStore.setProjectList(ProjectList.fromRaw({
        schema_version: 2,
        projects: ["alpha", "beta"].map((key) => ({
            key, name: `${key} project`, archived: false, color: "#ee6a3b",
            sections: [{ key: "planning", name: "Planning Section", archived: false }],
        })),
    }));
    const store = new TodoStore(projectStore);
    store.setTodoList(new TodoList(todos, ""));
    return Object.assign(Object.create(TodoView.prototype), {
        store, projectStore, timeContext, locale: new LocaleService("en"),
        projectFilterKey: "alpha", searchQuery: "", currentOnly: true, openOnly: true,
        selectedTodoId: null,
    });
}

/**
 * Returns visible IDs through the same API used by CombinedTodos and keyboard navigation.
 * @param {TodoView} view Controller under test.
 * @returns {string[]}
 */
function visibleIds(view) {
    return view.getVisibleTodos().map((item) => item.id);
}

test("a project's future and undated tasks appear without changing filters, routes or store order", () => {
    const view = makeView([
        todo("undated"), todo("future", { due: { date: "2026-09-16" } }),
        todo("other", { project_key: "beta" }), todo("archived", { archived: true }),
        todo("completed", { completed_at: "2026-09-14T12:00:00Z" }),
    ]);
    const route = view.getRouteState();
    const snapshot = view.store.snapshotRaw();
    assert.deepEqual(visibleIds(view), ["future", "undated"]);
    assert.equal(view.getFilteredTodos().showingNonDue, true);
    assert.deepEqual(view.getRouteState(), route);
    assert.deepEqual(view.store.snapshotRaw(), snapshot);
});

test("today and overdue tasks suppress fallback but another project's current tasks do not", () => {
    const view = makeView([
        todo("future", { due: { date: "2026-09-16" } }), todo("undated"),
        todo("today", { due: { date: "2026-09-15T23:59:00" } }),
        todo("overdue", { due: { date: "2026-09-14" } }),
        todo("beta-today", { project_key: "beta", due: { date: "2026-09-15" } }),
    ]);
    assert.deepEqual(visibleIds(view), ["overdue", "today"]);
    assert.equal(view.getFilteredTodos().showingNonDue, false);
    view.store.setTodoList(new TodoList([
        todo("undated"), todo("beta-today", { project_key: "beta", due: { date: "2026-09-15" } }),
    ], ""));
    assert.deepEqual(visibleIds(view), ["undated"]);
    assert.equal(view.getFilteredTodos().showingNonDue, true);
});

test("search fallback preserves the query and requires matching candidates", () => {
    const view = makeView([
        todo("unrelated-current", { due: { date: "2026-09-15" } }),
        todo("matching-future", { description: "Find NEEDLE here", due: { date: "2026-09-18" } }),
        todo("unrelated-undated"), todo("needle-other", { project_key: "beta" }),
    ]);
    view.searchQuery = "  NeEdLe  ";
    assert.deepEqual(visibleIds(view), ["matching-future"]);
    assert.equal(view.searchQuery, "  NeEdLe  ");
    view.searchQuery = "no such task";
    assert.deepEqual(visibleIds(view), []);
    assert.equal(view.getFilteredTodos().showingNonDue, false);
    view.searchQuery = "";
    assert.deepEqual(visibleIds(view), ["unrelated-current"]);
});

test("fallback retains assignment-name and label search semantics", () => {
    const view = makeView([
        todo("section-task", { section_key: "planning", labels: ["release-ready"] }),
        todo("root-task"), todo("beta-task", { project_key: "beta", section_key: "planning" }),
    ]);
    for (const query of ["planning section", "release-ready"]) {
        view.searchQuery = query;
        assert.deepEqual(visibleIds(view), ["section-task"]);
    }
    view.searchQuery = "alpha project";
    assert.deepEqual(visibleIds(view), ["root-task", "section-task"]);
});

test("open filtering excludes completed and archived current tasks before deciding fallback", () => {
    const view = makeView([
        todo("undated"),
        todo("closed-current", { due: { date: "2026-09-15" }, completed_at: "2026-09-15T10:00:00Z" }),
        todo("archived-current", { due: { date: "2026-09-15" }, archived: true }),
    ]);
    assert.deepEqual(visibleIds(view), ["undated"]);
    view.openOnly = false;
    assert.deepEqual(visibleIds(view), ["closed-current"]);
    assert.equal(view.getFilteredTodos().showingNonDue, false);
});

test("completed non-due tasks remain available only when the open filter is disabled", () => {
    const view = makeView([todo("closed-undated", { completed_at: "2026-09-15T10:00:00Z" })]);
    assert.deepEqual(visibleIds(view), []);
    assert.equal(view.getFilteredTodos().showingNonDue, false);
    view.openOnly = false;
    assert.deepEqual(visibleIds(view), ["closed-undated"]);
    assert.equal(view.getFilteredTodos().showingNonDue, true);
});

test("All Projects and unassigned views never automatically broaden", () => {
    const view = makeView([todo("undated"), todo("unassigned", { project_key: null })]);
    assert.deepEqual(visibleIds(view), ["undated"]);
    for (const project of ["*", ""]) {
        view.projectFilterKey = project;
        assert.deepEqual(visibleIds(view), []);
        assert.equal(view.getFilteredTodos().showingNonDue, false);
        assert.equal(view.currentOnly, true);
    }
    view.projectFilterKey = "beta";
    assert.deepEqual(visibleIds(view), []);
    assert.equal(view.getFilteredTodos().showingNonDue, false);
    view.projectFilterKey = "alpha";
    assert.deepEqual(visibleIds(view), ["undated"]);
});

test("explicitly disabling current filtering shows all matches without a fallback cue", () => {
    const view = makeView([todo("undated"), todo("other", { project_key: "beta" })]);
    view.currentOnly = false;
    assert.deepEqual(visibleIds(view), ["undated"]);
    assert.equal(view.getFilteredTodos().showingNonDue, false);
    view.projectFilterKey = "*";
    assert.deepEqual(visibleIds(view), ["undated", "other"]);
});

test("fallback is recomputed after task changes and the configured timezone's midnight", (context) => {
    const task = todo("tomorrow", { due: { date: "2026-09-16" } });
    const view = makeView([todo("undated"), task]);
    assert.equal(view.getFilteredTodos().showingNonDue, true);
    context.mock.timers.setTime(Date.parse("2026-09-15T22:00:00Z"));
    assert.deepEqual(visibleIds(view), ["tomorrow"]);
    assert.equal(view.getFilteredTodos().showingNonDue, false);
    task.completed_at = "2026-09-15T22:01:00Z";
    assert.deepEqual(visibleIds(view), ["undated"]);
    assert.equal(view.getFilteredTodos().showingNonDue, true);
    task.completed_at = null;
    assert.deepEqual(visibleIds(view), ["tomorrow"]);
    assert.equal(view.currentOnly, true);
});

test("fallback retains due, priority, section, order and title sorting without mutating the store", () => {
    const view = makeView([
        todo("Zulu"), todo("Alpha"), todo("section", { section_key: "planning" }),
        todo("earlier-order", { order: -1 }), todo("priority", { priority: 4 }),
        todo("later-due", { due: { date: "2026-09-18" } }),
        todo("sooner-due", { due: { date: "2026-09-16" } }),
        todo("closed", { due: { date: "2026-09-16" }, completed_at: "2026-09-14T12:00:00Z" }),
    ]);
    view.openOnly = false;
    const original = view.store.getTodos().map((item) => item.id);
    assert.deepEqual(visibleIds(view), [
        "sooner-due", "later-due", "priority", "earlier-order", "Alpha", "Zulu", "section", "closed",
    ]);
    assert.deepEqual(view.store.getTodos().map((item) => item.id), original);
});

/**
 * Minimal append/replace/attribute DOM used to exercise production rendering without a browser dependency.
 * @returns {object}
 */
function node() {
    return {
        children: [], attributes: {}, dataset: {}, scrollTop: 23, textContent: "", className: "",
        classList: { toggle() {} },
        setAttribute(key, value) { this.attributes[key] = value; },
        append(...items) {
            for (const item of items) this.children.push(...(item.fragment ? item.children : [item]));
        },
        replaceChildren(...items) { this.children = []; this.append(...items); },
        set innerHTML(value) { assert.equal(value, ""); this.children = []; },
    };
}

/**
 * Installs only the document operations used by the renderers and restores the original global afterward.
 * @param {import("node:test").TestContext} context Test cleanup owner.
 * @returns {void}
 */
function installDocument(context) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { createElement: node, createDocumentFragment: () => ({ ...node(), fragment: true }) },
    });
    context.after(() => {
        if (original) Object.defineProperty(globalThis, "document", original);
        else delete globalThis.document;
    });
}

test("render shows a transient accessible cue, accurate shown count and normalized selection", (context) => {
    installDocument(context);
    const view = makeView([todo("undated"), todo("other", { project_key: "beta" })]);
    let summary = "";
    Object.assign(view, {
        listEl: node(), selectedTodoId: "missing", onStatsChanged: (value) => { summary = value; },
        updateSaveState() {}, notifyStateChange() {}, buildTodoGroupElement: node,
    });
    view.render();
    const cue = view.listEl.children[0];
    assert.equal(cue.className, "todo-empty todo-non-due-fallback");
    assert.equal(cue.attributes.role, "status");
    assert.equal(cue.textContent, "No current tasks match this project. Showing non-due tasks.");
    assert.equal(view.selectedTodoId, "undated");
    assert.equal(summary, "1 shown • 2 open • 0 completed");
    assert.equal(view.getRouteState().currentOnly, true);
    view.projectFilterKey = "*";
    view.render();
    assert.equal(view.listEl.children.length, 1);
    assert.equal(view.listEl.children[0].textContent, "No tasks match this view.");
    assert.equal(view.selectedTodoId, null);
    assert.equal(summary, "0 shown • 2 open • 0 completed");
    view.projectFilterKey = "alpha";
    view.currentOnly = false;
    view.render();
    assert.ok(view.listEl.children.every((item) => item.className !== "todo-empty todo-non-due-fallback"));
});

test("CombinedTodos production rendering keeps all-workspace current filtering strict and local state intact", (context) => {
    installDocument(context);
    const selected = makeView([todo("undated"), todo("future", { due: { date: "2026-09-16" } })]);
    const second = makeView([
        todo("current", { due: { date: "2026-09-15" } }), todo("undated"),
        todo("closed", { due: { date: "2026-09-15" }, completed_at: "2026-09-15T10:00:00Z" }),
    ]);
    selected.listEl = node();
    selected.projectFiltersEl = node();
    selected.buildTodoRow = node;
    second.buildTodoRow = node;
    const origins = [selected, second].map((view, index) => ({
        id: String(index), name: `Workspace ${index}`, todoStore: view.store, views: { todoView: view },
    }));
    const app = {
        todoView: selected, state: { activeTab: "todos" }, locale: selected.locale,
        shell: { refreshDataBadge() {} },
    };
    const combined = Object.assign(Object.create(CombinedTodos.prototype), {
        sessions: { app, available: () => origins }, enabled: true, rendering: false, selectedKey: "",
    });
    const routes = [selected.getRouteState(), second.getRouteState()];
    assert.equal(selected.getFilteredTodos().showingNonDue, true);
    combined.render();
    assert.deepEqual(combined.rows.map((row) => [row.session.id, row.id]), [["1", "current"]]);
    assert.equal(app.shell.todoSummary, "1 shown • 4 open • 1 completed");
    assert.equal(selected.listEl.scrollTop, 23);
    assert.deepEqual([selected.getRouteState(), second.getRouteState()], routes);
    selected.searchQuery = "undated";
    combined.render();
    assert.deepEqual(combined.rows, []);
    assert.equal(selected.listEl.children[0].textContent, "No tasks match this view.");
    selected.currentOnly = false;
    combined.render();
    assert.deepEqual(combined.rows.map((row) => [row.session.id, row.id]), [["0", "undated"], ["1", "undated"]]);
    assert.equal(combined.rendering, false);
});
