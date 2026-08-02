import assert from "node:assert/strict";
import test from "node:test";

import { Manifest, ProjectList, TodoList } from "../docs/model.js";
import { EntryStore, TodoStore } from "../docs/store.js";
import { TimeContext } from "../docs/utils.js";

/**
 * Creates a compact canonical taxonomy used by project/section resolution tests.
 * @returns {ProjectList}
 */
function makeProjects() {
    return ProjectList.fromRaw({
        generated_at: "",
        schema_version: 2,
        projects: [
            {
                archived: false,
                billable: true,
                color: "#80ff00",
                external_refs: [{ provider: "todoist", id: "work-id" }],
                key: "ke",
                name: "KE",
                sections: [
                    {
                        archived: false,
                        billable: null,
                        color: null,
                        external_refs: [{ provider: "toggl", id: "coding-id" }],
                        key: "coding",
                        name: "Coding",
                    },
                    {
                        archived: false,
                        billable: false,
                        color: "#123456",
                        external_refs: [],
                        key: "internal",
                        name: "Internal",
                    },
                ],
            },
        ],
    });
}

test("newly built entry manifests retain the current schema version", () => {
    const manifest = Manifest.fromChunks(
        [
            {
                entries: 2,
                path: "data/entries/2026/31.json",
                sha: "0123456789abcdef0123456789abcdef01234567",
                size: 123,
                week: 31,
                year: 2026,
            },
        ],
        "Europe/Berlin",
        "2026-07-31T15:49:41Z",
    );

    const serialized = JSON.parse(manifest.toJson());
    assert.equal(serialized.schema_version, 2);
    assert.equal(Manifest.fromRaw(serialized).schema_version, 2);
});

test("sections inherit project defaults and can override them", () => {
    const projects = makeProjects();

    assert.deepEqual(
        {
            label: projects.resolveAssignment("ke", "coding")?.label,
            color: projects.resolveAssignment("ke", "coding")?.color,
            billable: projects.resolveAssignment("ke", "coding")?.billable,
        },
        { label: "KE / Coding", color: "#80ff00", billable: true },
    );
    assert.deepEqual(
        {
            color: projects.resolveAssignment("ke", "internal")?.color,
            billable: projects.resolveAssignment("ke", "internal")?.billable,
        },
        { color: "#123456", billable: false },
    );
});

test("project and section assignments share one searchable label model", () => {
    const projects = makeProjects();

    assert.deepEqual(projects.listAssignmentOptions(), [
        { projectKey: "ke", sectionKey: null, label: "KE", archived: false },
        { projectKey: "ke", sectionKey: "coding", label: "KE / Coding", archived: false },
        { projectKey: "ke", sectionKey: "internal", label: "KE / Internal", archived: false },
    ]);
    assert.deepEqual(projects.findAssignmentByLabel(" ke / CODING "), {
        projectKey: "ke",
        sectionKey: "coding",
    });
    assert.deepEqual(projects.findAssignmentByLabel(""), { projectKey: null, sectionKey: null });
    assert.equal(projects.findAssignmentByLabel("Made-up project"), null);
});

test("provider ids resolve independently from editable display names", () => {
    const projects = makeProjects();

    assert.deepEqual(projects.findAssignmentByExternalRef("todoist", "work-id"), {
        projectKey: "ke",
        sectionKey: null,
    });
    assert.deepEqual(projects.findAssignmentByExternalRef("toggl", "coding-id"), {
        projectKey: "ke",
        sectionKey: "coding",
    });
    assert.equal(projects.findProjectByName("KE")?.key, "ke");
});

test("TODO store rejects section keys outside the canonical taxonomy", () => {
    const entryStore = new EntryStore(new TimeContext("Europe/Berlin"));
    entryStore.setProjectList(makeProjects());
    const todoStore = new TodoStore(entryStore);
    const malformed = {
        archived: false,
        completed_at: null,
        completion_history: [],
        content: "Invalid assignment",
        created_at: "",
        deadline: null,
        description: "",
        due: null,
        id: "test:invalid",
        labels: [],
        order: 0,
        parent_id: null,
        priority: 1,
        project_key: "ke",
        recurrence: null,
        section_key: "missing",
        source: null,
        updated_at: "",
    };

    assert.throws(
        () => todoStore.setTodoList(TodoList.fromRaw({ generated_at: "", schema_version: 3, todos: [malformed] })),
        /references unknown assignment/,
    );
});
