import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import coverageLibrary from "istanbul-lib-coverage";
import { chromium } from "playwright";
import v8ToIstanbul from "v8-to-istanbul";
import { formatCapabilityLink } from "../routing.js";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE_ID = "replace-with-a-unique-id";
const QR_DECODER_FIXTURE =
    "iVBORw0KGgoAAAANSUhEUgAAAHsAAAB7AQMAAABuCW08AAAABlBMVEUAAAD///+l2Z/dAAAAAnRSTlP//8i138cAAAAJcEhZ" +
    "cwAACxIAAAsSAdLdfvwAAAFqSURBVEiJ1dUxboQwEAXQQS7olgtY8jXc+UrLBfBygfWV6OYaSL4A7lxYTD6r3ayUIkyKKIqF" +
    "BH4FjMczhuTLoP8MG1FkIwsNC3U6KNJGbgM7YTzrYLFRbKxrZBrVcO2JgpSfwIRZtYMepF29mdnGd+gngHyMbI/rnaATwNip" +
    "dXzMRAcbWfLrhdrkc9LB7k1hs2HGrdNB4XVgSY8lJh1shLuba75TizpAvrFRl4BvGtGBiLkFvMklllkHm29jtZ3kvZekg/KI" +
    "cVxQdK9Iz2Dv8Y518vbqXVIC5ZkdtmvgPCvBtynkWzBlMUkHm0d5ooEyVhl1IPzM+vSM9ByO8gm5LOsrUgVUO5G59XSlnJQg" +
    "MNRC3vo1KqGiG+QeLJEpOsBAsIi0E6eER2djZdSxSzrA+YHjcxZ0Ng1KwMEW7AUVRE7UMDI+jkgp6qG6GZ2KeJWAcx1ZZ7N/" +
    "bsMZHPmoR08QvRP0PfzKf+5P4AMSkGA7qFuRNgAAAABJRU5ErkJggg==";
const QR_DECODER_RESULT = "https://zeitberg.io/expenses?fixture=1#zb-cap=local-decoder-check";
const BROWSER_SOURCE_FILES = [
    "app.js",
    "expense.view.js",
    "search.view.js",
    "theme-init.js",
    "todo.view.js",
    "week.view.js",
];

/**
 * @typedef {Object} BrowserCoverageEntry
 * @property {string} url Loaded script URL.
 * @property {string} [source] Loaded source text.
 * @property {Array<Object>} functions V8 precise-coverage functions.
 */

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

/**
 * Verifies that one modal card contains its controls without creating a second horizontal scrolling surface.
 * @param {import("playwright").Locator} card Dialog card locator.
 * @returns {Promise<void>}
 */
async function assertNoHorizontalDialogOverflow(card) {
    const size = await card.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
    }));
    assert.ok(size.scrollWidth <= size.clientWidth, `Dialog overflowed by ${size.scrollWidth - size.clientWidth}px.`);
}

/**
 * Decodes a small generated fixture through the actual vendored worker inside the application CSP.
 * This protects the QR image fallback against missing worker assets, import-map errors, and absent blob-image permissions that DOM-only tests cannot observe.
 *
 * @param {import("playwright").Page} page Loaded zeitberg page.
 * @returns {Promise<void>}
 */
async function assertLocalQrDecoder(page) {
    const decoded = await page.evaluate(async (encoded) => {
        const { default: QrScanner } = await import("qr-scanner");
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        const image = new File([bytes], "capability.png", { type: "image/png" });
        const result = await QrScanner.scanImage(image, { returnDetailedScanResult: true });
        return result.data;
    }, QR_DECODER_FIXTURE);
    assert.equal(decoded, QR_DECODER_RESULT);
}

/**
 * Converts Chromium's precise V8 data into an Istanbul summary for browser-only controllers.
 * The result is reported separately from the 90% deterministic production-logic gate so difficult DOM code remains visible without mixing two incompatible execution environments.
 *
 * @param {BrowserCoverageEntry[]} entries Coverage entries collected across desktop and narrow pages.
 * @returns {Promise<{total: Object, files: Object}>} Serializable aggregate and per-file metrics.
 */
