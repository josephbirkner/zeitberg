import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "zeitberg-dialogs-"));
const port = await new Promise((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        socket.close(() => resolve(address.port));
    });
});
const origin = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["server.py", "--no-local", "--port", String(port), "--host", "127.0.0.1"], { cwd: root, stdio: "ignore" });

/**
 * Checks dialog geometry after real UI interactions, including descendants that a hidden
 * overflow rule might otherwise mask. Saves screenshots for a human design review.
 * @param {import("playwright").Page} page Browser page with a visible dialog.
 * @param {string} selector Dialog selector.
 * @param {string} name Screenshot and assertion label.
 * @returns {Promise<void>}
 */
async function inspectDialog(page, selector, name) {
    const dialog = page.locator(selector);
    await dialog.waitFor({ state: "visible" });
    const metrics = await dialog.evaluate((element) => {
        const card = element.querySelector(".dialog-card");
        const bounds = card.getBoundingClientRect();
        const visible = (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
        const clipped = [...card.querySelectorAll("input, select, textarea, button")].filter(visible).filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
        }).map((node) => node.id || node.className);
        const crosses = [...card.querySelectorAll('button:has(use[href$="#close"])')].filter(visible).map((button) => {
            const b = button.getBoundingClientRect();
            const s = button.querySelector("svg").getBoundingClientRect();
            return { width: b.width, height: b.height, dx: s.x + s.width / 2 - b.x - b.width / 2, dy: s.y + s.height / 2 - b.y - b.height / 2 };
        });
        const actions = card.querySelector(".dialog-actions")?.getBoundingClientRect();
        return {
            overflow: card.scrollWidth > card.clientWidth + 1, clipped, crosses,
            named: Boolean(element.getAttribute("aria-label") || document.getElementById(element.getAttribute("aria-labelledby"))?.textContent.trim()),
            actionsVisible: !actions || actions.top >= 0 && actions.bottom <= innerHeight + 1,
        };
    });
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    assert.equal(metrics.overflow, false, `${name}: horizontal card overflow`);
    assert.deepEqual(metrics.clipped, [], `${name}: clipped controls`);
    assert.equal(metrics.named, true, `${name}: accessible name`);
    assert.equal(metrics.actionsVisible, true, `${name}: reachable sticky actions`);
    if (selector === "#expenseDialog") {
        const date = await page.locator("#expenseDate").boundingBox();
        const category = await page.locator("#expenseCategory").boundingBox();
        const separate = date.x + date.width <= category.x + 1 || date.y + date.height <= category.y + 1;
        assert.ok(separate, `${name}: date and category must not overlap`);
        assert.ok(Math.abs(date.height - category.height) < 1, `${name}: matching date/category heights`);
    }
    for (const cross of metrics.crosses) {
        assert.ok(cross.width >= 44 && cross.height >= 44, `${name}: close touch target`);
        assert.ok(Math.abs(cross.dx) < 1 && Math.abs(cross.dy) < 1, `${name}: centered cross`);
    }
}

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
    browser = await (process.argv.includes("--webkit") ? webkit : chromium).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await page.clock.install({ time: new Date("2026-09-15T12:00:00Z") });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/time?demo=1&demoSeed=docs-v1`);
    await page.locator("#appSection:not([hidden])").waitFor();
    const cases = [
        ["entry", "#entryDialog", async () => { await page.locator("#menuWeekBtn").click(); await page.locator(".entry-block").first().dblclick(); }],
        ["task", "#todoDialog", async () => { await page.locator("#menuTodoBtn").click(); await page.locator("#todoAddBtn").click(); }],
        ["projects", "#projectsDialog", async () => { await page.locator("#projectsBtn").click(); }],
        ["preferences", "#interfaceDialog", async () => { await page.locator("#interfaceSettingsBtn").click(); }],
        ["requirements", "#weekReqDialog", async () => { await page.locator("#menuWeekBtn").click(); await page.locator("#weekReqBtn").click(); }],
        ["expense", "#expenseDialog", async () => { await page.locator("#menuExpenseBtn").click(); await page.locator("#expenseAddBtn").click(); }],
        ["expense-edit", "#expenseDialog", async () => { await page.locator("#menuExpenseBtn").click(); await page.locator(".expense-row:not(.is-transfer)").first().dblclick(); }],
        ["inventory", "#expenseInventoryDialog", async () => { await page.locator("#menuExpenseBtn").click(); await page.locator("#expenseInventoryBtn").click(); }],
        ["date", ".week-date-dialog", async () => { await page.locator("#menuWeekBtn").click(); await page.locator(".wg-week-number").click(); }],
    ];
    for (const [width, height, language, theme] of [[1280, 900, "en", "dark"], [390, 844, "en", "dark"], [320, 640, "de", "light"], [740, 420, "en", "light"]]) {
        await page.setViewportSize({ width, height });
        await page.locator("#interfaceSettingsBtn").click();
        await page.locator("#interfaceLanguage").selectOption(language);
        await page.keyboard.press("Escape");
        await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
        for (const [name, selector, open] of cases) {
            await open();
            const dialog = page.locator(selector);
            await inspectDialog(page, selector, `${name}-${width}`);
            if (name === "task") {
                assert.equal(await page.locator("#todoDetails").evaluate((node) => node.open), false);
                await page.locator("#todoDetails summary").click();
                await inspectDialog(page, selector, `task-details-${width}`);
            }
            if (name === "expense") {
                assert.equal(await page.locator("#expenseAmount").evaluate((node) => node === document.activeElement), true);
                await page.locator("#expenseAmount").fill("123.45");
                await page.locator("#expenseDescription").fill("A shared dinner");
                await page.locator("#expensePayerSummaryBtn").click();
                await page.locator("#expensePayer").selectOption("__custom__");
                await inspectDialog(page, selector, `expense-payers-${width}`);
                await page.locator("#expensePayerPanelCloseBtn").click();
                await page.locator("#expenseSplitSummaryBtn").click();
                for (const allocation of ["equal", "percentage", "exact"]) {
                    await page.locator(`[data-allocation-type="${allocation}"]`).click();
                    await inspectDialog(page, selector, `expense-${allocation}-${width}`);
                }
                await page.locator("#expenseSplitPanelCloseBtn").click();
                await page.locator("#expenseAdvancedDetails summary").click();
                await inspectDialog(page, selector, `expense-details-${width}`);
                await page.locator("#expenseAmount").fill("invalid");
                await page.locator("#expenseSubmitBtn").click();
                assert.equal(await page.locator("#expenseDialogError").isVisible(), true);
                assert.equal(await page.locator("#expenseAmount").evaluate((node) => node === document.activeElement), true);
                await inspectDialog(page, selector, `expense-error-${width}`);
            }
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: name === "date" ? "detached" : "hidden" });
        }
        console.log(`Interactive dialogs passed at ${width}×${height}, ${language}, ${theme}`);
    }
    // Optional task values survive collapsing, editing and saving; invalid recurrence stays
    // in the dialog instead of becoming a toast behind its backdrop.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#menuTodoBtn").click();
    await page.locator("#todoAddBtn").click();
    await page.locator("#todoContent").fill("Dialog regression task");
    await page.locator("#todoDueDate").fill("2026-09-15");
    await page.locator("#todoDetails summary").click();
    await page.locator("#todoDescription").fill("Keep this optional description");
    await page.locator("#todoLabels").fill("example, regression");
    await page.locator("#todoDueTime").fill("15:30");
    await page.locator("#todoRecurrence").fill("not a recurrence");
    await page.locator("#todoDetails summary").click();
    await page.locator('#todoForm button[type="submit"]').click();
    assert.equal(await page.locator("#todoDialogError").isVisible(), true);
    assert.equal(await page.locator("#todoDetails").evaluate((node) => node.open), true);
    assert.equal(await page.locator("#todoRecurrence").evaluate((node) => node === document.activeElement), true);
    await inspectDialog(page, "#todoDialog", "task-validation-390");
    await page.locator("#todoRecurrence").fill("every day");
    await page.locator("#todoDetails summary").click();
    await page.locator('#todoForm button[type="submit"]').click();
    await page.locator("#todoDialog").waitFor({ state: "hidden" });
    await page.locator('.todo-row').filter({ hasText: "Dialog regression task" }).dblclick();
    assert.equal(await page.locator("#todoDetails").evaluate((node) => node.open), true);
    assert.equal(await page.locator("#todoDescription").inputValue(), "Keep this optional description");
    assert.equal(await page.locator("#todoLabels").inputValue(), "example, regression");
    assert.equal(await page.locator("#todoDueTime").inputValue(), "15:30");
    assert.ok(await page.locator("#todoRecurrence").inputValue());
    await page.keyboard.press("Escape");
    // Remaining dialogs depend on repository setup or remote conflicts. Exercise their actual
    // shells without authenticating, provisioning a repository, or modifying user data.
    // Abandon only this test's disposable demo edits.
    await page.goto(`${origin}/?demo=1&demoSeed=docs-v1`);
    await page.locator("#appSection:not([hidden])").waitFor();
    for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 640 });
        for (const id of ["workspaceDialog", "workspaceEditDialog", "workspaceCreateDialog", "workspaceShareDialog", "todoConflictDialog", "projectBindingDialog", "expenseSettlementDialog"]) {
            await page.locator(`#${id}`).evaluate((dialog) => dialog.showModal());
            await inspectDialog(page, `#${id}`, `${id}-${width}`);
            await page.keyboard.press("Escape");
        }
    }
    // Mobile emulation includes touch and WebKit's mobile user agent, not just a narrow desktop viewport.
    const phone = await browser.newPage({ ...devices["iPhone 16 Pro"], locale: "de-DE", colorScheme: "light" });
    phone.on("pageerror", (error) => errors.push(error.message));
    await phone.goto(`${origin}/`);
    await phone.locator("#loginSection:not([hidden])").waitFor();
    await phone.evaluate(() => document.documentElement.dataset.theme = "light");
    assert.equal(await phone.locator("#demoLink").evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)");
    assert.doesNotMatch(await phone.locator("#demoLink").textContent(), /account|Konto/i);
    assert.equal(await phone.locator('[data-i18n="landing.aiDisclosure"], [data-i18n="landing.markAttribution"]').count(), 0);
    await phone.goto(`${origin}/expenses?demo=1&demoSeed=iphone`);
    await phone.locator("#appSection:not([hidden])").waitFor();
    await phone.evaluate(() => document.documentElement.dataset.theme = "light");
    await phone.locator("#expenseAddBtn").tap();
    await phone.locator("#expenseAmount").fill("10.50");
    await phone.locator("#expenseDescription").fill("Stolpe Backstube");
    await phone.locator("#expenseDate").fill("2026-09-07");
    await inspectDialog(phone, "#expenseDialog", "expense-iphone16pro-de-light");
    assert.equal(await phone.locator("#expenseDate").evaluate((node) => getComputedStyle(node).appearance), "none");
    await phone.close();
    assert.deepEqual(errors, []);
    console.log(`Dialog audit screenshots: ${output}`);
} finally {
    await browser?.close();
    server.kill("SIGTERM");
}
