import { gitBlobSha1 } from "./utils.js";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GRAPHQL_CHUNK_BATCH_MAX_BYTES = 8 * 1024 * 1024;
const GRAPHQL_CHUNK_BATCH_MAX_ITEMS = 200;
const GRAPHQL_UNKNOWN_CHUNK_BYTES = 64 * 1024;

/**
 * Returns true when a value looks like a Git commit/blob SHA.
 * Keeps GitHub API response validation readable at call sites.
 * @param {unknown} value
 * @returns {boolean}
 */
function isGitSha(value) {
    return /^[0-9a-f]{40}$/i.test(String(value || ""));
}

/**
 * Groups manifest chunks into GraphQL requests with bounded response sizes.
 * The manifest's byte counts let the browser use one request for today's data while automatically splitting future, larger histories.
 * @param {import("./model.js").ManifestChunk[]} chunks
 * @returns {import("./model.js").ManifestChunk[][]}
 */
function buildGraphqlChunkBatches(chunks) {
    /** @type {import("./model.js").ManifestChunk[][]} */
    const batches = [];
    /** @type {import("./model.js").ManifestChunk[]} */
    let current = [];
    let currentBytes = 0;

    for (const chunk of chunks) {
        const chunkBytes = typeof chunk.size === "number" && chunk.size >= 0 ? chunk.size : GRAPHQL_UNKNOWN_CHUNK_BYTES;
        const exceedsItemLimit = current.length >= GRAPHQL_CHUNK_BATCH_MAX_ITEMS;
        const exceedsByteLimit = current.length > 0 && currentBytes + chunkBytes > GRAPHQL_CHUNK_BATCH_MAX_BYTES;
        if (exceedsItemLimit || exceedsByteLimit) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(chunk);
        currentBytes += chunkBytes;
    }

    if (current.length) batches.push(current);
    return batches;
}

/**
 * @typedef {Object} RepoConfig
 * @description Identifies the GitHub repository and ref to read/write.
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref
 */

/**
 * @typedef {Object} SaveResult
 * @description Response payload for save operations.
 * @property {SaveFile[]} files
 */

/**
 * @typedef {Object} SaveFile
 * @description File payload to write via the data source.
 * @property {string} path
 * @property {string} content
 * @property {string} [sha]
 */

/**
 * @typedef {Object} GraphqlChunkBatchResult
 * @description Valid GraphQL blob texts plus any chunks that require the REST fallback.
 * @property {Map<string, string>} textsBySha
 * @property {import("./model.js").ManifestChunk[]} unresolvedChunks
 */

/**
 * Base data source interface for loading and saving.
 * Subclasses implement either GitHub API or local server workflows.
 */
export class DataSource {
    /**
     * Stores the repository configuration for later requests.
     * Used by the app to read or persist data.
     * @param {RepoConfig} config
     */
    constructor(config) {
        this.config = { ...config };
    }

    /**
     * Updates the configuration for subsequent requests.
     * Used by the app to read or persist data.
     * @param {RepoConfig} config
     * @returns {void}
     */
    setConfig(config) {
        this.config = { ...config };
    }

    /**
     * Loads the entries manifest JSON payload.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchManifest() {
        throw new Error("Not implemented");
    }

    /**
     * Fetches the raw JSON for a week chunk by sha/path.
     * Used by the app to read or persist data.
     * @param {import("./model.js").ManifestChunk} chunk
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        throw new Error("Not implemented");
    }

    /**
     * Fetches several week chunks through one logical data-source operation.
     * The default implementation preserves compatibility for local and future data sources by delegating to their single-chunk reader.
     * @param {import("./model.js").ManifestChunk[]} chunks
     * @returns {Promise<Map<string, string>>}
     */
    async fetchChunkTexts(chunks) {
        const textsBySha = new Map();
        for (const chunk of chunks) {
            if (textsBySha.has(chunk.sha)) continue;
            textsBySha.set(chunk.sha, await this.fetchChunkText(chunk));
        }
        return textsBySha;
    }

    /**
     * Loads the project definitions JSON payload.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchProjects() {
        throw new Error("Not implemented");
    }

    /**
     * Loads per-week required-hours settings JSON payload.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchWeekRequirements() {
        throw new Error("Not implemented");
    }

    /**
     * Loads the TODO document used by the task-management view.
     * Missing files are represented by an empty document so TODO management can be introduced without a repository migration gate.
     * @returns {Promise<Object>}
     */
    async fetchTodos() {
        throw new Error("Not implemented");
    }

