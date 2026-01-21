/**
 * @typedef {Object} ChunkCacheEntry
 * @property {string} sha
 * @property {Array<Object>} entriesRaw
 */

const CHUNK_CACHE = {
    dbName: "tt_viewer:chunk_cache:v1",
    dbVersion: 1,
    storeName: "chunks",
};

/**
 * Caches chunk payloads in memory + IndexedDB.
 */
export class ChunkCache {
    constructor() {
        this.dbPromise = null;
        this.db = null;
        this.writesDisabled = false;
        this.memory = new Map();
    }

    /**
     * @param {IDBRequest} req
     * @returns {Promise<any>}
     */
    requestToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
        });
    }

    /**
     * @param {IDBTransaction} tx
     * @returns {Promise<void>}
     */
    transactionDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
            tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
        });
    }

    /**
     * @param {unknown} err
     * @returns {boolean}
     */
    isQuotaError(err) {
        const name = err && typeof err === "object" ? String(err.name || "") : "";
        if (name === "QuotaExceededError") return true;
        if (name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
        return false;
    }

    /**
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
     * @param {string} key
     * @returns {ChunkCacheEntry | null}
     */
    getMemory(key) {
        return this.memory.get(key) || null;
    }

    /**
     * @param {string} key
     * @param {ChunkCacheEntry} entry
     * @returns {void}
     */
    setMemory(key, entry) {
        this.memory.set(key, entry);
    }

    /**
     * @returns {void}
     */
    clearMemory() {
        this.memory.clear();
    }

    /**
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
            const rec = await this.requestToPromise(store.get(key));
            await this.transactionDone(tx);
            if (rec && typeof rec.raw === "string") return rec.raw;
        } catch {
            // ignore
        }

        return null;
    }

    /**
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
            await this.transactionDone(tx);
        } catch (e) {
            if (this.isQuotaError(e)) this.writesDisabled = true;
        }
    }

    /**
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
            await this.transactionDone(tx);
        } catch {
            // ignore
        }
    }

    /**
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
