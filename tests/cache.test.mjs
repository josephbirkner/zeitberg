import assert from "node:assert/strict";
import test from "node:test";

import "fake-indexeddb/auto";

import { ChunkCache, DraftJournal, RemoteCache } from "../cache.js";

const DATABASES = [
    "zeitberg:chunk-cache:v2",
    "zeitberg:draft-journal:v2",
    "zeitberg:remote_cache:v1",
];

/**
 * Deletes one fake IndexedDB database and waits for the request to settle.
 *
 * @param {string} name Database name.
 * @returns {Promise<void>}
 */
function deleteDatabase(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
    });
}

test("browser caches persist chunks, remote payloads, and editable drafts by namespace", async () => {
    await Promise.all(DATABASES.map(deleteDatabase));

    const chunks = new ChunkCache();
    chunks.setMemory("2026-W33", { sha: "sha-a", entriesRaw: [{ id: 1 }] });
    assert.equal(chunks.getMemory("2026-W33")?.sha, "sha-a");
    assert.equal(chunks.getMemory("missing"), null);
    chunks.clearMemory();
    assert.equal(chunks.getMemory("2026-W33"), null);

    assert.deepEqual(await chunks.getRawByShas([]), new Map());
    await chunks.putRawByShas(
        new Map([
            ["sha-a", "{\"entries\":[]}"],
            ["sha-b", "{\"entries\":[1]}"],
            ["", "ignored"],
        ]),
    );
    assert.equal(await chunks.getRawBySha("sha-a"), "{\"entries\":[]}");
    assert.deepEqual(await chunks.getRawByShas(["sha-b", "sha-a", "sha-a", ""]), new Map([
        ["sha-b", "{\"entries\":[1]}"],
        ["sha-a", "{\"entries\":[]}"],
    ]));
    await chunks.putRawBySha("sha-c", "payload-c");
    assert.equal(await chunks.getRawBySha("sha-c"), "payload-c");
    await chunks.deleteRawBySha("sha-a");
    await chunks.deleteRawByShas(["sha-b", "sha-b", ""]);
    assert.equal(await chunks.getRawBySha("sha-a"), null);
    assert.equal(await chunks.getRawBySha("sha-b"), null);
    assert.equal(await chunks.getRawBySha(""), null);
    await chunks.putRawBySha("", "ignored");
    await chunks.putRawBySha("sha-d", "");

    const remote = new RemoteCache();
    assert.equal(remote.buildKey("workspace", "issues"), "workspace\u0000issues");
    assert.equal(await remote.get("", "issues"), null);
    assert.equal(await remote.put("workspace", "issues", { etag: "v1", rows: [1, 2] }), true);
    assert.deepEqual(await remote.get("workspace", "issues"), { etag: "v1", rows: [1, 2] });
    assert.equal(await remote.get("workspace", "missing"), null);
    assert.equal(await remote.put("workspace", "", {}), false);

    const drafts = new DraftJournal();
    assert.equal(drafts.buildKey("workspace", "2026-08-10"), "workspace\u00002026-08-10");
    assert.equal(drafts.buildDocumentKey("workspace", "todos"), "workspace\u0000document\u0000todos");
    assert.deepEqual(await drafts.getWeekDrafts(""), []);
    assert.equal(
        await drafts.putWeekDraft("workspace", {
            weekStart: "2026-08-17",
            baseSha: "base-2",
            baseEntriesRaw: [],
            entriesRaw: [{ id: 2 }],
            updatedAt: 20,
        }),
        true,
    );
    assert.equal(
        await drafts.putWeekDraft("workspace", {
            weekStart: "2026-08-10",
            baseSha: "base-1",
            baseEntriesRaw: [{ id: 1 }],
            entriesRaw: [{ id: 1, description: "edited" }],
            updatedAt: 10,
        }),
        true,
    );
    const weekDrafts = await drafts.getWeekDrafts("workspace");
    assert.deepEqual(weekDrafts.map((draft) => draft.weekStart), ["2026-08-10", "2026-08-17"]);
    assert.equal(await drafts.deleteWeekDraft("workspace", "2026-08-10"), true);
    assert.deepEqual((await drafts.getWeekDrafts("workspace")).map((draft) => draft.weekStart), ["2026-08-17"]);
    assert.equal(await drafts.deleteWeekDraft("", "2026-08-17"), false);

    assert.equal(
        await drafts.putDocumentDraft("workspace", "todos", {
            baseValue: { schema_version: 4, todos: [] },
            value: { schema_version: 4, todos: [{ id: "local:1" }] },
            updatedAt: 30,
        }),
        true,
    );
    assert.equal((await drafts.getDocumentDraft("workspace", "todos"))?.documentName, "todos");
    assert.equal(await drafts.getDocumentDraft("", "todos"), null);
    assert.equal(await drafts.deleteDocumentDraft("workspace", "todos"), true);
    assert.equal(await drafts.getDocumentDraft("workspace", "todos"), null);
    assert.equal(await drafts.putDocumentDraft("workspace", "todos", /** @type {any} */ ({})), false);
    assert.equal(await drafts.deleteDocumentDraft("", "todos"), false);

    chunks.clearAll();
    remote.clearAll();
    drafts.db?.close();
    await Promise.all(DATABASES.map(deleteDatabase));
});

test("browser caches remain optional when IndexedDB is unavailable or full", async () => {
    const originalIndexedDb = globalThis.indexedDB;
    // @ts-expect-error Exercise the explicit no-IndexedDB browser fallback.
    globalThis.indexedDB = undefined;
    try {
        assert.equal(await new ChunkCache().openDb(), null);
        assert.equal(await new RemoteCache().openDb(), null);
        assert.equal(await new DraftJournal().openDb(), null);
    } finally {
        globalThis.indexedDB = originalIndexedDb;
    }

    const quotaError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    const failingDb = {
        close() {},
        transaction() {
            throw quotaError;
        },
    };

    const chunks = new ChunkCache();
    chunks.db = /** @type {any} */ (failingDb);
    await chunks.putRawBySha("sha", "payload");
    assert.equal(chunks.writesDisabled, true);
    await chunks.putRawBySha("sha-2", "payload");
    chunks.clearAll();

    const remote = new RemoteCache();
    remote.db = /** @type {any} */ (failingDb);
    assert.equal(await remote.put("workspace", "issues", { rows: [] }), false);
    assert.equal(remote.writesDisabled, true);
    remote.clearAll();

    const drafts = new DraftJournal();
    drafts.db = /** @type {any} */ (failingDb);
    assert.equal(
        await drafts.putWeekDraft("workspace", {
            weekStart: "2026-08-10",
            baseSha: "",
            baseEntriesRaw: [],
            entriesRaw: [],
            updatedAt: 1,
        }),
        false,
    );
    assert.equal(drafts.writesDisabled, true);
});
