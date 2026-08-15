import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_CONFIG,
    formatGitHubRepositoryUrl,
    getEffectiveUiViewportWidth,
    getRecommendedUiZoom,
    migrateRenamedWorkspaceConfig,
    parseGitHubRepository,
} from "../config.js";

test("dark is the default application theme", () => {
    assert.equal(DEFAULT_CONFIG.theme, "dark");
});

test("automatic app zoom remains at 100%", () => {
    assert.equal(getRecommendedUiZoom(), 1);
});

test("effective responsive width includes application zoom", () => {
    assert.equal(getEffectiveUiViewportWidth(874, 2), 437);
    assert.equal(getEffectiveUiViewportWidth(760, 1), 760);
    assert.equal(getEffectiveUiViewportWidth(760, 0), 760);
});

test("GitHub repository locators accept full HTTPS URLs and compact shorthand", () => {
    assert.deepEqual(parseGitHubRepository("https://github.com/example/private-workspace"), {
        owner: "example",
        repo: "private-workspace",
    });
    assert.deepEqual(parseGitHubRepository("example/private-workspace.git"), {
        owner: "example",
        repo: "private-workspace",
    });
    assert.equal(formatGitHubRepositoryUrl("example", "private-workspace"), "https://github.com/example/private-workspace");
});

test("GitHub repository locators reject alternate hosts and credential-confusing paths", () => {
    assert.throws(() => parseGitHubRepository("https://gitlab.com/example/workspace"), /github\.com/);
    assert.throws(() => parseGitHubRepository("https://github.com/example/workspace/issues"), /repository URL/);
    assert.throws(() => parseGitHubRepository("https://github.com/example/workspace?token=secret"), /query or fragment/);
});

test("the original workspace defaults migrate to the renamed data repository", () => {
    const legacy = {
        ...DEFAULT_CONFIG,
        repo: "planplural-data",
        workspacePath: "planplural.json",
    };
    assert.deepEqual(migrateRenamedWorkspaceConfig(legacy), {
        ...DEFAULT_CONFIG,
        repo: "zeitplural-data",
        workspacePath: "zeitplural.json",
    });

    const independentlyNamed = {
        ...DEFAULT_CONFIG,
        owner: "someone-else",
        repo: "private-workspace",
        workspacePath: "planplural.json",
    };
    assert.deepEqual(migrateRenamedWorkspaceConfig(independentlyNamed), independentlyNamed);
});
