import assert from "node:assert/strict";
import test from "node:test";

import { Recurrence, Todo, TodoList } from "../model.js";
import { EntryStore, TodoStore } from "../store.js";
import { TimeContext } from "../utils.js";

const timeContext = new TimeContext("Europe/Berlin");

/**
 * Creates the smallest valid raw TODO used by store-level recurrence tests.
 * @param {Object} overrides
 * @returns {import("../model.js").TodoRaw}
 */
function makeTodo(overrides = {}) {
    return {
        id: "test:todo",
        content: "Recurring test",
        description: "",
        project_key: null,
        section_key: null,
        parent_id: null,
        labels: [],
        priority: 1,
        due: null,
        recurrence: null,
        completion_history: [],
        deadline: null,
        completed_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        archived: false,
        order: 1,
        source: null,
        ...overrides,
    };
}

test("all recurrence phrases currently imported from Todoist normalize", () => {
    const cases = [
        ["every 2 month", "2026-08-21", "monthly", 2],
        ["every 3 days", "2026-07-15", "daily", 3],
        ["every 3 months", "2026-08-28", "monthly", 3],
        ["every Monday", "2026-07-27", "weekly", 1],
        ["every day", "2026-07-08", "daily", 1],
        ["every friday", "2026-02-10", "weekly", 1],
        ["every month", "2026-02-11", "monthly", 1],
        ["every tuesday at 6 am", "2026-07-28T06:00:00", "weekly", 1],
        ["every year", "2026-08-15", "yearly", 1],
    ];

    for (const [text, anchor, frequency, interval] of cases) {
        const recurrence = Recurrence.fromText(text, anchor);
        assert.ok(recurrence, text);
        assert.equal(recurrence.isSupported(), true, text);
        assert.equal(recurrence.frequency, frequency, text);
        assert.equal(recurrence.interval, interval, text);
    }
});

test("German recurrence phrases normalize into language-neutral schedule fields", () => {
    const cases = [
        ["täglich", "daily", 1, "scheduled", []],
        ["jeden Freitag", "weekly", 1, "scheduled", [5]],
        ["jeden Dienstag um 06:00", "weekly", 1, "scheduled", [2]],
        ["jede Woche", "weekly", 1, "scheduled", [3]],
        ["jeden Monat", "monthly", 1, "scheduled", []],
        ["jedes Jahr", "yearly", 1, "scheduled", []],
        ["alle 3 Tage", "daily", 3, "scheduled", []],
        ["alle 2 Wochen nach Abschluss", "weekly", 2, "after_completion", [3]],
        ["jeden Monat nach Abschluss", "monthly", 1, "after_completion", []],
    ];

    for (const [text, frequency, interval, basis, weekdays] of cases) {
        const recurrence = Recurrence.fromText(text, "2026-08-19");
        assert.ok(recurrence, text);
        assert.equal(recurrence.frequency, frequency, text);
        assert.equal(recurrence.interval, interval, text);
        assert.equal(recurrence.basis, basis, text);
        assert.deepEqual(recurrence.weekdays, weekdays, text);
        assert.equal(recurrence.source_text, text, text);
    }
});

test("legacy Todoist due metadata normalizes into the schema v3 recurrence fields", () => {
    const todo = new Todo(
        makeTodo({
            due: {
                date: "2026-07-27",
                is_recurring: true,
                string: "every Monday",
                lang: "en",
                timezone: null,
            },
        }),
    );
    const raw = todo.toRaw();

    assert.equal(todo.recurrence?.frequency, "weekly");
    assert.deepEqual(raw.due, { date: "2026-07-27", timezone: null });
    assert.equal("is_recurring" in raw.due, false);
    assert.equal(raw.recurrence?.source_text, "every Monday");
    assert.equal(TodoList.fromRaw({ schema_version: 3, todos: [raw] }).schema_version, 3);
});

