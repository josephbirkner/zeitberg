import { formatDuration, safeText, setVisible } from "./utils.js";

/**
 * @typedef {Object} SearchViewOptions
 * @property {import("./store.js").EntryStore} store
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {Object} elements
 * @property {HTMLElement} elements.searchView
 * @property {HTMLInputElement} elements.searchInput
 * @property {HTMLSelectElement} elements.projectSelect
 * @property {HTMLInputElement} elements.fromDate
 * @property {HTMLInputElement} elements.toDate
 * @property {HTMLInputElement} elements.maxRows
 * @property {HTMLSelectElement} elements.sortSelect
 * @property {HTMLElement} elements.stats
 * @property {HTMLTableSectionElement} elements.entriesTbody
 * @property {(entry: import("./model.js").Entry) => void} onJumpToEntry
 */

/**
 * Renders search results as a desktop table that becomes touch-friendly cards on narrow viewports.
 * Provides filtering, sorting, and click-through to the week view from one shared result structure.
 */
export class SearchView {
    /**
     * Captures references to inputs and callbacks for filtering.
     * Keeps filtering behavior aligned with current data.
     * @param {SearchViewOptions} options
     */
    constructor(options) {
        this.store = options.store;
        this.timeContext = options.timeContext;

        this.searchViewEl = options.elements.searchView;
        this.searchInput = options.elements.searchInput;
        this.projectSelect = options.elements.projectSelect;
        this.fromDateInput = options.elements.fromDate;
        this.toDateInput = options.elements.toDate;
        this.maxRowsInput = options.elements.maxRows;
        this.sortSelect = options.elements.sortSelect;
        this.statsEl = options.elements.stats;
        this.entriesTbody = options.elements.entriesTbody;
        this.onJumpToEntry = options.onJumpToEntry;

        this.active = false;
        this.query = "";
        this.allEntries = [];
        this.searchDirty = false;

        this.bindEvents();
    }

    /**
     * Registers input listeners for live filtering.
     * Keeps filtering behavior aligned with current data.
     * @returns {void}
     */
    bindEvents() {
        this.searchInput.addEventListener("input", () => {
            if (!this.active) return;
            this.query = this.searchInput.value;
            this.applyFiltersAndRender();
        });
        const onChange = () => this.applyFiltersAndRender();
        for (const el of [this.projectSelect, this.fromDateInput, this.toDateInput, this.maxRowsInput, this.sortSelect]) {
            el.addEventListener("input", onChange);
            if (el instanceof HTMLSelectElement) el.addEventListener("change", onChange);
        }
    }

    /**
     * Shows or hides the view and refreshes results when active.
     * Keeps filtering behavior aligned with current data.
     * @param {boolean} isActive
     * @returns {void}
     */
    setActive(isActive) {
        this.active = Boolean(isActive);
        setVisible(this.searchViewEl, this.active);
        if (this.active) {
            queueMicrotask(() => this.applyFiltersAndRender());
        }
    }

    /**
     * Returns the time-entry query independently of the shared top-bar input's current view.
     * App uses this value when switching back from TODO search so each data type retains its own query.
     * @returns {string}
     */
    getSearchQuery() {
        return this.query;
    }

    /**
     * Replaces the time-entry query, optionally refreshing results when Search is already visible.
     * This is primarily used when typing into the shared search field from Week view.
     * @param {string} value
     * @param {boolean} [shouldRender]
     * @returns {void}
     */
    setSearchQuery(value, shouldRender = false) {
        this.query = String(value || "");
        if (this.active) this.searchInput.value = this.query;
        if (shouldRender && this.active) this.applyFiltersAndRender();
    }

    /**
     * Clears UI state after logout or reload.
     * Keeps filtering behavior aligned with current data.
     * @returns {void}
     */
    reset() {
        this.query = "";
        this.searchDirty = false;
        this.allEntries = [];
        this.entriesTbody.innerHTML = "";
        this.projectSelect.innerHTML = "";
        this.statsEl.textContent = "";
    }

    /**
     * Marks cached results as dirty so filters rerun.
     * Keeps filtering behavior aligned with current data.
     * @returns {void}
     */
    markDirty() {
        this.searchDirty = true;
    }

    /**
     * Rebuilds the project filter from the canonical project/section hierarchy.
     * Root options include every section beneath that project, while indented section options allow an exact assignment filter.
     * Keeps filtering behavior aligned with current data.
     * @param {import("./model.js").Entry[]} entries
     * @returns {void}
     */
    renderProjects(entries) {
        const knownProjects = this.store.getProjects();

        const current = this.projectSelect.value;
        this.projectSelect.innerHTML = "";
        const allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "All projects";
        this.projectSelect.append(allOpt);

        const noneOpt = document.createElement("option");
        noneOpt.value = "__none__";
        noneOpt.textContent = "No project";
        this.projectSelect.append(noneOpt);

        const sortedKnown = knownProjects.slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const project of sortedKnown) {
            const group = document.createElement("optgroup");
            group.label = project.archived ? `${project.name} (archived)` : project.name;
            group.append(new Option(`All ${project.name}`, `p:${project.key}`));
            for (const section of project.listSections()) {
                const suffix = section.archived ? " (archived)" : "";
                group.append(new Option(`${section.name}${suffix}`, `s:${project.key}/${section.key}`));
            }
            this.projectSelect.append(group);
        }

