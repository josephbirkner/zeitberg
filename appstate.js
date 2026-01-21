/**
 * Central application state container.
 * Tracks the current UI state and configuration for reuse across views.
 */
export class AppState {
    /**
     * Initializes state with persisted config and runtime flags.
     * Provides a simple setter used by the views.
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
     * Updates the stored repository configuration.
     * Provides a simple setter used by the views.
     * @param {import("./config.js").AppConfig} config
     * @returns {void}
     */
    setConfig(config) {
        this.config = { ...config };
    }

    /**
     * Stores the active access token in memory.
     * Provides a simple setter used by the views.
     * @param {string} token
     * @returns {void}
     */
    setToken(token) {
        this.token = token;
    }

    /**
     * Updates the currently selected week start string.
     * Provides a simple setter used by the views.
     * @param {string | null} weekStart
     * @returns {void}
     */
    setWeekStart(weekStart) {
        this.weekStart = weekStart;
    }

    /**
     * Updates the latest week start string derived from data.
     * Provides a simple setter used by the views.
     * @param {string | null} weekStart
     * @returns {void}
     */
    setLatestWeekStart(weekStart) {
        this.latestWeekStart = weekStart;
    }

    /**
     * Updates the vertical zoom factor for the week view.
     * Provides a simple setter used by the views.
     * @param {number} zoom
     * @returns {void}
     */
    setZoom(zoom) {
        this.zoom = zoom;
    }

    /**
     * Sets the active UI tab identifier.
     * Provides a simple setter used by the views.
     * @param {"week" | "search"} tab
     * @returns {void}
     */
    setActiveTab(tab) {
        this.activeTab = tab === "search" ? "search" : "week";
    }
}
