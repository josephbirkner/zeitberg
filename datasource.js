import { cloneJson, gitBlobSha1 } from "./utils.js";
import { normalizeRepositoryPath } from "./model.js";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GRAPHQL_CHUNK_BATCH_MAX_BYTES = 8 * 1024 * 1024;
const GRAPHQL_CHUNK_BATCH_MAX_ITEMS = 200;
const GRAPHQL_UNKNOWN_CHUNK_BYTES = 64 * 1024;
const HOSTED_CHUNK_CONCURRENCY = 6;

/**
 * Represents one non-successful response from a hosted Git provider.
 * Keeping the numeric status separate from the display message lets optional workspace documents distinguish a genuine 404 from transport and authorization failures without parsing prose.
 */
export class ProviderApiError extends Error {
    /**
     * Creates a bounded provider error suitable for the application error surface.
     * @param {string} provider Human-readable provider name.
     * @param {number} status HTTP response status.
     * @param {string} detail Provider-supplied diagnostic text with credentials already excluded.
     */
    constructor(provider, status, detail) {
        const suffix = String(detail || "").replace(/\s+/g, " ").trim().slice(0, 500);
        super(`${provider} API error ${status}${suffix ? `: ${suffix}` : ""}`);
        this.name = "ProviderApiError";
        this.status = status;
    }
}

/**
 * Describes a workspace bootstrap document that can be created or repaired by the application.
 * Authentication, repository access, and transport failures deliberately remain ordinary provider errors; only a missing or syntactically invalid bootstrap file enters the workspace-setup flow.
 */
export class WorkspaceConfigurationError extends Error {
    /**
     * Creates a recoverable workspace-configuration diagnostic.
     * @param {"missing" | "invalid_json"} reason Machine-readable setup reason.
     * @param {string} path Repository-relative bootstrap path.
     */
    constructor(reason, path) {
        const normalizedPath = String(path || "zeitberg.json");
        const message =
            reason === "missing"
                ? `${normalizedPath} does not exist yet.`
                : `${normalizedPath} is not valid JSON.`;
        super(message);
        this.name = "WorkspaceConfigurationError";
        this.reason = reason;
        this.path = normalizedPath;
    }
}

/**
 * Encodes arbitrary UTF-8 repository text for APIs whose file endpoints require base64 content.
 * Chunking avoids exceeding JavaScript's argument limit when a future workspace document becomes large.
 * @param {string} value Plain repository file content.
 * @returns {string}
 */
function encodeUtf8Base64(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

/**
 * Decodes provider-returned base64 into UTF-8 and rejects malformed or non-textual payloads.
 * @param {unknown} value Encoded response field.
 * @param {string} label Repository path used in diagnostics.
 * @returns {string}
 */
function decodeUtf8Base64(value, label) {
    const encoded = String(value || "").replace(/\s+/g, "");
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new Error(`${label} did not contain valid base64 text.`);
    }
    let binary;
    try {
        binary = atob(encoded);
    } catch {
        throw new Error(`${label} did not contain valid base64 text.`);
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`${label} is not valid UTF-8 text.`);
    }
}

/**
 * Parses a repository browser URL into API-safe provider coordinates.
 * GitLab permits nested groups, while GitHub and Forgejo-family repositories use exactly owner/repository; all variants reject credentials and active URL data.
 * @param {string} repositoryUrl Full HTTPS repository URL.
 * @param {"gitlab" | "codeberg" | "forgejo" | "custom"} provider Provider protocol and host policy.
 * @returns {{origin: string, owner: string, repo: string, repositoryPath: string, repositoryUrl: string}}
 */
