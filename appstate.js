/**
 * Central application state container.
 */
export class AppState {
    /**
     * @param {import("./config.js").AppConfig} config
     * @param {boolean} isLocalMode
     */
    constructor(config, isLocalMode) {
        this.config = { ...config };
        this.isLocalMode = isLocalMode;
        this.activeTab = "week";
        this.weekStart = null;
        this.latestWeekStart = null;
        this.zoom = 1;
        this.token = "";
        this.ghUser = null;
    }

    /**
     * @param {import("./config.js").AppConfig} config
     * @returns {void}
     */
    setConfig(config) {
        this.config = { ...config };
    }

    /**
     * @param {string} token
     * @returns {void}
     */
    setToken(token) {
        this.token = token;
    }

    /**
     * @param {string | null} weekStart
     * @returns {void}
     */
    setWeekStart(weekStart) {
        this.weekStart = weekStart;
    }

    /**
     * @param {string | null} weekStart
     * @returns {void}
     */
    setLatestWeekStart(weekStart) {
        this.latestWeekStart = weekStart;
    }

    /**
     * @param {number} zoom
     * @returns {void}
     */
    setZoom(zoom) {
        this.zoom = zoom;
    }

    /**
     * @param {"week" | "search"} tab
     * @returns {void}
     */
    setActiveTab(tab) {
        this.activeTab = tab === "search" ? "search" : "week";
    }
}
