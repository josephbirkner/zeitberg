import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const expectedStylesheets = [
    "./styles/common.css",
    "./styles/time.css",
    "./styles/todos.css",
    "./styles/expenses.css",
    "./styles/landing.css",
];

/**
 * Reads one repository-relative UTF-8 text file.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
function readRepositoryFile(path) {
    return readFile(new URL(path, repositoryRoot), "utf8");
}

test("the document loads modular stylesheets explicitly and in dependency order", async () => {
    const html = await readRepositoryFile("index.html");
    const linkedStylesheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/>/g)].map(
        (match) => match[1],
    );
    assert.deepEqual(linkedStylesheets, expectedStylesheets);
    await assert.rejects(access(new URL("style.css", repositoryRoot)), { code: "ENOENT" });
});

test("each stylesheet declares and retains its component ownership", async () => {
    const [common, time, todos, expenses, landing] = await Promise.all(
        expectedStylesheets.map((path) => readRepositoryFile(path.replace("./", ""))),
    );

    for (const content of [common, time, todos, expenses, landing]) {
        assert.doesNotMatch(content, /@import\b/);
    }

    assert.match(common, /^\/\* Shared design tokens,/);
    assert.match(common, /\.app-sidebar\s*\{/);
    assert.doesNotMatch(common, /\.todo-row\s*\{/);
    assert.doesNotMatch(common, /\.week-grid\s*\{/);

    assert.match(time, /^\/\* Time tracking,/);
    assert.match(time, /\.week-grid\s*\{/);
    assert.match(time, /\.search-results-table/);
    assert.doesNotMatch(time, /\.todo-row\s*\{/);

    assert.match(todos, /^\/\* TODO navigation,/);
    assert.match(todos, /\.todo-row\s*\{/);
    assert.match(todos, /\.todo-project-filter\s*\{/);
    assert.doesNotMatch(todos, /\.week-grid\s*\{/);

    assert.match(expenses, /^\/\* Expense ledger,/);
    assert.match(expenses, /\.expense-row\s*\{/);
    assert.match(expenses, /\.expense-balance-strip/);
    assert.doesNotMatch(expenses, /\.week-grid\s*\{/);

    assert.match(landing, /^\/\* Public landing page/);
    assert.match(landing, /\.landing-hero\s*\{/);
    assert.match(landing, /\.landing-landscape\s*\{/);
    assert.match(landing, /body:not\(\.app-mode\)/);
    assert.doesNotMatch(landing, /\.week-grid\s*\{/);
});
