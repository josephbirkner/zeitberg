import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { RepositoryDiscovery } from "../repository.discovery.js";

const workspace = await readFile(new URL("../workspace-template/zeitberg.json", import.meta.url), "utf8");
const config = { ref: "main", workspacePath: "zeitberg.json" };

for (const provider of ["github", "gitlab", "codeberg"]) {
    test(`${provider} discovery uses default branches, bounded pages, and distinct missing/error states`, async (context) => {
        const host = provider === "github" ? "github.com" : provider === "gitlab" ? "gitlab.com" : "codeberg.org";
        const calls = [];
        context.mock.method(globalThis, "fetch", async (value, options) => {
            const url = new URL(value);
            calls.push(url);
            assert.match(options.headers.Authorization, /test-token$/);
            if (["/user/repos", "/api/v4/projects", "/api/v1/user/repos"].includes(url.pathname)) {
                assert.equal(url.searchParams.get("page"), "2");
                assert.equal(url.searchParams.get(provider === "codeberg" ? "limit" : "per_page"), "20");
                if (provider === "gitlab") assert.equal(url.searchParams.get("membership"), "true");
                return Response.json(["ready", "missing", "forbidden", "invalid"].map((name) => ({
                    web_url: `https://${host}/owner/${name}`, html_url: `https://${host}/owner/${name}`,
                    full_name: `owner/${name}`, path_with_namespace: `owner/${name}`, default_branch: "develop",
                })));
            }
            assert.equal(url.searchParams.get("ref"), "develop");
            assert.match(url.pathname, /zeitberg.json$/);
            if (url.pathname.includes("missing")) return Response.json({ message: "Absent" }, { status: 404 });
            if (url.pathname.includes("forbidden")) return Response.json({ message: "Forbidden" }, { status: 403 });
            const content = url.pathname.includes("invalid") ? "{}" : workspace;
            return provider === "github" ? new Response(content) : Response.json({ encoding: "base64", content: Buffer.from(content).toString("base64") });
        });
        const discovery = new RepositoryDiscovery(config, provider, "test-token");
        const result = await discovery.scanPage(2);
        assert.equal(result.hasMore, false);
        assert.equal(result.repositories[0].status, "ready");
        assert.equal(result.repositories[0].detail, "My workspace");
        assert.equal(result.repositories.find((item) => item.name.endsWith("missing")).status, "missing");
        for (const name of ["forbidden", "invalid"]) assert.equal(result.repositories.find((item) => item.name.endsWith(name)).status, "attention");
        assert.equal(calls.length, 5);
        assert.ok(calls.every((url) => url.hostname === (provider === "github" ? "api.github.com" : host)));
    });
}

test("discovery never sends authorization to provider-returned foreign URLs", async (context) => {
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url) => {
        calls.push(String(url));
        return Response.json([{ web_url: "https://attacker.example/owner/repo", default_branch: "main" }]);
    });
    await assert.rejects(new RepositoryDiscovery(config, "gitlab", "secret").scanPage(1), /requires a gitlab.com/);
    assert.equal(calls.length, 1);
});

test("discovery bounds concurrent probes, supports pagination, and stops after cancellation", async (context) => {
    let active = 0;
    let maximum = 0;
    let probes = 0;
    const discovery = new RepositoryDiscovery(config, "codeberg", "secret");
    context.mock.method(globalThis, "fetch", async (url) => {
        if (String(url).includes("/user/repos")) return Response.json(Array.from({ length: 20 }, (_, index) => ({ html_url: `https://codeberg.org/owner/repo-${index}` })));
        probes++;
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        discovery.cancel();
        return Response.json({ message: "Absent" }, { status: 404 });
    });
    const result = await discovery.scanPage(1);
    assert.equal(result.hasMore, true);
    assert.equal(maximum, 4);
    assert.equal(probes, 4);
    assert.equal(discovery.token, "");
});

test("list failures and invalid pagination are not disguised as empty workspaces", async (context) => {
    context.mock.method(globalThis, "fetch", async () => Response.json({ message: "Not authorized" }, { status: 401 }));
    const discovery = new RepositoryDiscovery(config, "gitlab", "secret");
    await assert.rejects(discovery.scanPage(0), /Invalid repository page/);
    await assert.rejects(discovery.scanPage(1), /401.*Not authorized/);
    assert.throws(() => new RepositoryDiscovery(config, "custom", "secret"), /Unsupported/);
});

test("GitHub App discovery enumerates installations, skips suspended access, and retries pages without skipping repositories", async (context) => {
    const calls = [];
    const row = (name) => ({ html_url: `https://github.com/person/${name}`, full_name: `person/${name}`, default_branch: "trunk" });
    context.mock.method(globalThis, "fetch", async (input) => {
        const url = new URL(input);
        calls.push(url.pathname + url.search);
        if (url.pathname === "/user/installations") return Response.json({ installations: [{ id: 1 }, { id: 2, suspended_at: "2026-01-01" }, { id: 3 }] });
        if (url.pathname === "/user/installations/1/repositories") {
            const second = url.searchParams.get("page") === "2";
            return Response.json({ total_count: 21, repositories: second ? [row("last")] : Array.from({ length: 20 }, (_, i) => row(`repo-${i}`)) });
        }
        if (url.pathname === "/user/installations/3/repositories") return Response.json({ total_count: 1, repositories: [row("other")] });
        assert.match(url.pathname, /^\/repos\/person\/.+\/contents\/zeitberg.json$/);
        assert.equal(url.searchParams.get("ref"), "trunk");
        return new Response(workspace);
    });
    const discovery = new RepositoryDiscovery(config, "github", "app-grant", true);
    assert.equal((await discovery.scanPage(1)).repositories.length, 20);
    assert.equal((await discovery.scanPage(1)).hasMore, true);
    assert.equal((await discovery.scanPage(2)).repositories[0].name, "person/last");
    const third = await discovery.scanPage(3);
    assert.equal(third.repositories[0].name, "person/other");
    assert.equal(third.hasMore, false);
    assert.equal(calls.filter((url) => url.includes("/user/installations?")).length, 1);
    assert.equal(calls.filter((url) => url.includes("/1/repositories?")).length, 2);
    assert.ok(!calls.some((url) => url.startsWith("/user/repos") || url.includes("/2/repositories")));
});

test("GitHub App discovery distinguishes no installations from failed authorization and a refresh discovers new access", async (context) => {
    let installed = false;
    context.mock.method(globalThis, "fetch", async (input) => {
        const url = new URL(input);
        if (url.pathname === "/user/installations") return Response.json({ installations: installed ? [{ id: 10 }] : [] });
        if (url.pathname.endsWith("/repositories")) return Response.json({ total_count: 0, repositories: [] });
        assert.fail(`Unexpected probe: ${url}`);
    });
    const before = new RepositoryDiscovery(config, "github", "grant", true);
    assert.deepEqual(await before.scanPage(1), { repositories: [], hasMore: false });
    assert.equal(before.installations.length, 0);
    installed = true;
    const after = new RepositoryDiscovery(config, "github", "grant", true);
    await after.scanPage(1);
    assert.equal(after.installations.length, 1);
    context.mock.method(globalThis, "fetch", async () => Response.json({ message: "Expired" }, { status: 401 }));
    await assert.rejects(new RepositoryDiscovery(config, "github", "grant", true).scanPage(1), /401.*Expired/);
});
