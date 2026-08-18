import assert from "node:assert/strict";
import test from "node:test";

import {
    buildGitHubIssueUrl,
    createHostedDataSource,
    ForgejoDataSource,
    GitHubDataSource,
    GitLabDataSource,
    LocalDataSource,
    parseGitHubRepositoryId,
    parseHostedRepositoryUrl,
} from "../datasource.js";
import { Workspace } from "../model.js";
import { gitBlobSha1 } from "../utils.js";

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
 * @param {HeadersInit} [headers]
 * @returns {Response}
 */
function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

/**
 * Encodes UTF-8 fixture text as provider-compatible base64.
 * @param {string} value
 * @returns {string}
 */
function base64(value) {
    return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Builds a complete workspace model for hosted-provider save tests.
 * @returns {Workspace}
 */
function makeWorkspace() {
    return Workspace.fromRaw({
        components: {
            expenses: {
                paths: {
                    document: "data/expenses.json",
                    manifest: "data/index/expenses-manifest.json",
                },
                type: "expenses",
            },
            tasks: { paths: { document: "data/todos.json" }, type: "todos" },
            time: {
                paths: {
                    entries: "data/entries",
                    manifest: "data/index/entries-manifest.json",
                    week_requirements: "data/week-requirements.json",
                },
                type: "time_tracking",
            },
        },
        name: "Provider test",
        resources: { projects: "data/projects.json" },
        schema_version: 1,
        timezone: "Europe/Berlin",
        workspace_id: "provider-test",
    });
}

test("hosted repository URLs enforce provider hosts and repository shapes", () => {
    assert.deepEqual(parseHostedRepositoryUrl("https://gitlab.com/group/subgroup/workspace.git", "gitlab"), {
        origin: "https://gitlab.com",
        owner: "group",
        repo: "workspace",
        repositoryPath: "group/subgroup/workspace",
        repositoryUrl: "https://gitlab.com/group/subgroup/workspace",
    });
    assert.equal(
        parseHostedRepositoryUrl("https://codeberg.org/person/workspace", "codeberg").repositoryPath,
        "person/workspace",
    );
    assert.throws(
        () => parseHostedRepositoryUrl("https://gitlab.example/group/workspace", "gitlab"),
        /requires a gitlab\.com/,
    );
    assert.throws(
        () => parseHostedRepositoryUrl("https://codeberg.org/group/subgroup/workspace", "codeberg"),
        /exactly one owner/,
    );
    assert.throws(
        () => parseHostedRepositoryUrl("https://user:secret@codeberg.org/person/workspace", "codeberg"),
        /no credentials/,
    );
});

test("the hosted data-source factory selects GitHub, GitLab, and Forgejo implementations", () => {
    assert.ok(createHostedDataSource({ owner: "o", repo: "r", ref: "main", provider: "github" }, "t") instanceof GitHubDataSource);
    assert.ok(
        createHostedDataSource(
            { owner: "", repo: "", ref: "main", provider: "gitlab", repositoryUrl: "https://gitlab.com/o/r" },
            "t",
        ) instanceof GitLabDataSource,
    );
    assert.ok(
        createHostedDataSource(
            { owner: "", repo: "", ref: "main", provider: "codeberg", repositoryUrl: "https://codeberg.org/o/r" },
            "t",
        ) instanceof ForgejoDataSource,
    );
});

test("custom hosted providers report browser CORS incompatibility during protocol detection", async (context) => {
    context.mock.method(globalThis, "fetch", async () => {
        throw new TypeError("Failed to fetch");
    });
    const source = createHostedDataSource(
        {
            owner: "",
            repo: "",
            ref: "main",
            provider: "custom",
            repositoryUrl: "https://git.example.test/person/workspace",
        },
        "custom-token",
    );

    await assert.rejects(() => source.checkConnection(), /may not permit cross-origin API requests/);
});

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
    const created = await source.createGitHubIssue("app-owner/zeitberg", {
        title: "Issue-backed TODO",
        body: "Details",
        labels: ["type/feature"],
        state: "open",
    });
    await source.updateGitHubIssue("app-owner/zeitberg", created.number, { state: "closed" });

    assert.equal(requests[0].url, "https://api.github.com/repos/app-owner/zeitberg/issues");
    assert.equal(requests[0].options?.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0].options?.body)), {
        title: "Issue-backed TODO",
        body: "Details",
        labels: ["type/feature"],
    });
    assert.equal(requests[0].options?.headers?.Authorization, "Bearer secret");
    assert.equal(requests[1].url, "https://api.github.com/repos/app-owner/zeitberg/issues/17");
    assert.equal(requests[1].options?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(requests[1].options?.body)), { state: "closed" });
});

