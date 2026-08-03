/**
 * @typedef {Object} AppConfig
 * @description Repository settings and user preferences for the viewer.
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref
 * @property {string} timezone
 * @property {number} uiZoom
 * @property {"auto" | "manual"} uiZoomMode
 */

export const DEFAULT_CONFIG = {
    owner: "josephbirkner",
    repo: "timetracking",
    ref: "main",
    timezone: "Europe/Berlin",
    uiZoom: 1,
    uiZoomMode: "auto",
};

const COMPACT_TOUCH_MAX_SHORT_EDGE = 500;
const COMPACT_TOUCH_UI_ZOOM = 2;

/**
 * Recommends an application zoom from interaction precision and the viewport's shorter edge.
 * A coarse pointer plus a phone-sized viewport is a more useful readability signal than device pixel ratio, which browsers already map into density-independent CSS pixels.
 * @param {number} viewportWidth Width of the layout viewport in CSS pixels.
 * @param {number} viewportHeight Height of the layout viewport in CSS pixels.
 * @param {boolean} hasCoarsePointer Whether the primary pointing device has limited precision, such as a finger.
 * @returns {number}
 */
export function getRecommendedUiZoom(viewportWidth, viewportHeight, hasCoarsePointer) {
    const width = Number(viewportWidth);
    const height = Number(viewportHeight);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return 1;
    const shortEdge = Math.min(width, height);
    return hasCoarsePointer && shortEdge <= COMPACT_TOUCH_MAX_SHORT_EDGE ? COMPACT_TOUCH_UI_ZOOM : 1;
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
            return { ...DEFAULT_CONFIG, ...parsed };
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
