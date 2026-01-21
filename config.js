/**
 * @typedef {Object} AppConfig
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref
 * @property {string} timezone
 */

export const DEFAULT_CONFIG = {
    owner: "josephbirkner",
    repo: "timetracking",
    ref: "main",
    timezone: "Europe/Berlin",
};

const STORAGE_KEYS = {
    config: "tt_viewer:config:v1",
    token: "tt_viewer:token:v1",
    tokenRemembered: "tt_viewer:token_remembered:v1",
};

/**
 * Manages local/session storage for config and tokens.
 */
export class ConfigService {
    constructor() {
        this.storageKeys = { ...STORAGE_KEYS };
    }

    /**
     * @returns {AppConfig}
     */
    loadConfig() {
        try {
            const raw = localStorage.getItem(this.storageKeys.config);
            if (!raw) {
                return { ...DEFAULT_CONFIG };
            }
            const parsed = JSON.parse(raw);
            return { ...DEFAULT_CONFIG, ...parsed };
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    }

    /**
     * @param {AppConfig} config
     * @returns {void}
     */
    saveConfig(config) {
        localStorage.setItem(this.storageKeys.config, JSON.stringify(config));
    }

    /**
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
     * @returns {boolean}
     */
    isTokenRemembered() {
        return localStorage.getItem(this.storageKeys.tokenRemembered) === "1";
    }

    /**
     * @returns {void}
     */
    clearSaved() {
        localStorage.removeItem(this.storageKeys.config);
        localStorage.removeItem(this.storageKeys.token);
        localStorage.removeItem(this.storageKeys.tokenRemembered);
        sessionStorage.removeItem(this.storageKeys.token);
    }
}