export function parseHostedRepositoryUrl(repositoryUrl, provider) {
    let url;
    try {
        url = new URL(String(repositoryUrl || "").trim());
    } catch {
        throw new Error("Enter a valid HTTPS repository URL.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error("Repository URLs must use HTTPS and contain no credentials, query, or fragment.");
    }
    const expectedHost = provider === "gitlab" ? "gitlab.com" : provider === "codeberg" ? "codeberg.org" : "";
    if (expectedHost && url.hostname.toLowerCase() !== expectedHost) {
        throw new Error(`The ${provider} provider requires a ${expectedHost} repository URL.`);
    }
    const parts = url.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .map((part) => {
            try {
                return decodeURIComponent(part);
            } catch {
                throw new Error("The repository URL contains an invalid path escape.");
            }
        });
    if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, "");
    const segmentPattern = /^[A-Za-z0-9_.-]+$/;
    const needsTwoParts = provider === "codeberg" || provider === "forgejo";
    if (parts.length < 2 || (needsTwoParts && parts.length !== 2) || parts.some((part) => !segmentPattern.test(part))) {
        const shape = needsTwoParts ? "exactly one owner and repository" : "a namespace and repository";
        throw new Error(`The ${provider} repository URL must identify ${shape}.`);
    }
    url.pathname = `/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
    return {
        origin: url.origin,
        owner: parts[0],
        repo: parts[parts.length - 1],
        repositoryPath: parts.join("/"),
        repositoryUrl: url.toString().replace(/\/$/, ""),
    };
}

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
 * Parses the bootstrap document while preserving the distinction between repairable JSON syntax and unrelated repository failures.
 * @param {string} raw Raw UTF-8 workspace configuration.
 * @param {string} path Repository-relative bootstrap path used in setup diagnostics.
 * @returns {Object}
 */
function parseWorkspaceDocument(raw, path) {
    try {
        return JSON.parse(raw);
    } catch {
        throw new WorkspaceConfigurationError("invalid_json", path);
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
 * @description Identifies one provider repository and ref to read/write while retaining GitHub's historical owner/repo fields for compatibility.
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref
 * @property {string} [workspacePath]
 * @property {string} [localWorkspaceId] Local server workspace selector; never sent to a hosted provider.
 * @property {"github" | "gitlab" | "codeberg" | "forgejo" | "custom" | "local"} [provider]
 * @property {string} [repositoryUrl] Full credential-free repository URL used by non-GitHub providers.
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
 * @description User-facing issue fields synchronized from an issue-backed zeitberg TODO.
 * @property {string} [title]
 * @property {string} [body]
 * @property {string[]} [labels]
 * @property {"open" | "closed"} [state]
 */

/**
 * @typedef {Object} GitHubIssueCachePage
 * @description One conditionally reusable page from GitHub's all-issues REST collection.
 * @property {number} page
 * @property {string} etag
 * @property {boolean} hasNext
 * @property {Object[]} issues
 */

/**
 * @typedef {Object} GitHubIssueCollection
 * @description Complete non-pull-request issue inventory plus page metadata suitable for IndexedDB caching.
 * @property {Object[]} issues
 * @property {GitHubIssueCachePage[]} pages
 * @property {boolean} usedCachedPages
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
     * The path belongs to connection configuration rather than zeitberg.json because it must be known before that document can be loaded.
     * @returns {string}
     */
    getWorkspaceConfigPath() {
        return normalizeRepositoryPath(this.config.workspacePath || "zeitberg.json", "workspacePath");
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
     * Removes a previously loaded workspace model while retaining repository coordinates and save state.
     * A failed bootstrap reload uses this before presenting setup so stale component paths cannot influence initialization writes.
     * @returns {void}
     */
    clearWorkspace() {
        this.workspace = null;
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
     * Returns the provider-neutral expense ledger document path.
     * @returns {string}
     */
    getExpensesPath() {
        return this.getWorkspace().getComponentPath("expenses", "document");
    }

    /**
     * Returns the integrity manifest path paired with the expense ledger.
     * @returns {string}
     */
    getExpensesManifestPath() {
        return this.getWorkspace().getComponentPath("expenses", "manifest");
    }

    /**
     * Loads the root workspace bootstrap document before any component-specific data.
     * @returns {Promise<Object>}
     */
    async fetchWorkspace() {
        throw new Error("Not implemented");
    }

    /**
     * Checks whether one repository document already exists without interpreting its contents.
     * Workspace setup uses this operation to seed only absent component resources and therefore never replace user data merely because a component was enabled.
     * @param {string} repoPath Repository-relative document path.
     * @returns {Promise<boolean>}
     */
    async repositoryFileExists(repoPath) {
        void repoPath;
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
     * Loads the exact UTF-8 expense document text so its Git blob hash can be checked before parsing.
     * @returns {Promise<string>}
     */
    async fetchExpensesText() {
        throw new Error("Not implemented");
    }

    /**
     * Loads the expense integrity and summary manifest.
     * @returns {Promise<Object>}
     */
    async fetchExpensesManifest() {
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
     * Creates a private repository for onboarding when the selected provider supports a fully static public-client flow.
     * GitHub and local sources retain their existing manual setup; GitLab and Forgejo override this operation.
     * @param {string} name Repository name/path.
     * @param {string} [description] Optional repository description.
     * @returns {Promise<{repositoryUrl: string, repoInfo: any}>}
     */
    async createPrivateRepository(name, description = "Private zeitberg workspace") {
        void name;
        void description;
        throw new Error("Repository creation is not available for this provider.");
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

    /**
     * Loads every open and closed issue in a bound GitHub repository, excluding pull requests.
     * @param {string} repository GitHub owner/repository identity.
     * @param {GitHubIssueCachePage[]} [cachedPages] Previously cached conditional pages.
     * @returns {Promise<GitHubIssueCollection>}
     */
    async fetchGitHubIssues(repository, cachedPages = []) {
        void repository;
        void cachedPages;
        throw new Error("GitHub issue synchronization is not available for this data source.");
    }

    /**
     * Loads one current issue immediately before an optimistic update.
     * @param {string} repository GitHub owner/repository identity.
     * @param {number | string} issueNumber Positive issue number.
     * @returns {Promise<Object>}
     */
    async fetchGitHubIssue(repository, issueNumber) {
        void repository;
        void issueNumber;
        throw new Error("GitHub issue synchronization is not available for this data source.");
    }

    /**
     * Loads repository visibility and viewer-level capability metadata for project settings.
     * @param {string} repository GitHub owner/repository identity.
     * @returns {Promise<Object>}
     */
    async fetchGitHubRepositoryInfo(repository) {
        void repository;
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
     * Loads a complete issue collection using stable 100-row pages and conditional ETags.
     * Pull requests are removed because GitHub's REST issues endpoint intentionally returns both resource kinds.
     * @param {string} repository GitHub owner/repository identity.
     * @param {GitHubIssueCachePage[]} [cachedPages] Previously cached pages keyed by page number.
     * @returns {Promise<GitHubIssueCollection>}
     */
    async fetchGitHubIssues(repository, cachedPages = []) {
        if (!this.token) throw new Error("Not logged in.");
        const target = parseGitHubRepositoryId(repository);
        const cachedByPage = new Map(
            (Array.isArray(cachedPages) ? cachedPages : [])
                .filter((page) => Number.isSafeInteger(page?.page) && page.page > 0)
                .map((page) => [page.page, page]),
        );
        const pages = [];
        const issues = [];
        let pageNumber = 1;
        let usedCachedPages = false;
        while (pageNumber <= 1000) {
            const cached = cachedByPage.get(pageNumber) || null;
            const headers = this.buildHeaders("application/vnd.github+json");
            if (cached?.etag) headers["If-None-Match"] = cached.etag;
            const url = new URL(
                `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues`,
            );
            url.searchParams.set("state", "all");
            url.searchParams.set("sort", "created");
            url.searchParams.set("direction", "asc");
            url.searchParams.set("per_page", "100");
            url.searchParams.set("page", String(pageNumber));
            const response = await fetch(url, { headers, cache: "no-store" });
            let pageIssues;
            let etag;
            let hasNext;
            if (response.status === 304 && cached) {
                pageIssues = cached.issues;
                etag = cached.etag;
                hasNext = cached.hasNext;
                usedCachedPages = true;
            } else {
                if (!response.ok) throw new ProviderApiError("GitHub", response.status, await response.text());
                const payload = await response.json();
                if (!Array.isArray(payload)) throw new Error("GitHub returned an invalid issue page.");
                pageIssues = payload.filter((issue) => issue && typeof issue === "object" && !("pull_request" in issue));
                etag = response.headers.get("ETag") || "";
                hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get("Link") || "");
            }
            const normalizedPage = {
                page: pageNumber,
                etag,
                hasNext,
                issues: cloneJson(pageIssues),
            };
            pages.push(normalizedPage);
            issues.push(...normalizedPage.issues);
            if (!hasNext) return { issues, pages, usedCachedPages };
            pageNumber += 1;
        }
        throw new Error("GitHub issue pagination exceeded the safety limit.");
    }

    /**
     * Loads one current issue for conflict detection immediately before a patch.
     * @param {string} repository GitHub owner/repository identity.
     * @param {number | string} issueNumber Positive issue number.
     * @returns {Promise<Object>}
     */
    async fetchGitHubIssue(repository, issueNumber) {
        if (!this.token) throw new Error("Not logged in.");
        const target = parseGitHubRepositoryId(repository);
        const number = Number(issueNumber);
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid GitHub issue number.");
        return await this.fetchJsonRequest(
            `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${number}`,
        );
    }

    /**
     * Loads visibility and viewer permission metadata displayed beside a project binding.
     * Fine-grained issue-write scope can only be conclusively verified by GitHub when a write is attempted, which the returned metadata states explicitly.
     * @param {string} repository GitHub owner/repository identity.
     * @returns {Promise<Object>}
     */
    async fetchGitHubRepositoryInfo(repository) {
        if (!this.token) throw new Error("Not logged in.");
        const target = parseGitHubRepositoryId(repository);
        return await this.fetchJsonRequest(
            `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`,
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
            throw new ProviderApiError("GitHub", resp.status, await resp.text());
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
     * Loads zeitberg.json from the configured repository and ref.
     * This is the only read that occurs before workspace-owned paths become available.
     * @returns {Promise<Object>}
     */
    async fetchWorkspace() {
        const path = this.getWorkspaceConfigPath();
        try {
            const raw = await this.fetchRaw(this.buildContentsUrl(path));
            return parseWorkspaceDocument(raw, path);
        } catch (error) {
            if (error instanceof ProviderApiError && error.status === 404) {
                throw new WorkspaceConfigurationError("missing", path);
            }
            throw error;
        }
    }

    /**
     * Checks for an existing GitHub repository document through the same authenticated raw-content endpoint used by ordinary reads.
     * @param {string} repoPath Repository-relative document path.
     * @returns {Promise<boolean>}
     */
    async repositoryFileExists(repoPath) {
        try {
            await this.fetchRaw(this.buildContentsUrl(repoPath));
            return true;
        } catch (error) {
            if (error instanceof ProviderApiError && error.status === 404) return false;
            throw error;
        }
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
                return { generated_at: "", github_overlays: [], schema_version: 4, todos: [] };
            }
            if (message.includes("Failed to parse")) throw err;
            throw new Error(`Failed to load todos.json: ${message}`);
        }
    }

    /**
     * Loads exact expense-ledger bytes through GitHub's authenticated contents API.
     * Keeping the response as text allows ExpenseManifest to verify the same Git blob representation used by saves.
     * @returns {Promise<string>}
     */
    async fetchExpensesText() {
        return await this.fetchRaw(this.buildContentsUrl(this.getExpensesPath()));
    }

    /**
     * Loads and parses expense integrity metadata through GitHub's authenticated contents API.
     * @returns {Promise<Object>}
     */
    async fetchExpensesManifest() {
        const raw = await this.fetchRaw(this.buildContentsUrl(this.getExpensesManifestPath()));
        return parseJsonDocument(raw, "expenses-manifest.json");
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

        const messageText = String(message || "").trim() || "Update zeitberg workspace";

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
 * Shared implementation for hosted providers whose repository APIs expose file contents and immutable Git blobs.
 * GitLab and Forgejo retain provider-specific URL, commit, and repository-creation behavior while sharing workspace-document defaults and bounded parallel chunk loading.
 */
class HostedFileDataSource extends DataSource {
    /**
     * Captures provider coordinates and the credential used only in request headers.
     * @param {RepoConfig} config Provider-neutral repository configuration.
     * @param {string} token PAT or OAuth access token.
     * @param {string} providerLabel Human-readable provider name used in errors.
     */
    constructor(config, token, providerLabel) {
        super(config);
        this.token = String(token || "");
        this.providerLabel = providerLabel;
        this.apiRoot = "";
    }

    /**
     * Replaces the in-memory credential without persisting it or changing repository identity.
     * @param {string} token PAT or OAuth access token.
     * @returns {void}
     */
    setToken(token) {
        this.token = String(token || "");
    }

    /**
     * Builds default JSON request headers for OAuth bearer tokens.
     * Forgejo overrides the authorization scheme for compatibility with scoped API tokens.
     * @returns {HeadersInit}
     */
    buildHeaders() {
        const headers = { Accept: "application/json" };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        return headers;
    }

    /**
     * Converts one provider error response into a short message without including request headers or credential-bearing state.
     * @param {Response} response Failed provider response.
     * @returns {Promise<ProviderApiError>}
     */
    async buildApiError(response) {
        let detail = "";
        try {
            const text = await response.text();
            if (text) {
                try {
                    const payload = JSON.parse(text);
                    detail = String(payload?.message || payload?.error_description || payload?.error || text);
                } catch {
                    detail = text;
                }
            }
        } catch {
            // Status and provider still produce a useful error when a response body is unavailable.
        }
        return new ProviderApiError(this.providerLabel, response.status, detail);
    }

    /**
     * Performs one authenticated provider request and distinguishes browser transport/CORS failures from HTTP errors.
     * @param {string} endpoint API-root-relative path beginning with a slash.
     * @param {{method?: string, body?: Object, accept?: string, allowNotFound?: boolean}} [options] Request controls.
     * @returns {Promise<Response | null>}
     */
    async request(endpoint, options = {}) {
        if (!this.token) throw new Error(`Enter a ${this.providerLabel} access token.`);
        const headers = { ...this.buildHeaders(), Accept: options.accept || "application/json" };
        /** @type {RequestInit} */
        const init = { method: options.method || "GET", headers, cache: "no-store" };
        if (options.body !== undefined) {
            init.body = JSON.stringify(options.body);
            init.headers = { ...headers, "Content-Type": "application/json" };
        }
        let response;
        try {
            response = await fetch(`${this.apiRoot}${endpoint}`, init);
        } catch {
            throw new Error(
                `The browser could not reach ${new URL(this.apiRoot).host}. Check the network and whether that host permits cross-origin API requests.`,
            );
        }
        if (options.allowNotFound && response.status === 404) return null;
        if (!response.ok) throw await this.buildApiError(response);
        return response;
    }

    /**
     * Performs one JSON API request and safely handles empty success responses.
     * @param {string} endpoint API-root-relative path.
     * @param {{method?: string, body?: Object, accept?: string, allowNotFound?: boolean}} [options] Request controls.
     * @returns {Promise<any | null>}
     */
    async requestJson(endpoint, options = {}) {
        const response = await this.request(endpoint, options);
        if (!response) return null;
        if (response.status === 204) return {};
        return await response.json();
    }

    /**
     * Performs one text API request, used for GitLab's immutable raw-blob endpoint.
     * @param {string} endpoint API-root-relative path.
     * @param {{accept?: string}} [options] Request controls.
     * @returns {Promise<string>}
     */
    async requestText(endpoint, options = {}) {
        const response = await this.request(endpoint, { accept: options.accept || "text/plain" });
        if (!response) throw new Error(`${this.providerLabel} returned an empty response.`);
        return await response.text();
    }

    /**
     * Validates and deduplicates files before a provider starts a commit.
     * @param {SaveFile[]} files Candidate save records.
     * @returns {SaveFile[]}
     */
    prepareSaveFiles(files) {
        const prepared = [];
        const paths = new Set();
        for (const candidate of Array.isArray(files) ? files : []) {
            if (!candidate || !candidate.path) continue;
            const path = normalizeRepositoryPath(candidate.path, "save path");
            if (paths.has(path)) throw new Error(`The save contains duplicate path ${path}.`);
            paths.add(path);
            prepared.push({ ...candidate, path, content: String(candidate.content ?? "") });
        }
        if (!prepared.length) throw new Error("Nothing to save.");
        return prepared;
    }

    /**
     * Reads one repository file as UTF-8 text.
     * Subclasses decode their provider's contents response.
     * @param {string} repoPath Repository-relative path.
     * @returns {Promise<string>}
     */
    async fetchRepositoryFileText(repoPath) {
        void repoPath;
        throw new Error("Not implemented");
    }

    /**
     * Loads and parses the workspace bootstrap before component paths are known.
     * @returns {Promise<Object>}
     */
    async fetchWorkspace() {
        const path = this.getWorkspaceConfigPath();
        try {
            return parseWorkspaceDocument(await this.fetchRepositoryFileText(path), path);
        } catch (error) {
            if (error instanceof ProviderApiError && error.status === 404) {
                throw new WorkspaceConfigurationError("missing", path);
            }
            throw error;
        }
    }

    /**
     * Checks for an existing hosted-provider document while retaining provider-specific authentication and error handling.
     * @param {string} repoPath Repository-relative document path.
     * @returns {Promise<boolean>}
     */
    async repositoryFileExists(repoPath) {
        try {
            await this.fetchRepositoryFileText(repoPath);
            return true;
        } catch (error) {
            if (error instanceof ProviderApiError && error.status === 404) return false;
            throw error;
        }
    }

    /**
     * Loads the normalized time-entry index declared by the workspace.
     * @returns {Promise<Object>}
     */
    async fetchManifest() {
        return parseJsonDocument(await this.fetchRepositoryFileText(this.getEntriesManifestPath()), "entries-manifest.json");
    }

    /**
     * Loads the shared project and section taxonomy.
     * @returns {Promise<Object>}
     */
    async fetchProjects() {
        return parseJsonDocument(await this.fetchRepositoryFileText(this.getProjectsPath()), "projects.json");
    }

    /**
     * Loads weekly requirements or supplies the portable default when an older workspace has no document yet.
     * @returns {Promise<Object>}
     */
    async fetchWeekRequirements() {
        try {
            return parseJsonDocument(
                await this.fetchRepositoryFileText(this.getWeekRequirementsPath()),
                "week-requirements.json",
            );
        } catch (error) {
            if (error instanceof ProviderApiError && error.status === 404) {
                return { default_required_hours: 40, generated_at: "", schema_version: 1, weeks: [] };
            }
            throw error;
        }
    }

    /**
     * Loads TODO data or supplies an empty schema-v4 document when the optional file has not been created.
     * @returns {Promise<Object>}
     */
    async fetchTodos() {
        try {
            return parseJsonDocument(await this.fetchRepositoryFileText(this.getTodosPath()), "todos.json");
        } catch (error) {
            if (error instanceof ProviderApiError && error.status === 404) {
                return { generated_at: "", github_overlays: [], schema_version: 4, todos: [] };
            }
            throw error;
        }
    }

    /**
     * Loads exact expense-ledger text through the provider-specific repository file endpoint.
     * @returns {Promise<string>}
     */
    async fetchExpensesText() {
        return await this.fetchRepositoryFileText(this.getExpensesPath());
    }

    /**
     * Loads and parses the expense manifest through the shared hosted-provider file path.
     * @returns {Promise<Object>}
     */
    async fetchExpensesManifest() {
        return parseJsonDocument(
            await this.fetchRepositoryFileText(this.getExpensesManifestPath()),
            "expenses-manifest.json",
        );
    }

    /**
     * Loads distinct cache-miss week blobs with bounded parallelism so train/mobile networks gain latency without creating an unbounded request burst.
     * @param {import("./model.js").ManifestChunk[]} chunks Manifest records to fetch.
     * @returns {Promise<Map<string, string>>}
     */
    async fetchChunkTexts(chunks) {
        /** @type {Map<string, import("./model.js").ManifestChunk>} */
        const unique = new Map();
        for (const chunk of chunks) {
            if (!isGitSha(chunk?.sha)) throw new Error(`Invalid blob sha for ${String(chunk?.path || "week chunk")}`);
            if (!unique.has(chunk.sha)) unique.set(chunk.sha, chunk);
        }
        const queue = [...unique.values()];
        const texts = new Map();
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < queue.length) {
                const chunk = queue[nextIndex];
                nextIndex += 1;
                texts.set(chunk.sha, await this.fetchChunkText(chunk));
            }
        };
        await Promise.all(Array.from({ length: Math.min(HOSTED_CHUNK_CONCURRENCY, queue.length) }, () => worker()));
        return texts;
    }
}

/**
 * GitLab REST data source for gitlab.com and explicitly selected self-hosted GitLab instances.
 * File reads use repository-file/blob endpoints, while each zeitberg save becomes one atomic multi-action Git commit.
 */
export class GitLabDataSource extends HostedFileDataSource {
    /**
     * Resolves the GitLab project path and API root from a credential-free repository URL.
     * @param {RepoConfig} config Repository configuration.
     * @param {string} token PAT or OAuth access token.
     */
    constructor(config, token) {
        super(config, token, "GitLab");
        const policy = config.provider === "gitlab" ? "gitlab" : "custom";
        this.coordinates = parseHostedRepositoryUrl(config.repositoryUrl || "", policy);
        this.apiRoot = `${this.coordinates.origin}/api/v4`;
        this.projectId = encodeURIComponent(this.coordinates.repositoryPath);
    }

    /**
     * Builds the GitLab repository-file endpoint for one path and ref.
     * @param {string} repoPath Repository-relative path.
     * @param {string} [ref] Branch, tag, or commit SHA.
     * @returns {string}
     */
    buildFileEndpoint(repoPath, ref = this.config.ref) {
        const path = normalizeRepositoryPath(repoPath, "repository path");
        return `/projects/${this.projectId}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
    }

    /**
     * Fetches one file metadata/content record, optionally returning null for a missing path.
     * @param {string} repoPath Repository-relative path.
     * @param {string} [ref] Branch, tag, or commit SHA.
     * @param {boolean} [allowNotFound] Whether a missing file is expected.
     * @returns {Promise<any | null>}
     */
    async fetchFile(repoPath, ref = this.config.ref, allowNotFound = false) {
        return await this.requestJson(this.buildFileEndpoint(repoPath, ref), { allowNotFound });
    }

    /**
     * Reads and decodes one GitLab repository file.
     * @param {string} repoPath Repository-relative path.
     * @returns {Promise<string>}
     */
    async fetchRepositoryFileText(repoPath) {
        const payload = await this.fetchFile(repoPath);
        if (!payload || payload.encoding !== "base64") throw new Error(`${repoPath} has an unsupported GitLab encoding.`);
        return decodeUtf8Base64(payload.content, repoPath);
    }

    /**
     * Reads an immutable GitLab blob by the SHA recorded in entries-manifest.json.
     * @param {import("./model.js").ManifestChunk} chunk Manifest chunk metadata.
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        if (!isGitSha(chunk.sha)) throw new Error(`Invalid blob sha for ${chunk.path}`);
        return await this.requestText(`/projects/${this.projectId}/repository/blobs/${encodeURIComponent(chunk.sha)}/raw`);
    }

    /**
     * Persists every changed document in one GitLab commit with create/update actions guarded by each file's latest commit id.
     * @param {SaveFile[]} files Changed repository documents.
     * @param {string} message Commit message.
     * @returns {Promise<SaveResult>}
     */
    async saveFiles(files, message) {
        const prepared = this.prepareSaveFiles(files);
        const metadata = await Promise.all(prepared.map((file) => this.fetchFile(file.path, this.config.ref, true)));
        const actions = prepared.map((file, index) => ({
            action: metadata[index] ? "update" : "create",
            file_path: file.path,
            content: file.content,
            encoding: "text",
            ...(metadata[index]?.last_commit_id ? { last_commit_id: metadata[index].last_commit_id } : {}),
        }));
        const commit = await this.requestJson(`/projects/${this.projectId}/repository/commits`, {
            method: "POST",
            body: {
                branch: String(this.config.ref || "main"),
                commit_message: String(message || "").trim() || "Update zeitberg workspace",
                actions,
            },
        });
        const commitId = String(commit?.id || "");
        if (!isGitSha(commitId)) throw new Error("GitLab did not return the created commit id.");

        const committed = await Promise.all(prepared.map((file) => this.fetchFile(file.path, commitId)));
        const updatedFiles = prepared.map((file, index) => {
            const sha = String(committed[index]?.blob_id || "");
            if (!isGitSha(sha) || sha.toLowerCase() !== gitBlobSha1(file.content)) {
                throw new Error(`Blob sha mismatch for ${file.path}`);
            }
            return { ...file, sha };
        });
        return { files: updatedFiles };
    }

    /**
     * Checks project and account access, normalizing names consumed by the provider-neutral application shell.
     * @returns {Promise<{repoInfo: any, userInfo: any}>}
     */
    async checkConnection() {
        const [project, user] = await Promise.all([
            this.requestJson(`/projects/${this.projectId}`),
            this.requestJson("/user").catch(() => null),
        ]);
        return {
            repoInfo: { ...project, full_name: project?.path_with_namespace || this.coordinates.repositoryPath },
            userInfo: user ? { ...user, login: user.username || user.name || "" } : null,
        };
    }

    /**
     * Creates an initialized private project in the authenticated user's default GitLab namespace.
     * @param {string} name Repository path/name.
     * @param {string} [description] Optional project description.
     * @returns {Promise<{repositoryUrl: string, repoInfo: any}>}
     */
    async createPrivateRepository(name, description = "Private zeitberg workspace") {
        const path = String(name || "").trim();
        if (!/^[A-Za-z0-9_.-]+$/.test(path)) throw new Error("Use letters, numbers, dots, dashes, or underscores for the repository name.");
        const project = await this.requestJson("/projects", {
            method: "POST",
            body: {
                name: path,
                path,
                description: String(description || ""),
                visibility: "private",
                initialize_with_readme: true,
                default_branch: String(this.config.ref || "main"),
            },
        });
        const repositoryUrl = String(project?.web_url || "");
        parseHostedRepositoryUrl(repositoryUrl, this.config.provider === "gitlab" ? "gitlab" : "custom");
        return { repositoryUrl, repoInfo: project };
    }
}

