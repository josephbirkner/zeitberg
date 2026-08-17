import assert from "node:assert/strict";
import test from "node:test";

import { ProjectList, Todo, TodoList } from "../model.js";
import { EntryStore, TodoStore } from "../store.js";
import { ProviderApiError } from "../datasource.js";
import {
    buildTodoIssueBody,
    buildTodoIssueWrite,
    descriptionFromGitHubIssueBody,
    githubIssueMatchesWrite,
    isTodoIssuePublishable,
    normalizeGitHubIssueBase,
    todoRawFromGitHubIssue,
    TodoView,
    zeitbergTodoIdFromGitHubIssueBody,
} from "../todo.view.js";
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

/**
 * Creates the shared project inventory used by issue mapping and migration tests.
 * @param {string} [repository]
 * @param {string} [sectionLabel]
 * @returns {EntryStore}
 */
function makeProjectStore(repository = "owner/zeitberg", sectionLabel = "type/feature") {
    const projectStore = new EntryStore(new TimeContext("Europe/Berlin"));
    projectStore.setProjectList(ProjectList.fromRaw({
        generated_at: "",
        schema_version: 2,
        projects: [
            {
                archived: false,
                billable: false,
                color: "#ee6a3b",
                external_refs: repository ? [{ provider: "github", id: repository }] : [],
                key: "app",
                name: "App",
                sections: [
                    {
                        archived: false,
                        billable: null,
                        color: null,
                        external_refs: repository && sectionLabel ? [{ provider: "github-label", id: sectionLabel }] : [],
                        key: "features",
                        name: "Features",
                    },
                ],
            },
        ],
    }));
    return projectStore;
}

test("issue serialization keeps readable task details and a stable reconciliation marker", () => {
    const todo = makeTodo();
    const body = buildTodoIssueBody(todo);
    const write = buildTodoIssueWrite(todo, "type/feature");

    assert.match(body, /^Persist the active component/);
    assert.match(body, /zeitberg-todo-id: local:test-route/);
    assert.deepEqual(write, {
        title: "Restore application route",
        body,
        labels: ["type/feature", "area/platform"],
        state: "open",
    });
});

test("completed zeitberg tasks map to closed issues and retain their historical timestamp", () => {
    const todo = makeTodo({ completed_at: "2026-08-15T10:00:00Z" });
    const write = buildTodoIssueWrite(todo, "type/feature");

    assert.equal(write.state, "closed");
    assert.match(write.body, /Originally completed in zeitberg on 2026-08-15T10:00:00Z/);
});

test("provider-specific legacy tasks remain private instead of becoming public issues", () => {
    assert.equal(isTodoIssuePublishable(makeTodo({ content: "Replace Todoist import" })), false);
    assert.equal(isTodoIssuePublishable(makeTodo({ description: "Retire the old Toggl pipeline." })), false);
    assert.equal(isTodoIssuePublishable(makeTodo({ content: "Improve TODO toggles" })), true);
});

test("GitHub issues map section and ordinary labels without retaining generated body metadata", () => {
    const projectStore = makeProjectStore();
    const project = projectStore.getProjects()[0];
    const sourceTodo = makeTodo();
    const issue = {
        number: 41,
        title: "External issue title",
        body: buildTodoIssueBody(sourceTodo),
        labels: [{ name: "area/platform" }, { name: "type/feature" }],
        state: "closed",
        created_at: "2026-08-15T09:00:00Z",
        updated_at: "2026-08-16T11:00:00Z",
        closed_at: "2026-08-16T10:55:00Z",
    };

    const raw = todoRawFromGitHubIssue(issue, project, "owner/zeitberg");
    assert.equal(raw.id, "github:owner/zeitberg#41");
    assert.equal(raw.content, "External issue title");
    assert.equal(raw.description, sourceTodo.description);
    assert.equal(raw.project_key, "app");
    assert.equal(raw.section_key, "features");
    assert.deepEqual(raw.labels, ["area/platform"]);
    assert.equal(raw.completed_at, issue.closed_at);
    assert.deepEqual(raw.source, {
        provider: "github",
        id: "41",
        project_id: "owner/zeitberg",
        section_id: "type/feature",
    });
    assert.equal(descriptionFromGitHubIssueBody("Ordinary body\n<!-- unrelated -->"), "Ordinary body\n<!-- unrelated -->");
    assert.equal(zeitbergTodoIdFromGitHubIssueBody(issue.body), sourceTodo.id);
});

