/**
 * @typedef {Object} ChunkCacheEntry
 * @description In-memory representation of a cached week payload.
 * @property {string} sha
 * @property {Array<Object>} entriesRaw
 */

/**
 * @typedef {Object} WeekDraftRecord
 * @description Browser-persisted snapshot of an edited week and the repository state it was based on.
 * @property {string} key
 * @property {string} namespace
 * @property {string} weekStart
 * @property {string} baseSha
 * @property {Array<Object>} baseEntriesRaw
 * @property {Array<Object>} entriesRaw
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} DocumentDraftRecord
 * @description Browser-persisted baseline and edited value for a small repository JSON document.
 * @property {string} key
 * @property {string} namespace
 * @property {string} documentName
 * @property {Object} baseValue
 * @property {Object} value
 * @property {number} updatedAt
 */

const CHUNK_CACHE = {
    dbName: "tt_viewer:chunk_cache:v2",
    dbVersion: 1,
    storeName: "chunks",
};

const DRAFT_JOURNAL = {
    dbName: "tt_viewer:draft_journal:v2",
    dbVersion: 2,
    documentStoreName: "document_drafts",
    namespaceIndex: "namespace",
    storeName: "week_drafts",
};

/**
 * Wraps an IndexedDB request in a Promise so cache implementations can use async/await.
 * The request result is passed through unchanged because callers know the expected record type.
 * @param {IDBRequest} req
 * @returns {Promise<any>}
 */
function requestToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
    });
}

/**
 * Resolves after every request in an IndexedDB transaction has committed.
 * Rejecting aborted transactions prevents the UI from treating an incomplete write as durable.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    });
}

/**
 * Identifies browser quota errors so repeated writes can be disabled after storage is exhausted.
 * Other failures remain retryable because they may be caused by a transient database state.
 * @param {unknown} err
 * @returns {boolean}
 */
