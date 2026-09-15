import assert from "node:assert/strict";
import test from "node:test";
import { DemoDataSource, DemoRandom, MemoryStorage, createDemoFiles, newDemoSeed } from "../demo.js";
import { ConfigService } from "../config.js";
import { ChunkCache, DraftJournal, RemoteCache } from "../cache.js";
import { Workspace, TodoList, ExpenseDocument, ExpenseManifest, Manifest } from "../model.js";
import { addIsoDays, gitBlobSha1, isoWeekdayIndex, TimeContext } from "../utils.js";
import { WorkTimeConfig } from "../work-time.js";
import { formatBuildLabel, showBuildInfo } from "../version.js";

test("demo fixtures are deterministic, fictional and canonical for all modules", async () => {
    const now = new Date("2026-09-15T12:00:00Z");
    assert.deepEqual(createDemoFiles(now, "docs-v1"), createDemoFiles(now, "docs-v1"));
    const source = new DemoDataSource(undefined, now, "docs-v1");
    source.setWorkspace(Workspace.fromRaw(await source.fetchWorkspace()));
    assert.equal(source.getWorkspace().name, "Alex’s playground");
    assert.equal(await source.repositoryFileExists("missing.json"), false);
    assert.equal(await source.repositoryFileExists("zeitberg.json"), true);
    const manifest = Manifest.fromRaw(await source.fetchManifest());
    const chunks = (await source.fetchManifest()).chunks;
    assert.equal(chunks.length, 5);
    for (const chunk of chunks) {
        const raw = await source.fetchChunkText(chunk);
        assert.equal(gitBlobSha1(raw), chunk.sha);
        assert.ok(JSON.parse(raw).entries.length > 0);
    }
    assert.ok(manifest);
    assert.ok(TodoList.fromRaw(await source.fetchTodos()));
    assert.ok(ExpenseDocument.fromRaw(JSON.parse(await source.fetchExpensesText())).expenses.length >= 25);
    assert.ok(ExpenseManifest.fromRaw(await source.fetchExpensesManifest()));
    assert.equal((await source.fetchProjects()).projects.length, 6);
    assert.equal((await source.fetchWeekRequirements()).schema_version, 3);
    assert.throws(() => source.read("unknown"), /Missing demo/);
    const original = await source.fetchTodos();
    const updated = { ...original, todos: [] };
    const result = await source.saveFiles([{ path: source.getTodosPath(), content: JSON.stringify(updated) }], "Example save");
    assert.equal(result.files[0].sha, gitBlobSha1(JSON.stringify(updated)));
    assert.equal((await source.fetchTodos()).todos.length, 0);
    assert.equal(new DemoDataSource(undefined, now, "docs-v1").read(source.getTodosPath()).todos.length, original.todos.length);
    await source.saveFiles([{ path: "data/entries/2027/01.json", content: "{}" }], "New week");
    await assert.rejects(source.saveFiles([{ path: "data/todos.json", content: "{}" }, { path: "elsewhere", content: "{}" }], "Invalid"), /Invalid demo/);
    assert.equal((await source.fetchTodos()).schema_version, original.schema_version);
    await assert.rejects(source.saveFiles([{ path: source.getTodosPath(), content: "broken" }], "Invalid"));
});

/** @param {Map<string, string>} files Fictional repository. @returns {Object[]} Chronologically sorted entries. */
function timeEntries(files) {
    const manifest = JSON.parse(files.get("data/index/entries-manifest.json"));
    return manifest.chunks.flatMap((chunk) => JSON.parse(files.get(chunk.path)).entries).sort((a, b) => a.start.localeCompare(b.start));
}

test("visit seeds are fresh; fixed seeds and date-scoped streams remain reproducible", () => {
    assert.notEqual(newDemoSeed(), newDemoSeed());
    const now = new Date("2026-09-15T12:00:00Z");
    assert.notDeepEqual(timeEntries(createDemoFiles(now)), timeEntries(createDemoFiles(now)));
    const first = new DemoRandom("example");
    const second = new DemoRandom("example");
    for (let i = 0; i < 100; i++) {
        const value = first.next();
        assert.equal(value, second.next());
        assert.ok(value >= 0 && value < 1);
        const integer = first.integer(1, 6);
        assert.equal(integer, second.integer(1, 6));
        assert.ok(integer >= 1 && integer <= 6);
    }
    const stream = first.fork("entries:2026-09-01");
    first.next();
    assert.equal(stream.next(), first.fork("entries:2026-09-01").next());
    assert.notEqual(first.fork("entries:2026-09-01").next(), first.fork("entries:2026-09-02").next());
    const previous = timeEntries(createDemoFiles(now, "stable"));
    const next = timeEntries(createDemoFiles(new Date("2026-09-16T12:00:00Z"), "stable"));
    const day = (entry) => entry.start.startsWith("2026-09-10");
    assert.deepEqual(previous.filter(day), next.filter(day));
});

