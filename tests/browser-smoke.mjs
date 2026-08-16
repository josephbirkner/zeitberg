import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE_ID = "replace-with-a-unique-id";

/**
 * Reserves an available loopback port for the disposable local application server.
 *
 * @returns {Promise<number>} Available TCP port.
 */
function reservePort() {
    return new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.once("error", reject);
        socket.listen(0, "127.0.0.1", () => {
            const address = socket.address();
            const port = address && typeof address === "object" ? address.port : 0;
            socket.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
}

/**
 * Polls the local server until its workspace-discovery endpoint is available.
 *
 * @param {string} baseUrl Loopback origin.
 * @param {import("node:child_process").ChildProcess} process Local server process.
 * @returns {Promise<void>}
 */
async function waitForServer(baseUrl, process) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) throw new Error(`Local server exited with code ${process.exitCode}.`);
        try {
            const response = await fetch(`${baseUrl}/local-workspaces`);
            if (response.ok) return;
        } catch {
            // The listener may not have bound yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Timed out waiting for the local application server.");
}

/**
 * Opens one component route and waits for workspace initialization to finish.
 *
 * @param {import("playwright").Page} page Browser page.
 * @param {string} baseUrl Loopback origin.
 * @param {"time" | "todos" | "expenses"} component Component route.
 * @returns {Promise<void>}
 */
async function openComponent(page, baseUrl, component) {
    const params = new URLSearchParams({ source: "local", workspace: WORKSPACE_ID });
    await page.goto(`${baseUrl}/${component}?${params}`, { waitUntil: "domcontentloaded" });
    await page.locator("#appSection:not([hidden])").waitFor({ timeout: 10_000 });
}

/**
 * Returns the viewport-relative size of a dialog card.
 *
 * @param {import("playwright").Locator} card Dialog card locator.
 * @returns {Promise<{width: number, height: number, viewportWidth: number, viewportHeight: number}>}
 */
async function dialogSize(card) {
    return card.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        };
    });
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(
    "python3",
    ["server.py", "--workspace", "workspace-template", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: APP_ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
let serverOutput = "";
server.stdout?.on("data", (chunk) => {
    serverOutput += String(chunk);
});
server.stderr?.on("data", (chunk) => {
    serverOutput += String(chunk);
});

let browser;
try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });

    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const browserErrors = [];
    desktop.on("pageerror", (error) => browserErrors.push(error.message));
    desktop.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
    });

    await openComponent(desktop, baseUrl, "time");
    assert.equal(await desktop.locator("#weekViewSection").isVisible(), true);
    assert.match(await desktop.title(), /zeitplural/);
    await desktop.locator("#appZoomInBtn").click();
    assert.notEqual(await desktop.locator("#appZoomLabel").textContent(), "100%");
    await desktop.locator("#appZoomResetBtn").click();
    assert.equal(await desktop.locator("#appZoomLabel").textContent(), "100%");

    await desktop.locator("#workspaceSettingsBtn").click();
    assert.equal(await desktop.locator("#workspaceDialog").evaluate((dialog) => dialog.open), true);
    await desktop.locator("#workspaceDialogCloseBtn").click();
    await desktop.locator("#projectsBtn").click();
    assert.equal(await desktop.locator("#projectsDialog").evaluate((dialog) => dialog.open), true);
    await desktop.locator("#projectsCancelBtn").click();

    await desktop.locator("#menuTodoBtn").click();
    await desktop.waitForURL(/\/todos\?/);
    assert.equal(await desktop.locator("#todoView").isVisible(), true);
    await desktop.locator("#todoCurrentFilterBtn").click();
    await desktop.locator("#todoOpenFilterBtn").click();
    await desktop.locator("#todoAddBtn").click();
    assert.equal(await desktop.locator("#todoDialog").evaluate((dialog) => dialog.open), true);
    await desktop.locator("#todoCancelBtn").click();

    await openComponent(desktop, baseUrl, "expenses");
    assert.equal(await desktop.locator("#expenseView").isVisible(), true);
    await desktop.locator("#expenseInventoryBtn").click();
    assert.equal(await desktop.locator("#expenseInventoryDialog").evaluate((dialog) => dialog.open), true);
    await desktop.locator("#expenseInventoryCancelBtn").click();

    await openComponent(desktop, baseUrl, "time");
    await desktop.locator("#menuSearchBtn").click();
    assert.equal(await desktop.locator("#searchView").isVisible(), true);
    assert.match(desktop.url(), /panel=search/);
    await desktop.goBack();
    await desktop.locator("#weekViewSection:not([hidden])").waitFor();
    await desktop.goForward();
    await desktop.locator("#searchView:not([hidden])").waitFor();
    assert.deepEqual(browserErrors, []);

    const narrow = await browser.newPage({ viewport: { width: 500, height: 800 } });
    const narrowErrors = [];
    narrow.on("pageerror", (error) => narrowErrors.push(error.message));
    narrow.on("console", (message) => {
        if (message.type() === "error") narrowErrors.push(message.text());
    });
    await openComponent(narrow, baseUrl, "todos");
    await narrow.locator("#todoAddBtn").click();
    const todoDialog = await dialogSize(narrow.locator("#todoDialog .dialog-card"));
    assert.equal(todoDialog.width, todoDialog.viewportWidth);
    assert.equal(todoDialog.height, todoDialog.viewportHeight);
    await narrow.locator("#todoCancelBtn").click();

    await openComponent(narrow, baseUrl, "time");
    await narrow.locator("#workspaceSettingsBtn").click();
    const workspaceDialog = await dialogSize(narrow.locator("#workspaceDialog .dialog-card"));
    assert.equal(workspaceDialog.width, workspaceDialog.viewportWidth);
    assert.equal(workspaceDialog.height, workspaceDialog.viewportHeight);
    await narrow.locator("#workspaceDialogCloseBtn").click();
    assert.deepEqual(narrowErrors, []);

    console.log("Browser smoke passed: routing, workspace load, dialogs, history, and narrow layouts.");
} catch (error) {
    if (serverOutput.trim()) console.error(serverOutput.trim());
    throw error;
} finally {
    await browser?.close();
    if (server.exitCode === null) {
        server.kill("SIGTERM");
        const exited = await Promise.race([
            new Promise((resolve) => server.once("exit", () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
        if (!exited && server.exitCode === null) server.kill("SIGKILL");
    }
}