function isQuotaError(err) {
    const errObj = err && typeof err === "object" ? /** @type {{name?: string}} */ (err) : null;
    const name = errObj ? String(errObj.name || "") : "";
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/**
 * Caches chunk payloads in memory + IndexedDB.
 * Used to reduce load times and avoid repeated network fetches.
 */
export class ChunkCache {
    constructor() {
        this.dbPromise = null;
        this.db = null;
        this.writesDisabled = false;
        this.memory = new Map();
    }

    /**
     * Opens the IndexedDB database, creating stores on first use.
     * Supports cache reuse across reloads and edits.
     * @returns {Promise<IDBDatabase | null>}
     */
    async openDb() {
        if (this.db) return this.db;
        if (this.dbPromise) return await this.dbPromise;
        if (typeof indexedDB === "undefined") return null;

        this.dbPromise = new Promise((resolve) => {
            let req;
            try {
                req = indexedDB.open(CHUNK_CACHE.dbName, CHUNK_CACHE.dbVersion);
            } catch {
                resolve(null);
                return;
            }

            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CHUNK_CACHE.storeName)) {
                    db.createObjectStore(CHUNK_CACHE.storeName, { keyPath: "sha" });
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });

        this.db = await this.dbPromise;
        return this.db;
    }

    /**
     * Retrieves a cached entry from the in-memory map.
     * Supports cache reuse across reloads and edits.
     * @param {string} key
     * @returns {ChunkCacheEntry | null}
     */
    getMemory(key) {
        return this.memory.get(key) || null;
    }

    /**
     * Stores a cache entry in the in-memory map.
     * Supports cache reuse across reloads and edits.
     * @param {string} key
     * @param {ChunkCacheEntry} entry
     * @returns {void}
     */
    setMemory(key, entry) {
        this.memory.set(key, entry);
    }

    /**
     * Clears only the in-memory cache.
     * Supports cache reuse across reloads and edits.
     * @returns {void}
     */
    clearMemory() {
        this.memory.clear();
    }

    /**
     * Reads a raw chunk payload from IndexedDB by sha.
     * Supports cache reuse across reloads and edits.
     * @param {string} sha
     * @returns {Promise<string | null>}
     */
    async getRawBySha(sha) {
        const key = String(sha || "").trim();
        if (!key) return null;

        const db = await this.openDb();
        if (!db) return null;

        try {
            const tx = db.transaction(CHUNK_CACHE.storeName, "readonly");
            const store = tx.objectStore(CHUNK_CACHE.storeName);
            const rec = await requestToPromise(store.get(key));
            await transactionDone(tx);
            if (rec && typeof rec.raw === "string") return rec.raw;
        } catch {
            // ignore
        }

        return null;
    }

    /**
     * Persists a raw chunk payload to IndexedDB by sha.
     * Supports cache reuse across reloads and edits.
     * @param {string} sha
     * @param {string} raw
     * @returns {Promise<void>}
     */
    async putRawBySha(sha, raw) {
        if (this.writesDisabled) return;
        const key = String(sha || "").trim();
        if (!key) return;
        if (typeof raw !== "string" || !raw) return;

        const db = await this.openDb();
        if (!db) return;

        try {
            const tx = db.transaction(CHUNK_CACHE.storeName, "readwrite");
            const store = tx.objectStore(CHUNK_CACHE.storeName);
            store.put({ sha: key, raw, saved_at: Date.now() });
            await transactionDone(tx);
        } catch (e) {
            if (isQuotaError(e)) this.writesDisabled = true;
        }
    }

    /**
     * Removes a chunk payload from IndexedDB by sha.
     * Supports cache reuse across reloads and edits.
     * @param {string} sha
     * @returns {Promise<void>}
     */
    async deleteRawBySha(sha) {
        const key = String(sha || "").trim();
        if (!key) return;

        const db = await this.openDb();
        if (!db) return;

        try {
            const tx = db.transaction(CHUNK_CACHE.storeName, "readwrite");
            const store = tx.objectStore(CHUNK_CACHE.storeName);
            store.delete(key);
            await transactionDone(tx);
        } catch {
            // ignore
        }
    }

    /**
     * Clears both memory cache and IndexedDB database.
     * Supports cache reuse across reloads and edits.
     * @returns {void}
     */
    clearAll() {
        try {
            this.db?.close();
        } catch {
            // ignore
        }
        this.db = null;
        this.dbPromise = null;
        this.writesDisabled = false;
        this.memory.clear();

        try {
            if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(CHUNK_CACHE.dbName);
        } catch {
            // ignore
        }
    }
}

/**
 * Persists unsaved week edits independently from downloaded chunk caches.
 * Records remain until a remote or local save succeeds, allowing edits to survive reloads and failed saves.
 */
export class DraftJournal {
    /**
     * Initializes the lazy IndexedDB connection used for durable week drafts.
     * No database is opened until the first read or write operation.
     */
    constructor() {
        this.dbPromise = null;
        this.db = null;
        this.writesDisabled = false;
    }

