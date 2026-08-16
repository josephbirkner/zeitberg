import assert from "node:assert/strict";
import test from "node:test";

import {
    buildGitHubIssueUrl,
    GitHubDataSource,
    LocalDataSource,
    parseGitHubRepositoryId,
} from "../datasource.js";
import { Workspace } from "../model.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * Builds minimal manifest chunk metadata for data-source tests.
 * @param {string} sha
 * @param {number} week
 * @param {string} text
 * @returns {import("../model.js").ManifestChunk}
 */
function makeChunk(sha, week, text) {
    return {
        entries: 0,
        path: `data/entries/2026/${String(week).padStart(2, "0")}.json`,
        sha,
        size: Buffer.byteLength(text),
        week,
        year: 2026,
    };
}

/**
 * Creates a JSON response compatible with the browser Fetch API.
 * @param {Object} body
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

test("GitHub issue repository identities are strictly bounded", () => {
    assert.deepEqual(parseGitHubRepositoryId("owner/repo"), { owner: "owner", repo: "repo" });
    assert.equal(buildGitHubIssueUrl("owner/repo", 42), "https://github.com/owner/repo/issues/42");
    assert.throws(() => parseGitHubRepositoryId("owner/repo/issues"), /Invalid GitHub repository binding/);
    assert.throws(() => buildGitHubIssueUrl("owner/repo", 0), /Invalid GitHub issue number/);
});

test("GitHub issue writes can target a repository other than the workspace", async (context) => {
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({ url: String(url), options });
        const requestBody = JSON.parse(String(options?.body || "{}"));
        return jsonResponse({ number: requestBody.title ? 17 : 17, ...requestBody });
    });

    const source = new GitHubDataSource({ owner: "workspace-owner", repo: "workspace-data", ref: "main" }, "secret");
    const created = await source.createGitHubIssue("app-owner/zeitplural", {
        title: "Issue-backed TODO",
        body: "Details",
        labels: ["type/feature"],
        state: "open",
    });
    await source.updateGitHubIssue("app-owner/zeitplural", created.number, { state: "closed" });

    assert.equal(requests[0].url, "https://api.github.com/repos/app-owner/zeitplural/issues");
    assert.equal(requests[0].options?.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0].options?.body)), {
        title: "Issue-backed TODO",
        body: "Details",
        labels: ["type/feature"],
    });
    assert.equal(requests[0].options?.headers?.Authorization, "Bearer secret");
    assert.equal(requests[1].url, "https://api.github.com/repos/app-owner/zeitplural/issues/17");
    assert.equal(requests[1].options?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(requests[1].options?.body)), { state: "closed" });
});

test("GitHub data source bootstraps configured workspace document paths", async (context) => {
    const workspaceRaw = {
        components: {
            tasks: { paths: { document: "records/todos.json" }, type: "todos" },
            time: {
                paths: {
                    entries: "records/weeks",
                    manifest: "records/manifest.json",
                    week_requirements: "records/requirements.json",
                },
                type: "time_tracking",
            },
        },
        name: "Test",
        resources: { projects: "records/projects.json" },
        schema_version: 1,
        timezone: "Europe/Berlin",
        workspace_id: "test",
    };
    const requestedPaths = [];
    context.mock.method(globalThis, "fetch", async (url) => {
        const requestUrl = new URL(String(url));
        requestedPaths.push(requestUrl.pathname);
        const path = requestUrl.pathname.split("/contents/")[1];
        const documents = {
            "config/workspace.json": workspaceRaw,
            "records/manifest.json": { chunks: [], schema_version: 2, timezone: "Europe/Berlin" },
            "records/projects.json": { projects: [], schema_version: 2 },
            "records/requirements.json": { default_required_hours: 40, schema_version: 2, weeks: [] },
            "records/todos.json": { schema_version: 3, todos: [] },
        };
        return new Response(JSON.stringify(documents[path]), { status: documents[path] ? 200 : 404 });
    });

    const source = new GitHubDataSource(
        { owner: "owner", repo: "repo", ref: "main", workspacePath: "config/workspace.json" },
        "token",
    );
    source.setWorkspace(Workspace.fromRaw(await source.fetchWorkspace()));
    await Promise.all([source.fetchManifest(), source.fetchProjects(), source.fetchWeekRequirements(), source.fetchTodos()]);

    assert.deepEqual(requestedPaths, [
        "/repos/owner/repo/contents/config/workspace.json",
        "/repos/owner/repo/contents/records/manifest.json",
        "/repos/owner/repo/contents/records/projects.json",
        "/repos/owner/repo/contents/records/requirements.json",
        "/repos/owner/repo/contents/records/todos.json",
    ]);
});

test("local data sources scope discovery, reads, and writes by workspace id", async (context) => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { origin: "http://127.0.0.1:8000" } },
    });
    context.after(() => {
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else delete globalThis.window;
    });

    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        const requestUrl = new URL(String(url));
        requests.push({ options, url: requestUrl });
        if (requestUrl.pathname === "/local-workspaces") {
            return jsonResponse({
                default_workspace_id: "personal",
                workspaces: [
                    { name: "Personal", workspace_id: "personal", workspace_path: "zeitplural.json" },
                    { name: "Shared", workspace_id: "shared", workspace_path: "config/workspace.json" },
                ],
            });
        }
        if (requestUrl.pathname === "/workspace-config") {
            return jsonResponse({ name: "Shared", schema_version: 1, workspace_id: "shared" });
        }
        if (requestUrl.pathname === "/save") return jsonResponse({ ok: true });
        return jsonResponse({}, 404);
    });

    const source = new LocalDataSource({
        owner: "",
        repo: "",
        ref: "",
        workspacePath: "config/workspace.json",
        localWorkspaceId: "shared",
    });
    const catalog = await source.fetchAvailableWorkspaces();
    await source.fetchWorkspace();
    await source.saveFiles([{ content: "{}\n", path: "data/todos.json" }], "Save TODOs");

    assert.equal(catalog.workspaces.length, 2);
    assert.equal(requests[0].url.search, "");
    assert.equal(requests[1].url.searchParams.get("workspace"), "shared");
    assert.equal(JSON.parse(String(requests[2].options?.body)).workspace_id, "shared");
});

test("GitHub chunk loading retrieves multiple manifest blobs in one GraphQL request", async (context) => {
    const textA = '{"entries":[],"schema_version":2}\n';
    const textB = '{"entries":[],"schema_version":2,"week":2}\n';
    const chunks = [makeChunk(SHA_A, 1, textA), makeChunk(SHA_B, 2, textB)];
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({ url: String(url), options });
        const body = JSON.parse(String(options?.body || "{}"));
        assert.match(body.query, /chunk0: object\(oid: "a{40}"\)/);
        assert.match(body.query, /chunk1: object\(oid: "b{40}"\)/);
        assert.deepEqual(body.variables, { owner: "owner", repo: "repo" });
        return jsonResponse({
            data: {
                repository: {
                    chunk0: { oid: SHA_A, byteSize: Buffer.byteLength(textA), isBinary: false, isTruncated: false, text: textA },
                    chunk1: { oid: SHA_B, byteSize: Buffer.byteLength(textB), isBinary: false, isTruncated: false, text: textB },
                },
            },
        });
    });

    const source = new GitHubDataSource({ owner: "owner", repo: "repo", ref: "main" }, "token");
    const result = await source.fetchChunkTexts(chunks);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.github.com/graphql");
    assert.equal(requests[0].options?.method, "POST");
    assert.equal(result.get(SHA_A), textA);
    assert.equal(result.get(SHA_B), textB);
});

test("GitHub chunk loading falls back to REST only for an unresolved GraphQL blob", async (context) => {
    const textA = '{"entries":[],"schema_version":2}\n';
    const textB = '{"entries":[],"schema_version":2,"week":2}\n';
    const chunks = [makeChunk(SHA_A, 1, textA), makeChunk(SHA_B, 2, textB)];
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        const requestUrl = String(url);
        requests.push(requestUrl);
        if (requestUrl === "https://api.github.com/graphql") {
            return jsonResponse({
                data: {
                    repository: {
                        chunk0: { oid: SHA_A, byteSize: Buffer.byteLength(textA), isBinary: false, isTruncated: false, text: textA },
                        chunk1: { oid: SHA_B, byteSize: Buffer.byteLength(textB), isBinary: false, isTruncated: true, text: textB },
                    },
                },
            });
        }
        assert.match(requestUrl, new RegExp(`/git/blobs/${SHA_B}$`));
        assert.equal(options?.headers?.Accept, "application/vnd.github.raw");
        return new Response(textB, { status: 200 });
    });

    const source = new GitHubDataSource({ owner: "owner", repo: "repo", ref: "main" }, "token");
    const result = await source.fetchChunkTexts(chunks);

    assert.deepEqual(requests, ["https://api.github.com/graphql", `https://api.github.com/repos/owner/repo/git/blobs/${SHA_B}`]);
    assert.equal(result.get(SHA_A), textA);
    assert.equal(result.get(SHA_B), textB);
});

test("GitHub chunk loading retries a failed bulk query as smaller GraphQL batches", async (context) => {
    const textA = '{"entries":[],"schema_version":2}\n';
    const textB = '{"entries":[],"schema_version":2,"week":2}\n';
    const chunks = [makeChunk(SHA_A, 1, textA), makeChunk(SHA_B, 2, textB)];
    let graphqlRequests = 0;
    context.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(String(url), "https://api.github.com/graphql");
        graphqlRequests += 1;
        const body = JSON.parse(String(options?.body || "{}"));
        if (graphqlRequests === 1) {
            assert.match(body.query, /chunk1:/);
            return jsonResponse({ data: null, errors: [{ message: "The query timed out." }] });
        }

        assert.doesNotMatch(body.query, /chunk1:/);
        const isFirstChunk = body.query.includes(SHA_A);
        const sha = isFirstChunk ? SHA_A : SHA_B;
        const text = isFirstChunk ? textA : textB;
        return jsonResponse({
            data: {
                repository: {
                    chunk0: { oid: sha, byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: false, text },
                },
            },
        });
    });

    const source = new GitHubDataSource({ owner: "owner", repo: "repo", ref: "main" }, "token");
    const result = await source.fetchChunkTexts(chunks);

    assert.equal(graphqlRequests, 3);
    assert.equal(result.get(SHA_A), textA);
    assert.equal(result.get(SHA_B), textB);
});

test("GitHub chunk loading splits histories that exceed the response-size budget", async (context) => {
    const textA = '{"entries":[],"schema_version":2}\n';
    const textB = '{"entries":[],"schema_version":2,"week":2}\n';
    const chunks = [makeChunk(SHA_A, 1, textA), makeChunk(SHA_B, 2, textB)];
    chunks[0].size = 5 * 1024 * 1024;
    chunks[1].size = 5 * 1024 * 1024;
    let graphqlRequests = 0;
    context.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(String(url), "https://api.github.com/graphql");
        graphqlRequests += 1;
        const body = JSON.parse(String(options?.body || "{}"));
        assert.doesNotMatch(body.query, /chunk1:/);
        const isFirstChunk = body.query.includes(SHA_A);
        const chunk = isFirstChunk ? chunks[0] : chunks[1];
        const text = isFirstChunk ? textA : textB;
        return jsonResponse({
            data: {
                repository: {
                    chunk0: { oid: chunk.sha, byteSize: chunk.size, isBinary: false, isTruncated: false, text },
                },
            },
        });
    });

    const source = new GitHubDataSource({ owner: "owner", repo: "repo", ref: "main" }, "token");
    const result = await source.fetchChunkTexts(chunks);

    assert.equal(graphqlRequests, 2);
    assert.equal(result.get(SHA_A), textA);
    assert.equal(result.get(SHA_B), textB);
});