/**
 * Forgejo-family REST data source used by Codeberg and explicitly configured Forgejo hosts.
 * Its contents API commits one file at a time, so component integrity manifests are deliberately written after their documents and the workspace descriptor is exposed only after all seed files exist.
 */
export class ForgejoDataSource extends HostedFileDataSource {
    /**
     * Resolves owner/repository coordinates and the standard Forgejo API root.
     * @param {RepoConfig} config Repository configuration.
     * @param {string} token Scoped PAT or OAuth access token.
     */
    constructor(config, token) {
        super(config, token, config.provider === "codeberg" ? "Codeberg" : "Forgejo");
        const policy = config.provider === "codeberg" ? "codeberg" : "forgejo";
        this.coordinates = parseHostedRepositoryUrl(config.repositoryUrl || "", policy);
        this.apiRoot = `${this.coordinates.origin}/api/v1`;
        this.repositoryEndpoint = `/repos/${encodeURIComponent(this.coordinates.owner)}/${encodeURIComponent(this.coordinates.repo)}`;
    }

    /**
     * Uses Forgejo's token authorization syntax, which supports scoped personal tokens and OAuth access tokens on Forgejo-family servers.
     * @returns {HeadersInit}
     */
    buildHeaders() {
        const headers = { Accept: "application/json" };
        if (this.token) headers.Authorization = `token ${this.token}`;
        return headers;
    }

