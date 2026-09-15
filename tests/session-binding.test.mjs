import assert from "node:assert/strict";
import test from "node:test";
import { SessionBinding, bindSessionEvents } from "../session-binding.js";
import { parseAppRoute, formatAppRoute } from "../routing.js";
import { DataSource, CustomGitDataSource, ForgejoDataSource } from "../datasource.js";

test("shared listeners dispatch to the mounted controller without redirecting pending async work", async () => {
    let resume;
    const pending = new Promise((resolve) => { resume = resolve; });
    const first = {
        value: 1,
        increment() { this.value++; },
        async save() { await pending; this.value += 10; },
    };
    const second = { ...first, value: 100 };
    const binding = new SessionBinding(first);
    const event = () => binding.proxy.increment();
    const saving = binding.proxy.save();
    binding.target = second;
    event();
    binding.proxy.value += 1;
    resume();
    await saving;
    assert.equal(first.value, 11);
    assert.equal(second.value, 102);
});

test("secondary controllers never install duplicate shared-control listeners", () => {
    const handlers = [];
    const first = { value: 1, bindEvents() { handlers.push(() => this.increment()); }, increment() { this.value++; } };
    const second = { ...first, value: 10 };
    const binding = bindSessionEvents(first, {});
    bindSessionEvents(second, { bindEvents: false });
    binding.target = second;
    assert.equal(handlers.length, 1);
    handlers[0]();
    assert.equal(first.value, 1);
    assert.equal(second.value, 11);
});

test("combined task routes and explicit search scopes round-trip without bearer credentials", () => {
    const locator = { provider: "local", repositoryUrl: "", ref: "", workspacePath: "zeitberg.json", expectedWorkspaceId: "alpha" };
    const todo = { version: 1, component: "todos", panel: "main", workspace: locator, state: { allWorkspaces: true, selectedTodoId: "shared", currentOnly: false } };
    const todoUrl = formatAppRoute(todo);
    assert.equal(parseAppRoute(todoUrl).state.allWorkspaces, true);
    assert.equal(parseAppRoute(todoUrl).state.selectedTodoId, "shared");
    const search = { ...todo, component: "time", panel: "search", state: { workspaceScope: "local:beta", query: "Shared entry" } };
    const searchUrl = formatAppRoute(search);
    assert.equal(parseAppRoute(searchUrl).state.workspaceScope, "local:beta");
    assert.equal(parseAppRoute(searchUrl).state.query, "Shared entry");
});

test("credential refresh retains the detected provider and its concurrency baselines", () => {
    const config = { provider: "custom", repositoryUrl: "https://git.example.org/team/workspace", ref: "main", workspacePath: "zeitberg.json" };
    assert.throws(() => new DataSource(config).setToken("replacement"), /does not support credentials/);
    const source = new CustomGitDataSource(config, "old");
    source.setToken("before-detection");
    assert.equal(source.token, "before-detection");
    const delegate = new ForgejoDataSource(config, "old");
    source.delegate = delegate;
    source.setToken("replacement");
    assert.equal(source.delegate, delegate);
    assert.equal(delegate.token, "replacement");
});