test("GitHub issue loading paginates open and closed issues, excludes pull requests, and reuses ETags", async (context) => {
    const requests = [];
    let revalidate = false;
    context.mock.method(globalThis, "fetch", async (url, options) => {
        const requestUrl = new URL(String(url));
        const page = Number(requestUrl.searchParams.get("page"));
        requests.push({ page, headers: options?.headers, url: requestUrl });
        if (revalidate) {
            return new Response(null, { status: 304 });
        }
        if (page === 1) {
            return jsonResponse(
                [
                    { number: 1, state: "open", title: "First issue" },
                    { number: 2, pull_request: { url: "https://api.github.test/pulls/2" }, title: "A pull request" },
                ],
                200,
                {
                    ETag: '"page-one"',
                    Link: '<https://api.github.com/repos/owner/app/issues?state=all&page=2>; rel="next"',
                },
            );
        }
        return jsonResponse(
            [{ number: 3, state: "closed", title: "Closed issue" }],
            200,
            { ETag: '"page-two"' },
        );
    });
    const source = new GitHubDataSource({ owner: "workspace", repo: "data", ref: "main" }, "read-token");

    const first = await source.fetchGitHubIssues("owner/app");
    assert.deepEqual(first.issues.map((issue) => issue.number), [1, 3]);
    assert.equal(first.pages.length, 2);
    assert.equal(first.usedCachedPages, false);
    assert.equal(requests[0].url.searchParams.get("state"), "all");
    assert.equal(requests[0].url.searchParams.get("per_page"), "100");

    revalidate = true;
    const second = await source.fetchGitHubIssues("owner/app", first.pages);
    assert.deepEqual(second.issues.map((issue) => issue.number), [1, 3]);
    assert.equal(second.usedCachedPages, true);
    assert.equal(requests[2].headers?.["If-None-Match"], '"page-one"');
    assert.equal(requests[3].headers?.["If-None-Match"], '"page-two"');
});

test("GitHub repository inspection uses the bound repository and remains non-mutating", async (context) => {
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({ url: String(url), method: options?.method || "GET" });
        return jsonResponse({ private: true, has_issues: true, permissions: { pull: true, push: false } });
    });
    const source = new GitHubDataSource({ owner: "workspace", repo: "data", ref: "main" }, "read-token");

    const info = await source.fetchGitHubRepositoryInfo("owner/app");
    assert.equal(info.private, true);
    assert.deepEqual(requests, [{ url: "https://api.github.com/repos/owner/app", method: "GET" }]);
});

test("GitHub data source bootstraps configured workspace document paths", async (context) => {
    const workspaceRaw = {
        components: {
            expenses: {
                paths: {
                    document: "records/expenses.json",
                    manifest: "records/expenses-manifest.json",
                },
                type: "expenses",
            },
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
            "records/expenses.json": { categories: [], expenses: [], participants: [], schema_version: 1, transfers: [] },
            "records/expenses-manifest.json": { expenses: 0, schema_version: 1 },
        };
        return new Response(JSON.stringify(documents[path]), { status: documents[path] ? 200 : 404 });
    });

    const source = new GitHubDataSource(
        { owner: "owner", repo: "repo", ref: "main", workspacePath: "config/workspace.json" },
        "token",
    );
    source.setWorkspace(Workspace.fromRaw(await source.fetchWorkspace()));
    await Promise.all([
        source.fetchManifest(),
        source.fetchProjects(),
        source.fetchWeekRequirements(),
        source.fetchTodos(),
        source.fetchExpensesText(),
        source.fetchExpensesManifest(),
    ]);

    assert.deepEqual(requestedPaths, [
        "/repos/owner/repo/contents/config/workspace.json",
        "/repos/owner/repo/contents/records/manifest.json",
        "/repos/owner/repo/contents/records/projects.json",
        "/repos/owner/repo/contents/records/requirements.json",
        "/repos/owner/repo/contents/records/todos.json",
        "/repos/owner/repo/contents/records/expenses.json",
        "/repos/owner/repo/contents/records/expenses-manifest.json",
    ]);
});