    /**
     * Builds the contents endpoint for one repository-relative path.
     * @param {string} repoPath Repository-relative path.
     * @param {boolean} [includeRef] Whether to address the configured branch for a read.
     * @returns {string}
     */
    buildContentsEndpoint(repoPath, includeRef = true) {
        const path = encodeRepositoryPath(normalizeRepositoryPath(repoPath, "repository path"));
        const query = includeRef ? `?ref=${encodeURIComponent(this.config.ref)}` : "";
        return `${this.repositoryEndpoint}/contents/${path}${query}`;
    }

    /**
     * Fetches one contents record, optionally returning null when a new document does not exist.
     * Forgejo normally reports an absent path with HTTP 404, but an entirely empty repository can instead answer HTTP 200 with an empty array. Since Git cannot contain an empty directory, that response cannot represent a file or directory and is safely normalized to the same missing-file result.
     * @param {string} repoPath Repository-relative path.
     * @param {boolean} [allowNotFound] Whether a missing path is expected.
     * @returns {Promise<any | null>}
     */
    async fetchFile(repoPath, allowNotFound = false) {
        const payload = await this.requestJson(this.buildContentsEndpoint(repoPath), { allowNotFound });
        if (Array.isArray(payload) && payload.length === 0) {
            if (allowNotFound) return null;
            throw new ProviderApiError(this.providerLabel, 404, `${repoPath} was not found.`);
        }
        return payload;
    }