test("GitHub issue equality ignores label order but retains conflict timestamps", () => {
    const issue = {
        title: "A task",
        body: "Details",
        labels: [{ name: "area/tasks" }, { name: "type/feature" }],
        state: "open",
        updated_at: "2026-08-16T12:00:00Z",
    };
    assert.equal(
        githubIssueMatchesWrite(issue, {
            title: "A task",
            body: "Details",
            labels: ["type/feature", "area/tasks"],
            state: "open",
        }),
        true,
    );
    assert.equal(normalizeGitHubIssueBase(issue).updatedAt, "2026-08-16T12:00:00Z");
});

test("loaded GitHub tasks serialize only compact local overlays", () => {
    const projectStore = makeProjectStore();
    const todoStore = new TodoStore(projectStore);
    const legacy = makeTodo({
        id: "legacy:issue-41",
        content: "Stale mirrored title",
        due: { date: "2026-08-20", is_recurring: false, lang: "en", string: "2026-08-20", timezone: null },
        priority: 3,
        source: { provider: "github", id: "41", project_id: "owner/zeitberg", section_id: "type/feature" },
    }).toRaw();
    const local = makeTodo({ id: "local:kept", content: "Local workspace task", source: null }).toRaw();
    todoStore.setTodoList(TodoList.fromRaw({ generated_at: "", schema_version: 3, todos: [legacy, local] }));

    const issue = {
        number: 41,
        title: "Fresh upstream title",
        body: "Fresh upstream description",
        labels: [{ name: "type/feature" }],
        state: "open",
        created_at: "2026-08-15T09:00:00Z",
        updated_at: "2026-08-16T12:00:00Z",
        closed_at: null,
    };
    const remoteRaw = todoRawFromGitHubIssue(issue, projectStore.getProjects()[0], "owner/zeitberg");
    todoStore.replaceGitHubTodos(
        "owner/zeitberg",
        [remoteRaw],
        new Map([[remoteRaw.id, normalizeGitHubIssueBase(issue)]]),
    );

    assert.equal(todoStore.getTodoById(remoteRaw.id)?.content, "Fresh upstream title");
    assert.equal(todoStore.getTodoById(remoteRaw.id)?.priority, 3);
    const persisted = JSON.parse(todoStore.serialize("2026-08-16T12:01:00Z"));
    assert.equal(persisted.schema_version, 4);
    assert.deepEqual(persisted.todos.map((todo) => todo.id), ["local:kept"]);
    assert.deepEqual(persisted.github_overlays, [
        {
            completion_history: [],
            deadline: null,
            due: legacy.due,
            issue_number: 41,
            order: 1,
            parent_id: null,
            priority: 3,
            recurrence: null,
            repository: "owner/zeitberg",
        },
    ]);
});

test("project binding migration is opt-in and detaching never alters upstream state", () => {
    const projectStore = makeProjectStore();
    const todoStore = new TodoStore(projectStore);
    const linked = makeTodo({
        id: "github:owner/zeitberg#7",
        source: { provider: "github", id: "7", project_id: "owner/zeitberg", section_id: "type/feature" },
    }).toRaw();
    const eligible = makeTodo({ id: "local:eligible", source: null }).toRaw();
    const retained = makeTodo({ id: "local:retained", content: "Keep this one local", source: null }).toRaw();
    todoStore.setTodoList(TodoList.fromRaw({ generated_at: "", schema_version: 4, github_overlays: [], todos: [linked, eligible, retained] }));
    todoStore.loadedGitHubRepositories.add("owner/zeitberg");
    todoStore.rebuildRemoteTodoIds();

    assert.equal(
        todoStore.markProjectTodosForGitHub("app", "owner/zeitberg", (todo) => todo.id === "local:eligible"),
        1,
    );
    assert.equal(todoStore.getTodoById("local:eligible")?.source?.provider, "github-pending");
    assert.equal(todoStore.getTodoById("local:retained")?.source, null);

    projectStore.setProjectList(makeProjectStore("").getProjectList());
    assert.equal(todoStore.materializeGitHubProjectTodos("app", "owner/zeitberg"), 2);
    assert.equal(todoStore.getTodoById("github:owner/zeitberg#7")?.source, null);
    assert.equal(todoStore.getTodoById("local:eligible")?.source, null);
    assert.equal(todoStore.loadedGitHubRepositories.has("owner/zeitberg"), false);
});

