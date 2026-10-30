import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = process.argv.includes("--screenshots") ? path.join(root, "test-results/demo") : await mkdtemp(path.join(tmpdir(), "zeitberg-demo-"));
const publishedImages = ["time-desktop.png", "leave-desktop.png", "todos-desktop.png", "task-dialog-mobile.png", "expenses-desktop.png", "expense-dialog-mobile.png"];
const captures = [];

/**
 * Captures an asserted playground state after fonts settle, without animation or caret noise.
 * @param {import("playwright").Page} page Isolated playground page.
 * @param {string} name Screenshot filename, also recorded in the review manifest.
 * @returns {Promise<void>}
 */
async function capture(page, name) {
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator("#demoNotice").isVisible(), true);
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.locator("#appZoomLabel").textContent(), "100%");
    await page.screenshot({ path: path.join(output, name), animations: "disabled", caret: "hide" });
    captures.push({ name, viewport: page.viewportSize(), published: publishedImages.includes(name) });
}
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
        try {
            const response = await fetch(origin);
            // Drain readiness responses before the server closes its connection (Node/Undici).
            await response.arrayBuffer();
            if (response.ok) break;
        } catch { /* Listener starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "Europe/Berlin", colorScheme: "dark", reducedMotion: "reduce" });
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
    await capture(page, "time-desktop.png");
    await page.locator("#weekReqBtn").click();
    await page.locator("#weekReqDialog[open]").waitFor();
    assert.match(await page.locator("#weekReqDialog").textContent(), /Vacation balance/);
    assert.equal(await page.locator("#weekReqDialog tbody tr").count(), 7);
    await capture(page, "leave-desktop.png");
    await page.locator("#weekReqCancelBtn").click();
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
    await capture(page, "todos-desktop.png");
    await page.locator("#todoAddBtn").click();
    assert.equal(await page.locator("#todoDueDate").inputValue(), "2026-09-15");
    await page.locator("#todoContent").fill("Book the train tickets");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#todoDetails").evaluate((node) => node.open), false);
    assert.equal(await page.locator('#todoForm button[type="submit"]').isVisible(), true);
    await capture(page, "task-dialog-mobile.png");
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    assert.ok(await page.locator("#expenseList .expense-row").count() > 5);
    await capture(page, "expenses-desktop.png");
    await page.locator("#expenseAddBtn").click();
    await page.locator("#expenseDialog[open]").waitFor();
    await page.locator("#expenseAmount").fill("42");
    await page.locator("#expenseDescription").fill("Picnic by the lake");
    assert.match(await page.locator("#expenseOutcomeSummary").textContent(), /10[.,]50/);
    await capture(page, "expense-dialog-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#expenseSubmitBtn").isVisible(), true);
    await capture(page, "expense-dialog-mobile.png");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#expenseAmount").fill("50");
    await page.locator("#expenseDescription").fill("Disposable expense");
    await page.locator("#expenseSubmitBtn").click();
    await page.locator("#expenseDialog").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.demoWarnings), []);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "expenses-mobile.png");
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
    await writeFile(path.join(output, "capture-manifest.json"), JSON.stringify({
        version, seed: "docs-v1", referenceTime: "2026-09-15T12:00:00Z",
        locale: "en-US", timezone: "Europe/Berlin", theme: "dark", appZoom: 1,
        browser: browser.version(), screenshots: captures,
    }, null, 4) + "\n");
    if (process.argv.includes("--publish")) {
        const destination = path.join(root, "assets/guide");
        await mkdir(destination, { recursive: true });
        for (const name of publishedImages) {
            await copyFile(path.join(output, name), path.join(destination, name));
        }
    }
    console.log(`Demo isolation, edits, reset, routes, and screenshots passed: ${output}`);
} finally {
    await browser?.close();
    server.kill("SIGTERM");
}