async function summarizeBrowserCoverage(entries) {
    const coverageMap = coverageLibrary.createCoverageMap({});
    for (const entry of entries) {
        let fileName = "";
        try {
            fileName = path.basename(new URL(entry.url).pathname);
        } catch {
            continue;
        }
        if (!BROWSER_SOURCE_FILES.includes(fileName) || typeof entry.source !== "string") continue;
        const converter = v8ToIstanbul(path.join(APP_ROOT, fileName), 0, { source: entry.source });
        await converter.load();
        converter.applyCoverage(/** @type {any} */ (entry.functions));
        coverageMap.merge(converter.toIstanbul());
    }

    const files = {};
    for (const filePath of coverageMap.files().sort()) {
        files[path.basename(filePath)] = coverageMap.fileCoverageFor(filePath).toSummary().toJSON();
    }
    assert.deepEqual(Object.keys(files).sort(), BROWSER_SOURCE_FILES.slice().sort());
    return { total: coverageMap.getCoverageSummary().toJSON(), files };
}

/**
 * Writes the browser-controller summary beside c8's reports for CI artifact retention.
 *
 * @param {BrowserCoverageEntry[]} entries Coverage entries collected across browser scenarios.
 * @returns {Promise<Object>} Aggregate browser summary.
 */
async function writeBrowserCoverage(entries) {
    const summary = await summarizeBrowserCoverage(entries);
    const outputDirectory = path.join(APP_ROOT, "coverage");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
        path.join(outputDirectory, "browser-summary.json"),
        `${JSON.stringify(
            {
                schema_version: 1,
                generated_at: new Date().toISOString(),
                scope: BROWSER_SOURCE_FILES,
                ...summary,
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    return summary.total;
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

    const germanContext = await browser.newContext({ locale: "de-DE" });
    const germanLanding = await germanContext.newPage();
    await germanLanding.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await germanLanding.locator("#loginSection:not([hidden])").waitFor();
    assert.equal(await germanLanding.locator("html").getAttribute("lang"), "de");
    assert.match(await germanLanding.locator("#landingTitle").textContent(), /Zeiterfassung/);
    assert.equal(await germanLanding.locator("#landingLanguage").inputValue(), "auto");
    await germanLanding.locator("#landingLanguage").selectOption("en");
    assert.equal(await germanLanding.locator("html").getAttribute("lang"), "en");
    await germanLanding.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await germanLanding.locator("html").getAttribute("lang"), "en");
    await germanLanding.locator("#landingLanguage").selectOption("auto");
    assert.equal(await germanLanding.locator("html").getAttribute("lang"), "de");
    await germanContext.close();

    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.coverage.startJSCoverage({ resetOnNavigation: false });
    const browserErrors = [];
    desktop.on("pageerror", (error) => browserErrors.push(error.message));
    desktop.on("console", (message) => {
        if (message.type() !== "error") return;
        const location = message.location();
        const expectedMissingWorkspace = location.url.includes(
            "/repos/example/unconfigured/contents/zeitberg.json",
        );
        if (!expectedMissingWorkspace) browserErrors.push(message.text());
    });

    await openComponent(desktop, baseUrl, "time");
    await assertLocalQrDecoder(desktop);
    assert.equal(await desktop.locator("#weekViewSection").isVisible(), true);
    assert.match(await desktop.title(), /zeitberg/);
    await desktop.locator("#appZoomInBtn").click();
    assert.notEqual(await desktop.locator("#appZoomLabel").textContent(), "100%");
    await desktop.locator("#appZoomResetBtn").click();
    assert.equal(await desktop.locator("#appZoomLabel").textContent(), "100%");

    await desktop.locator("#appHomeLink").click();
    await desktop.locator("#loginSection:not([hidden])").waitFor();
    assert.equal(await desktop.locator("#appSidebar").isVisible(), true);
    await desktop.locator("#menuTodoBtn").click();
    await desktop.locator("#todoView:not([hidden])").waitFor();
    assert.match(desktop.url(), /\/todos\?/);
    await desktop.locator("#menuWeekBtn").click();
    await desktop.locator("#weekViewSection:not([hidden])").waitFor();

    await desktop.locator("#interfaceSettingsBtn").click();
    assert.equal(await desktop.locator("#interfaceDialog").evaluate((dialog) => dialog.open), true);
    await assertNoHorizontalDialogOverflow(desktop.locator("#interfaceDialog .dialog-card"));
    assert.match(desktop.url(), /panel=settings/);
    await desktop.locator("#interfaceLanguage").selectOption("de");
    assert.equal(await desktop.locator("html").getAttribute("lang"), "de");
    assert.equal(await desktop.locator("#appLanguageLabel").textContent(), "DE");
    await desktop.locator("#interfaceLanguage").selectOption("en");
    await desktop.locator("#interfaceDialogCloseBtn").click();
    await desktop.waitForURL((url) => !url.searchParams.has("panel"));

    await desktop.locator("#workspaceSettingsBtn").click();
    assert.equal(await desktop.locator("#workspaceDialog").evaluate((dialog) => dialog.open), true);
    await assertNoHorizontalDialogOverflow(desktop.locator("#workspaceDialog .dialog-card"));
    assert.equal(await desktop.locator("#workspaceConfigForm").isVisible(), true);
    assert.equal(await desktop.locator("#workspaceConfigName").inputValue(), "My workspace");
    assert.equal(await desktop.locator("#workspaceConfigTimeEnabled").isChecked(), true);
    await desktop.locator("#workspaceDialogCloseBtn").click();
    await desktop.locator("#projectsBtn").click();
    assert.equal(await desktop.locator("#projectsDialog").evaluate((dialog) => dialog.open), true);
    await assertNoHorizontalDialogOverflow(desktop.locator("#projectsDialog .dialog-card"));
    await desktop.locator("#projectsCancelBtn").click();

    await desktop.locator("#menuTodoBtn").click();
    await desktop.waitForURL(/\/todos\?/);
    assert.equal(await desktop.locator("#todoView").isVisible(), true);
    await desktop.locator("#todoCurrentFilterBtn").click();
    await desktop.locator("#todoOpenFilterBtn").click();
    await desktop.locator("#todoAddBtn").click();
    assert.equal(await desktop.locator("#todoDialog").evaluate((dialog) => dialog.open), true);
    await assertNoHorizontalDialogOverflow(desktop.locator("#todoDialog .dialog-card"));
    await desktop.locator("#todoCancelBtn").click();

    await openComponent(desktop, baseUrl, "expenses");
    assert.equal(await desktop.locator("#expenseView").isVisible(), true);
    assert.equal(await desktop.locator("#expenseAddBtn .expense-add-label").isVisible(), true);
    const expenseActionStyle = await desktop.locator("#expenseAddBtn").evaluate((button) => {
        const style = getComputedStyle(button);
        const settle = document.querySelector("#expenseSettleBtn");
        const settleStyle = settle ? getComputedStyle(settle) : null;
        return {
            background: style.backgroundColor,
            settleBackground: settleStyle?.backgroundColor || "",
            width: button.getBoundingClientRect().width,
            settleWidth: settle?.getBoundingClientRect().width || 0,
        };
    });
    assert.notEqual(expenseActionStyle.background, expenseActionStyle.settleBackground);
    assert.ok(expenseActionStyle.width > expenseActionStyle.settleWidth);
    const expenseActionChannels = (expenseActionStyle.background.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    assert.ok(
        expenseActionChannels[1] > expenseActionChannels[0] &&
            expenseActionChannels[1] > expenseActionChannels[2],
        `Expense action was not green: ${expenseActionStyle.background}`,
    );
    await desktop.locator("#expenseInventoryBtn").click();
    assert.equal(await desktop.locator("#expenseInventoryDialog").evaluate((dialog) => dialog.open), true);
    await assertNoHorizontalDialogOverflow(desktop.locator("#expenseInventoryDialog .dialog-card"));
    assert.equal(await desktop.locator("#expenseCategoryList .expense-category-row").count(), 7);
    await desktop.locator("#expenseAddParticipantBtn").click();
    await desktop.locator("#expenseAddParticipantBtn").click();
    await desktop.locator("#expenseParticipantList .expense-inventory-name").nth(0).fill("Alex");
    await desktop.locator("#expenseParticipantList .expense-inventory-name").nth(1).fill("Bea");
    await desktop.locator("#expenseInventoryForm").evaluate((form) => form.requestSubmit());
    await desktop.locator("#expenseInventoryDialog:not([open])").waitFor({ state: "attached" });

    await desktop.locator("#expenseAddBtn").click();
    assert.equal(await desktop.locator("#expenseDialog").evaluate((dialog) => dialog.open), true);
    await desktop.waitForFunction(() => document.activeElement?.id === "expenseAmount");
    assert.equal(await desktop.locator("#expenseDialog .dialog-title").count(), 1);
    assert.equal(await desktop.locator("#expenseDialogMeta").count(), 0);
    await assertNoHorizontalDialogOverflow(desktop.locator("#expenseDialog .dialog-card"));
    assert.equal(await desktop.locator("#expensePayerPanel").evaluate((panel) => panel.hidden), true);
    assert.equal(await desktop.locator("#expenseSplitPanel").evaluate((panel) => panel.hidden), true);
    assert.equal(await desktop.locator("#expenseOutcome").evaluate((outcome) => outcome.hidden), true);
    assert.equal(await desktop.locator("#expenseAdvancedDetails").evaluate((details) => details.open), false);
    assert.equal(await desktop.locator("#expensePayer option").count(), 3);
    assert.equal(await desktop.locator("#expenseSplitRows .expense-owed-input:checked").count(), 2);
    assert.equal(await desktop.locator("#expenseCategory").inputValue(), "Other");
    assert.equal(await desktop.locator("#expenseCategory").getAttribute("list"), "expenseCategoryOptions");
    assert.equal(await desktop.locator("#expenseCategoryOptions option").count(), 7);
    assert.equal(await desktop.locator("#expenseCurrency").inputValue(), "EUR");
    const amountFontSize = await desktop.locator("#expenseAmount").evaluate(
        (input) => Number.parseFloat(getComputedStyle(input).fontSize),
    );
    assert.ok(amountFontSize >= 30, `Amount typography was only ${amountFontSize}px.`);
    assert.notEqual(await desktop.locator("#expenseDate").inputValue(), "");
    await desktop.locator("#expensePayerSummaryBtn").click();
    assert.equal(await desktop.locator("#expensePayerPanel").isVisible(), true);
    await desktop.locator("#expensePayerPanelCloseBtn").click();
    await desktop.locator("#expenseSplitSummaryBtn").click();
    assert.equal(await desktop.locator("#expenseSplitPanel").isVisible(), true);
    await desktop.locator("#expenseSplitPanelCloseBtn").click();
    await desktop.locator("#expenseAmount").fill("invalid");
    await desktop.locator("#expenseDescription").fill("Dinner");
    await desktop.locator("#expenseForm").evaluate((form) => form.requestSubmit());
    await desktop.locator("#expenseDialogError").waitFor({ state: "visible" });
    assert.match(await desktop.locator("#expenseDialogError").textContent(), /Amount/);
    assert.equal(await desktop.locator("#expenseDialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await desktop.locator("#expenseCategory").inputValue(), "Food & drink");
    assert.match(await desktop.locator("#expenseCategoryHint").textContent(), /Suggested/);
    await desktop.locator("#expenseDescription").fill("Mysterious item");
    assert.equal(await desktop.locator("#expenseCategory").inputValue(), "Other");
    assert.equal(await desktop.locator("#expenseCategoryHint").textContent(), "");
    await desktop.locator("#expenseDescription").fill("Dinner");
    await desktop.locator("#expenseAmount").fill("48.00");
    assert.equal(await desktop.locator("#expenseOutcome").evaluate((outcome) => outcome.hidden), false);
    await desktop.locator("#expenseCategory").fill("Unknown category");
    await desktop.locator("#expenseForm").evaluate((form) => form.requestSubmit());
    await desktop.locator("#expenseDialogError").waitFor({ state: "visible" });
    assert.match(await desktop.locator("#expenseDialogError").textContent(), /existing category/i);
    await desktop.locator("#expenseCategory").fill("Food & drink");
    await desktop.locator("#expenseCurrency").fill("eur");
    await desktop.locator("#expenseCurrency").blur();
    assert.equal(await desktop.locator("#expenseCurrency").inputValue(), "EUR");
    await desktop.locator("#expensePayerSummaryBtn").click();
    await desktop.locator("#expensePayer").selectOption("__custom__");
    assert.equal(await desktop.locator("#expensePayerSummary").textContent(), "Alex");
    assert.match(await desktop.locator("#expensePayerRemaining").textContent(), /full.*48.*covered/i);
    await desktop.locator("#expenseSplitSummaryBtn").click();
    assert.equal(await desktop.locator("#expenseSplitPanel").isVisible(), true);
    await desktop.locator('[data-allocation-type="exact"]').click();
    const exactInputs = desktop.locator("#expenseSplitRows .expense-owed-input");
    assert.equal(await exactInputs.count(), 2);
    await exactInputs.nth(0).fill("20.00");
    assert.equal(await exactInputs.nth(1).inputValue(), "28.00");
    assert.equal(await exactInputs.nth(1).isEditable(), false);
    assert.match(await desktop.locator("#expenseOutcomeSummary").textContent(), /Bea owes Alex.*28/);
    await desktop.locator('[data-allocation-type="percentage"]').click();
    const percentageInputs = desktop.locator("#expenseSplitRows .expense-owed-input");
    assert.equal(await percentageInputs.nth(1).isEditable(), false);
    await percentageInputs.nth(0).fill("35.00");
    assert.equal(await percentageInputs.nth(1).inputValue(), "65.00");
    await desktop.locator("#expenseForm").evaluate((form) => form.requestSubmit());
    await desktop.locator("#expenseDialog:not([open])").waitFor({ state: "attached" });
    assert.match(await desktop.locator("#expenseList").textContent(), /Dinner/);

    await openComponent(desktop, baseUrl, "time");
    await desktop.locator("#menuSearchBtn").click();
    assert.equal(await desktop.locator("#searchView").isVisible(), true);
    assert.match(desktop.url(), /panel=search/);
    await desktop.goBack();
    await desktop.locator("#weekViewSection:not([hidden])").waitFor();
    await desktop.goForward();
    await desktop.locator("#searchView:not([hidden])").waitFor();

    // A hosted/provider-only start must ignore the local workspace that the preceding local session persisted.
    await desktop.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await desktop.locator("#loginSection:not([hidden])").waitFor();
    assert.equal(await desktop.locator("#loginSection").isVisible(), true);

    await desktop.route("https://api.github.com/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/repos/example/unconfigured") {
            await route.fulfill({ json: { default_branch: "main", full_name: "example/unconfigured", private: true } });
            return;
        }
        if (url.pathname === "/user") {
            await route.fulfill({ json: { login: "example" } });
            return;
        }
        if (url.pathname === "/repos/example/unconfigured/contents/zeitberg.json") {
            await route.fulfill({ json: { message: "Not Found" }, status: 404 });
            return;
        }
        await route.fulfill({ json: { message: "Unexpected browser-smoke request" }, status: 500 });
    });
    const capabilityToken = "browser-smoke-capability-token";
    const capabilityLink = formatCapabilityLink(
        {
            version: 1,
            component: "expenses",
            panel: "main",
            workspace: {
                provider: "github",
                repositoryUrl: "https://github.com/example/unconfigured",
                ref: "main",
                workspacePath: "zeitberg.json",
                expectedWorkspaceId: "",
            },
            state: {},
        },
        capabilityToken,
        baseUrl,
    );
    await desktop.locator("#openSharedWorkspaceBtn").click();
    await desktop.locator("#workspaceDialog[open]").waitFor();
    assert.equal(await desktop.locator("#workspaceAddSection").isVisible(), true);
    assert.equal(await desktop.locator("#workspaceScanCapabilityBtn").isVisible(), true);
    await desktop.locator("#workspaceCapabilityLink").fill(capabilityLink);
    await desktop.locator("#workspaceCapabilityForm").evaluate((form) => form.requestSubmit());
    await desktop.locator("#workspaceConfigForm:not([hidden])").waitFor();
    assert.equal(await desktop.locator("#workspaceCapabilityLink").inputValue(), "");
    const pastedCapabilityCredentials = await desktop.evaluate(() =>
        localStorage.getItem("zeitberg:workspace-credentials:local:v1"),
    );
    assert.match(pastedCapabilityCredentials || "", /browser-smoke-capability-token/);
    await desktop.locator("#workspaceDialogCloseBtn").click();
    await desktop.locator("#logoutBtn").click();

    await desktop.goto(capabilityLink, { waitUntil: "domcontentloaded" });
    await desktop.locator("#workspaceDialog[open]").waitFor();
    assert.equal(new URL(desktop.url()).hash, "");
    assert.equal(await desktop.locator("#capabilityImportDialog").count(), 0);
    const storedCapabilityCredentials = await desktop.evaluate(() => ({
        remembered: localStorage.getItem("zeitberg:workspace-credentials:local:v1"),
        session: sessionStorage.getItem("zeitberg:workspace-credentials:session:v1"),
    }));
    assert.match(storedCapabilityCredentials.remembered || "", /browser-smoke-capability-token/);
    assert.equal(storedCapabilityCredentials.session, null);
    assert.equal(await desktop.locator("#workspaceConfigForm").isVisible(), true);
    assert.notEqual(await desktop.locator("#workspaceConfigId").inputValue(), "");
    assert.match(await desktop.locator("#workspaceConfigMeta").textContent(), /zeitberg\.json/);
    assert.equal(await desktop.locator("#menuWeekBtn").isVisible(), false);
    assert.equal(await desktop.locator("#menuTodoBtn").isVisible(), false);
    assert.equal(await desktop.locator("#menuExpenseBtn").isVisible(), false);
    await desktop.locator("#workspaceDialogCloseBtn").click();
    await desktop.locator("#logoutBtn").click();
    assert.deepEqual(browserErrors, []);
    const desktopCoverage = await desktop.coverage.stopJSCoverage();

    const narrow = await browser.newPage({ viewport: { width: 375, height: 667 } });
    await narrow.coverage.startJSCoverage({ resetOnNavigation: false });
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
    await narrow.locator("#interfaceSettingsBtn").click();
    const interfaceDialog = await dialogSize(narrow.locator("#interfaceDialog .dialog-card"));
    assert.equal(interfaceDialog.width, interfaceDialog.viewportWidth);
    assert.equal(interfaceDialog.height, interfaceDialog.viewportHeight);
    await narrow.locator("#interfaceDialogCloseBtn").click();
    await narrow.waitForURL((url) => !url.searchParams.has("panel"));
    await narrow.locator("#workspaceSettingsBtn").click();
    const workspaceDialog = await dialogSize(narrow.locator("#workspaceDialog .dialog-card"));
    assert.equal(workspaceDialog.width, workspaceDialog.viewportWidth);
    assert.equal(workspaceDialog.height, workspaceDialog.viewportHeight);
    await narrow.locator("#workspaceDialogCloseBtn").click();
    await openComponent(narrow, baseUrl, "expenses");
    assert.equal(await narrow.locator("#expenseAddBtn .expense-add-label").isVisible(), false);
    const compactExpenseActionWidths = await narrow.evaluate(() => ({
        add: document.querySelector("#expenseAddBtn")?.getBoundingClientRect().width || 0,
        inventory: document.querySelector("#expenseInventoryBtn")?.getBoundingClientRect().width || 0,
    }));
    assert.equal(compactExpenseActionWidths.add, compactExpenseActionWidths.inventory);
    await narrow.locator("#expenseAddBtn").click();
    const expenseInventoryDialog = await dialogSize(narrow.locator("#expenseInventoryDialog .dialog-card"));
    assert.equal(expenseInventoryDialog.width, expenseInventoryDialog.viewportWidth);
    assert.equal(expenseInventoryDialog.height, expenseInventoryDialog.viewportHeight);
    assert.equal(await narrow.locator("#expenseInventoryCategoriesSection").evaluate((section) => section.hidden), true);
    assert.equal(await narrow.locator("#expenseParticipantList .expense-inventory-name").count(), 1);
    await narrow.locator("#expenseParticipantList .expense-inventory-name").last().fill("Alex");
    await narrow.locator("#expenseInventoryForm").evaluate((form) => form.requestSubmit());
    await narrow.locator("#expenseInventoryDialog:not([open])").waitFor({ state: "attached" });
    await narrow.locator("#expenseDialog[open]").waitFor();
    const expenseDialog = await dialogSize(narrow.locator("#expenseDialog .dialog-card"));
    assert.equal(expenseDialog.width, expenseDialog.viewportWidth);
    assert.equal(expenseDialog.height, expenseDialog.viewportHeight);
    assert.equal(await narrow.locator("#expenseInventoryBtn").isVisible(), true);
    const flowCardHeight = await narrow.locator("#expensePayerSummaryBtn").evaluate(
        (element) => element.getBoundingClientRect().height,
    );
    assert.ok(flowCardHeight >= 56, `Payer summary was compressed to ${flowCardHeight}px.`);
    await narrow.locator("#expenseSplitSummaryBtn").click();
    assert.equal(await narrow.locator("#expenseSplitPanel").isVisible(), true);
    const splitPanelPosition = await narrow.locator("#expenseSplitPanel").evaluate((panel) => {
        const panelRect = panel.getBoundingClientRect();
        const actions = document.querySelector("#expenseForm .dialog-actions");
        const actionRect = actions?.getBoundingClientRect();
        return {
            top: panelRect.top,
            bottom: panelRect.bottom,
            actionTop: actionRect?.top ?? window.innerHeight,
        };
    });
    assert.ok(splitPanelPosition.top >= 0);
    assert.ok(splitPanelPosition.bottom <= splitPanelPosition.actionTop + 1);
    const expenseFormScroll = await narrow.locator("#expenseForm").evaluate((form) => ({
        clientHeight: form.clientHeight,
        scrollHeight: form.scrollHeight,
        overflowY: getComputedStyle(form).overflowY,
    }));
    assert.ok(expenseFormScroll.scrollHeight > expenseFormScroll.clientHeight);
    assert.equal(expenseFormScroll.overflowY, "auto");
    await assertNoHorizontalDialogOverflow(narrow.locator("#expenseDialog .dialog-card"));
    await narrow.locator("#expenseCancelBtn").click();
    assert.deepEqual(narrowErrors, []);
    const narrowCoverage = await narrow.coverage.stopJSCoverage();

    const browserCoverage = await writeBrowserCoverage(
        /** @type {BrowserCoverageEntry[]} */ ([...desktopCoverage, ...narrowCoverage]),
    );

    console.log("Browser smoke passed: routing, workspace load, dialogs, history, and narrow layouts.");
    console.log(
        `Browser-controller coverage: ${browserCoverage.lines.pct}% lines, ${browserCoverage.functions.pct}% functions, ${browserCoverage.branches.pct}% branches.`,
    );
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
