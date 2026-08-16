import { gitBlobSha1 } from "./utils.js";
import { normalizeRepositoryPath } from "./model.js";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GRAPHQL_CHUNK_BATCH_MAX_BYTES = 8 * 1024 * 1024;
const GRAPHQL_CHUNK_BATCH_MAX_ITEMS = 200;
const GRAPHQL_UNKNOWN_CHUNK_BYTES = 64 * 1024;

/**
 * Parses one repository document and adds its logical name to malformed-JSON errors.
 * Data sources share this helper so local and hosted modes fail consistently before model validation.
 * @param {string} raw Raw UTF-8 JSON text.
 * @param {string} label Human-readable document name.
 * @returns {Object}
 */
function parseJsonDocument(raw, label) {
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(`Failed to parse ${label}`);
    }
}

/**
 * URL-encodes each segment of a validated repository-relative path while retaining path separators.
 * This supports spaces and non-ASCII filenames without allowing a configured path to alter surrounding API query parameters.
 * @param {string} repoPath Validated repository-relative path.
 * @returns {string}
 */
function encodeRepositoryPath(repoPath) {
    return repoPath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

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
 * Validates the provider-neutral `owner/repository` identifier stored in project and TODO external references.
 * Restricting it to exactly two safe path segments prevents integration metadata from altering the GitHub API or web origin.
 * @param {string} repository GitHub repository identity in `owner/repository` form.
 * @returns {{owner: string, repo: string}}
 */
export function parseGitHubRepositoryId(repository) {
    const parts = String(repository || "").trim().split("/");
    const segmentPattern = /^[A-Za-z0-9_.-]+$/;
    if (parts.length !== 2 || !segmentPattern.test(parts[0]) || !segmentPattern.test(parts[1])) {
        throw new Error(`Invalid GitHub repository binding: ${String(repository || "(empty)")}`);
    }
    return { owner: parts[0], repo: parts[1] };
}

/**
 * Builds the public browser URL for a linked GitHub issue after validating both repository and issue identity.
 * @param {string} repository GitHub repository identity in `owner/repository` form.
 * @param {number | string} issueNumber Positive GitHub issue number.
 * @returns {string}
 */
export function buildGitHubIssueUrl(repository, issueNumber) {
    const target = parseGitHubRepositoryId(repository);
    const number = Number(issueNumber);
    if (!Number.isInteger(number) || number <= 0) throw new Error("Invalid GitHub issue number.");
    return `https://github.com/${target.owner}/${target.repo}/issues/${number}`;
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
 * @property {string} [workspacePath]
 * @property {string} [localWorkspaceId] Local server workspace selector; never sent to a hosted provider.
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
 * @typedef {Object} GitHubIssueWrite
 * @description User-facing issue fields synchronized from an issue-backed zeitplural TODO.
 * @property {string} [title]
 * @property {string} [body]
 * @property {string[]} [labels]
 * @property {"open" | "closed"} [state]
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
        /** @type {import("./model.js").Workspace | null} */
        this.workspace = null;
    }

    /**
     * Updates the configuration for subsequent requests.
     * Used by the app to read or persist data.
     * @param {RepoConfig} config
     * @returns {void}
     */
    setConfig(config) {
        this.config = { ...config };
        this.workspace = null;
    }

    /**
     * Returns the validated repository path used to bootstrap workspace discovery.
     * The path belongs to connection configuration rather than zeitplural.json because it must be known before that document can be loaded.
     * @returns {string}
     */
    getWorkspaceConfigPath() {
        return normalizeRepositoryPath(this.config.workspacePath || "zeitplural.json", "workspacePath");
    }

    /**
     * Installs the validated workspace model used by all subsequent document operations.
     * Requiring this explicit step makes accidental fallback to historical hard-coded data paths impossible.
     * @param {import("./model.js").Workspace} workspace Parsed workspace model.
     * @returns {void}
     */
    setWorkspace(workspace) {
        this.workspace = workspace;
    }

    /**
     * Returns the active workspace or fails when the bootstrap document has not yet been loaded.
     * @returns {import("./model.js").Workspace}
     */
    getWorkspace() {
        if (!this.workspace) throw new Error("Workspace configuration has not been loaded.");
        return this.workspace;
    }

    /**
     * Returns the shared project-taxonomy document path declared by the workspace.
     * @returns {string}
     */
    getProjectsPath() {
        return this.getWorkspace().getResourcePath("projects");
    }

    /**
     * Returns the directory containing normalized weekly entry documents.
     * @returns {string}
     */
    getEntriesDirectory() {
        return this.getWorkspace().getComponentPath("time_tracking", "entries");
    }

    /**
     * Returns the normalized entry-manifest document path.
     * @returns {string}
     */
    getEntriesManifestPath() {
        return this.getWorkspace().getComponentPath("time_tracking", "manifest");
    }

    /**
     * Returns the weekly requirements document path.
     * @returns {string}
     */
    getWeekRequirementsPath() {
        return this.getWorkspace().getComponentPath("time_tracking", "week_requirements");
    }

    /**
     * Returns the TODO component document path.
     * @returns {string}
     */
    getTodosPath() {
        return this.getWorkspace().getComponentPath("todos", "document");
    }

    /**
     * Loads the root workspace bootstrap document before any component-specific data.
     * @returns {Promise<Object>}
     */
    async fetchWorkspace() {
        throw new Error("Not implemented");
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

    /**
     * Reports whether this data source can use the active credential for direct GitHub issue writes.
     * Local and future non-GitHub providers return false so the core TODO save path remains shared without pretending to have remote capabilities.
     * @returns {boolean}
     */
    supportsGitHubIssueSync() {
        return false;
    }

    /**
     * Creates a GitHub issue in an explicitly bound repository.
     * Subclasses without GitHub credentials reject the operation; callers should check `supportsGitHubIssueSync` first.
     * @param {string} repository GitHub repository identity in `owner/repository` form.
     * @param {GitHubIssueWrite} issue Fields for the new issue.
     * @returns {Promise<any>}
     */
    async createGitHubIssue(repository, issue) {
        void repository;
        void issue;
        throw new Error("GitHub issue synchronization is not available for this data source.");
    }

    /**
     * Updates an existing GitHub issue in an explicitly bound repository.
     * @param {string} repository GitHub repository identity in `owner/repository` form.
     * @param {number | string} issueNumber Positive GitHub issue number.
     * @param {GitHubIssueWrite} issue Changed issue fields.
     * @returns {Promise<any>}
     */
    async updateGitHubIssue(repository, issueNumber, issue) {
        void repository;
        void issueNumber;
        void issue;
        throw new Error("GitHub issue synchronization is not available for this data source.");
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
     * Confirms that this source has the authenticated GitHub transport required by issue-backed TODOs.
     * Fine-grained token permissions are still enforced by GitHub per target repository when a write occurs.
     * @returns {boolean}
     */
    supportsGitHubIssueSync() {
        return Boolean(this.token);
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
     * Creates one issue in the GitHub repository declared by a workspace project binding.
     * The target is independent of the workspace-data repository, allowing private tasks to mirror into the public application repository with the same fine-grained PAT.
     * @param {string} repository GitHub repository identity in `owner/repository` form.
     * @param {GitHubIssueWrite} issue Initial title, body, labels, and optional state.
     * @returns {Promise<any>}
     */
    async createGitHubIssue(repository, issue) {
        if (!this.token) throw new Error("Not logged in.");
        const target = parseGitHubRepositoryId(repository);
        const body = {
            title: String(issue?.title || "").trim(),
            body: String(issue?.body || ""),
            labels: Array.isArray(issue?.labels) ? issue.labels.map((label) => String(label)) : [],
        };
        if (!body.title) throw new Error("A GitHub issue needs a title.");
        return await this.fetchJsonRequest(
            `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues`,
            { method: "POST", body },
        );
    }

    /**
     * Patches only supplied fields on a linked GitHub issue.
     * Completion and reopening use GitHub's ordinary issue state while title, description, and task labels remain controlled by the workspace TODO.
     * @param {string} repository GitHub repository identity in `owner/repository` form.
     * @param {number | string} issueNumber Positive GitHub issue number.
     * @param {GitHubIssueWrite} issue Changed issue fields.
     * @returns {Promise<any>}
     */
    async updateGitHubIssue(repository, issueNumber, issue) {
        if (!this.token) throw new Error("Not logged in.");
        const target = parseGitHubRepositoryId(repository);
        const number = Number(issueNumber);
        if (!Number.isInteger(number) || number <= 0) throw new Error("Invalid GitHub issue number.");
        /** @type {GitHubIssueWrite} */
        const body = {};
        if (issue?.title !== undefined) body.title = String(issue.title).trim();
        if (issue?.body !== undefined) body.body = String(issue.body);
        if (issue?.labels !== undefined) {
            body.labels = Array.isArray(issue.labels) ? issue.labels.map((label) => String(label)) : [];
        }
        if (issue?.state === "open" || issue?.state === "closed") body.state = issue.state;
        return await this.fetchJsonRequest(
            `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${number}`,
            { method: "PATCH", body },
        );
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
        const path = normalizeRepositoryPath(repoPath, "repository path");
        return `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(
            this.config.repo,
        )}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(this.config.ref)}`;
    }

    /**
     * Loads zeitplural.json from the configured repository and ref.
     * This is the only read that occurs before workspace-owned paths become available.
     * @returns {Promise<Object>}
     */
    async fetchWorkspace() {
        const raw = await this.fetchRaw(this.buildContentsUrl(this.getWorkspaceConfigPath()));
        return parseJsonDocument(raw, "zeitplural.json");
    }

    /**
     * Loads the manifest file from the repository.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchManifest() {
        const raw = await this.fetchRaw(this.buildContentsUrl(this.getEntriesManifestPath()));
        return parseJsonDocument(raw, "entries-manifest.json");
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
        const raw = await this.fetchRaw(this.buildContentsUrl(this.getProjectsPath()));
        return parseJsonDocument(raw, "projects.json");
    }

    /**
     * Loads week-requirements.json from the repository.
     * Returns a default payload when the file does not exist yet.
     * @returns {Promise<Object>}
     */
    async fetchWeekRequirements() {
        try {
            const raw = await this.fetchRaw(this.buildContentsUrl(this.getWeekRequirementsPath()));
            return parseJsonDocument(raw, "week-requirements.json");
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
            const raw = await this.fetchRaw(this.buildContentsUrl(this.getTodosPath()));
            return parseJsonDocument(raw, "todos.json");
        } catch (err) {
            const message = String(err || "");
            if (message.includes("404")) {
                return { generated_at: "", schema_version: 3, todos: [] };
            }
            if (message.includes("Failed to parse")) throw err;
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

        const messageText = String(message || "").trim() || "Update zeitplural workspace";

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
    /**
     * Creates a local source whose workspace files are served through the dedicated /workspace endpoint.
     * @param {RepoConfig} [config] Bootstrap path configuration shared with hosted modes.
     */
    constructor(config = { owner: "", repo: "", ref: "", workspacePath: "zeitplural.json" }) {
        super({ owner: "", repo: "", ref: "", ...config });
    }

    /**
     * Adds the active local workspace selector to a same-origin server endpoint.
     * The selector is the public workspace_id from zeitplural.json rather than a filesystem path, so local routes never disclose checkout locations.
     * @param {string} path Absolute local-server endpoint path.
     * @returns {URL}
     */
    buildLocalServerUrl(path) {
        const url = new URL(path, window.location.origin);
        const workspaceId = String(this.config.localWorkspaceId || "").trim();
        if (workspaceId) url.searchParams.set("workspace", workspaceId);
        return url;
    }

    /**
     * Lists every workspace explicitly exposed by the local development server.
     * This bootstrap endpoint enables the same in-app switcher used for hosted repositories while keeping filesystem authority in server.py.
     * @returns {Promise<{default_workspace_id: string, workspaces: Array<{workspace_id: string, name: string, workspace_path: string}>}>}
     */
    async fetchAvailableWorkspaces() {
        const response = await fetch(new URL("/local-workspaces", window.location.origin), { cache: "no-store" });
        if (!response.ok) throw new Error(`Could not list local workspaces (${response.status}).`);
        const payload = await response.json();
        const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
        return {
            default_workspace_id: String(payload?.default_workspace_id || ""),
            workspaces: workspaces
                .map((item) => ({
                    workspace_id: String(item?.workspace_id || "").trim(),
                    name: String(item?.name || "").trim(),
                    workspace_path: String(item?.workspace_path || "zeitplural.json").trim(),
                }))
                .filter((item) => item.workspace_id),
        };
    }

    /**
     * Builds a URL relative to the repo root for local fetches.
     * Used by the app to read or persist data.
     * @param {string} repoPath
     * @returns {string}
     */
    buildWorkspaceUrl(repoPath) {
        const path = normalizeRepositoryPath(repoPath, "workspace path");
        return this.buildLocalServerUrl(`/workspace/${encodeRepositoryPath(path)}`).toString();
    }

    /**
     * Returns the fixed same-origin endpoint used for local workspace writes.
     * @returns {string}
     */
    buildSaveUrl() {
        return new URL("/save", window.location.origin).toString();
    }

    /**
     * Loads the root workspace configuration from the local workspace repository.
     * @returns {Promise<Object>}
     */
    async fetchWorkspace() {
        const resp = await fetch(this.buildLocalServerUrl("/workspace-config"), { cache: "no-store" });
        if (!resp.ok) {
            throw new Error(`Local zeitplural.json not found (${resp.status}). Start server.py with --workspace PATH.`);
        }
        return parseJsonDocument(await resp.text(), "zeitplural.json");
    }

    /**
     * Loads the local manifest file without caching.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchManifest() {
        const resp = await fetch(this.buildWorkspaceUrl(this.getEntriesManifestPath()), { cache: "no-store" });
        if (!resp.ok) {
            throw new Error(`Local manifest not found (${resp.status}). Run the local server from repo root: python3 server.py`);
        }
        return parseJsonDocument(await resp.text(), "entries-manifest.json");
    }

    /**
     * Fetches the raw week JSON from the local filesystem server.
     * Used by the app to read or persist data.
     * @param {import("./model.js").ManifestChunk} chunk
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        const resp = await fetch(this.buildWorkspaceUrl(chunk.path), { cache: "no-store" });
        if (!resp.ok) throw new Error(`Local fetch failed (${resp.status}): ${chunk.path}`);
        return await resp.text();
    }

    /**
     * Loads the local projects.json file without caching.
     * Used by the app to read or persist data.
     * @returns {Promise<Object>}
     */
    async fetchProjects() {
        const resp = await fetch(this.buildWorkspaceUrl(this.getProjectsPath()), { cache: "no-store" });
        if (!resp.ok) {
            throw new Error(`Local projects.json not found (${resp.status}).`);
        }
        return parseJsonDocument(await resp.text(), "projects.json");
    }

    /**
     * Loads local week-requirements.json without caching.
     * Returns a default payload when the file does not exist yet.
     * @returns {Promise<Object>}
     */
    async fetchWeekRequirements() {
        const resp = await fetch(this.buildWorkspaceUrl(this.getWeekRequirementsPath()), { cache: "no-store" });
        if (!resp.ok) {
            if (resp.status === 404) {
                return { default_required_hours: 40, generated_at: "", schema_version: 1, weeks: [] };
            }
            throw new Error(`Local week-requirements.json not found (${resp.status}).`);
        }

        return parseJsonDocument(await resp.text(), "week-requirements.json");
    }

    /**
     * Loads the local data/todos.json document without browser caching.
     * A missing file behaves like an empty task list and is created through POST /save on first persistence.
     * @returns {Promise<Object>}
     */
    async fetchTodos() {
        const resp = await fetch(this.buildWorkspaceUrl(this.getTodosPath()), { cache: "no-store" });
        if (!resp.ok) {
            if (resp.status === 404) {
                return { generated_at: "", schema_version: 3, todos: [] };
            }
            throw new Error(`Local todos.json not found (${resp.status}).`);
        }

        return parseJsonDocument(await resp.text(), "todos.json");
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
            workspace_id: String(this.config.localWorkspaceId || "").trim(),
        };

        let resp;
        try {
            resp = await fetch(this.buildSaveUrl(), {
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