    /**
     * Writes a set of files with a commit message, returning shas when available.
     * Used by the app to read or persist data.
     * @param {SaveFile[]} files
     * @param {string} message
     * @returns {Promise<SaveResult>}
     */
    async saveFiles(files, message) {
        throw new Error("Not implemented");
    }
}

/**
 * GitHub-backed data source.
 * Uses GraphQL for bulk week reads and the GitHub REST API for metadata, recovery reads, and commits.
 */
export class GitHubDataSource extends DataSource {
    /**
     * Creates a GitHub data source with an optional access token.
     * Used by the app to read or persist data.
     * @param {RepoConfig} config
     * @param {string} token
     */
    constructor(config, token) {
        super(config);
        this.token = token;
        this.lastKnownCommitSha = "";
    }

    /**
     * Clears cached branch state after repository configuration changes.
     * Prevents a remembered commit from one branch/repo being reused elsewhere.
     * @param {RepoConfig} config
     * @returns {void}
     */
    setConfig(config) {
        super.setConfig(config);
        this.lastKnownCommitSha = "";
    }

    /**
     * Updates the bearer token used for API calls.
     * Used by the app to read or persist data.
     * @param {string} token
     * @returns {void}
     */
    setToken(token) {
        this.token = token;
    }

    /**
     * Builds standard headers for GitHub API requests.
     * Cache directives belong in the Fetch API options because GitHub's CORS
     * policy does not allow Cache-Control or Pragma request headers.
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
     * Fetches JSON data and throws on non-2xx responses.
     * Used by the app to read or persist data.
     * @param {string} url
     * @returns {Promise<any>}
     */
    async fetchJson(url) {
        const resp = await fetch(url, { headers: this.buildHeaders("application/vnd.github+json"), cache: "no-store" });
        if (!resp.ok) {
            throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
        }
        return await resp.json();
    }