    /**
     * Opens the draft database and creates its namespace index on first use.
     * Returning null keeps the editor usable in browsers where IndexedDB is unavailable.
     * @returns {Promise<IDBDatabase | null>}
     */
    async openDb() {
        if (this.db) return this.db;
        if (this.dbPromise) return await this.dbPromise;
        if (typeof indexedDB === "undefined") return null;

        this.dbPromise = new Promise((resolve) => {
            /** @type {IDBOpenDBRequest} */
            let req;
            try {
                req = indexedDB.open(DRAFT_JOURNAL.dbName, DRAFT_JOURNAL.dbVersion);
            } catch {
                resolve(null);
                return;
            }

            req.onupgradeneeded = () => {
                const db = req.result;
                let store;
                if (db.objectStoreNames.contains(DRAFT_JOURNAL.storeName)) {
                    store = req.transaction?.objectStore(DRAFT_JOURNAL.storeName);
                } else {
                    store = db.createObjectStore(DRAFT_JOURNAL.storeName, { keyPath: "key" });
                }
                if (store && !store.indexNames.contains(DRAFT_JOURNAL.namespaceIndex)) {
                    store.createIndex(DRAFT_JOURNAL.namespaceIndex, "namespace", { unique: false });
                }
                let documentStore;
                if (db.objectStoreNames.contains(DRAFT_JOURNAL.documentStoreName)) {
                    documentStore = req.transaction?.objectStore(DRAFT_JOURNAL.documentStoreName);
                } else {
                    documentStore = db.createObjectStore(DRAFT_JOURNAL.documentStoreName, { keyPath: "key" });
                }
                if (documentStore && !documentStore.indexNames.contains(DRAFT_JOURNAL.namespaceIndex)) {
                    documentStore.createIndex(DRAFT_JOURNAL.namespaceIndex, "namespace", { unique: false });
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });

        this.db = await this.dbPromise;
        return this.db;
    }

    /**
     * Builds the stable primary key used to isolate drafts by source and ISO week.
     * The separator cannot occur in a valid ISO date and avoids ambiguous concatenation.
     * @param {string} namespace
     * @param {string} weekStart
     * @returns {string}
     */
    buildKey(namespace, weekStart) {
        return `${String(namespace || "").trim()}\u0000${String(weekStart || "").trim()}`;
    }

    /**
     * Returns every unsaved week draft for one local or GitHub data source.
     * Invalid records are ignored so one corrupt browser record cannot prevent application startup.
     * @param {string} namespace
     * @returns {Promise<WeekDraftRecord[]>}
     */
    async getWeekDrafts(namespace) {
        const scope = String(namespace || "").trim();
        if (!scope) return [];
        const db = await this.openDb();
        if (!db) return [];

        try {
            const tx = db.transaction(DRAFT_JOURNAL.storeName, "readonly");
            const store = tx.objectStore(DRAFT_JOURNAL.storeName);
            const index = store.index(DRAFT_JOURNAL.namespaceIndex);
            const result = await requestToPromise(index.getAll(IDBKeyRange.only(scope)));
            await transactionDone(tx);
            if (!Array.isArray(result)) return [];
            return result
                .filter(
                    (record) =>
                        record &&
                        typeof record === "object" &&
                        typeof record.weekStart === "string" &&
                        Array.isArray(record.baseEntriesRaw) &&
                        Array.isArray(record.entriesRaw),
                )
                .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
        } catch {
            return [];
        }
    }

    /**
     * Writes the latest edited and baseline snapshots for one week.
     * Returns false when durability is unavailable so the caller can warn the user without blocking edits.
     * @param {string} namespace
     * @param {{weekStart: string, baseSha: string, baseEntriesRaw: Array<Object>, entriesRaw: Array<Object>, updatedAt: number}} draft
     * @returns {Promise<boolean>}
     */
    async putWeekDraft(namespace, draft) {
        if (this.writesDisabled) return false;
        const scope = String(namespace || "").trim();
        const weekStart = String(draft?.weekStart || "").trim();
        if (!scope || !weekStart) return false;
        const db = await this.openDb();
        if (!db) return false;

        /** @type {WeekDraftRecord} */
        const record = {
            key: this.buildKey(scope, weekStart),
            namespace: scope,
            weekStart,
            baseSha: String(draft.baseSha || ""),
            baseEntriesRaw: draft.baseEntriesRaw,
            entriesRaw: draft.entriesRaw,
            updatedAt: Number(draft.updatedAt || Date.now()),
        };

        try {
            const tx = db.transaction(DRAFT_JOURNAL.storeName, "readwrite");
            tx.objectStore(DRAFT_JOURNAL.storeName).put(record);
            await transactionDone(tx);
            return true;
        } catch (err) {
            if (isQuotaError(err)) this.writesDisabled = true;
            return false;
        }
    }

    /**
     * Deletes one week draft after a successful save or a complete undo to its persisted state.
     * Returns false only when the browser database could not perform the deletion.
     * @param {string} namespace
     * @param {string} weekStart
     * @returns {Promise<boolean>}
     */
    async deleteWeekDraft(namespace, weekStart) {
        const scope = String(namespace || "").trim();
        const start = String(weekStart || "").trim();
        if (!scope || !start) return false;
        const db = await this.openDb();
        if (!db) return false;

        try {
            const tx = db.transaction(DRAFT_JOURNAL.storeName, "readwrite");
            tx.objectStore(DRAFT_JOURNAL.storeName).delete(this.buildKey(scope, start));
            await transactionDone(tx);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Builds an isolated key for a small editable document such as data/todos.json.
     * @param {string} namespace
     * @param {string} documentName
     * @returns {string}
     */
    buildDocumentKey(namespace, documentName) {
        return `${String(namespace || "").trim()}\u0000document\u0000${String(documentName || "").trim()}`;
    }

    /**
     * Reads one durable document draft for the active local or GitHub namespace.
     * Invalid records are ignored so application startup can fall back to repository data safely.
     * @param {string} namespace
     * @param {string} documentName
     * @returns {Promise<DocumentDraftRecord | null>}
     */
    async getDocumentDraft(namespace, documentName) {
        const scope = String(namespace || "").trim();
        const name = String(documentName || "").trim();
        if (!scope || !name) return null;
        const db = await this.openDb();
        if (!db) return null;

        try {
            const tx = db.transaction(DRAFT_JOURNAL.documentStoreName, "readonly");
            const store = tx.objectStore(DRAFT_JOURNAL.documentStoreName);
            const result = await requestToPromise(store.get(this.buildDocumentKey(scope, name)));
            await transactionDone(tx);
            if (!result || typeof result !== "object") return null;
            if (!result.baseValue || typeof result.baseValue !== "object") return null;
            if (!result.value || typeof result.value !== "object") return null;
            return result;
        } catch {
            return null;
        }
    }

    /**
     * Persists one edited JSON document together with the clean repository value it was based on.
     * @param {string} namespace
     * @param {string} documentName
     * @param {{baseValue: Object, value: Object, updatedAt: number}} draft
     * @returns {Promise<boolean>}
     */
    async putDocumentDraft(namespace, documentName, draft) {
        if (this.writesDisabled) return false;
        const scope = String(namespace || "").trim();
        const name = String(documentName || "").trim();
        if (!scope || !name || !draft?.baseValue || !draft?.value) return false;
        const db = await this.openDb();
        if (!db) return false;

        /** @type {DocumentDraftRecord} */
        const record = {
            key: this.buildDocumentKey(scope, name),
            namespace: scope,
            documentName: name,
            baseValue: draft.baseValue,
            value: draft.value,
            updatedAt: Number(draft.updatedAt || Date.now()),
        };

        try {
            const tx = db.transaction(DRAFT_JOURNAL.documentStoreName, "readwrite");
            tx.objectStore(DRAFT_JOURNAL.documentStoreName).put(record);
            await transactionDone(tx);
            return true;
        } catch (err) {
            if (isQuotaError(err)) this.writesDisabled = true;
            return false;
        }
    }

    /**
     * Removes a document draft after a successful save or an undo back to the clean snapshot.
     * @param {string} namespace
     * @param {string} documentName
     * @returns {Promise<boolean>}
     */
    async deleteDocumentDraft(namespace, documentName) {
        const scope = String(namespace || "").trim();
        const name = String(documentName || "").trim();
        if (!scope || !name) return false;
        const db = await this.openDb();
        if (!db) return false;

        try {
            const tx = db.transaction(DRAFT_JOURNAL.documentStoreName, "readwrite");
            tx.objectStore(DRAFT_JOURNAL.documentStoreName).delete(this.buildDocumentKey(scope, name));
            await transactionDone(tx);
            return true;
        } catch {
            return false;
        }
    }
}