    /**
     * Reads and decodes one Forgejo repository file.
     * @param {string} repoPath Repository-relative path.
     * @returns {Promise<string>}
     */
    async fetchRepositoryFileText(repoPath) {
        const payload = await this.fetchFile(repoPath);
        if (!payload || Array.isArray(payload) || payload.encoding !== "base64") {
            throw new Error(`${repoPath} has an unsupported ${this.providerLabel} encoding.`);
        }
        return decodeUtf8Base64(payload.content, repoPath);
    }

    /**
     * Loads one immutable Git blob and decodes its base64 JSON representation.
     * @param {import("./model.js").ManifestChunk} chunk Manifest chunk metadata.
     * @returns {Promise<string>}
     */
    async fetchChunkText(chunk) {
        if (!isGitSha(chunk.sha)) throw new Error(`Invalid blob sha for ${chunk.path}`);
        const payload = await this.requestJson(`${this.repositoryEndpoint}/git/blobs/${encodeURIComponent(chunk.sha)}`);
        if (!payload || payload.encoding !== "base64" || String(payload.sha || "").toLowerCase() !== chunk.sha.toLowerCase()) {
            throw new Error(`${this.providerLabel} returned an invalid blob for ${chunk.path}.`);
        }
        return decodeUtf8Base64(payload.content, chunk.path);
    }