test("GitLab reads configured files and writes changed documents in one guarded commit", async (context) => {
    const workspace = makeWorkspace();
    const workspaceText = workspace.toJson();
    const weekPath = "data/entries/2026/33.json";
    const weekText = '{"entries":[],"schema_version":2}\n';
    const manifestPath = "data/index/entries-manifest.json";
    const manifestText = '{"chunks":[],"schema_version":2,"timezone":"Europe/Berlin"}\n';
    const commitId = "c".repeat(40);
    const requests = [];

    context.mock.method(globalThis, "fetch", async (url, options = {}) => {
        const requestUrl = new URL(String(url));
        const method = options.method || "GET";
        const body = options.body ? JSON.parse(String(options.body)) : null;
        requests.push({ body, method, url: requestUrl });
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");

        if (requestUrl.pathname.endsWith("/repository/files/zeitberg.json")) {
            return jsonResponse({ content: base64(workspaceText), encoding: "base64" });
        }
        if (requestUrl.pathname.endsWith("/repository/commits") && method === "POST") {
            return jsonResponse({ id: commitId });
        }
        const decodedPath = decodeURIComponent(requestUrl.pathname.split("/repository/files/")[1] || "");
        if (requestUrl.searchParams.get("ref") === commitId) {
            const content = decodedPath === weekPath ? weekText : manifestText;
            return jsonResponse({ blob_id: gitBlobSha1(content) });
        }
        if (decodedPath === weekPath) return jsonResponse({ last_commit_id: "b".repeat(40) });
        if (decodedPath === manifestPath) return jsonResponse({ message: "404 File Not Found" }, 404);
        return jsonResponse({ message: "unexpected request" }, 500);
    });

    const source = new GitLabDataSource(
        {
            owner: "",
            repo: "",
            ref: "main",
            provider: "gitlab",
            repositoryUrl: "https://gitlab.com/group/nested/workspace",
            workspacePath: "zeitberg.json",
        },
        "gitlab-token",
    );
    source.setWorkspace(Workspace.fromRaw(await source.fetchWorkspace()));
    const result = await source.saveFiles(
        [
            { path: weekPath, content: weekText },
            { path: manifestPath, content: manifestText },
        ],
        "Save provider test",
    );

    const commitRequest = requests.find((request) => request.url.pathname.endsWith("/repository/commits"));
    assert.equal(commitRequest.method, "POST");
    assert.deepEqual(commitRequest.body, {
        branch: "main",
        commit_message: "Save provider test",
        actions: [
            {
                action: "update",
                file_path: weekPath,
                content: weekText,
                encoding: "text",
                last_commit_id: "b".repeat(40),
            },
            {
                action: "create",
                file_path: manifestPath,
                content: manifestText,
                encoding: "text",
            },
        ],
    });
    assert.deepEqual(
        result.files.map((file) => file.sha),
        [gitBlobSha1(weekText), gitBlobSha1(manifestText)],
    );
    assert.match(requests[0].url.pathname, /\/api\/v4\/projects\/group%2Fnested%2Fworkspace\/repository\/files/);
});