test("four-week histories stay valid through weekends, leave, DST and year boundaries", () => {
    const clock = new TimeContext("Europe/Berlin");
    for (const instant of ["2026-09-15T12:07:00Z", "2026-01-05T20:00:00Z", "2026-04-01T20:00:00Z", "2026-11-01T20:00:00Z", "2026-09-15T00:03:00Z"]) {
        for (const seed of ["docs-v1", "summer", "winter", "try-again"]) {
            const now = new Date(instant);
            const today = clock.formatDate(now);
            const earliest = addIsoDays(today, -27);
            const files = createDemoFiles(now, seed);
            const rows = timeEntries(files);
            const requirements = new WorkTimeConfig(JSON.parse(files.get("data/week-requirements.json")));
            const employer = requirements.employers[0];
            const leaveByDate = new Map(employer.days.map((day) => [day.date, day.halves]));
            assert.ok(rows.length > 100);
            assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
            assert.equal(clock.formatDate(new Date(rows[0].start)), earliest);
            let previousEnd = -Infinity;
            for (const row of rows) {
                const start = Date.parse(row.start);
                const end = Date.parse(row.end);
                const day = clock.formatDate(new Date(start));
                assert.ok(day >= earliest && day <= today);
                assert.ok(start >= previousEnd, `Overlap: ${seed} / ${row.description}`);
                assert.ok(end <= now.getTime());
                assert.ok(end - start >= 900000);
                assert.equal(row.duration_seconds, (end - start) / 1000);
                assert.equal(start % 900000, 0);
                assert.equal(end % 900000, 0);
                if (isoWeekdayIndex(day) >= 5 || leaveByDate.get(day)?.every((half) => half !== "work")) assert.equal(row.billable, false);
                previousEnd = end;
            }
            for (const day of employer.days) {
                assert.ok(isoWeekdayIndex(day.date) < 5, "Weekend must not consume PTO");
                if (day.date > today) assert.ok(!day.halves.includes("sick"), "Do not predict sickness");
                const worked = rows.filter((row) => row.billable && clock.formatDate(new Date(row.start)) === day.date).reduce((sum, row) => sum + row.duration_seconds, 0);
                if (day.halves.includes("work")) assert.ok(worked <= 4 * 3600);
                else assert.equal(worked, 0);
            }
            for (const year of [earliest.slice(0, 4), today.slice(0, 4), addIsoDays(today, 14).slice(0, 4)]) assert.equal(employer.vacation_allowances[year], 30);
        }
    }
});

test("sample mixes demonstrate varied durations, PTO, task states and exact shared costs", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const files = createDemoFiles(now, "docs-v1");
    const rows = timeEntries(files);
    assert.ok(new Set(rows.map((row) => row.description)).size >= 25);
    assert.ok(new Set(rows.map((row) => row.duration_seconds)).size >= 6);
    const leave = JSON.parse(files.get("data/week-requirements.json")).employers[0].days;
    assert.ok(leave.some((day) => day.halves.every((half) => half === "pto")));
    assert.ok(leave.some((day) => day.halves.includes("pto") && day.halves.includes("work")));
    assert.ok(leave.some((day) => day.date > "2026-09-15" && day.halves.includes("pto")));
    const tasks = JSON.parse(files.get("data/todos.json")).todos;
    assert.ok(tasks.length >= 30);
    assert.ok(tasks.some((task) => task.completed_at));
    assert.ok(tasks.some((task) => task.recurrence));
    assert.ok(tasks.some((task) => !task.due));
    assert.ok(tasks.some((task) => task.due?.date < "2026-09-15" && !task.completed_at));
    assert.ok(tasks.some((task) => task.due?.date > "2026-09-15"));
    const expenses = ExpenseDocument.fromRaw(JSON.parse(files.get("data/expenses.json"))).toObject().expenses;
    assert.ok(expenses.some((expense) => expense.payers.length > 1));
    assert.ok(expenses.some((expense) => expense.allocation_rule.type === "shares"));
    assert.ok(expenses.some((expense) => expense.allocation_rule.type === "equal"));
    for (const expense of expenses) {
        assert.equal(expense.payers.reduce((sum, payer) => sum + payer.amount_minor, 0), expense.amount_minor);
        assert.equal(expense.allocations.reduce((sum, line) => sum + line.amount_minor, 0), expense.amount_minor);
    }
});

test("disposable settings and caches never open real browser storage", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const config = new ConfigService({ local, session });
    config.saveLocale("de");
    assert.equal(config.loadLocale(), "de");
    config.saveToken("fictional", true);
    assert.equal(config.loadToken(), "fictional");
    config.saveToken("session", false);
    assert.equal(config.loadToken(), "session");
    assert.ok(local.length);
    assert.equal(local.key(0), "zeitberg:locale:v1");
    assert.equal(local.key(100), null);
    local.clear();
    assert.equal(local.length, 0);
    globalThis.indexedDB = { open() { throw new Error("Persistent access"); }, deleteDatabase() { throw new Error("Persistent deletion"); } };
    try {
        for (const cache of [new ChunkCache(false), new RemoteCache(false), new DraftJournal(false)]) {
            assert.equal(await cache.openDb(), null);
            if (cache.clearAll) cache.clearAll();
        }
    } finally { delete globalThis.indexedDB; }
});

test("build label uses the served revision, with honest unbuilt/dirty states", () => {
    assert.equal(formatBuildLabel({ version: "1.3.0", commit: "a".repeat(40), dirty: false }), "v1.3.0 · aaaaaaaa");
    assert.match(formatBuildLabel({ version: "1.3.0-dev", commit: "bad", dirty: true }), /unbuilt.*local changes/);
    const element = { removeAttribute(name) { assert.equal(name, "href"); } };
    showBuildInfo(element);
    assert.match(element.textContent, /unbuilt/);
});
