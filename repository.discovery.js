import { GitHubDataSource, GitLabDataSource, ForgejoDataSource, WorkspaceConfigurationError, parseHostedRepositoryUrl } from "./datasource.js";
import { Workspace } from "./model.js";

/**
 * @typedef {Object} DiscoveredRepository
 * @description A credential-free repository choice, checked only at its default branch and root zeitberg.json.
 * @property {string} repositoryUrl
 * @property {string} name
 * @property {string} ref
 * @property {"ready" | "missing" | "attention"} status
 * @property {string} detail
 */

/**
 * Lists authorized repositories in bounded pages and checks their bootstrap documents.
 * No component data is downloaded. Provider-returned URLs are validated before a
 * credential can be sent, and cancellation stops scheduling further probes.
 */
export class RepositoryDiscovery {
    /**
     * Captures one provider authorization without persisting it to browser storage.
     * @param {import("./config.js").AppConfig} config Base application configuration.
     * @param {string} provider GitHub, GitLab.com, or Codeberg.
     * @param {string} token Provider-scoped credential.
     * @param {boolean} [githubApp] Use installation-scoped enumeration for a GitHub App user grant, not a PAT.
     */
    constructor(config, provider, token, githubApp = false) {
        if (!["github", "gitlab", "codeberg"].includes(provider)) throw new Error("Unsupported repository discovery provider.");
        this.config = config;
        this.provider = provider;
        this.token = token;
        this.pageSize = 20;
        this.cancelled = false;
        this.githubApp = githubApp;
        /** @type {any[] | null} */
        this.installations = null;
        /** @type {Map<number, {rows: any[], next: {installation: number, page: number}, hasMore: boolean}>} */
        this.githubPages = new Map();
        this.origin = provider === "github" ? "https://github.com" : provider === "gitlab" ? "https://gitlab.com" : "https://codeberg.org";
    }

    /**
     * Enumerates only repositories this GitHub App installation can actually access.
     * Caches each page within this scan so a failed configuration probe can retry
     * without advancing the installation cursor. Refresh uses a new discovery object.
     * @param {GitHubDataSource} source Authenticated first-party GitHub transport.
     * @param {number} page One-based chooser page, visited sequentially.
     * @returns {Promise<{rows: any[], hasMore: boolean}>}
     */
    async githubRepositories(source, page) {
        if (this.installations === null) {
            const installations = [];
            for (let index = 1; !this.cancelled; index++) {
                const result = await source.fetchJson(`https://api.github.com/user/installations?per_page=100&page=${index}`);
                if (!Array.isArray(result.installations)) throw new Error("GitHub did not return an installation list.");
                installations.push(...result.installations.filter((item) => !item.suspended_at));
                if (result.installations.length < 100) break;
            }
            this.installations = installations;
        }
        const cached = this.githubPages.get(page);
        if (cached) return cached;
        const previous = page === 1 ? { installation: 0, page: 1 } : this.githubPages.get(page - 1)?.next;
        if (!previous) throw new Error("Scan repository pages in order.");
        const cursor = { ...previous };
        let rows = [];
        while (!this.cancelled && cursor.installation < this.installations.length) {
            const id = this.installations[cursor.installation].id;
            if (!Number.isSafeInteger(id) || id <= 0) throw new Error("GitHub returned an invalid installation id.");
            const result = await source.fetchJson(`https://api.github.com/user/installations/${id}/repositories?per_page=${this.pageSize}&page=${cursor.page}`);
            if (!Array.isArray(result.repositories)) throw new Error("GitHub did not return a repository list.");
            rows = result.repositories;
            if (rows.length < this.pageSize || cursor.page * this.pageSize >= result.total_count) {
                cursor.installation++;
                cursor.page = 1;
            } else cursor.page++;
            if (rows.length) break;
        }
        const result = { rows, next: cursor, hasMore: cursor.installation < this.installations.length };
        this.githubPages.set(page, result);
        return result;
    }

    /**
     * Builds a transport only after enforcing the selected provider's origin.
     * @param {string} repositoryUrl Repository URL from the provider response.
     * @param {string} ref Default branch reported by the provider.
     * @returns {GitHubDataSource | GitLabDataSource | ForgejoDataSource}
     */
    source(repositoryUrl, ref) {
        const policy = this.provider === "gitlab" ? "gitlab" : this.provider === "codeberg" ? "codeberg" : "forgejo";
        const coordinates = parseHostedRepositoryUrl(repositoryUrl, policy);
        if (coordinates.origin !== this.origin) throw new Error("Repository belongs to a different provider.");
        const config = { ...this.config, provider: this.provider, repositoryUrl, ref, workspacePath: "zeitberg.json", owner: coordinates.owner, repo: coordinates.repo };
        return this.provider === "github" ? new GitHubDataSource(config, this.token)
            : this.provider === "gitlab" ? new GitLabDataSource(config, this.token) : new ForgejoDataSource(config, this.token);
    }

    /**
     * Reads one page; an explicit Load more action advances beyond it.
     * A full page advertises another page even when the provider omits pagination headers.
     * @param {number} page One-based page number.
     * @returns {Promise<{repositories: DiscoveredRepository[], hasMore: boolean}>}
     */
    async scanPage(page) {
        if (!Number.isInteger(page) || page < 1) throw new Error("Invalid repository page.");
        const source = this.source(`${this.origin}/zeitberg-onboarding/placeholder`, "main");
        const scoped = this.githubApp && source instanceof GitHubDataSource ? await this.githubRepositories(source, page) : null;
        const rows = scoped ? scoped.rows : source instanceof GitHubDataSource
            ? await source.fetchJson(`https://api.github.com/user/repos?per_page=${this.pageSize}&page=${page}&sort=updated`)
            : await source.requestJson(this.provider === "gitlab"
                ? `/projects?membership=true&simple=true&per_page=${this.pageSize}&page=${page}&order_by=last_activity_at&sort=desc`
                : `/user/repos?limit=${this.pageSize}&page=${page}`);
        if (!Array.isArray(rows)) throw new Error("Provider did not return a repository list.");
        /** @type {DiscoveredRepository[]} */
        const repositories = [];
        let next = 0;
        /** Reads one repository at a time per worker, keeping transport errors distinct from absent configuration. @returns {Promise<void>} */
        const worker = async () => {
            while (!this.cancelled && next < rows.length) {
                const row = rows[next++];
                const repositoryUrl = String(row.web_url || row.html_url || "");
                const ref = String(row.default_branch || "main");
                // Ignore untrusted cross-host URLs entirely, not as selectable error rows.
                const source = this.source(repositoryUrl, ref);
                /** @type {DiscoveredRepository} */
                const item = { repositoryUrl, ref, name: String(row.path_with_namespace || row.full_name || row.name || repositoryUrl), status: "missing", detail: "" };
                try {
                    const workspace = Workspace.fromRaw(await source.fetchWorkspace());
                    item.status = "ready";
                    item.detail = workspace.name;
                } catch (error) {
                    if (!(error instanceof WorkspaceConfigurationError && error.reason === "missing")) {
                        item.status = "attention";
                        item.detail = error instanceof Error ? error.message : String(error);
                    }
                }
                repositories.push(item);
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
        repositories.sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready") || a.name.localeCompare(b.name));
        return { repositories, hasMore: scoped ? scoped.hasMore : rows.length === this.pageSize };
    }

    /** Stops subsequent work and releases the retained token when the chooser closes. @returns {void} */
    cancel() {
        this.cancelled = true;
        this.token = "";
    }
}