test("Forgejo decodes immutable blobs and commits the entries manifest last", async (context) => {
    const workspace = makeWorkspace();
    const weekPath = "data/entries/2026/33.json";
    const weekText = '{"entries":[],"schema_version":2}\n';
    const manifestPath = "data/index/entries-manifest.json";
    const manifestText = '{"chunks":[],"schema_version":2,"timezone":"Europe/Berlin"}\n';
    const requests = [];
    const blobSha = gitBlobSha1(weekText);

    context.mock.method(globalThis, "fetch", async (url, options = {}) => {
        const requestUrl = new URL(String(url));
        const method = options.method || "GET";
        const body = options.body ? JSON.parse(String(options.body)) : null;
        requests.push({ body, method, url: requestUrl });
        assert.equal(options.headers.Authorization, "token forgejo-token");

        if (requestUrl.pathname.endsWith(`/git/blobs/${blobSha}`)) {
            return jsonResponse({ content: base64(weekText), encoding: "base64", sha: blobSha });
        }
        const marker = "/contents/";
        const encodedPath = requestUrl.pathname.includes(marker) ? requestUrl.pathname.split(marker)[1] : "";
        const path = encodedPath.split("/").map(decodeURIComponent).join("/");
        if (method === "GET") {
            if (path === weekPath) return jsonResponse({ content: base64("old"), encoding: "base64", sha: "a".repeat(40) });
            if (path === manifestPath) return jsonResponse({ message: "not found" }, 404);
        }
        if (method === "PUT" || method === "POST") {
            const content = Buffer.from(body.content, "base64").toString("utf8");
            return jsonResponse({ content: { sha: gitBlobSha1(content) } });
        }
        return jsonResponse({ message: "unexpected request" }, 500);
    });

    const source = new ForgejoDataSource(
        {
            owner: "",
            repo: "",
            ref: "main",
            provider: "codeberg",
            repositoryUrl: "https://codeberg.org/person/workspace",
        },
        "forgejo-token",
    );
    source.setWorkspace(workspace);
    assert.equal(await source.fetchChunkText(makeChunk(blobSha, 33, weekText)), weekText);
    const result = await source.saveFiles(
        [
            { path: manifestPath, content: manifestText },
            { path: weekPath, content: weekText },
        ],
        "Save provider test",
    );

    const writes = requests.filter((request) => request.method === "PUT" || request.method === "POST");
    assert.equal(writes.length, 2);
    assert.match(writes[0].url.pathname, /data\/entries\/2026\/33\.json$/);
    assert.equal(writes[0].method, "PUT");
    assert.equal(writes[0].body.sha, "a".repeat(40));
    assert.match(writes[1].url.pathname, /data\/index\/entries-manifest\.json$/);
    assert.equal(writes[1].method, "POST");
    assert.deepEqual(
        result.files.map((file) => file.path),
        [weekPath, manifestPath],
    );
});

test("GitLab and Codeberg repository creation is private and initializes a SHA-1-compatible default branch", async (context) => {
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options = {}) => {
        const requestUrl = new URL(String(url));
        const body = JSON.parse(String(options.body || "{}"));
        requests.push({ body, url: requestUrl });
        if (requestUrl.hostname === "gitlab.com") {
            return jsonResponse({ path_with_namespace: "person/new-space", web_url: "https://gitlab.com/person/new-space" });
        }
        return jsonResponse({ full_name: "person/new-space", html_url: "https://codeberg.org/person/new-space" });
    });
    const gitlab = new GitLabDataSource(
        {
            owner: "",
            repo: "",
            ref: "main",
            provider: "gitlab",
            repositoryUrl: "https://gitlab.com/placeholder/workspace",
        },
        "token",
    );
    const codeberg = new ForgejoDataSource(
        {
            owner: "",
            repo: "",
            ref: "main",
            provider: "codeberg",
            repositoryUrl: "https://codeberg.org/placeholder/workspace",
        },
        "token",
    );

    assert.equal((await gitlab.createPrivateRepository("new-space")).repositoryUrl, "https://gitlab.com/person/new-space");
    assert.equal((await codeberg.createPrivateRepository("new-space")).repositoryUrl, "https://codeberg.org/person/new-space");
    assert.equal(requests[0].url.pathname, "/api/v4/projects");
    assert.equal(requests[0].body.visibility, "private");
    assert.equal(requests[0].body.initialize_with_readme, true);
    assert.equal(requests[1].url.pathname, "/api/v1/user/repos");
    assert.equal(requests[1].body.private, true);
    assert.equal(requests[1].body.auto_init, true);
    assert.equal(requests[1].body.object_format_name, "sha1");
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
                    { name: "Personal", workspace_id: "personal", workspace_path: "zeitberg.json" },
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
