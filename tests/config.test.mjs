import assert from "node:assert/strict";
import test from "node:test";

import {
    formatGitHubRepositoryUrl,
    getEffectiveUiViewportWidth,
    getRecommendedUiZoom,
    parseGitHubRepository,
} from "../config.js";

test("automatic app zoom remains at 100%", () => {
    assert.equal(getRecommendedUiZoom(), 1);
});

test("effective responsive width includes application zoom", () => {
    assert.equal(getEffectiveUiViewportWidth(874, 2), 437);
    assert.equal(getEffectiveUiViewportWidth(760, 1), 760);
    assert.equal(getEffectiveUiViewportWidth(760, 0), 760);
});

test("GitHub repository locators accept canonical URLs and compact shorthand", () => {
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