    /**
     * Writes changed files through Forgejo's create/update contents API.
     * Separate provider commits are unavoidable; ordering enabled-component manifests after ordinary documents and zeitberg.json last preserves a recoverable repository state if a request fails midway.
     * @param {SaveFile[]} files Changed repository documents.
     * @param {string} message Commit message prefix.
     * @returns {Promise<SaveResult>}
     */
    async saveFiles(files, message) {
        const manifestPaths = new Set();
        if (this.workspace?.hasComponent("time_tracking")) {
            manifestPaths.add(this.getEntriesManifestPath());
        }
        if (this.workspace?.hasComponent("expenses")) {
            manifestPaths.add(this.getExpensesManifestPath());
        }
        const workspacePath = this.getWorkspaceConfigPath();
        const prepared = this.prepareSaveFiles(files).sort((left, right) => {
            const rank = (path) => (path === workspacePath ? 2 : manifestPaths.has(path) ? 1 : 0);
            return rank(left.path) - rank(right.path);
        });
        const updatedFiles = [];
        for (const file of prepared) {
            const existing = await this.fetchFile(file.path, true);
            const result = await this.requestJson(this.buildContentsEndpoint(file.path, false), {
                method: existing ? "PUT" : "POST",
                body: {
                    branch: String(this.config.ref || "main"),
                    content: encodeUtf8Base64(file.content),
                    message: String(message || "").trim() || "Update zeitberg workspace",
                    ...(existing?.sha ? { sha: existing.sha } : {}),
                },
            });
            const sha = String(result?.content?.sha || "");
            if (!isGitSha(sha) || sha.toLowerCase() !== gitBlobSha1(file.content)) {
                throw new Error(`Blob sha mismatch for ${file.path}`);
            }
            updatedFiles.push({ ...file, sha });
        }
        return { files: updatedFiles };
    }

