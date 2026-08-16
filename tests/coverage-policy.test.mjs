import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_PRODUCTION_SCOPE = [
    "appstate.js",
    "cache.js",
    "config.js",
    "datasource.js",
    "locale.js",
    "model.js",
    "oauth.js",
    "routing.js",
    "store.js",
    "utils.js",
];

test("coverage policy names its production scope, threshold, reports, and browser prerequisite", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    assert.equal(packageJson.c8.all, true);
    assert.equal(packageJson.c8["check-coverage"], true);
    assert.equal(packageJson.c8.lines, 90);
    assert.deepEqual(packageJson.c8.include, EXPECTED_PRODUCTION_SCOPE);
    assert.deepEqual(packageJson.c8.reporter, ["text", "html", "json-summary", "lcov"]);
    assert.equal(packageJson.scripts.coverage, "node scripts/run-coverage.mjs");
    assert.equal(packageJson.scripts.test, "node --test tests/*.test.mjs");
    assert.equal(packageJson.scripts.typecheck, "npx tsc --noEmit");
});

test("GitHub Actions runs the local coverage command and retains its report", async () => {
    const workflow = await readFile(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");

    assert.match(workflow, /- "release\/\*\*"/);
    assert.match(workflow, /npx playwright install --with-deps chromium/);
    assert.match(workflow, /run: npm run coverage/);
    assert.match(workflow, /if: always\(\)[\s\S]*actions\/upload-artifact@v7/);
    assert.match(workflow, /path: coverage\//);
});

test("README exposes workflow, threshold, and latest-release badges", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    assert.match(readme, /actions\/workflows\/test\.yml\/badge\.svg\?branch=main/);
    assert.match(readme, /logic%20coverage-%E2%89%A590%25-2b9c68/);
    assert.match(readme, /releases\/latest/);
    assert.match(readme, /img\.shields\.io\/github\/v\/release\/josephbirkner\/zeitplural/);
});