test("a staged section-label migration survives reload as a compact override", () => {
    const oldProjectStore = makeProjectStore("owner/zeitberg", "type/feature");
    const todoStore = new TodoStore(oldProjectStore);
    todoStore.setTodoList(TodoList.createEmpty());
    const issue = {
        number: 12,
        title: "Relabel this issue",
        body: "Details",
        labels: [{ name: "type/feature" }],
        state: "open",
        created_at: "2026-08-15T09:00:00Z",
        updated_at: "2026-08-16T09:00:00Z",
        closed_at: null,
    };
    const oldRaw = todoRawFromGitHubIssue(issue, oldProjectStore.getProjects()[0], "owner/zeitberg");
    todoStore.replaceGitHubTodos(
        "owner/zeitberg",
        [oldRaw],
        new Map([[oldRaw.id, normalizeGitHubIssueBase(issue)]]),
    );

    const newProjectStore = makeProjectStore("owner/zeitberg", "kind/feature");
    oldProjectStore.setProjectList(newProjectStore.getProjectList());
    assert.equal(todoStore.refreshGitHubTaskOverlays(), true);
    const persisted = JSON.parse(todoStore.serialize("2026-08-16T09:05:00Z"));
    assert.equal(persisted.todos.length, 0);
    assert.equal(persisted.github_overlays[0].section_key_override, "features");

    const reloadedStore = new TodoStore(newProjectStore);
    reloadedStore.setTodoList(TodoList.fromRaw(persisted));
    const newRaw = todoRawFromGitHubIssue(issue, newProjectStore.getProjects()[0], "owner/zeitberg");
    assert.equal(newRaw.section_key, null, "the old upstream label is no longer recognized by the new config");
    reloadedStore.replaceGitHubTodos(
        "owner/zeitberg",
        [newRaw],
        new Map([[newRaw.id, normalizeGitHubIssueBase(issue)]]),
    );
    assert.equal(reloadedStore.getTodoById(newRaw.id)?.sectionKey, "features");
    assert.equal(reloadedStore.getTodoById(newRaw.id)?.source?.section_id, null);
});

test("a cached issue collection remains available during a transient GitHub read failure", async () => {
    const projectStore = makeProjectStore();
    const todoStore = new TodoStore(projectStore);
    todoStore.setTodoList(TodoList.createEmpty());
    const warnings = [];
    const cachedIssue = {
        number: 5,
        title: "Cached issue",
        body: "Cached details",
        labels: [],
        state: "open",
        created_at: "2026-08-15T09:00:00Z",
        updated_at: "2026-08-16T09:00:00Z",
        closed_at: null,
    };
    const view = Object.create(TodoView.prototype);
    view.store = todoStore;
    view.projectStore = projectStore;
    view.dataSource = {
        supportsGitHubIssueSync: () => true,
        fetchGitHubIssues: async () => {
            throw new Error("offline");
        },
    };
    view.remoteCache = {
        get: async () => ({ issues: [cachedIssue], pages: [], fetchedAt: Date.now() - 1000 }),
        put: async () => true,
    };
    view.draftNamespace = "github:workspace/data@main";
    view.locale = { t: (key, values) => `${key}:${values?.repository || ""}` };
    view.onToast = (message) => warnings.push(message);

    await view.loadGitHubIssues();
    assert.equal(todoStore.getTodoById("github:owner/zeitberg#5")?.content, "Cached issue");
    assert.deepEqual(warnings, ["toast.githubIssuesCached:owner/zeitberg"]);
});