        this.projectSelect.value = current;
        if (!this.projectSelect.value && current !== "") {
            this.projectSelect.value = "";
        }
    }

    /**
     * Applies filters, updates stats, and renders the table.
     * Keeps filtering behavior aligned with current data.
     * @returns {void}
     */
    applyFiltersAndRender() {
        if (this.searchDirty) {
            this.allEntries = this.store.getAllEntries();
            this.renderProjects(this.allEntries);
            this.searchDirty = false;
        }

        const query = this.query.trim().toLowerCase();
        const project = this.projectSelect.value;
        const from = this.fromDateInput.value ? this.fromDateInput.value : null;
        const to = this.toDateInput.value ? this.toDateInput.value : null;
        const maxRows = Math.max(50, Number.parseInt(this.maxRowsInput.value || "500", 10) || 500);
        const sortDir = this.sortSelect.value === "asc" ? "asc" : "desc";

        const qTokens = query ? query.split(/\s+/).filter(Boolean) : [];

        let entries = this.allEntries;
        if (project === "__none__") {
            entries = entries.filter((entry) => !entry.projectKey);
        } else if (project.startsWith("p:")) {
            const projectKey = project.slice(2);
            entries = entries.filter((entry) => entry.projectKey === projectKey);
        } else if (project.startsWith("s:")) {
            const [projectKey, sectionKey] = project.slice(2).split("/", 2);
            entries = entries.filter((entry) => entry.projectKey === projectKey && entry.sectionKey === sectionKey);
        }
        if (from) {
            entries = entries.filter((entry) => this.timeContext.formatDate(entry.startDate) >= from);
        }
        if (to) {
            entries = entries.filter((entry) => this.timeContext.formatDate(entry.startDate) <= to);
        }
        if (qTokens.length) {
            entries = entries.filter((entry) => qTokens.every((token) => entry.searchHaystack.includes(token)));
        }

        entries = entries.slice().sort((a, b) => {
            const diff = a.startDate.getTime() - b.startDate.getTime();
            if (diff !== 0) return sortDir === "asc" ? diff : -diff;
            return sortDir === "asc" ? a.id - b.id : b.id - a.id;
        });

        const total = entries.length;
        const shown = entries.slice(0, maxRows);
        const dur = entries.reduce((sum, entry) => {
            if (typeof entry.durationSeconds === "number" && Number.isFinite(entry.durationSeconds) && entry.durationSeconds >= 0) {
                return sum + entry.durationSeconds;
            }
            return sum;
        }, 0);
        this.statsEl.textContent = `${total} match • ${formatDuration(dur)} total • showing ${shown.length}`;

        this.entriesTbody.innerHTML = "";
        const frag = document.createDocumentFragment();
        for (const entry of shown) {
            const tr = document.createElement("tr");
            tr.classList.add("row-link", "search-result-card");
            tr.title = "Open this entry in Week view";
            tr.tabIndex = 0;
            tr.addEventListener("click", () => this.onJumpToEntry(entry));
            tr.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                this.onJumpToEntry(entry);
            });

            const tdDate = document.createElement("td");
            tdDate.className = "search-result-cell search-result-date";
            tdDate.dataset.label = "Date";
            tdDate.textContent = this.timeContext.formatDate(entry.startDate);
            const tdStart = document.createElement("td");
            tdStart.className = "search-result-cell search-result-start";
            tdStart.dataset.label = "Start";
            tdStart.textContent = this.timeContext.formatTime(entry.startDate);
            const tdEnd = document.createElement("td");
            tdEnd.className = "search-result-cell search-result-end";
            tdEnd.dataset.label = "End";
            tdEnd.textContent = entry.endDate ? this.timeContext.formatTime(entry.endDate) : "—";
            const tdDur = document.createElement("td");
            tdDur.className = "search-result-cell search-result-duration";
            tdDur.dataset.label = "Duration";
            tdDur.textContent = formatDuration(entry.durationSeconds);

            const tdProject = document.createElement("td");
            tdProject.className = "search-result-cell search-result-project";
            tdProject.dataset.label = "Project";
            tdProject.textContent = this.store.getAssignmentLabel(entry.projectKey, entry.sectionKey) || "No project";
            const tdDesc = document.createElement("td");
            tdDesc.className = "search-result-cell search-result-description";
            tdDesc.dataset.label = "Description";
            tdDesc.textContent = safeText(entry.description);
            const tdBillable = document.createElement("td");
            tdBillable.className = "search-result-cell search-result-billable";
            tdBillable.dataset.label = "Billable";
            tdBillable.textContent = entry.billable === true ? "Yes" : entry.billable === false ? "No" : "—";

            tr.append(tdDate, tdStart, tdEnd, tdDur, tdProject, tdDesc, tdBillable);
            frag.append(tr);
        }
        this.entriesTbody.append(frag);
    }
}
