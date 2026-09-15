import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
import net from "node:net";
import { EntryStore, TodoStore, ExpenseStore } from "../store.js";
import { Manifest, ProjectList, ExpenseDocument } from "../model.js";
import { TimeContext } from "../utils.js";

const root = new URL("..", import.meta.url).pathname;
const temporary = await mkdtemp(path.join(tmpdir(), "zeitberg-sessions-"));
const directories = [path.join(temporary, "alpha"), path.join(temporary, "beta")];
for (const [index, directory] of directories.entries()) {
    await cp(path.join(root, "workspace-template"), directory, { recursive: true });
    const file = path.join(directory, "zeitberg.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.workspace_id = index ? "beta" : "alpha";
    raw.name = index ? "Beta" : "Alpha";
    await writeFile(file, JSON.stringify(raw));
    const store = new EntryStore(new TimeContext(raw.timezone));
    store.setProjectList(ProjectList.fromRaw(JSON.parse(await readFile(path.join(directory, "data/projects.json"), "utf8"))));
    store.setManifest(Manifest.fromRaw(JSON.parse(await readFile(path.join(directory, "data/index/entries-manifest.json"), "utf8"))));
    store.applyWeekSnapshot("2026-09-14", [{
        id: 42, start: "2026-09-14T08:00:00+02:00", end: "2026-09-14T09:00:00+02:00",
        duration_seconds: 3600, description: `${raw.name} logged time`, project_key: "personal",
        section_key: null, billable: false, is_running: false, updated_at: "2026-09-14T08:00:00Z",
    }]);
    const weeks = store.serializeWeeks(["2026-09-14"]);
    for (const week of weeks) {
        await mkdir(path.dirname(path.join(directory, week.path)), { recursive: true });
        await writeFile(path.join(directory, week.path), week.content);
    }
    await writeFile(path.join(directory, "data/index/entries-manifest.json"), store.buildManifest(weeks).toJson());
    const todoStore = new TodoStore(store);
    todoStore.createTodo({ content: `${raw.name} baseline`, description: "", projectKey: null, sectionKey: null, labels: [], priority: 1, due: null, recurrence: null });
    const todos = JSON.parse(todoStore.serialize());
    todos.todos[0].id = "shared-task-id";
    await writeFile(path.join(directory, "data/todos.json"), JSON.stringify(todos));
    const expenses = JSON.parse(await readFile(path.join(directory, "data/expenses.json"), "utf8"));
    expenses.participants = [
        { key: "alex", name: "Alex", archived: false, source_refs: [] },
        { key: "bea", name: "Bea", archived: false, source_refs: [] },
    ];
    const expenseStore = new ExpenseStore(store);
    expenseStore.setDocument(ExpenseDocument.fromRaw(expenses));
    for (const file of expenseStore.buildPersistenceFiles("data/expenses.json", "data/index/expenses-manifest.json").files) {
        await writeFile(path.join(directory, file.path), file.content);
    }
}
const port = await new Promise((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        socket.close(() => resolve(address.port));
    });
});
const server = spawn("python3", ["server.py", "--workspace", directories[0], "--workspace", directories[1], "--port", String(port), "--host", "127.0.0.1"], { cwd: root, stdio: "ignore" });
let browser;
try {
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/local-workspaces`)).ok) break; } catch { /* Starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    browser = await (process.argv.includes("--webkit") ? webkit : chromium).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await page.clock.install();
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
    await page.goto(`http://127.0.0.1:${port}/todos?source=local&workspace=alpha&current=0`);
    await page.locator("#appSection:not([hidden])").waitFor();
    const selectWorkspace = (name) => page.locator("#documentWorkspaces").selectOption({ label: name });
    await page.locator('#documentWorkspaces option', { hasText: "Beta" }).waitFor({ state: "attached", timeout: 15000 });
    assert.equal(await page.locator("#documentWorkspaceName").textContent(), "Alpha");
    const titleBounds = await page.locator(".document-workspace-header").boundingBox();
    const toolbarBounds = await page.locator(".topbar").boundingBox();
    assert.ok(titleBounds.y + titleBounds.height <= toolbarBounds.y);
    assert.equal((await page.locator("#editorBadge").boundingBox()).height, (await page.locator("#todoAddBtn").boundingBox()).height);
    assert.equal(await page.locator(".workspace-tab-close, #closeDocumentWorkspace").count(), 0);
    await page.locator("#documentWorkspaces").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#documentWorkspaceName").textContent(), "Beta");
    assert.equal(await page.locator("#documentWorkspaces").evaluate((element) => element === document.activeElement), true);
    await selectWorkspace("Alpha");
    await page.locator("#todoAddBtn").click();
    await page.locator("#todoContent").fill("Alpha task");
    await page.locator("#todoForm").evaluate((form) => form.requestSubmit());
    await page.locator("#todoDialog").waitFor({ state: "hidden" });
    assert.match(await page.locator(".save-countdown").textContent(), /(?:59|60)s/);
    await selectWorkspace("Beta");
    await page.locator("#todoAddBtn").click();
    await page.locator("#todoContent").fill("Beta task");
    await page.locator("#todoForm").evaluate((form) => form.requestSubmit());
    await page.locator("#todoDialog").waitFor({ state: "hidden" });
    await selectWorkspace("Alpha");
    assert.match(await page.locator("#todoList").textContent(), /Alpha task/);
    assert.doesNotMatch(await page.locator("#todoList").textContent(), /Beta task/);
    await selectWorkspace("All workspaces");
    assert.match(await page.locator("#todoList").textContent(), /Alpha task/);
    assert.match(await page.locator("#todoList").textContent(), /Beta task/);
    await page.locator("#todoList").focus();
    await page.keyboard.press("Control+z");
    assert.doesNotMatch(await page.locator("#todoList").textContent(), /Beta task/);
    await page.keyboard.press("Control+y");
    assert.match(await page.locator("#todoList").textContent(), /Beta task/);
    // Combined creation uses one searchable workspace/project/section field.
    await page.locator("#todoAddBtn").click();
    await page.locator("#todoContent").fill("Created in Alpha from combined view");
    const alphaDestination = await page.locator("#todoAssignmentList option").evaluateAll((options) => options.find((option) => option.value.startsWith("Alpha → ")).value);
    await page.locator("#todoAssignment").fill(alphaDestination);
    await page.locator("#todoForm").evaluate((form) => form.requestSubmit());
    await page.locator("#todoDialog").waitFor({ state: "hidden" });
    assert.match(await page.locator("#todoList").textContent(), /Created in Alpha/);
    // Editing during an actual delayed write must not be acknowledged by the earlier snapshot.
    let releaseWrites;
    const writesReleased = new Promise((resolve) => { releaseWrites = resolve; });
    let writesStarted = 0;
    await page.route("**/save", async (route) => { writesStarted++; await writesReleased; await route.continue(); });
    await page.keyboard.press("Control+s");
    for (let attempt = 0; attempt < 100 && !writesStarted; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(writesStarted > 0);
    await page.locator("#todoAddBtn").click();
    await page.locator("#todoContent").fill("Newer than saved snapshot");
    await page.locator("#todoForm").evaluate((form) => form.requestSubmit());
    await page.locator("#todoDialog").waitFor({ state: "hidden" });
    releaseWrites();
    await page.waitForFunction(() => document.getElementById("editorBadge").dataset.state === "dirty");
    await page.unroute("**/save");
    const firstSaved = JSON.parse(await readFile(path.join(directories[0], "data/todos.json"), "utf8"));
    assert.equal(firstSaved.todos.some((todo) => todo.content === "Newer than saved snapshot"), false);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.getElementById("editorBadge").textContent === "Saved");
    assert.ok(JSON.parse(await readFile(path.join(directories[0], "data/todos.json"), "utf8")).todos.some((todo) => todo.content === "Alpha task"));
    assert.ok(JSON.parse(await readFile(path.join(directories[1], "data/todos.json"), "utf8")).todos.some((todo) => todo.content === "Beta task"));
    await page.reload();
    await page.locator('#documentWorkspaces option', { hasText: "Beta" }).waitFor({ state: "attached" });
    await page.locator(".todo-row", { hasText: "Beta task" }).waitFor();
    assert.equal(await page.locator("#documentWorkspaces").inputValue(), "");
    assert.equal(await page.locator("#documentWorkspaceName").textContent(), "All workspaces");
    assert.match(await page.locator("#todoList").textContent(), /Newer than saved snapshot/);
    assert.match(await page.locator("#todoList").textContent(), /Beta task/);
    // Duplicate local task ids retain their repository ownership.
    const betaBaseline = page.locator(".todo-row", { hasText: "Beta baseline" });
    await betaBaseline.locator(".todo-check").click();
    assert.equal(await page.locator(".todo-row", { hasText: "Alpha baseline" }).count(), 1);
    assert.equal(await page.locator(".todo-row", { hasText: "Beta baseline" }).count(), 0);
    // A failed save keeps the workspace available and its changes pending.
    await page.route("**/save", (route) => route.fulfill({ status: 500, body: "Injected save failure" }));
    await page.locator("#editorBadge").click();
    await page.waitForFunction(() => document.getElementById("editorBadge").dataset.state === "failed");
    assert.equal(await page.locator('#documentWorkspaces option', { hasText: "Beta" }).count(), 1);
    assert.equal(await page.locator(".todo-row", { hasText: "Beta baseline" }).count(), 0);
    await page.unroute("**/save");
    // Search spans all available time repositories, including identical entry IDs.
    await page.keyboard.press("Control+g");
    await page.keyboard.press("Control+k");
    await page.locator("#entriesTbody tr").first().waitFor();
    assert.equal(await page.locator("#entriesTbody tr").count(), 2);
    await page.locator("#entriesTbody tr", { hasText: "Beta logged time" }).click();
    assert.equal(await page.locator("#documentWorkspaceName").textContent(), "Beta");
    assert.match(page.url(), /workspace=beta/);
    await page.keyboard.press("Control+k");
    const betaScope = await page.locator("#searchWorkspace option").evaluateAll((options) => options.find((option) => option.textContent === "Beta").value);
    await page.locator("#searchWorkspace").selectOption(betaScope);
    assert.equal(await page.locator("#documentWorkspaces").inputValue(), betaScope);
    assert.equal(await page.locator("#documentWorkspaceName").textContent(), "Beta");
    await selectWorkspace("All workspaces");
    assert.equal(await page.locator("#searchWorkspace").inputValue(), "");
    assert.equal(await page.locator("#entriesTbody tr").count(), 2);
    await selectWorkspace("Beta");
    assert.equal(await page.locator("#searchWorkspace").inputValue(), betaScope);
    const betaProject = await page.locator("#projectSelect option").evaluateAll((options) => options.find((option) => option.value.endsWith("|p:personal")).value);
    await page.locator("#projectSelect").selectOption(betaProject);
    assert.equal(await page.locator("#entriesTbody tr").count(), 1);
    await page.waitForURL(/scope=/);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#searchWorkspace option").length === 3);
    assert.equal(await page.locator("#searchWorkspace").inputValue(), betaScope);
    assert.equal(await page.locator("#projectSelect").inputValue(), betaProject);
    assert.equal(await page.locator("#entriesTbody tr").count(), 1);
    // Week saves acknowledge only their serialized entry heights, even if another resize follows in flight.
    await page.locator("#entriesTbody tr").click();
    await page.locator("#weekScroll").focus();
    await page.keyboard.press("Shift+ArrowDown");
    assert.match(await page.locator(".save-countdown").textContent(), /(?:59|60)s/);
    let releaseTime;
    const timeReleased = new Promise((resolve) => { releaseTime = resolve; });
    let timeWriteStarted = false;
    await page.route("**/save", async (route) => { timeWriteStarted = true; await timeReleased; await route.continue(); });
    await page.keyboard.press("Control+s");
    for (let attempt = 0; attempt < 100 && !timeWriteStarted; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(timeWriteStarted);
    await page.keyboard.press("Shift+ArrowDown");
    releaseTime();
    await page.waitForFunction(() => document.getElementById("editorBadge").dataset.state === "dirty");
    await page.unroute("**/save");
    const betaWeekPath = path.join(directories[1], "data/entries/2026/38.json");
    assert.equal(JSON.parse(await readFile(betaWeekPath, "utf8")).entries[0].duration_seconds, 4500);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.getElementById("editorBadge").textContent === "Saved");
    assert.equal(JSON.parse(await readFile(betaWeekPath, "utf8")).entries[0].duration_seconds, 5400);
    await page.locator("#zoomInput").evaluate((input) => { input.value = "4"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.locator("#weekScroll").evaluate((element) => { element.scrollTop = 1200; });
    await page.waitForFunction(() => document.getElementById("weekScroll").scrollTop === 1200);
    await selectWorkspace("Alpha");
    await selectWorkspace("Beta");
    await page.waitForFunction(() => Math.abs(document.getElementById("weekScroll").scrollTop - 1200) < 1);
    assert.equal(await page.locator("#zoomInput").inputValue(), "4");
    // Expenses retain their independent workspace selection and snapshot baseline too.
    await page.keyboard.press("Control+e");
    assert.equal(await page.locator("#documentWorkspaceName").textContent(), "Alpha");
    await selectWorkspace("Beta");
    await page.locator("#expenseAddBtn").click();
    await page.locator("#expenseAmount").fill("10");
    await page.locator("#expenseDescription").fill("Beta first receipt");
    await page.locator("#expenseForm").evaluate((form) => form.requestSubmit());
    await page.locator("#expenseDialog").waitFor({ state: "hidden" });
    let releaseExpenses;
    const expensesReleased = new Promise((resolve) => { releaseExpenses = resolve; });
    let expenseWriteStarted = false;
    await page.route("**/save", async (route) => { expenseWriteStarted = true; await expensesReleased; await route.continue(); });
    await page.keyboard.press("Control+s");
    for (let attempt = 0; attempt < 100 && !expenseWriteStarted; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(expenseWriteStarted);
    await page.locator("#expenseAddBtn").click();
    await page.locator("#expenseAmount").fill("20");
    await page.locator("#expenseDescription").fill("Beta newer receipt");
    await page.locator("#expenseForm").evaluate((form) => form.requestSubmit());
    await page.locator("#expenseDialog").waitFor({ state: "hidden" });
    releaseExpenses();
    await page.waitForFunction(() => document.getElementById("editorBadge").dataset.state === "dirty");
    await page.unroute("**/save");
    const expensePath = path.join(directories[1], "data/expenses.json");
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 1);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.getElementById("editorBadge").textContent === "Saved");
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 2);
    assert.equal(JSON.parse(await readFile(path.join(directories[0], "data/expenses.json"), "utf8")).expenses.length, 0);
    await page.locator("#expenseList").focus();
    await page.keyboard.press("Control+z");
    await page.locator("#editorBadge").click();
    await page.waitForFunction(() => document.getElementById("editorBadge").textContent === "Saved");
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 1);
    // Switching retains the saved document without duplicating listeners.
    await selectWorkspace("Alpha");
    await selectWorkspace("Beta");
    assert.equal(await page.locator("#documentWorkspaceName").textContent(), "Beta");
    // The taller header must not obscure save feedback.
    assert.ok(await page.evaluate(() => Number(getComputedStyle(document.getElementById("dataError")).zIndex)
        > Number(getComputedStyle(document.getElementById("topbar")).zIndex)));
    await page.locator("#expenseList").focus();
    await page.locator("#dataError").waitFor({ state: "hidden" });
    await page.screenshot({ path: path.join(temporary, "workspace-title-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    // Resize classes update on the next animation frame. Measure the settled layout
    // atomically; sequential reads can straddle that update and hide a real mismatch.
    await page.waitForFunction(() => document.documentElement.classList.contains("ui-toolbar-compact"));
    const compactHeights = await page.evaluate(() => ["editorBadge", "expenseAddBtn"].map(
        (id) => document.getElementById(id).getBoundingClientRect().height,
    ));
    assert.deepEqual(compactHeights, [34, 34]);
    await page.screenshot({ path: path.join(temporary, "multi-workspace-narrow.png"), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1));
    // Exercise real local writes using a virtual clock: edits debounce, navigation does not.
    console.log("Workspace switching and manual-save regressions passed; checking autosave deadlines.");
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    const countdown = () => page.locator(".save-countdown").textContent();
    const addReceipt = async (description) => {
        await page.locator("#expenseAddBtn").click();
        await page.locator("#expenseAmount").fill("10");
        await page.locator("#expenseDescription").fill(description);
        await page.locator("#expenseForm").evaluate((form) => form.requestSubmit());
        await page.locator("#expenseDialog").waitFor({ state: "hidden" });
    };
    const warnsOnExit = () => page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    });
    assert.equal(await warnsOnExit(), false);
    await addReceipt("First idle edit");
    assert.equal(await countdown(), "Autosave in 60s");
    assert.equal(await page.locator(".save-label").textContent(), "Save Changes");
    const labelBox = await page.locator(".save-label").boundingBox();
    const countdownBox = await page.locator(".save-countdown").boundingBox();
    const saveBox = await page.locator("#editorBadge").boundingBox();
    assert.ok(labelBox.y + labelBox.height <= countdownBox.y);
    assert.ok(countdownBox.y + countdownBox.height < saveBox.y + saveBox.height);
    assert.equal(saveBox.height, 34);
    assert.equal(await page.locator(".save-countdown").evaluate((element) => getComputedStyle(element).fontWeight), "400");
    assert.equal(await page.locator("#editorBadge").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(230, 170, 75)");
    await page.screenshot({ path: path.join(temporary, "autosave-pending-narrow.png"), fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    assert.equal(await page.locator("#editorBadge").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(181, 68, 36)");
    assert.equal(await page.locator("#editorBadge").evaluate((element) => getComputedStyle(element).color), "rgb(255, 255, 255)");
    await page.screenshot({ path: path.join(temporary, "autosave-pending-light-narrow.png"), fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    assert.equal(await warnsOnExit(), true);
    await page.clock.fastForward(30000);
    assert.equal(await countdown(), "Autosave in 30s");
    await selectWorkspace("Alpha");
    await selectWorkspace("Beta");
    assert.equal(await countdown(), "Autosave in 30s");
    await addReceipt("Reset idle countdown");
    assert.equal(await countdown(), "Autosave in 60s");
    await page.clock.fastForward(59000);
    assert.equal(await countdown(), "Autosave in 1s");
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 1);
    await page.clock.fastForward(1000);
    console.log("Idle deadline reached; waiting for the automatic write.");
    await page.locator('#editorBadge[data-state="saved"]').waitFor();
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 3);
    assert.equal(await warnsOnExit(), false);
    // A newer edit during autosave keeps its own deadline after the older snapshot completes.
    console.log("Idle autosave passed; checking edits during an automatic write.");
    let releaseAuto;
    const autoReleased = new Promise((resolve) => { releaseAuto = resolve; });
    let autoWrites = 0;
    await page.route("**/save", async (route) => { autoWrites++; await autoReleased; await route.continue(); });
    await addReceipt("Captured by autosave");
    await page.clock.fastForward(60000);
    for (let attempt = 0; attempt < 100 && !autoWrites; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(autoWrites, 1);
    assert.equal(await warnsOnExit(), true);
    await page.clock.fastForward(20000);
    await addReceipt("Newer than autosave");
    await page.clock.fastForward(10000);
    releaseAuto();
    await page.locator('#editorBadge[data-state="dirty"]').waitFor();
    await page.unroute("**/save");
    assert.equal(await countdown(), "Autosave in 50s");
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 4);
    await page.clock.fastForward(50000);
    await page.locator('#editorBadge[data-state="saved"]').waitFor();
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 5);
    // Fail once, retain the edit and warning, then retry after 60 seconds without further editing.
    let failures = 0;
    await page.route("**/save", (route) => { failures++; return route.fulfill({ status: 500, body: "Transient failure" }); });
    await page.locator("#expenseList").focus();
    await page.keyboard.press("Control+z");
    assert.equal(await countdown(), "Autosave in 60s");
    await page.clock.fastForward(60000);
    await page.locator('#editorBadge[data-state="failed"]').waitFor();
    assert.match(await page.locator("#editorBadge").getAttribute("title"), /Beta/);
    assert.equal(await countdown(), "Retry in 60s");
    assert.equal(await warnsOnExit(), true);
    await page.clock.fastForward(59000);
    assert.equal(failures, 1);
    await page.unroute("**/save");
    await page.clock.fastForward(1000);
    await page.locator('#editorBadge[data-state="saved"]').waitFor();
    assert.equal(JSON.parse(await readFile(expensePath, "utf8")).expenses.length, 4);
    // Reduced-motion users retain the amber pending state without animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await addReceipt("Reduced motion");
    assert.equal(await page.locator("#editorBadge").evaluate((element) => getComputedStyle(element).animationName), "none");
    await page.locator("#editorBadge").click();
    await page.locator('#editorBadge[data-state="saved"]').waitFor();
    let emptyWrites = 0;
    await page.route("**/save", (route) => { emptyWrites++; return route.continue(); });
    await page.clock.fastForward(120000);
    assert.equal(emptyWrites, 0);
    assert.equal(await warnsOnExit(), false);
    assert.deepEqual(errors, []);
    // Expense-only repositories must retain a visible, tappable title picker on phones.
    // Mutate only these disposable fixtures after the full-module scenarios finish.
    for (const directory of directories) {
        const file = path.join(directory, "zeitberg.json");
        const raw = JSON.parse(await readFile(file, "utf8"));
        raw.components = Object.fromEntries(Object.entries(raw.components).filter(([, component]) => component.type === "expenses"));
        await writeFile(file, JSON.stringify(raw));
    }
    const phone = await browser.newPage({ ...devices["iPhone 16 Pro"], locale: "de-DE" });
    phone.on("pageerror", (error) => errors.push(error.message));
    await phone.goto(`http://127.0.0.1:${port}/expenses?source=local&workspace=alpha`);
    await phone.locator('#documentWorkspaces option', { hasText: "Beta" }).waitFor({ state: "attached" });
    const picker = phone.locator("#documentWorkspaces");
    await picker.waitFor({ state: "visible" });
    assert.equal(await picker.evaluate((element) => getComputedStyle(element).opacity), "1");
    assert.equal(await picker.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
    }), true, "The workspace title is directly tappable");
    await picker.tap();
    await picker.selectOption({ label: "Beta" });
    await phone.waitForURL(/workspace=beta/);
    assert.equal(await phone.locator("#documentWorkspaceName").textContent(), "Beta");
    const betaId = await picker.inputValue();
    await phone.screenshot({ path: path.join(temporary, "iphone-expense-workspaces.png") });
    await picker.selectOption({ label: "Alpha" });
    await phone.waitForURL(/workspace=alpha/);
    await phone.locator("#workspaceSettingsBtn").tap();
    const betaRow = phone.locator(".workspace-row", { hasText: "Beta" });
    await betaRow.locator('[data-workspace-action="edit"]').tap();
    await phone.locator("#workspaceEditDialog[open]").waitFor();
    assert.equal(await phone.locator("#workspaceConfigName").inputValue(), "Beta");
    await phone.locator("#workspaceConfigName").fill("Canceled mobile edit");
    await phone.locator("#workspaceEditCancelBtn").tap();
    assert.equal(await phone.locator("#workspaceDialog").isVisible(), true);
    await phone.locator(".workspace-row", { hasText: "Beta" }).locator('[data-workspace-action="edit"]').tap();
    assert.equal(await phone.locator("#workspaceConfigName").inputValue(), "Beta");
    await phone.locator("#workspaceConfigName").fill("Beta updated");
    await phone.route("**/save", (route) => route.fulfill({ status: 503, body: "Configuration save unavailable" }));
    await phone.locator("#workspaceConfigSaveBtn").tap();
    await phone.locator("#workspaceConfigError:not([hidden])").waitFor();
    assert.equal(await phone.locator("#workspaceEditDialog").isVisible(), true);
    await phone.unroute("**/save");
    await phone.locator("#workspaceConfigSaveBtn").tap();
    await phone.locator("#workspaceEditDialog").waitFor({ state: "hidden" });
    await phone.waitForFunction(() => document.getElementById("documentWorkspaceName").textContent === "Beta updated");
    assert.equal(JSON.parse(await readFile(path.join(directories[1], "zeitberg.json"), "utf8")).name, "Beta updated");
    // Simulate a secondary repository that failed hydration: its picker option must not vanish.
    let failedHydration = false;
    await phone.route("**/workspace-config?*", (route) => {
        if (new URL(route.request().url()).searchParams.get("workspace") !== "beta") return route.continue();
        failedHydration = true;
        return route.fulfill({ status: 503, body: "Unavailable fixture" });
    });
    await phone.goto(`http://127.0.0.1:${port}/expenses?source=local&workspace=alpha`);
    await phone.locator('#documentWorkspaces option', { hasText: "Beta" }).waitFor({ state: "attached" });
    await phone.waitForFunction(() => document.getElementById("workspaceAvailability").title.includes("503"));
    assert.equal(failedHydration, true);
    assert.equal(await picker.isVisible(), true);
    await phone.unroute("**/workspace-config?*");
    await picker.selectOption(betaId);
    await phone.waitForURL(/workspace=beta/);
    assert.equal(await phone.locator("#documentWorkspaceName").textContent(), "Beta updated");
    await phone.close();
    assert.deepEqual(errors, []);
    console.log(`Multi-workspace browser tests passed: ${temporary}`);
} finally {
    await browser?.close();
    server.kill("SIGTERM");
}
