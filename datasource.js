import { gitBlobSha1 } from "./utils.js";

/**
 * @typedef {Object} RepoConfig
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref
 */

/**
 * @typedef {Object} SaveResult
 * @property {Array<import("./store.js").WeekFile>} weekFiles
 */

/**
 * Base data source interface for loading and saving.
 */
export class DataSource {
    /**
     * @param {RepoConfig} config
     */
    constructor(config) {
        this.config = { ...config };
    }

    /**
     * @param {RepoConfig} config
     * @returns {void}
     */
    setConfig(config) {
        this.config = { ...config };
    }

    /**
     * @returns {Promise<Object>}
     */
    async fetchManifest() {
        throw new Error("Not implemented");
    }

    /**
     * @param {import("./model.js").ManifestChunk} chunk
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        throw new Error("Not implemented");
    }

    /**
     * @param {Array<import("./store.js").WeekFile>} weekFiles
     * @param {import("./model.js").Manifest} manifest
     * @param {string} reason
     * @returns {Promise<SaveResult>}
     */
    async saveWeeks(weekFiles, manifest, reason) {
        throw new Error("Not implemented");
    }
}

/**
 * GitHub-backed data source.
 */
export class GitHubDataSource extends DataSource {
    /**
     * @param {RepoConfig} config
     * @param {string} token
     */
    constructor(config, token) {
        super(config);
        this.token = token;
    }

    /**
     * @param {string} token
     * @returns {void}
     */
    setToken(token) {
        this.token = token;
    }

    /**
     * @param {string} accept
     * @returns {HeadersInit}
     */
    buildHeaders(accept) {
        const headers = {
            Accept: accept || "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }
        return headers;
    }

    /**
     * @param {string} url
     * @returns {Promise<any>}
     */
    async fetchJson(url) {
        const resp = await fetch(url, { headers: this.buildHeaders("application/vnd.github+json") });
        if (!resp.ok) {
            throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
        }
        return await resp.json();
    }

    /**
     * @param {string} url
     * @param {Object} options
     * @returns {Promise<any>}
     */
    async fetchJsonRequest(url, options) {
        const opts = options || {};
        const headers = this.buildHeaders(opts.accept || "application/vnd.github+json");
        const init = { method: opts.method || "GET", headers };
        if (opts.body !== undefined && opts.body !== null) {
            init.body = JSON.stringify(opts.body);
            init.headers = { ...headers, "Content-Type": "application/json" };
        }
        const resp = await fetch(url, init);
        if (!resp.ok) {
            throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
        }
        return await resp.json();
    }

    /**
     * @param {string} url
     * @returns {Promise<string>}
     */
    async fetchRaw(url) {
        const resp = await fetch(url, { headers: this.buildHeaders("application/vnd.github.raw") });
        if (!resp.ok) {
            throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
        }
        return await resp.text();
    }

    /**
     * @param {string} repoPath
     * @returns {string}
     */
    buildContentsUrl(repoPath) {
        return `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(
            this.config.repo,
        )}/contents/${repoPath}?ref=${encodeURIComponent(this.config.ref)}`;
    }

    /**
     * @returns {Promise<Object>}
     */
    async fetchManifest() {
        const raw = await this.fetchRaw(this.buildContentsUrl("data/index/entries-manifest.json"));
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error("Failed to parse entries-manifest.json");
        }
    }

