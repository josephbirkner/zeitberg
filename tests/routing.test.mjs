import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    CAPABILITY_FRAGMENT_PREFIX,
    consumeCapabilityLink,
    formatCapabilityLink,
    formatAppRoute,
    normalizeRouteBasePath,
    normalizeWorkspaceRouteLocator,
    parseCapabilityLink,
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

test("Workspace settings preserve the Time panel they cover", () => {
    const route = {
        version: 1,
        component: "time",
        panel: "workspaces",
        workspace: githubWorkspace,
        state: {
            returnPanel: "search",
            weekStart: "2026-08-10",
            query: "workspace-covered search",
            sort: "desc",
        },
    };

    const encoded = formatAppRoute(route);

    assert.match(encoded, /panel=workspaces/);
    assert.match(encoded, /under=search/);
    assert.deepEqual(parseAppRoute(`https://zeitplural.io${encoded}`), route);
});

test("capability links round-trip one exact workspace and keep credentials out of the public route", () => {
    const route = {
        version: 1,
        component: "todos",
        panel: "main",
        workspace: githubWorkspace,
        state: { currentOnly: true, openOnly: false, query: "shared task" },
    };
    const token = "github_pat_dedicated-example-token";
    const link = formatCapabilityLink(route, token, "https://zeitplural.io", "/");
    const url = new URL(link);
    const parsed = parseCapabilityLink(url);

    assert.equal(url.hash.startsWith(CAPABILITY_FRAGMENT_PREFIX), true);
    assert.equal(url.pathname, "/todos");
    assert.equal(url.searchParams.has("token"), false);
    assert.equal(`${url.pathname}${url.search}`.includes(token), false);
    assert.equal(link.includes(token), false);
    assert.equal(parsed.credential, token);
    assert.deepEqual(parsed.route, route);
    assert.equal(parsed.requiresHostConfirmation, false);
});

test("capability links reject host confusion and scrub malformed bearer fragments", () => {
    const route = { version: 1, component: "time", panel: "main", workspace: githubWorkspace, state: {} };
    const link = formatCapabilityLink(route, "dedicated-secret", "https://zeitplural.io");
    const confused = new URL(link);
    confused.searchParams.set("repo", "https://github.com/attacker/other-repository");
    assert.throws(() => parseCapabilityLink(confused), /does not match/);

    const location = new URL(`https://zeitplural.io/time?v=1${CAPABILITY_FRAGMENT_PREFIX}not-valid-base64`);
    const replacements = [];
    const browser = {
        history: {
            replaceState(_state, _title, value) {
                replacements.push(value);
                location.href = new URL(value, location).href;
            },
        },
        location,
    };
    assert.throws(() => consumeCapabilityLink(/** @type {any} */ (browser)), /credential fragment was removed/);
    assert.deepEqual(replacements, ["/time?v=1"]);
    assert.equal(location.hash, "");
});

test("valid capability consumption scrubs history before returning the session credential", () => {
    const route = { version: 1, component: "time", panel: "main", workspace: githubWorkspace, state: {} };
    const location = new URL(formatCapabilityLink(route, "session-only-token", "https://zeitplural.io"));
    let scrubbed = false;
    const browser = {
        history: {
            replaceState(_state, _title, value) {
                scrubbed = true;
                location.href = new URL(value, location).href;
            },
        },
        location,
    };

    const consumed = consumeCapabilityLink(/** @type {any} */ (browser));

    assert.equal(scrubbed, true);
    assert.equal(location.hash, "");
    assert.equal(consumed?.credential, "session-only-token");
    assert.equal(consumed?.route.workspace?.repositoryUrl, githubWorkspace.repositoryUrl);
});

test("custom-host capability links require an additional host confirmation", () => {
    const link = formatCapabilityLink(
        {
            version: 1,
            component: "expenses",
            panel: "main",
            workspace: {
                provider: "custom",
                repositoryUrl: "https://git.example.test/family/shared-expenses",
                ref: "main",
                workspacePath: "zeitplural.json",
                expectedWorkspaceId: "family-expenses",
            },
            state: {},
        },
        "custom-host-token",
        "https://zeitplural.io",
    );

    assert.equal(parseCapabilityLink(link).requiresHostConfirmation, true);
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
    assert.equal(workspaceRouteLocatorKey(parsed.workspace), "local:local-workspace:nested/zeitplural.json");
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

test("workspace locators normalize GitLab groups and bound Forgejo repository paths", () => {
    assert.deepEqual(
        normalizeWorkspaceRouteLocator({
            provider: "gitlab",
            repositoryUrl: "https://gitlab.com/group/subgroup/workspace.git/",
            ref: "main",
            workspacePath: "zeitplural.json",
            expectedWorkspaceId: "",
        }),
        {
            provider: "gitlab",
            repositoryUrl: "https://gitlab.com/group/subgroup/workspace",
            ref: "main",
            workspacePath: "zeitplural.json",
            expectedWorkspaceId: "",
        },
    );
    assert.throws(
        () =>
            normalizeWorkspaceRouteLocator({
                provider: "forgejo",
                repositoryUrl: "https://git.example.test/group/subgroup/workspace",
                ref: "main",
                workspacePath: "zeitplural.json",
                expectedWorkspaceId: "",
            }),
        /exactly one owner/,
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
    assert.match(localServer, /"\/local-workspaces"/);
    assert.match(localServer, /action="append"/);
    assert.match(localServer, /workspace_id/);
});
