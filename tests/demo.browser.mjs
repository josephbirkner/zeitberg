import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = process.argv.includes("--screenshots") ? path.join(root, "test-results/demo") : await mkdtemp(path.join(tmpdir(), "zeitberg-demo-"));
await mkdir(output, { recursive: true });
const port = await new Promise((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        socket.close(() => resolve(address.port));
    });
});
const origin = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["server.py", "--no-local", "--port", String(port), "--host", "127.0.0.1"], { cwd: root, stdio: "ignore" });
let browser;
try {
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch(origin)).ok) break; } catch { /* Listener starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
    await page.clock.install({ time: new Date("2026-09-15T12:00:00Z") });
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
    const forbidden = [];
    await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || request.method() !== "GET" || /^\/(?:data|workspace|local-workspaces|save)(?:\/|$)/.test(url.pathname)) {
            forbidden.push(request.url());
            await route.abort();
        } else await route.continue();
    });
    // Seed sentinel credentials, then reject every durable-storage access in demo mode.
    await page.addInitScript(() => {
        if (new URL(location.href).searchParams.get("demo") !== "1") return;
        localStorage.setItem("demo-sentinel", "keep-me");
        window.demoStorageAccess = [];
        for (const method of ["getItem", "setItem", "removeItem", "clear"]) {
            Storage.prototype[method] = () => { window.demoStorageAccess.push(method); throw new Error(`Demo touched Storage.${method}`); };
        }
        indexedDB.open = () => { window.demoStorageAccess.push("indexedDB.open"); throw new Error("Demo opened IndexedDB"); };
        indexedDB.deleteDatabase = () => { window.demoStorageAccess.push("indexedDB.delete"); throw new Error("Demo cleared IndexedDB"); };
        window.demoWarnings = [];
        document.addEventListener("DOMContentLoaded", () => {
            const toast = document.getElementById("dataError");
            new MutationObserver(() => {
                if (toast.textContent.includes("Browser draft storage is unavailable")) window.demoWarnings.push(toast.textContent);
            }).observe(toast, { childList: true, subtree: true, characterData: true });
        });
    });
    await page.goto(`${origin}/time?demo=1&demoSeed=docs-v1`);
    await page.locator("#appSection:not([hidden])").waitFor();
    assert.equal(await page.locator("#demoNotice").isVisible(), true);
    assert.ok(await page.locator(".entry-block").count() > 5);
    const seededTime = await page.locator(".entry-block").allTextContents();
    await page.screenshot({ path: path.join(output, "time-desktop.png") });
    await page.locator(".entry-block").first().dblclick();
    await page.locator("#entryDesc").fill("Disposable time edit");
    await page.locator("#entrySaveBtn").click();
    await page.locator("#entryDialog").waitFor({ state: "hidden" });
    await page.keyboard.press("Control+z");
    assert.deepEqual(await page.evaluate(() => window.demoWarnings), []);
    await page.locator("#menuTodoBtn").click();
    await page.locator("#todoList .todo-row").first().waitFor();
    assert.equal(new URL(page.url()).searchParams.get("demo"), "1");
    assert.equal(new URL(page.url()).searchParams.get("demoSeed"), "docs-v1");
    await page.screenshot({ path: path.join(output, "todos-desktop.png") });
    await page.locator("#todoAddBtn").click();
    await page.locator("#todoContent").fill("Disposable task");
    await page.locator("#todoForm").evaluate((form) => form.requestSubmit());
    await page.locator("#todoDialog").waitFor({ state: "hidden" });
    await page.locator("#editorBadge").click();
    await page.waitForFunction(() => document.getElementById("editorBadge").dataset.state === "saved");
    await page.locator("#todoCurrentFilterBtn").click();
    assert.match(await page.locator("#todoList").textContent(), /Disposable task/);
    assert.deepEqual(await page.evaluate(() => window.demoStorageAccess), []);
    assert.deepEqual(await page.evaluate(() => window.demoWarnings), []);
    await page.reload();
    await page.locator("#appSection:not([hidden])").waitFor();
    assert.doesNotMatch(await page.locator("#todoList").textContent(), /Disposable task/);
    await page.locator("#menuExpenseBtn").click();
    await page.locator("#expenseAddBtn").waitFor();
    await page.screenshot({ path: path.join(output, "expenses-desktop.png") });
    await page.locator("#expenseAddBtn").click();
    await page.locator("#expenseDialog[open]").waitFor();
    await page.screenshot({ path: path.join(output, "expense-dialog-desktop.png") });
    await page.locator("#expenseAmount").fill("50");
    await page.locator("#expenseDescription").fill("Disposable expense");
    await page.locator("#expenseSubmitBtn").click();
    await page.locator("#expenseDialog").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.demoWarnings), []);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, "expenses-mobile.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("#demoReset").click();
    await page.locator("#appSection:not([hidden])").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("demo"), "1");
    assert.equal(new URL(page.url()).searchParams.get("demoSeed"), "docs-v1");
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.demoStorageAccess), []);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#menuWeekBtn").click();
    assert.deepEqual(await page.locator(".entry-block").allTextContents(), seededTime);
    // Fresh visits really regenerate, while explicit seeds survive navigation and reset.
    await page.goto(`${origin}/time?demo=1`);
    await page.locator("#appSection:not([hidden])").waitFor();
    const randomTime = await page.locator(".entry-block").allTextContents();
    assert.equal(new URL(page.url()).searchParams.has("demoSeed"), false);
    await page.reload();
    await page.locator("#appSection:not([hidden])").waitFor();
    assert.notDeepEqual(await page.locator(".entry-block").allTextContents(), randomTime);
    assert.deepEqual(await page.evaluate(() => window.demoStorageAccess), []);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    await page.locator("#demoExit").click();
    await page.locator("#loginSection:not([hidden])").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("demo-sentinel")), "keep-me");
    const buildLabel = await page.locator("#buildInfo").textContent();
    assert.ok(buildLabel.startsWith(`v${version} · `));
    assert.match(buildLabel, / · [a-f0-9]{8}/);
    console.log(`Demo isolation, edits, reset, routes, and screenshots passed: ${output}`);
} finally {
    await browser?.close();
    server.kill("SIGTERM");
}
