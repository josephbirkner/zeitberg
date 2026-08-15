import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    formatAppRoute,
    normalizeRouteBasePath,
    normalizeWorkspaceRouteLocator,
    parseAppRoute,
    RouteController,
    STATIC_ROUTE_STORAGE_KEY,
    workspaceRouteLocatorKey,
} from "../routing.js";

const githubWorkspace = {
    provider: "github",
    repositoryUrl: "https://github.com/example/private-data",
    ref: "release/data",
    workspacePath: "config/zeitplural.json",
    expectedWorkspaceId: "workspace-123",
};

test("component routes round-trip workspace and Time view state", () => {
    const route = {
        version: 1,
        component: "time",
        panel: "search",
        workspace: githubWorkspace,
        state: {
            weekStart: "2026-08-10",
            dayWindowStart: 2,
            selectedEntryId: 42,
            zoom: 1.75,
            scrollMinutes: 485.5,
            query: "release planning",
            project: "p:app",
            from: "2026-08-01",
            to: "2026-08-16",
            maxRows: 750,
            sort: "asc",
        },
    };

    const encoded = formatAppRoute(route, "/zeitplural/");
    assert.match(encoded, /^\/zeitplural\/time\?/);
    assert.match(encoded, /panel=search/);
    assert.equal(encoded.includes("token"), false);
    assert.deepEqual(parseAppRoute(`https://example.test${encoded}`, "/zeitplural/"), route);
});

test("TODO routes preserve explicit false filters and selection", () => {
    const encoded = formatAppRoute(
        {
            version: 1,
            component: "todos",
            panel: "main",
            workspace: githubWorkspace,
            state: {
                query: "passport",
                project: "travel",
                selectedTodoId: "local:todo-1",
                currentOnly: false,
                openOnly: true,
            },
        },
        "/",
    );
    const parsed = parseAppRoute(`https://zeitplural.io${encoded}`);

    assert.equal(parsed.component, "todos");
    assert.deepEqual(parsed.state, {
        query: "passport",
        project: "travel",
        selectedTodoId: "local:todo-1",
        currentOnly: false,
        openOnly: true,
    });
});

test("local routes retain source mode without inventing repository coordinates", () => {
    const encoded = formatAppRoute({
        version: 1,
        component: "time",
        panel: "main",
        workspace: {
            provider: "local",
            repositoryUrl: "",
            ref: "",
            workspacePath: "nested/zeitplural.json",
            expectedWorkspaceId: "local-workspace",
        },
        state: {},
    });
    const parsed = parseAppRoute(`http://127.0.0.1:8000${encoded}`);

    assert.match(encoded, /source=local/);
    assert.deepEqual(parsed.workspace, {
        provider: "local",
        repositoryUrl: "",
        ref: "",
        workspacePath: "nested/zeitplural.json",
        expectedWorkspaceId: "local-workspace",
    });
});

test("malformed and unavailable route shapes fall back safely", () => {
    assert.deepEqual(parseAppRoute("https://zeitplural.io/not-a-component?token=secret"), {
        version: 1,
        component: null,
        panel: "main",
        workspace: null,
        state: {},
    });

    const malformed = parseAppRoute(
        "https://zeitplural.io/time?provider=github&repo=https%3A%2F%2Fevil.example%2Fx%3Ftoken%3Dsecret&day=999&zoom=nope",
    );
    assert.equal(malformed.workspace, null);
    assert.deepEqual(malformed.state, { dayWindowStart: 6 });
    assert.equal(parseAppRoute("https://zeitplural.io/time?v=99").component, null);
});

test("workspace locators reject credential-confusing repository URLs", () => {
    assert.throws(
        () =>
            normalizeWorkspaceRouteLocator({
                ...githubWorkspace,
                repositoryUrl: "https://token@github.com/example/private-data",
            }),
        /no credentials/,
    );
    assert.throws(
        () => normalizeWorkspaceRouteLocator({ ...githubWorkspace, repositoryUrl: "https://example.test/example/data" }),
        /github\.com/,
    );
    assert.throws(
        () => normalizeWorkspaceRouteLocator({ ...githubWorkspace, workspacePath: "../zeitplural.json" }),
        /unsafe segment/,
    );
    assert.equal(
        workspaceRouteLocatorKey(githubWorkspace),
        "github:https://github.com/example/private-data:release/data:config/zeitplural.json",
    );
});

test("route base paths remain stable for root and project-page deployments", () => {
    assert.equal(normalizeRouteBasePath("/"), "/");
    assert.equal(normalizeRouteBasePath("zeitplural"), "/zeitplural/");
    assert.equal(parseAppRoute("https://example.test/time", "/zeitplural/").component, null);
});

test("History controller restores a same-origin static route and handles push plus replace", () => {
    const listeners = new Map();
    const storage = new Map([[STATIC_ROUTE_STORAGE_KEY, "/zeitplural/todos?q=one"]]);
    const location = new URL("https://example.test/zeitplural/");
    const writes = [];
    const browser = {
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        clearTimeout,
        history: {
            pushState(_state, _title, value) {
                writes.push(["push", value]);
                location.href = new URL(value, location).href;
            },
            replaceState(_state, _title, value) {
                writes.push(["replace", value]);
                location.href = new URL(value, location).href;
            },
        },
        location,
        removeEventListener(type) {
            listeners.delete(type);
        },
        sessionStorage: {
            getItem(key) {
                return storage.get(key) || null;
            },
            removeItem(key) {
                storage.delete(key);
            },
        },
        setTimeout,
    };
    const controller = new RouteController(/** @type {any} */ (browser), "/zeitplural/");

    assert.equal(controller.restoreStaticRoute(), true);
    assert.equal(controller.read().component, "todos");
    controller.write({ version: 1, component: "time", panel: "main", workspace: null, state: {} }, "push");
    assert.deepEqual(writes.map(([kind]) => kind), ["replace", "push"]);

    let popped = null;
    controller.start((route) => {
        popped = route;
    });
    listeners.get("popstate")();
    assert.equal(popped.component, "time");
    controller.stop();
});

test("static-host and local-server entrypoints preserve component-first reloads", async () => {
    const [notFoundPage, localServer] = await Promise.all([
        readFile(new URL("../404.html", import.meta.url), "utf8"),
        readFile(new URL("../server.py", import.meta.url), "utf8"),
    ]);

    assert.match(notFoundPage, /zeitplural:static-route:v1/);
    assert.match(notFoundPage, /location\.replace\(basePath\)/);
    assert.match(localServer, /\{"time", "todos", "expenses"\}/);
    assert.match(localServer, /_is_application_route\(parsed\.path, self\.app_entry_path\)/);
});
