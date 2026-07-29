import assert from "node:assert/strict";
import test from "node:test";

import {
    buildCompletedWindows,
    mapTask,
    preserveLocalCompletionHistory,
} from "../scripts/import-todoist.mjs";

test("completed-history windows are contiguous and remain below the API range limit", () => {
    const until = new Date("2026-07-28T12:34:56.000Z");
    const windows = buildCompletedWindows("2025-01-01", until);

    assert.ok(windows.length > 1);
    assert.equal(windows[0].since, "2025-01-01T00:00:00.000Z");
    assert.equal(windows.at(-1)?.until, until.toISOString());
    for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index];
        const durationDays =
            (new Date(window.until).getTime() - new Date(window.since).getTime()) /
            (24 * 60 * 60 * 1000);
        assert.ok(durationDays > 0 && durationDays <= 89);
        if (index > 0) assert.equal(windows[index - 1].until, window.since);
    }
});

test("completed-history windows reject impossible calendar dates", () => {
    assert.throws(
        () => buildCompletedWindows("2026-02-30", new Date("2026-07-28T00:00:00Z")),
        /Invalid completed-history start date/,
    );
});

test("active and completed occurrences receive distinct stable local identifiers", () => {
    const projectNames = new Map([["project-1", "Personal"]]);
    const sectionNames = new Map([["section-1", "Someday"]]);
    const raw = {
        id: "task-1",
        content: "Remember this",
        description: "",
        project_id: "project-1",
        section_id: "section-1",
        parent_id: "parent-1",
        labels: ["nostalgia"],
        priority: 2,
        child_order: 3,
        due: null,
        added_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
    };

    const active = mapTask(raw, projectNames, sectionNames);
    const completed = mapTask(
        { ...raw, completed_at: "2025-02-03T04:05:06Z" },
        projectNames,
        sectionNames,
        { historical: true },
    );

    assert.equal(active?.id, "todoist:task-1");
    assert.equal(active?.completed_at, null);
    assert.equal(active?.parent_id, "todoist:parent-1");
    assert.equal(completed?.id, "todoist-completed:task-1:2025-02-03T04:05:06Z");
    assert.equal(completed?.completed_at, "2025-02-03T04:05:06Z");
    assert.equal(
        completed?.parent_id,
        "todoist-completed:parent-1:2025-02-03T04:05:06Z",
    );
});

test("refreshing active Todoist tasks retains local recurring completion history", () => {
    const imported = [
        {
            id: "todoist:task-1",
            content: "Recurring task",
            completion_history: [],
        },
    ];
    const prior = [
        {
            id: "todoist:task-1",
            content: "Recurring task",
            completion_history: [
                {
                    completed_at: "2026-07-20T08:00:00Z",
                    scheduled_for: "2026-07-20",
                },
            ],
        },
    ];

    const refreshed = preserveLocalCompletionHistory(imported, prior);

    assert.deepEqual(refreshed[0].completion_history, prior[0].completion_history);
    assert.notEqual(refreshed[0].completion_history, prior[0].completion_history);
});