test("scheduled recurrence skips overdue occurrences to the first future date", () => {
    const daily = Recurrence.fromText("every day", "2026-07-08");
    const friday = Recurrence.fromText("every friday", "2026-02-10");

    assert.deepEqual(
        daily?.nextDue({ date: "2026-07-08", timezone: null }, "2026-07-24T10:00:00Z", timeContext),
        { date: "2026-07-25", timezone: null },
    );
    assert.deepEqual(
        friday?.nextDue({ date: "2026-02-10", timezone: null }, "2026-07-24T10:00:00Z", timeContext),
        { date: "2026-07-31", timezone: null },
    );
});

test("timed recurrence compares local wall time and preserves its time", () => {
    const recurrence = Recurrence.fromText("every Tuesday at 6 am", "2026-07-21T06:00:00");
    const due = { date: "2026-07-21T06:00:00", timezone: "Europe/Berlin" };

    assert.deepEqual(recurrence?.nextDue(due, "2026-07-28T03:00:00Z", timeContext), {
        date: "2026-07-28T06:00:00",
        timezone: "Europe/Berlin",
    });
    assert.deepEqual(recurrence?.nextDue(due, "2026-07-28T05:00:00Z", timeContext), {
        date: "2026-08-04T06:00:00",
        timezone: "Europe/Berlin",
    });
});

test("monthly and yearly rules retain their preferred calendar day after clamping", () => {
    const monthly = Recurrence.fromText("every month", "2026-01-31");
    const yearly = Recurrence.fromText("every year", "2024-02-29");

    const february = monthly?.nextDue(
        { date: "2026-01-31", timezone: null },
        "2026-01-31T12:00:00Z",
        timeContext,
    );
    assert.deepEqual(february, { date: "2026-02-28", timezone: null });
    assert.deepEqual(monthly?.nextDue(february, "2026-02-28T12:00:00Z", timeContext), {
        date: "2026-03-31",
        timezone: null,
    });

    assert.equal(yearly?.advanceScheduledDate("2024-02-29"), "2025-02-28");
    assert.equal(yearly?.advanceScheduledDate("2027-02-28"), "2028-02-29");
});

test("completion-relative recurrence advances once from the completion date", () => {
    const recurrence = Recurrence.fromText("every! 2 weeks", "2026-01-01");

    assert.equal(recurrence?.basis, "after_completion");
    assert.deepEqual(
        recurrence?.nextDue({ date: "2026-01-01", timezone: null }, "2026-07-24T10:00:00Z", timeContext),
        { date: "2026-08-07", timezone: null },
    );
});

test("TodoStore logs a recurring occurrence and keeps the series open", () => {
    const entryStore = new EntryStore(timeContext);
    const todoStore = new TodoStore(entryStore);
    const recurrence = Recurrence.fromText("every day", "2026-07-08");
    todoStore.setTodoList(
        TodoList.fromRaw({
            schema_version: 3,
            todos: [
                makeTodo({
                    due: { date: "2026-07-08", timezone: null },
                    recurrence: recurrence?.toRaw() || null,
                }),
            ],
        }),
    );
    const before = todoStore.snapshotRaw();

    const completed = todoStore.toggleTodoCompleted("test:todo", "2026-07-24T10:00:00Z");
    assert.equal(completed.isCompleted(), false);
    assert.equal(completed.due?.date, "2026-07-25");
    assert.deepEqual(completed.completion_history, [
        {
            completed_at: "2026-07-24T10:00:00Z",
            scheduled_for: "2026-07-08",
        },
    ]);

    todoStore.applySnapshot(before);
    const restored = todoStore.getTodoById("test:todo");
    assert.equal(restored?.due?.date, "2026-07-08");
    assert.deepEqual(restored?.completion_history, []);
});

test("one-off completion remains a reversible completed timestamp", () => {
    const entryStore = new EntryStore(timeContext);
    const todoStore = new TodoStore(entryStore);
    todoStore.setTodoList(TodoList.fromRaw({ schema_version: 3, todos: [makeTodo({ id: "test:one-off" })] }));

    assert.equal(todoStore.toggleTodoCompleted("test:one-off", "2026-07-24T10:00:00Z").completed_at, "2026-07-24T10:00:00Z");
    assert.equal(todoStore.toggleTodoCompleted("test:one-off", "2026-07-24T11:00:00Z").completed_at, null);
});
