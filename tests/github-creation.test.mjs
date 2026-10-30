import assert from "node:assert/strict";
import test from "node:test";
import { GitHubDataSource, ProviderApiError } from "../datasource.js";
import { WorkspaceController } from "../workspace.js";

test("GitHub creates a private initialized repository and preserves the provider's default branch", async (context) => {
    const source = new GitHubDataSource({ owner: "person", repo: "placeholder", ref: "main" }, "grant");
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push(url);
        assert.equal(url, "https://api.github.com/user/repos");
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), { name: "new-space", description: "Private zeitberg workspace", private: true, auto_init: true });
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ html_url: "https://github.com/person/new-space", private: true, default_branch: "trunk" });
    });
    const created = await source.createPrivateRepository("new-space");
    assert.equal(created.repoInfo.default_branch, "trunk");
    assert.equal(created.repositoryUrl, "https://github.com/person/new-space");
    assert.equal(requests.length, 1);
    for (const invalid of ["../unsafe", ".", "", "space here"]) await assert.rejects(source.createPrivateRepository(invalid));
    assert.equal(requests.length, 1);
});

test("GitHub creation preserves permission and duplicate-name errors and never retries POST", async (context) => {
    const source = new GitHubDataSource({ owner: "person", repo: "placeholder", ref: "main" }, "grant");
    for (const status of [403, 422]) {
        let calls = 0;
        context.mock.method(globalThis, "fetch", async () => {
            calls++;
            return Response.json({ message: "Validation failed", errors: [{ message: "name already exists" }] }, { status });
        });
        await assert.rejects(source.createPrivateRepository("new-space"), (error) => error instanceof ProviderApiError && error.status === status && /name already exists/.test(error.detail));
        assert.equal(calls, 1);
    }
    let calls = 0;
    context.mock.method(globalThis, "fetch", async () => { calls++; throw new DOMException("Stalled", "TimeoutError"); });
    await assert.rejects(source.createPrivateRepository("new-space"), /timed out.*may already have succeeded/);
    assert.equal(calls, 1);
});

test("GitHub creation rejects unsafe or incomplete success metadata", async (context) => {
    const source = new GitHubDataSource({ owner: "person", repo: "placeholder", ref: "main" }, "grant");
    for (const overrides of [{ private: false }, { default_branch: "" }, { html_url: "https://other.example/person/new-space" }]) {
        context.mock.method(globalThis, "fetch", async () => Response.json({ html_url: "https://github.com/person/new-space", private: true, default_branch: "main", ...overrides }));
        await assert.rejects(source.createPrivateRepository("new-space"));
    }
});

test("shared workspace initialization validates app choices before creating any remote repository", async () => {
    let built = 0;
    const controller = Object.assign(Object.create(WorkspaceController.prototype), {
        locale: { t: (key) => key },
        async buildWorkspaceInitializationFiles(workspace) { built++; return [{ path: "zeitberg.json", content: workspace.toJson() }]; },
    });
    const { workspace, files } = await controller.loadWorkspaceTemplateFiles("Trip", "Europe/Berlin", ["expenses"]);
    assert.deepEqual(Object.keys(JSON.parse(workspace.toJson()).components), ["expenses"]);
    assert.equal(files[0].path, "zeitberg.json");
    for (const invalid of [[], ["unknown"], ["__proto__"]]) await assert.rejects(controller.loadWorkspaceTemplateFiles("Trip", "Europe/Berlin", invalid), /chooseApps/);
    assert.equal(built, 1);
});
