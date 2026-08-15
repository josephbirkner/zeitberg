/**
 * @typedef {Object} AppConfig
 * @description Repository settings and user preferences for the viewer.
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref
 * @property {string} workspacePath
 * @property {string} timezone
 * @property {number} uiZoom
 * @property {"auto" | "manual"} uiZoomMode
 * @property {"dark" | "light"} theme
 */

export const DEFAULT_CONFIG = {
    owner: "josephbirkner",
    repo: "zeitplural-data",
    ref: "main",
    workspacePath: "zeitplural.json",
    timezone: "Europe/Berlin",
    uiZoom: 1,
    uiZoomMode: "auto",
    theme: "dark",
};

/**
 * Migrates the original hosted workspace defaults after the product and repository rename.
 * The migration is deliberately limited to Joseph's first-party data repository so independently named workspaces may continue using any bootstrap filename they chose.
 * @param {AppConfig} config Fully merged application configuration.
 * @returns {AppConfig}
 */
export function migrateRenamedWorkspaceConfig(config) {
    const migrated = { ...config };
    const isFirstPartyWorkspace =
        migrated.owner === "josephbirkner" && ["planplural-data", "zeitplural-data"].includes(migrated.repo);
    if (!isFirstPartyWorkspace) return migrated;
    if (migrated.repo === "planplural-data") migrated.repo = "zeitplural-data";
    if (migrated.workspacePath === "planplural.json") migrated.workspacePath = "zeitplural.json";
    return migrated;
}

/**
 * Parses a GitHub repository locator into the owner and repository values used by the API data source.
 * The public connection form accepts the full HTTPS URL promised by the onboarding copy as well as the compact `owner/repo` form for experienced users.
 * Query strings, fragments, extra path segments, and non-GitHub hosts are rejected so a credential can never be redirected to an unexpected origin.
 * @param {string} value User-entered GitHub repository URL or `owner/repo` shorthand.
 * @returns {{owner: string, repo: string}}
 */
export function parseGitHubRepository(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Enter a GitHub workspace repository URL.");

    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
        let url;
        try {
            url = new URL(raw);
        } catch {
            throw new Error("Enter a valid GitHub repository URL.");
        }
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
            throw new Error("The current connector accepts HTTPS github.com repository URLs.");
        }
        if (url.search || url.hash) throw new Error("The repository URL must not contain a query or fragment.");
        path = url.pathname;
    }

    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) throw new Error("Use a repository URL such as https://github.com/you/zeitplural-data.");
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    const segmentPattern = /^[A-Za-z0-9_.-]+$/;
    if (!segmentPattern.test(owner) || !segmentPattern.test(repo) || !repo) {
        throw new Error("The GitHub owner or repository name is invalid.");
    }
    return { owner, repo };
}

/**
 * Formats stored owner/repository configuration as the standard public connection URL.
 * @param {string} owner GitHub account or organization name.
 * @param {string} repo GitHub repository name.
 * @returns {string}
 */
export function formatGitHubRepositoryUrl(owner, repo) {
    return `https://github.com/${String(owner || "").trim()}/${String(repo || "").trim()}`;
}

/**
 * Returns the default application zoom for automatic mode.
 * Browser and operating-system page zoom already express the user's preferred physical size, so automatic mode deliberately leaves the application at its natural 100% scale on every viewport.
 * @returns {number}
 */
export function getRecommendedUiZoom() {
    return 1;
}

/**
 * Returns the horizontal CSS space available after applying the application's layout-affecting zoom.
 * Native media queries continue to see the unzoomed viewport, so this derived width is the shared breakpoint input for JavaScript and class-driven responsive styles.
 * @param {number} viewportWidth Width of the layout viewport in CSS pixels.
 * @param {number} uiZoom Current application zoom factor.
 * @returns {number}
 */
export function getEffectiveUiViewportWidth(viewportWidth, uiZoom) {
    const width = Number(viewportWidth);
    const zoom = Number(uiZoom);
    if (!Number.isFinite(width) || width <= 0) return 0;
    if (!Number.isFinite(zoom) || zoom <= 0) return width;
    return width / zoom;
}

const STORAGE_KEYS = {
    config: "tt_viewer:config:v1",
    token: "tt_viewer:token:v1",
    tokenRemembered: "tt_viewer:token_remembered:v1",
};

/**
 * Manages local/session storage for config and tokens.
 * Keeps persistence concerns out of the main app controller.
 */
export class ConfigService {
    constructor() {
        this.storageKeys = { ...STORAGE_KEYS };
    }

    /**
     * Loads persisted config, falling back to defaults when missing or invalid.
     * Keeps storage logic separated from the UI.
     * @returns {AppConfig}
     */
    loadConfig() {
        try {
            const raw = localStorage.getItem(this.storageKeys.config);
            if (!raw) {
                return { ...DEFAULT_CONFIG };
            }
            const parsed = JSON.parse(raw);
            const config = migrateRenamedWorkspaceConfig({ ...DEFAULT_CONFIG, ...parsed });
            if (config.repo !== parsed.repo || config.workspacePath !== parsed.workspacePath) {
                localStorage.setItem(this.storageKeys.config, JSON.stringify(config));
            }
            return config;
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    }

    /**
     * Persists config overrides to local storage.
     * Keeps storage logic separated from the UI.
     * @param {AppConfig} config
     * @returns {void}
     */
    saveConfig(config) {
        localStorage.setItem(this.storageKeys.config, JSON.stringify(config));
    }

    /**
     * Loads the stored token, respecting the remember flag.
     * Keeps storage logic separated from the UI.
     * @returns {string}
     */
    loadToken() {
        const remembered = this.isTokenRemembered();
        if (remembered) {
            return localStorage.getItem(this.storageKeys.token) || "";
        }
        return sessionStorage.getItem(this.storageKeys.token) || "";
    }

    /**
     * Stores the token in either localStorage or sessionStorage.
     * Keeps storage logic separated from the UI.
     * @param {string} token
     * @param {boolean} remember
     * @returns {void}
     */
    saveToken(token, remember) {
        localStorage.setItem(this.storageKeys.tokenRemembered, remember ? "1" : "0");
        if (remember) {
            localStorage.setItem(this.storageKeys.token, token);
            sessionStorage.removeItem(this.storageKeys.token);
        } else {
            sessionStorage.setItem(this.storageKeys.token, token);
            localStorage.removeItem(this.storageKeys.token);
        }
    }

    /**
     * Returns true when the token is stored in localStorage.
     * Keeps storage logic separated from the UI.
     * @returns {boolean}
     */
    isTokenRemembered() {
        return localStorage.getItem(this.storageKeys.tokenRemembered) === "1";
    }

    /**
     * Clears all saved config and token state from storage.
     * Keeps storage logic separated from the UI.
     * @returns {void}
     */
    clearSaved() {
        localStorage.removeItem(this.storageKeys.config);
        localStorage.removeItem(this.storageKeys.token);
        localStorage.removeItem(this.storageKeys.tokenRemembered);
        sessionStorage.removeItem(this.storageKeys.token);
    }
}