test("an authorization failure never exposes a previously cached private issue collection", async () => {
    const projectStore = makeProjectStore();
    const todoStore = new TodoStore(projectStore);
    todoStore.setTodoList(TodoList.createEmpty());
    const view = Object.create(TodoView.prototype);
    view.store = todoStore;
    view.projectStore = projectStore;
    view.dataSource = {
        supportsGitHubIssueSync: () => true,
        fetchGitHubIssues: async () => {
            throw new ProviderApiError("GitHub", 401, "Bad credentials");
        },
    };
    view.remoteCache = {
        get: async () => ({
            issues: [{ number: 5, title: "Must stay hidden", state: "open" }],
            pages: [],
        }),
        put: async () => true,
    };
    view.draftNamespace = "github:workspace/data@main";
    view.locale = { t: (key) => key };
    view.onToast = () => {};

    await assert.rejects(() => view.loadGitHubIssues(), /GitHub API error 401/);
    assert.equal(todoStore.getTodos().length, 0);
});

test("startup reconciles an already-created issue marker instead of publishing a duplicate", async () => {
    const projectStore = makeProjectStore();
    const todoStore = new TodoStore(projectStore);
    const pending = makeTodo({
        id: "local:interrupted-create",
        source: {
            provider: "github-pending",
            id: "local:interrupted-create",
            project_id: "owner/zeitberg",
            section_id: "type/feature",
        },
    });
    todoStore.setTodoList(TodoList.fromRaw({
        generated_at: "",
        github_overlays: [],
        schema_version: 4,
        todos: [pending.toRaw()],
    }));
    const issue = {
        number: 27,
        title: pending.content,
        body: buildTodoIssueBody(pending),
        labels: [{ name: "type/feature" }],
        state: "open",
        created_at: "2026-08-16T10:00:00Z",
        updated_at: "2026-08-16T10:00:00Z",
        closed_at: null,
    };
    const view = Object.create(TodoView.prototype);
    view.store = todoStore;
    view.projectStore = projectStore;
    view.dataSource = {
        supportsGitHubIssueSync: () => true,
        fetchGitHubIssues: async () => ({ issues: [issue], pages: [], usedCachedPages: false }),
    };
    view.remoteCache = null;
    view.draftNamespace = "github:workspace/data@main";
    view.locale = { t: (key) => key };
    view.onToast = () => {};
    view.selectedTodoId = pending.id;
    view.editingTodoId = null;

    await view.loadGitHubIssues();
    assert.equal(todoStore.getTodoById(pending.id), null);
    assert.equal(todoStore.getTodoById("github:owner/zeitberg#27")?.content, pending.content);
    assert.equal(todoStore.getTodos().length, 1);
    assert.equal(view.selectedTodoId, "github:owner/zeitberg#27");
});