    /**
     * Checks repository and account access while returning the common shell naming fields.
     * @returns {Promise<{repoInfo: any, userInfo: any}>}
     */
    async checkConnection() {
        const [repository, user] = await Promise.all([
            this.requestJson(this.repositoryEndpoint),
            this.requestJson("/user").catch(() => null),
        ]);
        return {
            repoInfo: { ...repository, full_name: repository?.full_name || this.coordinates.repositoryPath },
            userInfo: user ? { ...user, login: user.login || user.username || user.full_name || "" } : null,
        };
    }

    /**
     * Creates a private SHA-1 repository in the authenticated Forgejo account and initializes its default branch.
     * SHA-1 is explicit because the current entries-manifest schema stores 40-character Git blob ids.
     * @param {string} name Repository name.
     * @param {string} [description] Optional repository description.
     * @returns {Promise<{repositoryUrl: string, repoInfo: any}>}
     */
    async createPrivateRepository(name, description = "Private zeitberg workspace") {
        const repo = String(name || "").trim();
        if (!/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Use letters, numbers, dots, dashes, or underscores for the repository name.");
        const repository = await this.requestJson("/user/repos", {
            method: "POST",
            body: {
                name: repo,
                description: String(description || ""),
                private: true,
                auto_init: true,
                default_branch: String(this.config.ref || "main"),
                object_format_name: "sha1",
            },
        });
        const repositoryUrl = String(repository?.html_url || "");
        parseHostedRepositoryUrl(repositoryUrl, this.config.provider === "codeberg" ? "codeberg" : "forgejo");
        return { repositoryUrl, repoInfo: repository };
    }
}

/**
 * Self-hosted adapter that probes one explicitly trusted HTTPS origin for GitLab or Forgejo before delegating any workspace operation.
 * A failed browser fetch is reported as a likely CORS/transport incompatibility instead of being misdiagnosed as bad workspace data.
 */
export class CustomGitDataSource extends DataSource {
    /**
     * Captures the custom repository and delays protocol selection until connection preflight.
     * @param {RepoConfig} config Repository configuration using provider `custom`.
     * @param {string} token Provider credential.
     */
    constructor(config, token) {
        super(config);
        this.token = String(token || "");
        this.coordinates = parseHostedRepositoryUrl(config.repositoryUrl || "", "custom");
        /** @type {GitLabDataSource | ForgejoDataSource | null} */
        this.delegate = null;
    }

    /**
     * Applies the workspace model to both wrapper and detected implementation.
     * @param {import("./model.js").Workspace} workspace Parsed workspace model.
     * @returns {void}
     */
    setWorkspace(workspace) {
        super.setWorkspace(workspace);
        if (this.delegate) this.delegate.setWorkspace(workspace);
    }

    /** @returns {void} Clears the wrapper and detected provider workspace models together. */
    clearWorkspace() {
        super.clearWorkspace();
        if (this.delegate) this.delegate.clearWorkspace();
    }

    /**
     * Probes a public version endpoint without a credential, returning null for network/CORS failures.
     * @param {string} endpoint Origin-relative API endpoint.
     * @returns {Promise<{response: Response | null, transportFailed: boolean}>}
     */
    async probe(endpoint) {
        try {
            return {
                response: await fetch(`${this.coordinates.origin}${endpoint}`, { headers: { Accept: "application/json" }, cache: "no-store" }),
                transportFailed: false,
            };
        } catch {
            return { response: null, transportFailed: true };
        }
    }

    /**
     * Detects GitLab or Forgejo from standard version endpoints and memoizes the provider-specific data source.
     * @returns {Promise<GitLabDataSource | ForgejoDataSource>}
     */
    async ensureDelegate() {
        if (this.delegate) return this.delegate;
        const gitlabProbe = await this.probe("/api/v4/version");
        if (gitlabProbe.response && gitlabProbe.response.status !== 404) {
            this.delegate = new GitLabDataSource({ ...this.config, provider: "custom" }, this.token);
        } else {
            const forgejoProbe = await this.probe("/api/v1/version");
            if (forgejoProbe.response && forgejoProbe.response.status !== 404) {
                this.delegate = new ForgejoDataSource({ ...this.config, provider: "forgejo" }, this.token);
            } else if (gitlabProbe.transportFailed || forgejoProbe.transportFailed) {
                throw new Error(
                    `The browser could not inspect ${this.coordinates.origin}. The server may not permit cross-origin API requests from zeitberg.`,
                );
            } else {
                throw new Error("This host does not expose a compatible GitLab or Forgejo API.");
            }
        }
        if (this.workspace) this.delegate.setWorkspace(this.workspace);
        return this.delegate;
    }

