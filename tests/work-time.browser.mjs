import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WorkTimeConfig } from "../work-time.js";
import { isoWeekStart } from "../utils.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Uses the visible date picker and waits for its week navigation to reach the shareable route.
 * @param {import("playwright").Page} page Browser page under test.
 * @param {string} date ISO date to focus.
 * @returns {Promise<void>} Resolves once the containing week is reflected in the URL.
 */
async function jumpToDate(page, date) {
    await page.getByRole("button", { name: "Jump to a date", exact: true }).click();
    await page.locator(".week-date-dialog input").fill(date);
    await page.getByRole("button", { name: "Show week", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("week") === isoWeekStart(date));
}

/**
 * Allocates a loopback port for an isolated local-server integration test.
 * @returns {Promise<number>} Available port.
 */
function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

const temporary = await mkdtemp(path.join(tmpdir(), "zeitberg-work-time-test-"));
const workspace = path.join(temporary, "workspace");
await cp(path.join(root, "workspace-template"), workspace, { recursive: true });
const requirementsPath = path.join(workspace, "data/week-requirements.json");
const account = WorkTimeConfig.newEmployer("employer", "Example employer", "2025-09-01", ["personal"]);
account.vacation_allowances = { 2025: 30, 2026: 30 };
const config = new WorkTimeConfig({ schema_version: 3, generated_at: "", employers: [account] });
await writeFile(requirementsPath, config.toJson());
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["server.py", "--workspace", workspace, "--port", String(port), "--host", "127.0.0.1"], { cwd: root, stdio: "ignore" });
let browser;
try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try { if ((await fetch(`${origin}/local-workspaces`)).ok) break; } catch { /* Listener starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await page.clock.install({ time: new Date("2026-09-15T12:00:00Z") });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/time?source=local&workspace=replace-with-a-unique-id&week=2026-09-14`);
    await page.locator("#appSection:not([hidden])").waitFor();
    await page.locator('.wg-work-status').first().waitFor();
    assert.equal(await page.locator(".document-workspace-title h1").isVisible(), true);
    assert.equal(await page.locator("#documentWorkspaces").isVisible(), false);
    assert.equal(await page.locator(".workspace-title-chevron").isVisible(), false);
    assert.deepEqual(await page.locator(".wg-work-status").allTextContents(), ["Work", "Work", "Work", "Work", "Work", "Off", "Off"]);
    assert.equal(await page.locator(".wg-day-total").count(), 7);
    assert.equal(await page.locator(".wg-date").first().textContent(), "09/14/2026");
    // Date selection validates input, handles ISO-week year boundaries, and survives a reload.
    await page.getByRole("button", { name: "Jump to a date", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.locator(".week-date-dialog[open]").waitFor();
    await page.locator(".week-date-dialog input").fill("");
    await page.getByRole("button", { name: "Show week", exact: true }).click();
    assert.equal(await page.locator(".week-date-dialog").isVisible(), true);
    await page.keyboard.press("Escape");
    await page.locator(".week-date-dialog").waitFor({ state: "detached" });
    await jumpToDate(page, "2027-01-01");
    assert.equal(await page.locator(".wg-date").first().textContent(), "12/28/2026");
    assert.equal(await page.locator(".wg-date").nth(4).textContent(), "01/01/2027");
    assert.equal(await page.locator('.wg-header[data-day-idx="4"]').evaluate((element) => element.classList.contains("is-focused")), true);
    await page.reload();
    await page.locator(".wg-date").first().waitFor();
    assert.equal(await page.locator(".wg-date").first().textContent(), "12/28/2026");
    // Future leave must update the planning budget before saving, without spending today's taken balance.
    await jumpToDate(page, "2026-10-01");
    await page.locator('.wg-header[data-day-idx="3"] .wg-work-status').click();
    const annualValue = (key) => page.locator(`[data-vacation="${key}"] dd`);
    assert.equal(await annualValue("taken").textContent(), "0 days");
    assert.equal(await annualValue("planned").textContent(), "0 days");
    assert.equal(await annualValue("unplanned").textContent(), "60 days");
    await page.getByText("PTO dates this year", { exact: true }).click();
    assert.equal(await page.getByText("No PTO taken or planned for this year.", { exact: true }).isVisible(), true);
    await page.getByLabel("2026-10-01 First half", { exact: true }).selectOption("pto");
    assert.equal(await annualValue("planned").textContent(), "0.5 days");
    assert.equal(await annualValue("unplanned").textContent(), "59.5 days");
    await page.getByLabel("2026-10-01 Second half", { exact: true }).selectOption("pto");
    assert.equal(await annualValue("taken").textContent(), "0 days");
    assert.equal(await annualValue("planned").textContent(), "1 day");
    assert.equal(await annualValue("unplanned").textContent(), "59 days");
    await page.getByText("How this is calculated", { exact: true }).click();
    await page.getByLabel("2026-10-01 Second half", { exact: true }).selectOption("work");
    assert.equal(await page.locator(".work-time-vacation-calculation").evaluate((element) => element.open), true);
    assert.equal(await page.locator(".work-time-vacation-overview").evaluate((element) => element.open), true);
    assert.equal(await page.locator(".work-time-vacation-booking").count(), 1);
    assert.match(await page.locator(".work-time-vacation-booking").textContent(), /0.5 days · First half/);
    await page.locator("#weekReqCancelBtn").click();
    await jumpToDate(page, "2026-09-14");
    // Header shortcuts work by keyboard and focus the matching daily control, not an entry editor.
    await page.locator('.wg-header[data-day-idx="2"] .wg-work-status').focus();
    await page.keyboard.press("Enter");
    await page.locator("#weekReqDialog[open]").waitFor();
    assert.equal(await page.getByLabel("2026-09-16 First half", { exact: true }).evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator(".work-time-table tbody tr").count(), 7);
    assert.equal(await page.locator("#weekReqHours").count(), 0);
    assert.equal(await page.locator(".work-time-error").isVisible(), false);
    await page.getByRole("button", { name: "Select scheduled workdays", exact: true }).click();
    await page.getByLabel("Bulk leave status", { exact: true }).selectOption("pto");
    await page.getByRole("button", { name: "Apply to selected days", exact: true }).click();
    assert.equal(await page.locator(".work-time-table tbody select").evaluateAll((selects) => selects.filter((select) => select.value === "pto").length), 10);
    assert.equal(await page.locator(".work-time-error").isVisible(), false);
    assert.equal(await annualValue("taken").textContent(), "2 days");
    assert.equal(await annualValue("planned").textContent(), "3 days");
    assert.equal(await annualValue("unplanned").textContent(), "55 days");
    // Failed writes keep the dialog and editable draft intact, with feedback on the modal layer.
    await page.route("**/save", (route) => route.fulfill({ status: 500, body: "Injected write failure" }));
    await page.locator("#weekReqOkBtn").click();
    await page.locator(".work-time-error:not([hidden])").waitFor();
    assert.equal(await page.locator("#weekReqDialog").isVisible(), true);
    assert.equal(await page.locator(".wg-work-status").first().textContent(), "Work");
    assert.equal(JSON.parse(await readFile(requirementsPath, "utf8")).employers[0].days.length, 0);
    await page.unroute("**/save");
    await page.locator("#weekReqOkBtn").click();
    await page.locator("#weekReqDialog").waitFor({ state: "hidden" });
    const saved = JSON.parse(await readFile(requirementsPath, "utf8"));
    assert.equal(saved.schema_version, 3);
    assert.equal(saved.employers[0].days.length, 5);
    assert.ok(saved.employers[0].days.every((day) => day.halves.every((half) => half === "pto")));
    assert.equal(await page.locator(".wg-work-status").first().textContent(), "PTO");
    await page.reload();
    await page.locator("#appSection:not([hidden])").waitFor();
    await page.locator("#weekReqBtn").click();
    assert.equal(await page.locator(".work-time-table tbody select").evaluateAll((selects) => selects.filter((select) => select.value === "pto").length), 10);
    // Gleitzeit is available in both row and bulk controls and survives the shared save pipeline.
    await page.getByLabel("2026-09-14 First half", { exact: true }).selectOption("flex");
    assert.equal(await page.locator(".work-time-table tbody tr").first().locator("td.work-time-hours").last().textContent(), "4");
    await page.locator("#weekReqOkBtn").click();
    await page.locator("#weekReqDialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".wg-work-status").first().textContent(), "½ TOIL · ½ PTO");
    await page.locator(".wg-work-status").first().click();
    await page.getByRole("button", { name: "Select scheduled workdays", exact: true }).click();
    await page.getByLabel("Bulk leave status", { exact: true }).selectOption("flex");
    await page.getByRole("button", { name: "Apply to selected days", exact: true }).click();
    assert.equal(await page.locator(".work-time-table tbody select").evaluateAll((selects) => selects.filter((select) => select.value === "flex").length), 10);
    assert.equal(await page.locator(".work-time-table tbody tr").first().locator("td.work-time-hours").last().textContent(), "8");
    await page.locator("#weekReqOkBtn").click();
    await page.locator("#weekReqDialog").waitFor({ state: "hidden" });
    const flexSaved = JSON.parse(await readFile(requirementsPath, "utf8"));
    assert.ok(flexSaved.employers[0].days.every((day) => day.halves.every((half) => half === "flex")));
    assert.equal(await page.locator(".wg-work-status").first().textContent(), "TOIL");
    await page.reload();
    await page.locator("#appSection:not([hidden])").waitFor();
    await page.locator("#weekReqBtn").click();
    assert.equal(await page.getByLabel("2026-09-14 First half", { exact: true }).inputValue(), "flex");
    // Controls remain readable and contained in the full-screen narrow dialog.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.classList.contains("ui-narrow"));
    assert.ok(await page.locator("#weekReqDialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(temporary, "work-time-narrow.png"), fullPage: true });
    assert.ok(await page.locator(".work-time-vacation-columns").evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#weekReqCancelBtn").click();
    // Different employers remain distinct; non-working days and all leave kinds stay readable.
    account.days = [
        { date: "2026-09-15", halves: ["pto", "pto"], comment: "Booked leave" },
        { date: "2026-09-16", halves: ["work", "pto"], comment: "Afternoon off" },
        { date: "2026-09-17", halves: ["sick", "sick"], comment: "" },
        { date: "2026-09-18", halves: ["holiday", "holiday"], comment: "Granted day off" },
        { date: "2026-09-20", halves: ["pto", "pto"], comment: "Context only: not scheduled" },
        { date: "2026-10-01", halves: ["pto", "pto"], comment: "Future trip" },
    ];
    const second = WorkTimeConfig.newEmployer("second", "Second employer", "2026-09-15");
    second.active_until = "2026-09-15";
    const future = WorkTimeConfig.newEmployer("future", "Future accounting", "2026-09-01");
    future.tracking_start = "2026-10-01";
    await writeFile(requirementsPath, new WorkTimeConfig({ schema_version: 3, generated_at: "", employers: [account, second, future] }).toJson());
    await page.reload();
    await page.locator(".wg-work-status").first().waitFor();
    assert.deepEqual(await page.locator(".wg-work-status").allTextContents(), ["Work", "2 employers", "½ Work · ½ PTO", "Sick", "Holiday", "Off", "PTO"]);
    const mixedTitle = await page.locator(".wg-work-status").nth(1).getAttribute("title");
    assert.match(mixedTitle, /Example employer/);
    assert.match(mixedTitle, /Second employer/);
    assert.match(mixedTitle, /Booked leave/);
    // Overview dates reconcile with annual totals and preserve unsaved edits when navigating between weeks.
    await page.locator("#weekReqBtn").click();
    await page.getByText("PTO dates this year", { exact: true }).click();
    assert.deepEqual(await page.locator(".work-time-vacation-booking").evaluateAll((buttons) => buttons.map((button) => button.dataset.date)), ["2026-09-15", "2026-09-16", "2026-10-01"]);
    assert.deepEqual(await page.locator(".work-time-vacation-status").allTextContents(), ["Taken", "Planned", "Planned"]);
    assert.match(await page.locator(".work-time-vacation-booking").first().textContent(), /Booked leave/);
    await page.getByLabel("2026-09-14 First half", { exact: true }).selectOption("pto");
    await page.getByLabel("2026-09-14 Comment", { exact: true }).fill("<b>Draft comment</b> " + "long-word-".repeat(30));
    // Clicking directly from a dirty comment must not lose the first click or the typed draft.
    await page.locator('.work-time-vacation-booking[data-date="2026-09-16"]').click();
    assert.equal(await page.getByLabel("2026-09-16 First half", { exact: true }).evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator(".work-time-vacation-comment b").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator(".work-time-vacation-overview").evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.locator(".work-time-vacation-overview").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(temporary, "pto-overview-narrow.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.work-time-vacation-booking[data-date="2026-10-01"]').focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.getByLabel("2026-10-01 First half", { exact: true }).evaluate((element) => element === document.activeElement), true);
    await page.waitForURL((url) => url.searchParams.get("week") === "2026-09-28");
    assert.match(await page.locator("#weekReqMeta").textContent(), /W40/);
    await page.getByLabel("2026-10-01 Second half", { exact: true }).selectOption("work");
    await page.locator('.work-time-vacation-booking[data-date="2026-09-14"]').click();
    assert.equal(await page.getByLabel("2026-09-14 First half", { exact: true }).inputValue(), "pto");
    assert.match(await page.getByLabel("2026-09-14 Comment", { exact: true }).inputValue(), /Draft comment/);
    // Navigation itself performs no writes, and OK persists edits from both visited weeks together.
    assert.equal(JSON.parse(await readFile(requirementsPath, "utf8")).employers[0].days.some((day) => day.date === "2026-09-14"), false);
    await page.locator("#weekReqOkBtn").click();
    await page.locator("#weekReqDialog").waitFor({ state: "hidden" });
    const navigatedDraft = JSON.parse(await readFile(requirementsPath, "utf8")).employers[0].days;
    assert.deepEqual(navigatedDraft.find((day) => day.date === "2026-09-14").halves, ["pto", "work"]);
    assert.deepEqual(navigatedDraft.find((day) => day.date === "2026-10-01").halves, ["pto", "work"]);
    await writeFile(requirementsPath, new WorkTimeConfig({ schema_version: 3, generated_at: "", employers: [account, second, future] }).toJson());
    await page.reload();
    await page.locator(".wg-work-status").first().waitFor();
    // The new row must neither widen the grid nor introduce a document-level scrollbar.
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(150);
        assert.ok(await page.locator(".week-grid").evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
        assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
        assert.ok(await page.locator(".wg-header").first().evaluate((element) => element.offsetHeight < 90));
        await page.screenshot({ path: path.join(temporary, `day-status-${width}.png`), fullPage: true });
    }
    await jumpToDate(page, "2026-09-20");
    assert.equal(await page.locator('.wg-header[data-day-idx="6"]').isVisible(), true);
    await page.getByRole("button", { name: "Jump to a date", exact: true }).click();
    assert.equal(await page.locator(".week-date-dialog input").inputValue(), "2026-09-20");
    assert.ok(await page.locator(".week-date-dialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(temporary, "week-date-picker-narrow.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    const german = await browser.newPage({ locale: "de-DE", viewport: { width: 1280, height: 900 } });
    await german.clock.install({ time: new Date("2026-09-15T12:00:00Z") });
    await german.goto(`${origin}/time?source=local&workspace=replace-with-a-unique-id&week=2026-09-14`);
    await german.locator(".wg-work-status").first().waitFor();
    assert.deepEqual(await german.locator(".wg-work-status").allTextContents(), ["Arbeit", "2 Arbeitgeber", "½ Arbeit · ½ Urlaub", "Krank", "Feiertag", "Frei", "Urlaub"]);
    assert.equal(await german.locator(".wg-date").first().textContent(), "14.09.2026");
    await german.locator("#weekReqBtn").click();
    await german.getByText("Urlaubstage dieses Jahr", { exact: true }).click();
    assert.deepEqual(await german.locator(".work-time-vacation-status").allTextContents(), ["Genommen", "Geplant", "Geplant"]);
    await german.close();
    // Source data is changed only in the disposable workspace to verify legacy history cannot be overwritten.
    await writeFile(requirementsPath, JSON.stringify({ schema_version: 2, default_required_hours: 40, weeks: [
        { week_start: "2025-09-22", required_hours: 36, comment: "Ein halber Tag Urlaub am Donnerstag" },
        { week_start: "2025-09-29", required_hours: 20, comment: "" },
    ] }));
    await page.reload();
    await page.locator("#appSection:not([hidden])").waitFor();
    await page.locator("#weekReqBtn").click();
    assert.equal(await page.locator(".wg-work-status").count(), 0);
    await page.locator("#weekReqOkBtn").click();
    await page.locator(".work-time-error:not([hidden])").waitFor();
    assert.match(await page.locator(".work-time-error").textContent(), /read-only/i);
    assert.equal(await page.locator(".work-time-migration").count(), 0);
    assert.equal(JSON.parse(await readFile(requirementsPath, "utf8")).schema_version, 2);
    await page.locator("#weekReqCancelBtn").click();
    // A fresh workspace has no legacy history and can create its first employer normally.
    await writeFile(requirementsPath, JSON.stringify({ schema_version: 3, generated_at: "", employers: [] }));
    await page.reload();
    await page.locator("#appSection:not([hidden])").waitFor();
    await page.locator("#weekReqBtn").click();
    await page.getByRole("button", { name: "Add employer", exact: true }).click();
    assert.equal(await page.locator(".work-time-table tbody tr").count(), 7);
    await page.locator("#weekReqOkBtn").click();
    await page.locator("#weekReqDialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".wg-work-status").count(), 7);
    const created = JSON.parse(await readFile(requirementsPath, "utf8"));
    assert.equal(created.employers.length, 1);
    assert.deepEqual(created.employers[0].schedules[0].hours, [8, 8, 8, 8, 8, 0, 0]);
    assert.deepEqual(created.employers[0].vacation_allowances, {});
    assert.deepEqual(errors, []);
    console.log(`Work-time browser tests passed. Disposable workspace/screenshots: ${temporary}`);
} finally {
    await browser?.close();
    server.kill("SIGTERM");
}
