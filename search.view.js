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
 * @property {HTMLDataListElement} elements.projectDatalist
 * @property {(entry: import("./model.js").Entry) => void} onJumpToEntry
 */

/**
 * Renders the search/browse table.
 */
export class SearchView {
    /**
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
        this.projectDatalistEl = options.elements.projectDatalist;

        this.onJumpToEntry = options.onJumpToEntry;

        this.allEntries = [];
        this.searchDirty = false;

        this.bindEvents();
    }

    /**
     * @returns {void}
     */
    bindEvents() {
        const onChange = () => this.applyFiltersAndRender();
        for (const el of [this.searchInput, this.projectSelect, this.fromDateInput, this.toDateInput, this.maxRowsInput, this.sortSelect]) {
            el.addEventListener("input", onChange);
            if (el instanceof HTMLSelectElement) el.addEventListener("change", onChange);
        }
    }

    /**
     * @param {boolean} isActive
     * @returns {void}
     */
    setActive(isActive) {
        setVisible(this.searchViewEl, isActive);
        if (isActive) {
            queueMicrotask(() => this.applyFiltersAndRender());
        }
    }

    /**
     * @returns {void}
     */
    reset() {
        this.searchDirty = false;
        this.allEntries = [];
        this.entriesTbody.innerHTML = "";
        this.projectSelect.innerHTML = "";
        this.projectDatalistEl.innerHTML = "";
        this.statsEl.textContent = "";
    }

    /**
     * @returns {void}
     */
    markDirty() {
        this.searchDirty = true;
    }

    /**
     * @param {import("./model.js").Entry[]} entries
     * @returns {void}
     */
    renderProjects(entries) {
        const projects = new Set();
        for (const entry of entries) {
            if (entry.project) projects.add(entry.project);
        }
        const sorted = Array.from(projects).sort((a, b) => a.localeCompare(b));

        const current = this.projectSelect.value;
        this.projectSelect.innerHTML = "";
        const allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "All projects";
        this.projectSelect.append(allOpt);

        for (const project of sorted) {
            const opt = document.createElement("option");
            opt.value = project;
            opt.textContent = project;
            this.projectSelect.append(opt);
        }

        if (current) this.projectSelect.value = current;

        this.projectDatalistEl.innerHTML = "";
        for (const project of sorted) {
            const opt = document.createElement("option");
            opt.value = project;
            this.projectDatalistEl.append(opt);
        }
    }

    /**
     * @returns {void}
     */
    applyFiltersAndRender() {
        if (this.searchDirty) {
            this.allEntries = this.store.getAllEntries();
            this.renderProjects(this.allEntries);
            this.searchDirty = false;
        }

        const query = this.searchInput.value.trim().toLowerCase();
        const project = this.projectSelect.value;
        const from = this.fromDateInput.value ? this.fromDateInput.value : null;
        const to = this.toDateInput.value ? this.toDateInput.value : null;
        const maxRows = Math.max(50, Number.parseInt(this.maxRowsInput.value || "500", 10) || 500);
        const sortDir = this.sortSelect.value === "asc" ? "asc" : "desc";

        const qTokens = query ? query.split(/\s+/).filter(Boolean) : [];

        let entries = this.allEntries;
        if (project) entries = entries.filter((entry) => entry.project === project);
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
            tr.classList.add("row-link");
            tr.title = "Open this entry in Week view";
            tr.addEventListener("click", () => this.onJumpToEntry(entry));

            const tdDate = document.createElement("td");
            tdDate.textContent = this.timeContext.formatDate(entry.startDate);
            const tdStart = document.createElement("td");
            tdStart.textContent = this.timeContext.formatTime(entry.startDate);
            const tdEnd = document.createElement("td");
            tdEnd.textContent = entry.endDate ? this.timeContext.formatTime(entry.endDate) : "—";
            const tdDur = document.createElement("td");
            tdDur.textContent = formatDuration(entry.durationSeconds);

            const tdProject = document.createElement("td");
            tdProject.textContent = safeText(entry.project);
            const tdDesc = document.createElement("td");
            tdDesc.textContent = safeText(entry.description);
            const tdTags = document.createElement("td");
            tdTags.textContent = Array.isArray(entry.tags) ? entry.tags.join(", ") : "";
            const tdBillable = document.createElement("td");
            tdBillable.textContent = entry.billable === true ? "Yes" : entry.billable === false ? "No" : "—";

            tr.append(tdDate, tdStart, tdEnd, tdDur, tdProject, tdDesc, tdTags, tdBillable);
            frag.append(tr);
        }
        this.entriesTbody.append(frag);
    }
}