    /** @returns {Promise<Object>} Loads the custom provider's workspace bootstrap. */
    async fetchWorkspace() {
        return await (await this.ensureDelegate()).fetchWorkspace();
    }

    /** @param {string} repoPath @returns {Promise<boolean>} Checks a custom provider repository path through the detected implementation. */
    async repositoryFileExists(repoPath) {
        return await (await this.ensureDelegate()).repositoryFileExists(repoPath);
    }

    /** @returns {Promise<Object>} Loads the custom provider's entries manifest. */
    async fetchManifest() {
        return await (await this.ensureDelegate()).fetchManifest();
    }

    /** @param {import("./model.js").ManifestChunk} chunk @returns {Promise<string>} Loads one custom-provider week blob. */
    async fetchChunkText(chunk) {
        return await (await this.ensureDelegate()).fetchChunkText(chunk);
    }

    /** @param {import("./model.js").ManifestChunk[]} chunks @returns {Promise<Map<string, string>>} Loads custom-provider week blobs. */
    async fetchChunkTexts(chunks) {
        return await (await this.ensureDelegate()).fetchChunkTexts(chunks);
    }

    /** @returns {Promise<Object>} Loads the custom provider's project taxonomy. */
    async fetchProjects() {
        return await (await this.ensureDelegate()).fetchProjects();
    }

    /** @returns {Promise<Object>} Loads the custom provider's weekly requirements. */
    async fetchWeekRequirements() {
        return await (await this.ensureDelegate()).fetchWeekRequirements();
    }

    /** @returns {Promise<Object>} Loads the custom provider's TODO document. */
    async fetchTodos() {
        return await (await this.ensureDelegate()).fetchTodos();
    }

    /** @returns {Promise<string>} Loads the custom provider's exact expense document text. */
    async fetchExpensesText() {
        return await (await this.ensureDelegate()).fetchExpensesText();
    }

    /** @returns {Promise<Object>} Loads the custom provider's expense manifest. */
    async fetchExpensesManifest() {
        return await (await this.ensureDelegate()).fetchExpensesManifest();
    }

    /** @param {SaveFile[]} files @param {string} message @returns {Promise<SaveResult>} Saves through the detected provider. */
    async saveFiles(files, message) {
        return await (await this.ensureDelegate()).saveFiles(files, message);
    }

    /** @returns {Promise<{repoInfo: any, userInfo: any}>} Detects the host and checks repository/account access. */
    async checkConnection() {
        return await (await this.ensureDelegate()).checkConnection();
    }
}

/**
 * Creates the hosted data-source implementation selected by a normalized workspace locator.
 * Application controllers therefore depend only on DataSource and never branch around individual read/save code paths.
 * @param {RepoConfig} config Active repository configuration.
 * @param {string} token PAT or OAuth access token.
 * @returns {GitHubDataSource | GitLabDataSource | ForgejoDataSource | CustomGitDataSource}
 */
export function createHostedDataSource(config, token) {
    const provider = String(config.provider || "github");
    if (provider === "github") return new GitHubDataSource(config, token);
    if (provider === "gitlab") return new GitLabDataSource(config, token);
    if (provider === "codeberg" || provider === "forgejo") return new ForgejoDataSource(config, token);
    if (provider === "custom") return new CustomGitDataSource(config, token);
    throw new Error(`Unsupported hosted workspace provider: ${provider}`);
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
    constructor(config = { owner: "", repo: "", ref: "", workspacePath: "zeitberg.json" }) {
        super({ owner: "", repo: "", ref: "", ...config });
    }

    /**
     * Adds the active local workspace selector to a same-origin server endpoint.
     * The selector is the public workspace_id from zeitberg.json rather than a filesystem path, so local routes never disclose checkout locations.
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
                    workspace_path: String(item?.workspace_path || "zeitberg.json").trim(),
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
            if (resp.status === 404) {
                throw new WorkspaceConfigurationError("missing", this.getWorkspaceConfigPath());
            }
            throw new Error(`Local zeitberg.json not found (${resp.status}). Start server.py with --workspace PATH.`);
        }
        return parseWorkspaceDocument(await resp.text(), this.getWorkspaceConfigPath());
    }

    /**
     * Checks a local workspace document without caching or exposing its filesystem location to the browser.
     * @param {string} repoPath Repository-relative document path.
     * @returns {Promise<boolean>}
     */
    async repositoryFileExists(repoPath) {
        const resp = await fetch(this.buildWorkspaceUrl(repoPath), { cache: "no-store" });
        if (resp.status === 404) return false;
        if (!resp.ok) throw new Error(`Could not inspect local workspace file (${resp.status}).`);
        return true;
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
                return { generated_at: "", github_overlays: [], schema_version: 4, todos: [] };
            }
            throw new Error(`Local todos.json not found (${resp.status}).`);
        }

        return parseJsonDocument(await resp.text(), "todos.json");
    }

    /**
     * Loads exact local expense-ledger text without browser caching for manifest verification.
     * @returns {Promise<string>}
     */
    async fetchExpensesText() {
        const resp = await fetch(this.buildWorkspaceUrl(this.getExpensesPath()), { cache: "no-store" });
        if (!resp.ok) throw new Error(`Local expenses.json not found (${resp.status}).`);
        return await resp.text();
    }

    /**
     * Loads the local expense integrity manifest without browser caching.
     * @returns {Promise<Object>}
     */
    async fetchExpensesManifest() {
        const resp = await fetch(this.buildWorkspaceUrl(this.getExpensesManifestPath()), { cache: "no-store" });
        if (!resp.ok) throw new Error(`Local expenses-manifest.json not found (${resp.status}).`);
        return parseJsonDocument(await resp.text(), "expenses-manifest.json");
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