    /**
     * Sends a JSON request and returns the parsed JSON response.
     * Used by the app to read or persist data.
     * @param {string} url
     * @param {Object} options
     * @returns {Promise<any>}
     */
    async fetchJsonRequest(url, options) {
        const opts = options || {};
        const headers = this.buildHeaders(opts.accept || "application/vnd.github+json");
        /** @type {RequestInit} */
        const init = { method: opts.method || "GET", headers, cache: "no-store" };
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
     * Fetches raw text from the GitHub API.
     * Used by the app to read or persist data.
     * @param {string} url
     * @returns {Promise<string>}
     */
    async fetchRaw(url) {
        const resp = await fetch(url, { headers: this.buildHeaders("application/vnd.github.raw"), cache: "no-store" });
        if (!resp.ok) {
            throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
        }
        return await resp.text();
    }

    /**
     * Resolves the best base commit for a save operation.
     * If GitHub/browser caching returns the previous branch head shortly after
     * a successful save, the remembered head is compared against the returned
     * ref and used only when it is provably ahead.
     * @param {string} baseUrl
     * @param {string} refCommitSha
     * @returns {Promise<string>}
     */
    async resolveSaveBaseCommitSha(baseUrl, refCommitSha) {
        if (!isGitSha(refCommitSha)) {
            throw new Error("Failed to resolve branch ref.");
        }
        if (!isGitSha(this.lastKnownCommitSha) || this.lastKnownCommitSha === refCommitSha) {
            return refCommitSha;
        }

        try {
            const compare = await this.fetchJsonRequest(
                `${baseUrl}/compare/${encodeURIComponent(refCommitSha)}...${encodeURIComponent(this.lastKnownCommitSha)}`,
            );
            const status = String(compare?.status || "");
            if (status === "ahead" || status === "identical") {
                return this.lastKnownCommitSha;
            }
        } catch {
            // Fall back to the freshly fetched ref if comparison is unavailable.
        }

        this.lastKnownCommitSha = refCommitSha;
        return refCommitSha;
    }

    /**
     * Builds a contents API URL for a repository path.
     * Used by the app to read or persist data.
     * @param {string} repoPath
     * @returns {string}
     */
    buildContentsUrl(repoPath) {
        return `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(
            this.config.repo,
        )}/contents/${repoPath}?ref=${encodeURIComponent(this.config.ref)}`;
    }

    /**
     * Loads the manifest file from the repository.
     * Used by the app to read or persist data.
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
     * Fetches the raw chunk JSON text by blob sha.
     * Used by the app to read or persist data.
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
     * Builds a strongly bounded GraphQL query whose aliases map directly back to manifest chunks.
     * Blob OIDs are validated before interpolation, while owner and repository names remain ordinary GraphQL variables.
     * @param {import("./model.js").ManifestChunk[]} chunks
     * @returns {string}
     */
    buildChunkBatchQuery(chunks) {
        const fields = chunks.map(
            (chunk, index) =>
                `chunk${index}: object(oid: "${chunk.sha}") { ... on Blob { oid byteSize isBinary isTruncated text } }`,
        );
        return `query BulkWeekChunks($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
                ${fields.join("\n")}
            }
        }`;
    }

    /**
     * Fetches one prepared GraphQL batch and validates every returned blob against its manifest metadata.
     * Partial GraphQL responses remain useful: only missing, binary, truncated, or mismatched blobs are marked for REST recovery.
     * @param {import("./model.js").ManifestChunk[]} chunks
     * @returns {Promise<GraphqlChunkBatchResult>}
     */
    async fetchGraphqlChunkBatch(chunks) {
        const response = await this.fetchJsonRequest(GITHUB_GRAPHQL_URL, {
            method: "POST",
            body: {
                query: this.buildChunkBatchQuery(chunks),
                variables: { owner: this.config.owner, repo: this.config.repo },
            },
        });
        const repository = response?.data?.repository;
        if (!repository || typeof repository !== "object") {
            const messages = Array.isArray(response?.errors)
                ? response.errors.map((error) => String(error?.message || "")).filter(Boolean).join("; ")
                : "";
            throw new Error(`GitHub GraphQL chunk query failed${messages ? `: ${messages}` : "."}`);
        }

        const textsBySha = new Map();
        const unresolvedChunks = [];
        for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index];
            const blob = repository[`chunk${index}`];
            const expectedSize = typeof chunk.size === "number" && chunk.size >= 0 ? chunk.size : null;
            const valid =
                blob &&
                typeof blob === "object" &&
                String(blob.oid || "").toLowerCase() === chunk.sha.toLowerCase() &&
                blob.isBinary === false &&
                blob.isTruncated === false &&
                typeof blob.text === "string" &&
                (expectedSize === null || Number(blob.byteSize) === expectedSize);
            if (valid) {
                textsBySha.set(chunk.sha, blob.text);
            } else {
                unresolvedChunks.push(chunk);
            }
        }
        return { textsBySha, unresolvedChunks };
    }

    /**
     * Fetches one GraphQL batch, retries a failed large request as two smaller requests, and finally falls back to REST.
     * A partial GraphQL response uses REST only for unresolved blobs so successful bulk data is never downloaded twice.
     * @param {import("./model.js").ManifestChunk[]} chunks
     * @param {boolean} [allowSplit]
     * @returns {Promise<Map<string, string>>}
     */
    async fetchChunkBatchWithFallback(chunks, allowSplit = true) {
        try {
            const { textsBySha, unresolvedChunks } = await this.fetchGraphqlChunkBatch(chunks);
            if (unresolvedChunks.length) {
                const recovered = await super.fetchChunkTexts(unresolvedChunks);
                for (const [sha, text] of recovered) textsBySha.set(sha, text);
            }
            return textsBySha;
        } catch (error) {
            if (allowSplit && chunks.length > 1) {
                const midpoint = Math.ceil(chunks.length / 2);
                const first = await this.fetchChunkBatchWithFallback(chunks.slice(0, midpoint), false);
                const second = await this.fetchChunkBatchWithFallback(chunks.slice(midpoint), false);
                for (const [sha, text] of second) first.set(sha, text);
                return first;
            }
            return await super.fetchChunkTexts(chunks);
        }
    }

    /**
     * Bulk-loads all distinct cache-miss blobs through size-bounded GraphQL alias queries.
     * The returned SHA-keyed map lets the app retain one shared parsing and cache path for GitHub and local modes.
     * @param {import("./model.js").ManifestChunk[]} chunks
     * @returns {Promise<Map<string, string>>}
     */
    async fetchChunkTexts(chunks) {
        /** @type {Map<string, import("./model.js").ManifestChunk>} */
        const uniqueBySha = new Map();
        for (const chunk of chunks) {
            if (!isGitSha(chunk?.sha)) {
                throw new Error(`Invalid blob sha for ${String(chunk?.path || "week chunk")}`);
            }
            if (!uniqueBySha.has(chunk.sha)) uniqueBySha.set(chunk.sha, chunk);
        }

        const textsBySha = new Map();
        for (const batch of buildGraphqlChunkBatches([...uniqueBySha.values()])) {
            const batchTexts = await this.fetchChunkBatchWithFallback(batch);
            for (const [sha, text] of batchTexts) textsBySha.set(sha, text);
        }
        return textsBySha;
    }

    /**
     * Loads the projects.json file from the repository.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchProjects() {
        const raw = await this.fetchRaw(this.buildContentsUrl("data/projects.json"));
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error("Failed to parse projects.json");
        }
    }

    /**
     * Loads week-requirements.json from the repository.
     * Returns a default payload when the file does not exist yet.
     * @returns {Promise<Object>}
     */
    async fetchWeekRequirements() {
        try {
            const raw = await this.fetchRaw(this.buildContentsUrl("data/week-requirements.json"));
            return JSON.parse(raw);
        } catch (err) {
            const message = String(err || "");
            if (message.includes("404")) {
                return { default_required_hours: 40, generated_at: "", schema_version: 1, weeks: [] };
            }
            if (message.includes("Failed to parse")) {
                throw err;
            }
            throw new Error(`Failed to load week-requirements.json: ${message}`);
        }
    }

    /**
     * Loads data/todos.json through the authenticated GitHub contents API.
     * A repository without the optional file starts with an empty TODO document and will create it on first save.
     * @returns {Promise<Object>}
     */
    async fetchTodos() {
        try {
            const raw = await this.fetchRaw(this.buildContentsUrl("data/todos.json"));
            return JSON.parse(raw);
        } catch (err) {
            const message = String(err || "");
            if (message.includes("404")) {
                return { generated_at: "", schema_version: 3, todos: [] };
            }
            if (err instanceof SyntaxError) {
                throw new Error("Failed to parse todos.json");
            }
            throw new Error(`Failed to load todos.json: ${message}`);
        }
    }

    /**
     * Commits a set of files to the repository.
     * Used by the app to read or persist data.
     * @param {SaveFile[]} files
     * @param {string} message
     * @returns {Promise<SaveResult>}
     */
    async saveFiles(files, message) {
        if (!this.token) {
            throw new Error("Not logged in.");
        }
        const inputFiles = Array.isArray(files) ? files.filter((file) => file && file.path) : [];
        if (!inputFiles.length) {
            throw new Error("Nothing to save.");
        }
        const baseUrl = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
        const branch = String(this.config.ref || "").trim();
        if (!branch) {
            throw new Error("Missing branch ref.");
        }

        const refInfo = await this.fetchJsonRequest(`${baseUrl}/git/ref/heads/${encodeURIComponent(branch)}`);
        const refCommitSha = refInfo?.object?.sha;
        const baseCommitSha = await this.resolveSaveBaseCommitSha(baseUrl, refCommitSha);

        const baseCommit = await this.fetchJsonRequest(`${baseUrl}/git/commits/${encodeURIComponent(baseCommitSha)}`);
        const baseTreeSha = baseCommit?.tree?.sha;
        if (!isGitSha(baseTreeSha)) throw new Error("Failed to resolve base tree.");

        const updatedFiles = [];
        for (const file of inputFiles) {
            const blob = await this.fetchJsonRequest(`${baseUrl}/git/blobs`, {
                method: "POST",
                body: { content: file.content, encoding: "utf-8" },
            });
            const sha = blob?.sha;
            if (!isGitSha(sha)) {
                throw new Error(`Failed to create blob for ${file.path}`);
            }
            if (gitBlobSha1(file.content) !== sha) {
                throw new Error(`Blob sha mismatch for ${file.path}`);
            }
            updatedFiles.push({ ...file, sha });
        }

        const tree = [];
        for (const file of updatedFiles) {
            tree.push({ path: file.path, mode: "100644", type: "blob", sha: file.sha });
        }

        const treeRes = await this.fetchJsonRequest(`${baseUrl}/git/trees`, {
            method: "POST",
            body: { base_tree: baseTreeSha, tree },
        });
        const newTreeSha = treeRes?.sha;
        if (!isGitSha(newTreeSha)) throw new Error("Failed to create tree.");

        const messageText = String(message || "").trim() || "Update timetracking data";

        const commitRes = await this.fetchJsonRequest(`${baseUrl}/git/commits`, {
            method: "POST",
            body: { message: messageText, tree: newTreeSha, parents: [baseCommitSha] },
        });
        const newCommitSha = commitRes?.sha;
        if (!isGitSha(newCommitSha)) throw new Error("Failed to create commit.");

        await this.fetchJsonRequest(`${baseUrl}/git/refs/heads/${encodeURIComponent(branch)}`, {
            method: "PATCH",
            body: { sha: newCommitSha, force: false },
        });

        this.lastKnownCommitSha = newCommitSha;
        return { files: updatedFiles };
    }

    /**
     * Checks repository and user access with the current token.
     * Used by the app to read or persist data.
     * @returns {Promise<{repoInfo: any, userInfo: any}>}
     */
    async checkConnection() {
        const repoRequest = this.fetchJson(
            `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`,
        );
        const userRequest = this.fetchJson("https://api.github.com/user").catch(() => null);
        const [repoInfo, userInfo] = await Promise.all([repoRequest, userRequest]);
        return { repoInfo, userInfo };
    }
}

