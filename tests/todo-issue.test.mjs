import assert from "node:assert/strict";
import test from "node:test";

import { ProjectList, Todo, TodoList } from "../model.js";
import { EntryStore, TodoStore } from "../store.js";
import { buildTodoIssueBody, buildTodoIssueWrite, isTodoIssuePublishable, TodoView } from "../todo.view.js";
import { TimeContext } from "../utils.js";

/**
 * Creates a normalized TODO model for issue serialization tests.
 * @param {Partial<import("../model.js").TodoRaw>} [overrides]
 * @returns {Todo}
 */
function makeTodo(overrides = {}) {
    return new Todo({
        archived: false,
        completed_at: null,
        completion_history: [],
        content: "Restore application route",
        created_at: "2026-08-15T09:00:00Z",
        deadline: null,
        description: "Persist the active component and selection.",
        due: null,
        id: "local:test-route",
        labels: ["area/platform", "area/platform"],
        order: 1,
        parent_id: null,
        priority: 1,
        project_key: "app",
        recurrence: null,
        section_key: "features",
        source: null,
        updated_at: "2026-08-15T09:00:00Z",
        ...overrides,
    });
}

test("issue serialization keeps readable task details and a stable reconciliation marker", () => {
    const todo = makeTodo();
    const body = buildTodoIssueBody(todo);
    const write = buildTodoIssueWrite(todo, "type/feature");

    assert.match(body, /^Persist the active component/);
    assert.match(body, /planplural-todo-id: local:test-route/);
    assert.deepEqual(write, {
        title: "Restore application route",
        body,
        labels: ["type/feature", "area/platform"],
        state: "open",
    });
});

test("completed planplural tasks map to closed issues and retain their historical timestamp", () => {
    const todo = makeTodo({ completed_at: "2026-08-15T10:00:00Z" });
    const write = buildTodoIssueWrite(todo, "type/feature");

    assert.equal(write.state, "closed");
    assert.match(write.body, /Originally completed in planplural on 2026-08-15T10:00:00Z/);
});

test("provider-specific legacy tasks remain private instead of becoming public issues", () => {
    assert.equal(isTodoIssuePublishable(makeTodo({ content: "Replace Todoist import" })), false);
    assert.equal(isTodoIssuePublishable(makeTodo({ description: "Retire the old Toggl pipeline." })), false);
    assert.equal(isTodoIssuePublishable(makeTodo({ content: "Improve TODO toggles" })), true);
});

test("issue synchronization journals an assigned issue number and retries without duplication", async () => {
    const projectStore = new EntryStore(new TimeContext("Europe/Berlin"));
    projectStore.setProjectList(ProjectList.fromRaw({
        generated_at: "",
        schema_version: 2,
        projects: [
            {
                archived: false,
                billable: false,
                color: "#ee6a3b",
                external_refs: [{ provider: "github", id: "owner/planplural" }],
                key: "app",
                name: "App",
                sections: [
                    {
                        archived: false,
                        billable: null,
                        color: null,
                        external_refs: [{ provider: "github-label", id: "type/feature" }],
                        key: "features",
                        name: "Features",
                    },
                ],
            },
        ],
    }));
    const todoStore = new TodoStore(projectStore);
    const raw = makeTodo().toRaw();
    todoStore.setTodoList(TodoList.fromRaw({ generated_at: "", schema_version: 3, todos: [raw] }));

    const creates = [];
    const updates = [];
    let draftWrites = 0;
    const view = Object.create(TodoView.prototype);
    view.store = todoStore;
    view.projectStore = projectStore;
    view.cleanSnapshot = [];
    view.dataSource = {
        supportsGitHubIssueSync: () => true,
        createGitHubIssue: async (repository, issue) => {
            creates.push({ repository, issue });
            return { number: 23 };
        },
        updateGitHubIssue: async (repository, issueNumber, issue) => {
            updates.push({ repository, issueNumber, issue });
            return { number: issueNumber };
        },
    };
    view.queueDraftWrite = () => {
        draftWrites += 1;
    };

    await view.synchronizeGitHubIssues();
    assert.equal(creates.length, 1);
    assert.equal(updates.length, 0);
    assert.equal(draftWrites, 1);
    assert.deepEqual(todoStore.getTodoById(raw.id)?.source, {
        provider: "github",
        id: "23",
        project_id: "owner/planplural",
        section_id: "type/feature",
    });

    await view.synchronizeGitHubIssues();
    assert.equal(creates.length, 1, "a failed workspace save must not create a second issue");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].issueNumber, 23);
});