test("upstream edits made after a local draft began become explicit conflicts", async () => {
    const projectStore = makeProjectStore();
    const todoStore = new TodoStore(projectStore);
    const originalIssue = {
        number: 9,
        title: "Original title",
        body: "Original body",
        labels: [{ name: "type/feature" }],
        state: "open",
        created_at: "2026-08-15T09:00:00Z",
        updated_at: "2026-08-16T09:00:00Z",
        closed_at: null,
    };
    const originalRaw = todoRawFromGitHubIssue(
        originalIssue,
        projectStore.getProjects()[0],
        "owner/zeitberg",
    );
    todoStore.setTodoList(TodoList.createEmpty());
    todoStore.replaceGitHubTodos(
        "owner/zeitberg",
        [originalRaw],
        new Map([[originalRaw.id, normalizeGitHubIssueBase(originalIssue)]]),
    );
    const baseline = structuredClone(todoStore.snapshotRaw());
    const originalTodo = todoStore.getTodoById(originalRaw.id);
    todoStore.updateTodo(originalRaw.id, {
        content: "Browser title",
        description: originalTodo.description,
        projectKey: originalTodo.projectKey,
        sectionKey: originalTodo.sectionKey,
        labels: originalTodo.labels,
        priority: originalTodo.priority,
        due: originalTodo.due,
        recurrence: originalTodo.recurrence?.toRaw() || null,
    }, "2026-08-16T10:00:00Z");
    const externalIssue = {
        ...originalIssue,
        title: "GitHub title",
        updated_at: "2026-08-16T10:01:00Z",
    };

    const view = Object.create(TodoView.prototype);
    view.store = todoStore;
    view.projectStore = projectStore;
    view.cleanSnapshot = baseline;
    view.conflicts = new Map();
    view.dataSource = {
        supportsGitHubIssueSync: () => true,
        fetchGitHubIssue: async () => structuredClone(externalIssue),
        updateGitHubIssue: async () => {
            throw new Error("must not overwrite a conflict");
        },
    };
    view.locale = { t: (key) => key };
    view.openConflictDialog = () => {};
    view.queueDraftWrite = () => {};
    view.selectedTodoId = originalRaw.id;
    view.editingTodoId = null;

    await assert.rejects(() => view.synchronizeGitHubIssues(), /githubIssueConflict/);
    assert.equal(view.conflicts.size, 1);
    assert.equal(view.conflicts.get(originalRaw.id)?.local?.content, "Browser title");
    assert.equal(view.conflicts.get(originalRaw.id)?.remote?.content, "GitHub title");
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
                external_refs: [{ provider: "github", id: "owner/zeitberg" }],
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
    const raw = makeTodo({
        source: {
            provider: "github-pending",
            id: "local:test-route",
            project_id: "owner/zeitberg",
            section_id: "type/feature",
        },
    }).toRaw();
    todoStore.setTodoList(TodoList.fromRaw({ generated_at: "", schema_version: 3, todos: [raw] }));

    const creates = [];
    const updates = [];
    let draftWrites = 0;
    let upstreamIssue = null;
    const view = Object.create(TodoView.prototype);
    view.store = todoStore;
    view.projectStore = projectStore;
    view.cleanSnapshot = [];
    view.dataSource = {
        supportsGitHubIssueSync: () => true,
        createGitHubIssue: async (repository, issue) => {
            creates.push({ repository, issue });
            upstreamIssue = {
                number: 23,
                title: issue.title,
                body: issue.body,
                labels: issue.labels.map((name) => ({ name })),
                state: "open",
                created_at: "2026-08-16T10:00:00Z",
                updated_at: "2026-08-16T10:00:00Z",
                closed_at: null,
            };
            return structuredClone(upstreamIssue);
        },
        fetchGitHubIssue: async () => structuredClone(upstreamIssue),
        updateGitHubIssue: async (repository, issueNumber, issue) => {
            updates.push({ repository, issueNumber, issue });
            upstreamIssue = {
                ...upstreamIssue,
                ...issue,
                number: issueNumber,
                labels: (issue.labels || upstreamIssue.labels).map((label) =>
                    typeof label === "string" ? { name: label } : label,
                ),
                updated_at: "2026-08-16T10:01:00Z",
            };
            return structuredClone(upstreamIssue);
        },
    };
    view.locale = { t: (key) => key };
    view.selectedTodoId = raw.id;
    view.editingTodoId = null;
    view.queueDraftWrite = () => {
        draftWrites += 1;
    };

    await view.synchronizeGitHubIssues();
    assert.equal(creates.length, 1);
    assert.equal(updates.length, 0);
    assert.equal(draftWrites, 1);
    const promoted = todoStore.getTodoById("github:owner/zeitberg#23");
    assert.deepEqual(promoted?.source, {
        provider: "github",
        id: "23",
        project_id: "owner/zeitberg",
        section_id: "type/feature",
    });

    await view.synchronizeGitHubIssues();
    assert.equal(creates.length, 1, "a failed workspace save must not create a second issue");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].issueNumber, 23);
});