/**
 * Local server data source.
 * Talks to the lightweight Python server via HTTP.
 */
export class LocalDataSource extends DataSource {
    constructor() {
        super({ owner: "", repo: "", ref: "" });
    }

    /**
     * Builds a URL relative to the repo root for local fetches.
     * Used by the app to read or persist data.
     * @param {string} repoPath
     * @returns {string}
     */
    buildLocalUrl(repoPath) {
        const clean = String(repoPath || "").replace(/^\/+/, "");
        return new URL(`../${clean}`, window.location.href).toString();
    }

    /**
     * Loads the local manifest file without caching.
     * Used by the app to read or persist data.
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
     * Fetches the raw week JSON from the local filesystem server.
     * Used by the app to read or persist data.
     * @param {import("./model.js").ManifestChunk} chunk
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        const resp = await fetch(this.buildLocalUrl(chunk.path), { cache: "no-store" });
        if (!resp.ok) throw new Error(`Local fetch failed (${resp.status}): ${chunk.path}`);
        return await resp.text();
    }

    /**
     * Loads the local projects.json file without caching.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchProjects() {
        const resp = await fetch(this.buildLocalUrl("data/projects.json"), { cache: "no-store" });
        if (!resp.ok) {
            throw new Error(`Local projects.json not found (${resp.status}).`);
        }
        const raw = await resp.text();
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error("Failed to parse projects.json");
        }
    }

    /**
     * Loads local week-requirements.json without caching.
     * Returns a default payload when the file does not exist yet.
     * @returns {Promise<Object>}
     */
    async fetchWeekRequirements() {
        const resp = await fetch(this.buildLocalUrl("data/week-requirements.json"), { cache: "no-store" });
        if (!resp.ok) {
            if (resp.status === 404) {
                return { default_required_hours: 40, generated_at: "", schema_version: 1, weeks: [] };
            }
            throw new Error(`Local week-requirements.json not found (${resp.status}).`);
        }

        const raw = await resp.text();
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error("Failed to parse week-requirements.json");
        }
    }

    /**
     * Loads the local data/todos.json document without browser caching.
     * A missing file behaves like an empty task list and is created through POST /save on first persistence.
     * @returns {Promise<Object>}
     */
    async fetchTodos() {
        const resp = await fetch(this.buildLocalUrl("data/todos.json"), { cache: "no-store" });
        if (!resp.ok) {
            if (resp.status === 404) {
                return { generated_at: "", schema_version: 3, todos: [] };
            }
            throw new Error(`Local todos.json not found (${resp.status}).`);
        }

        const raw = await resp.text();
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error("Failed to parse todos.json");
        }
    }

    /**
     * Writes files through the local /save endpoint.
     * Used by the app to read or persist data.
     * @param {SaveFile[]} files
     * @param {string} message
     * @returns {Promise<SaveResult>}
     */
    async saveFiles(files, message) {
        const inputFiles = Array.isArray(files) ? files.filter((file) => file && file.path) : [];
        if (!inputFiles.length) {
            throw new Error("Nothing to save.");
        }

        const body = {
            files: inputFiles.map((file) => ({ path: file.path, content: file.content })),
            message: String(message || "").trim(),
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

        return { files: inputFiles };
    }
}