    /**
     * @param {import("./model.js").ManifestChunk} chunk
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        const url = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(
            this.config.repo,
        )}/git/blobs/${encodeURIComponent(chunk.sha)}`;
        return await this.fetchRaw(url);
    }

    /**
     * @param {Array<import("./store.js").WeekFile>} weekFiles
     * @param {import("./model.js").Manifest} manifest
     * @param {string} reason
     * @returns {Promise<SaveResult>}
     */
    async saveWeeks(weekFiles, manifest, reason) {
        if (!this.token) {
            throw new Error("Not logged in.");
        }
        const baseUrl = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
        const branch = String(this.config.ref || "").trim();
        if (!branch) {
            throw new Error("Missing branch ref.");
        }

        const refInfo = await this.fetchJsonRequest(`${baseUrl}/git/ref/heads/${encodeURIComponent(branch)}`);
        const baseCommitSha = refInfo?.object?.sha;
        if (!/^[0-9a-f]{40}$/i.test(baseCommitSha || "")) throw new Error("Failed to resolve branch ref.");

        const baseCommit = await this.fetchJsonRequest(`${baseUrl}/git/commits/${encodeURIComponent(baseCommitSha)}`);
        const baseTreeSha = baseCommit?.tree?.sha;
        if (!/^[0-9a-f]{40}$/i.test(baseTreeSha || "")) throw new Error("Failed to resolve base tree.");

        const updatedWeekFiles = [];
        for (const file of weekFiles) {
            const blob = await this.fetchJsonRequest(`${baseUrl}/git/blobs`, {
                method: "POST",
                body: { content: file.content, encoding: "utf-8" },
            });
            const sha = blob?.sha;
            if (!/^[0-9a-f]{40}$/i.test(sha || "")) {
                throw new Error(`Failed to create blob for ${file.path}`);
            }
            if (gitBlobSha1(file.content) !== sha) {
                throw new Error(`Blob sha mismatch for ${file.path}`);
            }
            updatedWeekFiles.push({ ...file, sha });
        }

        const manifestContent = manifest.toJson();
        const manifestBlob = await this.fetchJsonRequest(`${baseUrl}/git/blobs`, {
            method: "POST",
            body: { content: manifestContent, encoding: "utf-8" },
        });
        const manifestSha = manifestBlob?.sha;
        if (!/^[0-9a-f]{40}$/i.test(manifestSha || "")) throw new Error("Failed to create manifest blob.");

        const tree = [];
        for (const file of updatedWeekFiles) {
            tree.push({ path: file.path, mode: "100644", type: "blob", sha: file.sha });
        }
        tree.push({ path: "data/index/entries-manifest.json", mode: "100644", type: "blob", sha: manifestSha });

        const treeRes = await this.fetchJsonRequest(`${baseUrl}/git/trees`, {
            method: "POST",
            body: { base_tree: baseTreeSha, tree },
        });
        const newTreeSha = treeRes?.sha;
        if (!/^[0-9a-f]{40}$/i.test(newTreeSha || "")) throw new Error("Failed to create tree.");

        const labels = updatedWeekFiles
            .map((file) => `${file.year}-W${String(file.week).padStart(2, "0")}`)
            .sort((a, b) => a.localeCompare(b))
            .join(", ");
        const message = reason === "autosave" ? `Autosave time entries (${labels})` : `Edit time entries (${labels})`;

        const commitRes = await this.fetchJsonRequest(`${baseUrl}/git/commits`, {
            method: "POST",
            body: { message, tree: newTreeSha, parents: [baseCommitSha] },
        });
        const newCommitSha = commitRes?.sha;
        if (!/^[0-9a-f]{40}$/i.test(newCommitSha || "")) throw new Error("Failed to create commit.");

        await this.fetchJsonRequest(`${baseUrl}/git/refs/heads/${encodeURIComponent(branch)}`, {
            method: "PATCH",
            body: { sha: newCommitSha, force: false },
        });

        return { weekFiles: updatedWeekFiles };
    }

    /**
     * @returns {Promise<{repoInfo: any, userInfo: any}>}
     */
    async checkConnection() {
        const repoInfo = await this.fetchJson(
            `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`,
        );
        let userInfo = null;
        try {
            userInfo = await this.fetchJson("https://api.github.com/user");
        } catch {
            userInfo = null;
        }
        return { repoInfo, userInfo };
    }
}

/**
 * Local server data source.
 */
export class LocalDataSource extends DataSource {
    constructor() {
        super({ owner: "", repo: "", ref: "" });
    }

    /**
     * @param {string} repoPath
     * @returns {string}
     */
    buildLocalUrl(repoPath) {
        const clean = String(repoPath || "").replace(/^\/+/, "");
        return new URL(`../${clean}`, window.location.href).toString();
    }

    /**
     * @returns {Promise<Object>}
     */
    async fetchManifest() {
        const resp = await fetch(this.buildLocalUrl("data/index/entries-manifest.json"), { cache: "no-store" });
        if (!resp.ok) {
            throw new Error(`Local manifest not found (${resp.status}). Run the local server from repo root: python3 server.py`);
        }
        const raw = await resp.text();
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error("Failed to parse entries-manifest.json");
        }
    }

    /**
     * @param {import("./model.js").ManifestChunk} chunk
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        const resp = await fetch(this.buildLocalUrl(chunk.path), { cache: "no-store" });
        if (!resp.ok) throw new Error(`Local fetch failed (${resp.status}): ${chunk.path}`);
        return await resp.text();
    }

    /**
     * @param {Array<import("./store.js").WeekFile>} weekFiles
     * @param {import("./model.js").Manifest} manifest
     * @param {string} reason
     * @returns {Promise<SaveResult>}
     */
    async saveWeeks(weekFiles, manifest, reason) {
        const body = {
            weeks: weekFiles.map((file) => ({ path: file.path, content: file.content })),
            manifest: { path: "data/index/entries-manifest.json", content: manifest.toJson() },
        };

        let resp;
        try {
            resp = await fetch(this.buildLocalUrl("save"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch {
            throw new Error("Local save failed. Run the app via: python3 server.py");
        }

        if (!resp.ok) {
            throw new Error(`Local save failed (${resp.status}): ${await resp.text()}`);
        }

        const result = await resp.json();
        if (!result || result.ok !== true) {
            throw new Error(typeof result?.error === "string" ? result.error : "Local save failed.");
        }

        return { weekFiles };
    }
}
