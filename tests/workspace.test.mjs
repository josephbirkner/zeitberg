import assert from "node:assert/strict";
import test from "node:test";

import { Manifest, Workspace } from "../model.js";

/**
 * Creates a minimal valid workspace payload for model tests.
 * @returns {Object}
 */
function makeWorkspaceRaw() {
    return {
        $schema: "https://zeitplural.io/schema/workspace-v1.schema.json",
        components: {
            tasks: { paths: { document: "records/todos.json" }, type: "todos" },
            time: {
                paths: {
                    entries: "records/weeks",
                    manifest: "records/manifest.json",
                    week_requirements: "records/requirements.json",
                },
                type: "time_tracking",
            },
        },
        name: "Test workspace",
        resources: { projects: "records/projects.json" },
        schema_version: 1,
        timezone: "Europe/Berlin",
        workspace_id: "test-workspace",
    };
}

test("workspace model resolves provider-neutral component paths", () => {
    const workspace = Workspace.fromRaw(makeWorkspaceRaw());

    assert.equal(workspace.workspace_id, "test-workspace");
    assert.equal(workspace.getResourcePath("projects"), "records/projects.json");
    assert.equal(workspace.getComponentPath("time_tracking", "entries"), "records/weeks");
    assert.equal(workspace.getComponentPath("time_tracking", "manifest"), "records/manifest.json");
    assert.equal(workspace.getComponentPath("todos", "document"), "records/todos.json");
    assert.deepEqual(Workspace.fromRaw(workspace.toObject()).toObject(), workspace.toObject());
});

test("workspace model rejects unsafe repository paths", () => {
    const traversal = makeWorkspaceRaw();
    traversal.resources.projects = "../outside.json";
    assert.throws(() => Workspace.fromRaw(traversal), /traversal segments/);

    const absolute = makeWorkspaceRaw();
    absolute.components.tasks.paths.document = "/tmp/todos.json";
    assert.throws(() => Workspace.fromRaw(absolute), /normalized repository-relative path/);
});

test("entry manifests accept only the configured workspace directory", () => {
    const raw = {
        chunks: [
            {
                entries: 0,
                path: "records/weeks/2026/33.json",
                sha: "a".repeat(40),
                size: 100,
                week: 33,
                year: 2026,
            },
            {
                entries: 0,
                path: "data/entries/2026/33.json",
                sha: "b".repeat(40),
                size: 100,
                week: 33,
                year: 2026,
            },
        ],
        generated_at: "2026-08-14T00:00:00Z",
        schema_version: 2,
        timezone: "Europe/Berlin",
    };

    const manifest = Manifest.fromRaw(raw, "records/weeks");
    assert.deepEqual(manifest.chunks.map((chunk) => chunk.path), ["records/weeks/2026/33.json"]);
});
