import {
    addIsoDays,
    cloneJson,
    formatDuration,
    parseHexColor,
    hhmmToMinutes,
    chunkKey,
    isoWeekInfo,
    isoWeekStart,
    isoWeekdayIndex,
    isEditableTarget,
    minutesToHHMM,
    safeText,
    setVisible,
    utcNowIso,
} from "./utils.js";

const MIN_ENTRY_MINUTES = 15;
const MIN_ENTRY_MS = MIN_ENTRY_MINUTES * 60 * 1000;

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DESC_SUGGEST_MIN_CHARS = 2;
const DESC_SUGGEST_LIMIT = 8;

/**
 * @typedef {Object} WeekViewOptions
 * @description Dependency bundle for week view rendering and editing.
 * @property {import("./store.js").EntryStore} store
 * @property {import("./cache.js").ChunkCache} chunkCache
 * @property {import("./appstate.js").AppState} appState
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {Object} elements
 * @property {HTMLElement} elements.weekViewSection
 * @property {HTMLElement} elements.weekControls
 * @property {HTMLElement} elements.weekLabel
 * @property {HTMLElement} elements.weekBillable
 * @property {HTMLElement} elements.weekScroll
 * @property {HTMLButtonElement} elements.prevWeekBtn
 * @property {HTMLButtonElement} elements.nextWeekBtn
 * @property {HTMLButtonElement} elements.latestWeekBtn
 * @property {HTMLInputElement} elements.zoomInput
 * @property {HTMLElement} elements.editorBadge
 * @property {HTMLDialogElement} elements.entryDialog
 * @property {HTMLFormElement} elements.entryForm
 * @property {HTMLButtonElement} elements.entryCloseBtn
 * @property {HTMLButtonElement} elements.entryCancelBtn
 * @property {HTMLElement} elements.entryMeta
 * @property {HTMLInputElement} elements.entryProject
 * @property {HTMLDataListElement} elements.entryProjectList
 * @property {HTMLTextAreaElement} elements.entryDesc
 * @property {HTMLElement} elements.entryDescSuggestions
 * @property {(message: string, timeout?: number, tone?: "error" | "success") => void} onToast
 * @property {(isBusy: boolean) => void} onBusy
 * @property {() => void} onSearchDirty
 * @property {() => void} onManifestUpdated
 */

/**
 * Renders the week view and manages editor interactions.
 * Owns keyboard navigation, selection, and edit/save workflows.
 */
export class WeekView {
    /**
     * Initializes view state and captures UI element references.
     * Part of the week view interaction flow.
     * @param {WeekViewOptions} options
     */
    constructor(options) {
        this.store = options.store;
        this.chunkCache = options.chunkCache;
        this.appState = options.appState;
        this.timeContext = options.timeContext;
        this.dataSource = options.dataSource;

        this.weekViewSection = options.elements.weekViewSection;
        this.weekControlsEl = options.elements.weekControls;
        this.weekLabelEl = options.elements.weekLabel;
        this.weekBillableEl = options.elements.weekBillable;
        this.weekScrollEl = options.elements.weekScroll;
        this.prevWeekBtn = options.elements.prevWeekBtn;
        this.nextWeekBtn = options.elements.nextWeekBtn;
        this.latestWeekBtn = options.elements.latestWeekBtn;
        this.zoomInput = options.elements.zoomInput;
        this.editorBadgeEl = options.elements.editorBadge;

        this.entryDialog = options.elements.entryDialog;
        this.entryForm = options.elements.entryForm;
        this.entryCloseBtn = options.elements.entryCloseBtn;
        this.entryCancelBtn = options.elements.entryCancelBtn;
        this.entryMetaEl = options.elements.entryMeta;
        this.entryProjectInput = options.elements.entryProject;
        this.entryProjectListEl = options.elements.entryProjectList;
        this.entryDescInput = options.elements.entryDesc;
        this.entryDescSuggestionsEl = options.elements.entryDescSuggestions;

        this.onToast = options.onToast;
        this.onBusy = options.onBusy;
        this.onSearchDirty = options.onSearchDirty;
        this.onManifestUpdated = options.onManifestUpdated;

        this.weekDom = null;
        this.segmentsIndex = new Map();
        this.projectColorCache = new Map();
        this.focusedDayIndex = 0;
        this.focusedEntryIndexByDay = Array(7).fill(0);
        this.selectedSegKey = null;
        this.selectedEntryId = null;
        this.editMode = "normal";
        this.cursor = null;
        this.cursorEl = null;
        this.addDraft = null;
        this.addDraftEl = null;
        this.dialogEntryId = null;
        this.dialogAllowUnlistedProject = false;
        this.descSuggestions = [];

        this.dirtyWeekStarts = new Set();
        this.saveInFlight = false;
        this.toastTimer = 0;
        this.nowTimer = 0;
        this.nowLineEl = null;
        this.nowLineDayIdx = -1;

        this.undoStack = [];
        this.redoStack = [];

        const initialZoom = Number.parseFloat(this.zoomInput.value || "1");
        this.zoom = Number.isFinite(initialZoom) && initialZoom >= 1 ? initialZoom : 1;

        this.bindEvents();
    }

    /**
     * Updates the data source for future save requests.
     * Part of the week view interaction flow.
     * @param {import("./datasource.js").DataSource} dataSource
     * @returns {void}
     */
    setDataSource(dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Applies a new project list and refreshes cached colors.
     * Part of the week view interaction flow.
     * @param {import("./model.js").ProjectList | null} projectList
     * @returns {void}
     */
    setProjects(projectList) {
        if (projectList) {
            this.store.setProjectList(projectList);
        }
        this.projectColorCache.clear();
        if (this.entryDialog.open && this.dialogEntryId) {
            const entry = this.store.getEntryById(this.dialogEntryId);
            if (entry) {
                this.populateProjectSelect({
                    selected: safeText(entry.project),
                    allowUnlisted: !this.store.getProjectByName(entry.project || ""),
                });
            }
        }
        if (this.appState.weekStart) {
            this.rebuildWeekView();
        }
    }

    /**
     * Registers UI events for navigation and dialog actions.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    bindEvents() {
        this.prevWeekBtn.addEventListener("click", () => this.handlePrevWeek());
        this.nextWeekBtn.addEventListener("click", () => this.handleNextWeek());
        this.latestWeekBtn.addEventListener("click", () => this.handleLatestWeek());
        this.zoomInput.addEventListener("input", () => this.handleZoomInput());

        this.entryCloseBtn.addEventListener("click", () => this.closeEntryDialog());
        this.entryCancelBtn.addEventListener("click", () => this.closeEntryDialog());
        this.entryDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.closeEntryDialog();
        });
        this.entryForm.addEventListener("submit", (ev) => this.handleEntryFormSubmit(ev));
        this.entryDescInput.addEventListener("input", () => this.handleDescriptionInput());
        this.entryDescInput.addEventListener("keydown", (ev) => this.handleDescriptionKeydown(ev));
        this.entryDescSuggestionsEl.addEventListener("mousedown", (ev) => this.handleSuggestionPointerDown(ev));
        this.entryDescSuggestionsEl.addEventListener("click", (ev) => this.handleSuggestionClick(ev));
        this.entryDescSuggestionsEl.addEventListener("keydown", (ev) => this.handleSuggestionKeydown(ev));
    }

    /**
     * Shows or hides the week view and repositions the timeline.
     * Part of the week view interaction flow.
     * @param {boolean} isActive
     * @returns {void}
     */
    setActive(isActive) {
        setVisible(this.weekViewSection, isActive);
        if (isActive) {
            queueMicrotask(() => {
                try {
                    this.weekScrollEl.focus();
                } catch {
                    // ignore
                }
                this.updateWeekScaleAndReposition();
            });
            this.startNowTimer();
        } else {
            this.stopNowTimer();
        }
    }

    /**
     * Resets view state for logout or reload.
     * Clears selection, cached DOM, and undo history.
     * @returns {void}
     */
    reset() {
        this.weekScrollEl.innerHTML = "";
        this.weekLabelEl.textContent = "";
        if (this.weekBillableEl) {
            this.weekBillableEl.textContent = "";
        }
        this.weekDom = null;
        this.segmentsIndex = new Map();
        this.projectColorCache.clear();
        this.focusedDayIndex = 0;
        this.focusedEntryIndexByDay = Array(7).fill(0);
        this.selectedSegKey = null;
        this.selectedEntryId = null;
        this.dialogEntryId = null;
        this.dialogAllowUnlistedProject = false;
        this.saveInFlight = false;
        this.dirtyWeekStarts.clear();
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.setEditMode("normal");
        this.updateEditorBadge();
        this.clearDescriptionSuggestions();
        this.clearAddDraft();
        this.stopNowTimer();
        this.clearNowMarker();
    }

    /**
     * Sets the active week and rebuilds the timeline.
     * Part of the week view interaction flow.
     * @param {string | null} weekStart
     * @param {number} [focusedDayIndex]
     * @returns {void}
     */
    setWeekStart(weekStart, focusedDayIndex = this.focusedDayIndex) {
        if (!weekStart) return;
        this.appState.setWeekStart(weekStart);
        this.focusedDayIndex = Math.max(0, Math.min(6, focusedDayIndex));
        this.rebuildWeekView();
    }

    /**
     * Updates latest week metadata and button state.
     * Part of the week view interaction flow.
     * @param {string | null} latestWeekStart
     * @returns {void}
     */
    setLatestWeekStart(latestWeekStart) {
        this.appState.setLatestWeekStart(latestWeekStart);
        if (latestWeekStart && this.appState.weekStart === latestWeekStart) {
            this.latestWeekBtn.disabled = true;
        } else {
            this.latestWeekBtn.disabled = false;
        }
    }

    /**
     * Moves focus to the previous week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    handlePrevWeek() {
        if (!this.appState.weekStart) return;
        this.setWeekStart(addIsoDays(this.appState.weekStart, -7));
    }

    /**
     * Moves focus to the next week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    handleNextWeek() {
        if (!this.appState.weekStart) return;
        this.setWeekStart(addIsoDays(this.appState.weekStart, 7));
    }

    /**
     * Jumps focus to the latest available week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    handleLatestWeek() {
        if (!this.appState.latestWeekStart) return;
        this.setWeekStart(this.appState.latestWeekStart);
    }

    /**
     * Updates zoom state from the range input.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    handleZoomInput() {
        const nextZoom = Number.parseFloat(this.zoomInput.value || "1");
        if (!Number.isFinite(nextZoom) || nextZoom < 1) return;
        this.zoom = nextZoom;
        this.appState.setZoom(nextZoom);
        this.updateWeekScaleAndReposition();
    }

    /**
     * Adjusts zoom by discrete steps and clamps to range bounds.
     * Part of the week view interaction flow.
     * @param {number} deltaSteps
     * @returns {void}
     */
    nudgeZoom(deltaSteps) {
        const stepText = String(this.zoomInput.step || "0.25");
        const step = Number.parseFloat(stepText);
        if (!Number.isFinite(step) || step <= 0) return;
        const min = Number.parseFloat(this.zoomInput.min || "1");
        const max = Number.parseFloat(this.zoomInput.max || "4");
        const current = Number.parseFloat(this.zoomInput.value || String(this.zoom || 1));
        const base = Number.isFinite(current) ? current : this.zoom;

        const currentSteps = Math.round((base - min) / step);
        let next = min + (currentSteps + deltaSteps) * step;
        if (Number.isFinite(min)) next = Math.max(min, next);
        if (Number.isFinite(max)) next = Math.min(max, next);

        const decimals = stepText.includes(".") ? stepText.split(".")[1].length : 0;
        next = Number(next.toFixed(Math.min(6, Math.max(0, decimals))));
        if (!Number.isFinite(next) || next < 1) return;

        this.zoom = next;
        this.appState.setZoom(next);
        this.zoomInput.value = String(next);
        this.updateWeekScaleAndReposition();
    }

    /**
     * Updates the editor badge with mode and save status.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    updateEditorBadge() {
        const dirty = this.dirtyWeekStarts.size > 0;
        const mode = String(this.editMode || "normal").toUpperCase();
        const save = this.saveInFlight ? "Saving…" : dirty ? "Unsaved" : "Saved";
        this.editorBadgeEl.classList.toggle("is-dirty", dirty);
        this.editorBadgeEl.innerHTML = `<span class="dot"></span><span class="mode">${mode}</span><span class="save">${save}</span>`;
    }

    /**
     * Clears the cursor line from the DOM.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    clearCursor() {
        this.cursor = null;
        if (this.cursorEl) this.cursorEl.remove();
        this.cursorEl = null;
    }

    /**
     * Positions the cursor line within the current week grid.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    updateCursorLine() {
        if (!this.weekDom || !this.cursor || !this.weekDom.metrics) {
            this.clearCursor();
            return;
        }

        const dt = new Date(this.cursor.ms);
        if (Number.isNaN(dt.getTime())) {
            this.clearCursor();
            return;
        }
        const dayStr = this.timeContext.formatDate(dt);
        const dayIdx = this.weekDom.days.indexOf(dayStr);
        if (dayIdx < 0) {
            this.clearCursor();
            return;
        }

        const minutes = hhmmToMinutes(this.timeContext.formatTime(dt));
        if (minutes === null) {
            this.clearCursor();
            return;
        }

        if (!this.cursorEl) {
            this.cursorEl = document.createElement("div");
            this.cursorEl.className = "cursor-line";
        }

        this.cursorEl.classList.toggle("is-split", this.cursor.kind === "split");
        this.cursorEl.style.top = `${minutes * this.weekDom.metrics.pxPerMinute}px`;

        const parent = this.weekDom.dayColEls[dayIdx];
        if (this.cursorEl.parentElement !== parent) parent.append(this.cursorEl);
    }

    /**
     * Clears the in-progress add-mode draft entry.
     * Removes any preview element from the week grid.
     * @returns {void}
     */
    clearAddDraft() {
        this.addDraft = null;
        if (this.addDraftEl) {
            this.addDraftEl.remove();
        }
        this.addDraftEl = null;
    }

    /**
     * Updates the add-mode draft preview block in the week grid.
     * Keeps the draft entry aligned with zoom and scrolling changes.
     * @returns {void}
     */
    updateAddDraftPreview() {
        if (!this.weekDom || !this.weekDom.metrics || !this.addDraft) {
            if (this.addDraftEl) {
                this.addDraftEl.remove();
                this.addDraftEl = null;
            }
            return;
        }
        const dayIdx = this.weekDom.days.indexOf(this.addDraft.dayStr);
        if (dayIdx < 0) {
            if (this.addDraftEl) {
                this.addDraftEl.remove();
                this.addDraftEl = null;
            }
            return;
        }

        if (!this.addDraftEl) {
            this.addDraftEl = document.createElement("div");
            this.addDraftEl.className = "entry-block entry-draft";
        }

        const pxPerMinute = this.weekDom.metrics.pxPerMinute;
        const startMinutes = this.addDraft.startMinutes;
        const endMinutes = this.addDraft.endMinutes;
        const topPx = startMinutes * pxPerMinute;
        const heightPx = Math.max(1, (endMinutes - startMinutes) * pxPerMinute);

        this.addDraftEl.style.top = `${topPx}px`;
        this.addDraftEl.style.height = `${heightPx}px`;
        this.addDraftEl.style.left = "0";
        this.addDraftEl.style.width = "100%";

        const parent = this.weekDom.dayColEls[dayIdx];
        if (this.addDraftEl.parentElement !== parent) parent.append(this.addDraftEl);
    }

    /**
     * Starts a timer to keep the current-time marker updated.
     * Ensures the marker remains accurate while viewing the week.
     * @returns {void}
     */
    startNowTimer() {
        if (this.nowTimer) return;
        this.updateNowMarker();
        this.nowTimer = window.setInterval(() => {
            this.updateNowMarker();
        }, 60_000);
    }

    /**
     * Stops the current-time marker timer.
     * Avoids unnecessary updates when the week view is hidden.
     * @returns {void}
     */
    stopNowTimer() {
        if (!this.nowTimer) return;
        window.clearInterval(this.nowTimer);
        this.nowTimer = 0;
    }

    /**
     * Removes the current-time marker from the DOM.
     * Clears cached references after week rebuilds.
     * @returns {void}
     */
    clearNowMarker() {
        if (this.nowLineEl) {
            this.nowLineEl.remove();
        }
        this.nowLineEl = null;
        this.nowLineDayIdx = -1;
    }

    /**
     * Positions the current-time marker inside the active week.
     * Hides the marker when the current day is outside the week.
     * @returns {void}
     */
    updateNowMarker() {
        if (!this.weekDom || !this.weekDom.metrics || !this.appState.weekStart) {
            this.clearNowMarker();
            return;
        }
        const now = new Date();
        const dayStr = this.timeContext.formatDate(now);
        const dayIdx = this.weekDom.days.indexOf(dayStr);
        if (dayIdx < 0) {
            this.clearNowMarker();
            return;
        }
        const minutes = hhmmToMinutes(this.timeContext.formatTime(now));
        if (minutes === null) {
            this.clearNowMarker();
            return;
        }

        const topPx = Math.max(0, Math.min(this.weekDom.metrics.timelineHeight, minutes * this.weekDom.metrics.pxPerMinute));
        if (!this.nowLineEl) {
            this.nowLineEl = document.createElement("div");
            this.nowLineEl.className = "now-line";
        }
        if (this.nowLineDayIdx !== dayIdx || !this.nowLineEl.parentElement) {
            this.nowLineDayIdx = dayIdx;
            this.weekDom.dayColEls[dayIdx].append(this.nowLineEl);
        }
        this.nowLineEl.style.top = `${topPx}px`;
    }

    /**
     * Switches between normal, add, and split edit modes.
     * Part of the week view interaction flow.
     * @param {"normal" | "add" | "split"} nextMode
     * @returns {void}
     */
    setEditMode(nextMode) {
        const next = nextMode === "add" ? "add" : nextMode === "split" ? "split" : "normal";
        const wasAdd = this.editMode === "add";
        this.editMode = next;
        if (next === "normal") this.clearCursor();
        if (wasAdd && next !== "add") {
            this.clearAddDraft();
        }
        this.updateCursorLine();
        this.updateEditorBadge();
    }

    /**
     * Clamps focus indices to available entries in the week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    clampWeekFocus() {
        this.focusedDayIndex = Math.max(0, Math.min(6, this.focusedDayIndex));
        if (!this.weekDom) return;
        const keys = this.weekDom.dayKeys[this.focusedDayIndex] || [];
        if (!keys.length) {
            this.focusedEntryIndexByDay[this.focusedDayIndex] = 0;
            return;
        }
        const current = Number(this.focusedEntryIndexByDay[this.focusedDayIndex] || 0);
        this.focusedEntryIndexByDay[this.focusedDayIndex] = Math.max(0, Math.min(keys.length - 1, current));
    }

    /**
     * Applies focus styling and updates selected entry metadata.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    applyWeekFocusAndSelection() {
        if (!this.weekDom) return;
        this.clampWeekFocus();

        for (let i = 0; i < this.weekDom.dayColEls.length; i++) {
            this.weekDom.dayColEls[i].classList.toggle("is-focused", i === this.focusedDayIndex);
        }

        const dayKeys = this.weekDom.dayKeys[this.focusedDayIndex] || [];
        const selectedKey = dayKeys.length ? dayKeys[this.focusedEntryIndexByDay[this.focusedDayIndex] || 0] : null;
        this.selectedSegKey = selectedKey || null;
        this.selectedEntryId = null;
        if (selectedKey && typeof selectedKey === "string") {
            const at = selectedKey.indexOf("@");
            const idText = at >= 0 ? selectedKey.slice(0, at) : selectedKey;
            const idNum = Number.parseInt(idText, 10);
            if (Number.isFinite(idNum)) this.selectedEntryId = idNum;
        }
        for (const [key, el] of this.weekDom.entryElsByKey.entries()) {
            el.classList.toggle("is-selected", Boolean(selectedKey && key === selectedKey));
        }
    }

    /**
     * Scrolls the focused day or entry into view.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    scrollWeekFocusIntoView() {
        if (!this.weekDom) return;
        const dayKeys = this.weekDom.dayKeys[this.focusedDayIndex] || [];
        const selectedKey = dayKeys.length ? dayKeys[this.focusedEntryIndexByDay[this.focusedDayIndex] || 0] : null;

        const target = selectedKey ? this.weekDom.entryElsByKey.get(selectedKey) : this.weekDom.dayColEls[this.focusedDayIndex];
        if (!target) return;
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    /**
     * Computes layout metrics based on zoom and container height.
     * Part of the week view interaction flow.
     * @returns {{baseHeight: number, headerHeight: number, timelineHeight: number, pxPerMinute: number} | null}
     */
    computeWeekMetrics() {
        if (!this.weekDom) return null;
        const headerEl = /** @type {HTMLElement | null} */ (this.weekDom.gridEl.querySelector(".wg-header"));
        const headerHeight = headerEl ? headerEl.offsetHeight : 48;
        const baseHeight = Math.max(240, this.weekScrollEl.clientHeight - headerHeight);
        const timelineHeight = Math.max(240, Math.round(baseHeight * this.zoom));
        return { baseHeight, headerHeight, timelineHeight, pxPerMinute: timelineHeight / 1440 };
    }

    /**
     * Renders hour labels along the time axis.
     * Part of the week view interaction flow.
     * @param {{timelineHeight: number, pxPerMinute: number}} metrics
     * @returns {void}
     */
    renderTimeAxis(metrics) {
        if (!this.weekDom) return;
        const { timelineHeight, pxPerMinute } = metrics;
        this.weekDom.timeAxisEl.innerHTML = "";

        for (let hour = 0; hour <= 24; hour++) {
            if (hour === 24 && timelineHeight < 420) continue;
            const top = hour * 60 * pxPerMinute;
            const label = document.createElement("div");
            label.className = "wg-time-label";
            label.textContent = `${String(hour).padStart(2, "0")}:00`;
            label.style.top = `${top}px`;
            label.style.transform = hour === 0 ? "translateY(0)" : "translateY(-50%)";
            this.weekDom.timeAxisEl.append(label);
        }
    }

    /**
     * Repositions entry blocks after zoom or resize changes.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    updateWeekScaleAndReposition() {
        if (!this.weekDom) return;
        const metrics = this.computeWeekMetrics();
        if (!metrics) return;
        this.weekDom.metrics = metrics;
        this.weekDom.gridEl.style.setProperty("--timeline-height", `${metrics.timelineHeight}px`);
        this.renderTimeAxis(metrics);

        for (const el of this.weekDom.entryElsByKey.values()) {
            const start = Number.parseFloat(el.dataset.start || "0");
            const end = Number.parseFloat(el.dataset.end || "0");
            const topPx = start * metrics.pxPerMinute;
            const heightPx = Math.max(1, (end - start) * metrics.pxPerMinute);
            el.style.top = `${topPx}px`;
            el.style.height = `${heightPx}px`;
        }

        this.updateCursorLine();
        this.updateAddDraftPreview();
        this.updateNowMarker();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Rebuilds the week DOM from the store segment index.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    rebuildWeekView() {
        this.weekScrollEl.innerHTML = "";
        this.weekDom = null;
        this.clearNowMarker();
        this.addDraftEl = null;

        const weekStart = this.appState.weekStart;
        const hasProjectList = Boolean(this.store.getProjectList());
        if (!weekStart) {
            this.weekLabelEl.textContent = "";
            if (this.weekBillableEl) {
                this.weekBillableEl.textContent = "";
            }
            return;
        }

        this.segmentsIndex = this.store.getWeekSegmentsIndex(weekStart);

        const days = Array.from({ length: 7 }, (_, i) => addIsoDays(weekStart, i));
        const weekEnd = days[6];
        const { isoYear, week } = isoWeekInfo(weekStart);
        this.weekLabelEl.textContent = `${isoYear}-W${String(week).padStart(2, "0")} • ${weekStart} → ${weekEnd}`;
        this.updateWeekBillableTotal(weekStart);

        const gridEl = document.createElement("div");
        gridEl.className = "week-grid";

        const timeHeader = document.createElement("div");
        timeHeader.className = "wg-header";
        gridEl.append(timeHeader);

        for (let i = 0; i < 7; i++) {
            const header = document.createElement("div");
            header.className = "wg-header";
            header.dataset.dayIdx = String(i);

            const dowEl = document.createElement("div");
            dowEl.className = "wg-dow";
            dowEl.textContent = DOW_LABELS[i];
            const dateEl = document.createElement("div");
            dateEl.className = "wg-date";
            dateEl.textContent = days[i];

            header.append(dowEl, dateEl);
            header.addEventListener("click", () => {
                this.focusedDayIndex = i;
                this.applyWeekFocusAndSelection();
                this.scrollWeekFocusIntoView();
                this.weekScrollEl.focus();
            });
            gridEl.append(header);
        }

        const timeAxisEl = document.createElement("div");
        timeAxisEl.className = "wg-timeaxis";
        gridEl.append(timeAxisEl);

        const dayColEls = [];
        const entryElsByKey = new Map();
        const keyToIndexByDay = Array.from({ length: 7 }, () => new Map());
        const dayKeys = Array.from({ length: 7 }, () => []);

        for (let i = 0; i < 7; i++) {
            const col = document.createElement("div");
            col.className = "wg-daycol";
            col.dataset.dayIdx = String(i);
            col.addEventListener("click", () => {
                this.focusedDayIndex = i;
                this.applyWeekFocusAndSelection();
                this.scrollWeekFocusIntoView();
                this.weekScrollEl.focus();
            });
            dayColEls.push(col);
            gridEl.append(col);
        }

        this.weekScrollEl.append(gridEl);
        this.weekDom = { days, dayColEls, dayKeys, entryElsByKey, gridEl, keyToIndexByDay, metrics: null, timeAxisEl };

        const metrics = this.computeWeekMetrics();
        if (metrics) {
            this.weekDom.metrics = metrics;
            gridEl.style.setProperty("--timeline-height", `${metrics.timelineHeight}px`);
            this.renderTimeAxis(metrics);
        }

        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
            const dateStr = days[dayIdx];
            const segs = (this.segmentsIndex.get(dateStr) || []).slice();
            segs.sort(
                (a, b) =>
                    a.startMinutes - b.startMinutes ||
                    a.endMinutes - b.endMinutes ||
                    (a.entry?.project || "").localeCompare(b.entry?.project || "") ||
                    (a.entry?.id || 0) - (b.entry?.id || 0),
            );

            const laneEnds = [];
            const assigned = [];
            for (const seg of segs) {
                let lane = -1;
                let bestEnd = Infinity;
                for (let i = 0; i < laneEnds.length; i++) {
                    const end = laneEnds[i];
                    if (end <= seg.startMinutes && end < bestEnd) {
                        lane = i;
                        bestEnd = end;
                    }
                }
                if (lane === -1) {
                    lane = laneEnds.length;
                    laneEnds.push(seg.endMinutes);
                } else {
                    laneEnds[lane] = seg.endMinutes;
                }
                assigned.push({ lane, seg });
            }

            const laneCount = Math.max(1, laneEnds.length);
            const pxPerMinute = this.weekDom.metrics ? this.weekDom.metrics.pxPerMinute : 1;

            for (let idx = 0; idx < assigned.length; idx++) {
                const { lane, seg } = assigned[idx];
                const entry = seg.entry || {};
                const projectName = entry.project || "";
                const projectLabel = projectName || "No project";
                const description = entry.description || "";

                dayKeys[dayIdx].push(seg.key);
                keyToIndexByDay[dayIdx].set(seg.key, idx);

                const el = document.createElement("div");
                el.className = "entry-block";
                el.dataset.key = seg.key;
                el.dataset.dayIdx = String(dayIdx);
                el.dataset.start = String(seg.startMinutes);
                el.dataset.end = String(seg.endMinutes);

                const colors = this.projectColors(projectName);
                el.style.setProperty("--entry-bg", colors.bg);
                el.style.setProperty("--entry-border", colors.border);

                const widthPct = 100 / laneCount;
                el.style.left = `${lane * widthPct}%`;
                el.style.width = `${widthPct}%`;

                const topPx = seg.startMinutes * pxPerMinute;
                const heightPx = Math.max(1, (seg.endMinutes - seg.startMinutes) * pxPerMinute);
                el.style.top = `${topPx}px`;
                el.style.height = `${heightPx}px`;

                const projectEl = document.createElement("div");
                projectEl.className = "entry-project";
                projectEl.textContent = projectLabel;
                const descEl = document.createElement("div");
                descEl.className = "entry-desc";
                descEl.textContent = description;
                const timeEl = document.createElement("div");
                timeEl.className = "entry-times";
                timeEl.textContent = `${minutesToHHMM(seg.startMinutes)}–${minutesToHHMM(seg.endMinutes)}`;
                el.append(projectEl, descEl, timeEl);

                el.title = `${dateStr} ${minutesToHHMM(seg.startMinutes)}–${minutesToHHMM(seg.endMinutes)} • ${projectLabel}${
                    description ? ` • ${description}` : ""
                }`;

                el.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    this.focusedDayIndex = dayIdx;
                    const idxInDay = keyToIndexByDay[dayIdx].get(seg.key);
                    if (typeof idxInDay === "number") this.focusedEntryIndexByDay[dayIdx] = idxInDay;
                    this.applyWeekFocusAndSelection();
                    this.scrollWeekFocusIntoView();
                    this.weekScrollEl.focus();
                });

                dayColEls[dayIdx].append(el);
                entryElsByKey.set(seg.key, el);
            }
        }

        this.applyWeekFocusAndSelection();
        this.updateCursorLine();
        this.updateAddDraftPreview();
        this.scrollWeekFocusIntoView();
        this.updateEditorBadge();
        this.updateNowMarker();
        if (this.appState.activeTab === "week" && !this.weekViewSection.hidden) {
            this.startNowTimer();
        }

        this.latestWeekBtn.disabled = Boolean(this.appState.latestWeekStart && this.appState.latestWeekStart === weekStart);
    }

    /**
     * Returns a cached color pair for a project name.
     * Part of the week view interaction flow.
     * @param {string} project
     * @returns {{bg: string, border: string}}
     */
    projectColors(project) {
        const key = String(project || "");
        const cached = this.projectColorCache.get(key);
        if (cached) return cached;

        if (!key) {
            const neutral = { bg: "rgba(255, 255, 255, 0.06)", border: "rgba(255, 255, 255, 0.16)" };
            this.projectColorCache.set(key, neutral);
            return neutral;
        }

        const projectDef = this.store.getProjectByName(key);
        if (projectDef && projectDef.color) {
            const rgb = parseHexColor(projectDef.color);
            if (rgb) {
                const colors = {
                    bg: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.26)`,
                    border: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55)`,
                };
                this.projectColorCache.set(key, colors);
                return colors;
            }
        }

        let hash = 2166136261;
        for (let i = 0; i < key.length; i++) {
            hash ^= key.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        const hue = Math.abs(hash) % 360;
        const colors = {
            bg: `hsla(${hue}, 82%, 55%, 0.26)`,
            border: `hsla(${hue}, 82%, 65%, 0.55)`,
        };
        this.projectColorCache.set(key, colors);
        return colors;
    }

    /**
     * Focuses an entry by id within the current week grid.
     * Part of the week view interaction flow.
     * @param {number} entryId
     * @param {string | null} preferredDayStr
     * @returns {void}
     */
    focusEntryByIdInWeek(entryId, preferredDayStr = null) {
        if (!this.weekDom || !entryId) return;
        const id = Number(entryId);
        if (!Number.isFinite(id)) return;

        if (preferredDayStr && typeof preferredDayStr === "string") {
            const dayIdx = this.weekDom.days.indexOf(preferredDayStr);
            if (dayIdx >= 0) {
                const key = `${id}@${preferredDayStr}`;
                const idx = this.weekDom.keyToIndexByDay?.[dayIdx]?.get(key);
                if (typeof idx === "number") {
                    this.focusedDayIndex = dayIdx;
                    this.focusedEntryIndexByDay[dayIdx] = idx;
                    this.applyWeekFocusAndSelection();
                    this.scrollWeekFocusIntoView();
                    return;
                }
            }
        }

        const prefix = `${id}@`;
        for (let i = 0; i < 7; i++) {
            const keys = this.weekDom.dayKeys[i] || [];
            const found = keys.findIndex((key) => typeof key === "string" && key.startsWith(prefix));
            if (found >= 0) {
                this.focusedDayIndex = i;
                this.focusedEntryIndexByDay[i] = found;
                this.applyWeekFocusAndSelection();
                this.scrollWeekFocusIntoView();
                return;
            }
        }
    }

    /**
     * Focuses the current day and selects its last entry segment.
     * Optionally forces the week view to the current week.
     * @param {boolean} [forceWeek]
     * @returns {boolean}
     */
    focusTodayLastEntry(forceWeek = false) {
        const today = this.timeContext.formatDate(new Date());
        if (!today) return false;
        const weekStart = isoWeekStart(today);
        if (!weekStart) return false;

        if (forceWeek || this.appState.weekStart !== weekStart) {
            this.setWeekStart(weekStart);
        }
        if (!this.weekDom) return false;

        const dayIdx = this.weekDom.days.indexOf(today);
        if (dayIdx < 0) return false;
        const keys = this.weekDom.dayKeys[dayIdx] || [];
        this.focusedDayIndex = dayIdx;
        this.focusedEntryIndexByDay[dayIdx] = keys.length ? keys.length - 1 : 0;
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
        return true;
    }

    /**
     * Handles resize events by recalculating layout metrics.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    handleResize() {
        if (this.appState.activeTab === "week") {
            this.updateWeekScaleAndReposition();
        }
    }

    /**
     * Processes keyboard navigation and editing shortcuts.
     * Part of the week view interaction flow.
     * @param {KeyboardEvent} ev
     * @returns {void}
     */
    handleKeydown(ev) {
        if (this.appState.activeTab !== "week") return;
        if (this.weekViewSection.hidden) return;
        if (this.entryDialog.open) return;
        if (isEditableTarget(ev.target)) return;

        const key = String(ev.key || "");
        const keyLower = key.toLowerCase();

        if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
            if (keyLower === "z") {
                ev.preventDefault();
                this.undo();
                return;
            }
            if (keyLower === "y") {
                ev.preventDefault();
                this.redo();
                return;
            }
            if (keyLower === "s") {
                ev.preventDefault();
                this.saveDirtyWeeksNow();
                return;
            }
        }

        if (key === "Escape") {
            ev.preventDefault();
            this.setEditMode("normal");
            this.weekScrollEl.focus();
            return;
        }

        if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
            if (keyLower === "a") {
                ev.preventDefault();
                this.enterAddMode();
                this.weekScrollEl.focus();
                return;
            }
            if (keyLower === "s") {
                ev.preventDefault();
                this.enterSplitMode();
                this.weekScrollEl.focus();
                return;
            }
        }

        if (this.editMode === "add") {
            if (key === "ArrowLeft") {
                ev.preventDefault();
                this.shiftAddCursorDay(-1);
                this.weekScrollEl.focus();
                return;
            }
            if (key === "ArrowRight") {
                ev.preventDefault();
                this.shiftAddCursorDay(1);
                this.weekScrollEl.focus();
                return;
            }
            if (key === "ArrowUp" || key === "ArrowDown") {
                const direction = key === "ArrowUp" ? -1 : 1;
                const ctrlOnly = ev.ctrlKey && !ev.altKey && !ev.metaKey;
                if (ev.shiftKey) {
                    ev.preventDefault();
                    this.extendAddDraft(direction, ctrlOnly);
                    this.weekScrollEl.focus();
                    return;
                }
                if (ctrlOnly) {
                    ev.preventDefault();
                    this.jumpAddCursorGap(direction);
                    this.weekScrollEl.focus();
                    return;
                }
                ev.preventDefault();
                this.nudgeAddCursor(direction);
                this.weekScrollEl.focus();
                return;
            }
            if (key === "Enter") {
                ev.preventDefault();
                this.addEntryFromCursor();
                this.weekScrollEl.focus();
                return;
            }
            return;
        }

        if (this.editMode === "split") {
            if (key === "ArrowUp") {
                ev.preventDefault();
                this.nudgeSplitCursor(-1);
                this.weekScrollEl.focus();
                return;
            }
            if (key === "ArrowDown") {
                ev.preventDefault();
                this.nudgeSplitCursor(1);
                this.weekScrollEl.focus();
                return;
            }
            if (key === "Enter") {
                ev.preventDefault();
                this.splitSelectedEntryAtCursor();
                this.weekScrollEl.focus();
                return;
            }
            return;
        }

        if (key === "Enter") {
            if (!this.selectedEntryId) return;
            ev.preventDefault();
            this.openEntryDialog(this.selectedEntryId);
            return;
        }

        if (keyLower === "d") {
            ev.preventDefault();
            this.deleteSelectedEntry();
            this.weekScrollEl.focus();
            return;
        }

        if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
            ev.preventDefault();
            if (key === "ArrowUp") this.extendSelectedEntry(0, -MIN_ENTRY_MS);
            else this.extendSelectedEntry(0, MIN_ENTRY_MS);
            this.weekScrollEl.focus();
            return;
        }

        if (ev.ctrlKey && !ev.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
            ev.preventDefault();
            this.moveSelectedEntry(key === "ArrowUp" ? -MIN_ENTRY_MS : MIN_ENTRY_MS);
            this.weekScrollEl.focus();
            return;
        }

        if (key === "ArrowLeft") {
            ev.preventDefault();
            this.moveFocusDay(-1);
            this.weekScrollEl.focus();
            return;
        }
        if (key === "ArrowRight") {
            ev.preventDefault();
            this.moveFocusDay(1);
            this.weekScrollEl.focus();
            return;
        }
        if (key === "ArrowUp") {
            ev.preventDefault();
            this.moveFocusEntry(-1);
            this.weekScrollEl.focus();
            return;
        }
        if (key === "ArrowDown") {
            ev.preventDefault();
            this.moveFocusEntry(1);
            this.weekScrollEl.focus();
            return;
        }
        if (key === "PageUp") {
            if (!this.appState.weekStart) return;
            ev.preventDefault();
            this.setEditMode("normal");
            this.setWeekStart(addIsoDays(this.appState.weekStart, -7));
            this.weekScrollEl.focus();
            return;
        }
        if (key === "PageDown") {
            if (!this.appState.weekStart) return;
            ev.preventDefault();
            this.setEditMode("normal");
            this.setWeekStart(addIsoDays(this.appState.weekStart, 7));
            this.weekScrollEl.focus();
            return;
        }
    }

    /**
     * Moves day focus left/right, wrapping across weeks when needed.
     * Part of the week view interaction flow.
     * @param {number} deltaDays
     * @returns {void}
     */
    moveFocusDay(deltaDays) {
        if (!this.weekDom || !this.appState.weekStart) return;
        const next = this.focusedDayIndex + deltaDays;
        if (next < 0) return this.setWeekStart(addIsoDays(this.appState.weekStart, -7), 6);
        if (next > 6) return this.setWeekStart(addIsoDays(this.appState.weekStart, 7), 0);
        this.focusedDayIndex = next;
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Moves focus between entries within the current day.
     * Part of the week view interaction flow.
     * @param {number} deltaEntries
     * @returns {void}
     */
    moveFocusEntry(deltaEntries) {
        if (!this.weekDom) return;
        const dayKeys = this.weekDom.dayKeys[this.focusedDayIndex] || [];
        if (!dayKeys.length) return this.moveFocusDay(deltaEntries > 0 ? 1 : -1);

        const current = Number(this.focusedEntryIndexByDay[this.focusedDayIndex] || 0);
        const next = current + deltaEntries;
        if (next < 0) {
            this.moveFocusDay(-1);
            if (!this.weekDom) return;
            const keys = this.weekDom.dayKeys[this.focusedDayIndex] || [];
            this.focusedEntryIndexByDay[this.focusedDayIndex] = keys.length ? keys.length - 1 : 0;
            this.applyWeekFocusAndSelection();
            this.scrollWeekFocusIntoView();
            return;
        }
        if (next >= dayKeys.length) {
            this.moveFocusDay(1);
            if (!this.weekDom) return;
            this.focusedEntryIndexByDay[this.focusedDayIndex] = 0;
            this.applyWeekFocusAndSelection();
            this.scrollWeekFocusIntoView();
            return;
        }

        this.focusedEntryIndexByDay[this.focusedDayIndex] = next;
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Snaps the add cursor around existing entries when overlapping.
     * Part of the week view interaction flow.
     * @param {number} ms
     * @param {number} direction
     * @returns {number}
     */
    snapAddCursorMs(ms, direction) {
        if (!Number.isFinite(ms)) return ms;
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return ms;

        const dt = new Date(ms);
        if (Number.isNaN(dt.getTime())) return ms;
        const dayStr = this.timeContext.formatDate(dt);
        const minutes = hhmmToMinutes(this.timeContext.formatTime(dt));
        if (minutes === null) return ms;

        const segs = this.segmentsIndex.get(dayStr) || [];
        for (const seg of segs) {
            if (minutes >= seg.startMinutes && minutes < seg.endMinutes) {
                const entry = seg.entry;
                const startMs = entry?.startDate instanceof Date ? entry.startDate.getTime() : null;
                const endMs = entry?.endDate instanceof Date ? entry.endDate.getTime() : null;
                const jumpMs = direction < 0 ? startMs : endMs;
                if (Number.isFinite(jumpMs) && jumpMs >= bounds.startMs && jumpMs <= bounds.endMs) return jumpMs;
                return ms;
            }
        }

        return ms;
    }

    /**
     * Returns the day string and minutes for the add-mode cursor.
     * Normalizes invalid dates into a null return value.
     * @returns {{dayStr: string, minutes: number} | null}
     */
    getAddCursorDayInfo() {
        if (!this.cursor || this.cursor.kind !== "add") return null;
        const dt = new Date(this.cursor.ms);
        if (Number.isNaN(dt.getTime())) return null;
        const dayStr = this.timeContext.formatDate(dt);
        const minutes = hhmmToMinutes(this.timeContext.formatTime(dt));
        if (!dayStr || minutes === null) return null;
        return { dayStr, minutes };
    }

    /**
     * Returns a sorted list of segments for a given day.
     * Keeps add-mode gap calculations deterministic.
     * @param {string} dayStr
     * @returns {Array<import("./store.js").Segment>}
     */
    getDaySegmentsSorted(dayStr) {
        const segs = (this.segmentsIndex.get(dayStr) || []).slice();
        segs.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || (a.entry?.id || 0) - (b.entry?.id || 0));
        return segs;
    }

    /**
     * Finds the free gap boundaries that contain the provided minute offset.
     * Used for add-mode cursor jumps and draft sizing.
     * @param {string} dayStr
     * @param {number} minutes
     * @returns {{gapStart: number, gapEnd: number}}
     */
    getDayGapBounds(dayStr, minutes) {
        const segs = this.getDaySegmentsSorted(dayStr);
        let gapStart = 0;
        for (const seg of segs) {
            if (minutes < seg.startMinutes) {
                return { gapStart, gapEnd: seg.startMinutes };
            }
            if (minutes >= seg.startMinutes && minutes < seg.endMinutes) {
                return { gapStart: seg.endMinutes, gapEnd: seg.endMinutes };
            }
            gapStart = Math.max(gapStart, seg.endMinutes);
        }
        return { gapStart, gapEnd: 1440 };
    }

    /**
     * Jumps the add-mode cursor to the nearest gap boundary.
     * Skips empty space above or below without creating a draft entry.
     * @param {number} direction
     * @returns {void}
     */
    jumpAddCursorGap(direction) {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const info = this.getAddCursorDayInfo();
        if (!info) return;
        const { dayStr, minutes } = info;
        const { gapStart, gapEnd } = this.getDayGapBounds(dayStr, minutes);
        const targetMinutes = direction < 0 ? gapStart : gapEnd;
        if (!Number.isFinite(targetMinutes)) return;
        if (targetMinutes === minutes) return;

        this.clearAddDraft();
        const nextMs = this.timeContext.dateFromLocalDayMinutes(dayStr, targetMinutes).getTime();
        this.cursor.ms = nextMs;
        const dayIdx = this.weekDom?.days?.indexOf(dayStr) ?? -1;
        if (dayIdx >= 0) this.focusedDayIndex = dayIdx;
        this.updateCursorLine();
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Extends or creates an add-mode draft entry from the cursor.
     * Keeps the draft within the current free gap.
     * @param {number} direction
     * @param {boolean} jumpToBoundary
     * @returns {void}
     */
    extendAddDraft(direction, jumpToBoundary) {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const info = this.getAddCursorDayInfo();
        if (!info) return;
        const { dayStr, minutes } = info;

        let draft = this.addDraft;
        if (!draft || draft.dayStr !== dayStr) {
            const { gapStart, gapEnd } = this.getDayGapBounds(dayStr, minutes);
            draft = {
                dayStr,
                anchorMinutes: minutes,
                startMinutes: minutes,
                endMinutes: minutes,
                gapStart,
                gapEnd,
            };
        }

        const delta = direction < 0 ? -MIN_ENTRY_MINUTES : MIN_ENTRY_MINUTES;
        let nextMinutes = jumpToBoundary ? (direction < 0 ? draft.gapStart : draft.gapEnd) : minutes + delta;
        nextMinutes = Math.max(draft.gapStart, Math.min(draft.gapEnd, nextMinutes));

        const startMinutes = Math.min(draft.anchorMinutes, nextMinutes);
        const endMinutes = Math.max(draft.anchorMinutes, nextMinutes);
        if (endMinutes - startMinutes < MIN_ENTRY_MINUTES) {
            this.onToast("Entry shorter than 15 minutes.");
            return;
        }

        draft.startMinutes = startMinutes;
        draft.endMinutes = endMinutes;
        this.addDraft = draft;

        const nextMs = this.timeContext.dateFromLocalDayMinutes(dayStr, nextMinutes).getTime();
        this.cursor.ms = nextMs;
        const dayIdx = this.weekDom?.days?.indexOf(dayStr) ?? -1;
        if (dayIdx >= 0) this.focusedDayIndex = dayIdx;
        this.updateCursorLine();
        this.updateAddDraftPreview();
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Enters add mode and positions the cursor at a sensible time.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    enterAddMode() {
        const weekStart = this.appState.weekStart;
        if (!weekStart) return;
        const bounds = this.timeContext.weekBoundsMs(weekStart);
        if (!bounds) return;
        this.clearAddDraft();

        let ms = null;
        if (this.selectedEntryId) {
            const entry = this.store.getEntryById(this.selectedEntryId);
            if (entry?.endDate instanceof Date && !Number.isNaN(entry.endDate.getTime())) ms = entry.endDate.getTime();
        }

        if (!Number.isFinite(ms)) {
            const dayStr = this.weekDom?.days?.[this.focusedDayIndex] || weekStart;
            ms = this.timeContext.dateFromLocalDayMinutes(dayStr, 8 * 60).getTime();
        }

        ms = Math.max(bounds.startMs, Math.min(bounds.endMs, ms));
        ms = this.snapAddCursorMs(ms, 1);
        this.cursor = { kind: "add", ms };
        this.setEditMode("add");

        const dayStr = this.timeContext.formatDate(new Date(ms));
        const dayIdx = this.weekDom?.days?.indexOf(dayStr) ?? -1;
        if (dayIdx >= 0) {
            this.focusedDayIndex = dayIdx;
            this.applyWeekFocusAndSelection();
        }
        this.updateCursorLine();
    }

    /**
     * Moves the add cursor up or down in fixed increments.
     * Part of the week view interaction flow.
     * @param {number} deltaSteps
     * @returns {void}
     */
    nudgeAddCursor(deltaSteps) {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;
        this.clearAddDraft();

        const direction = deltaSteps < 0 ? -1 : 1;
        let nextMs = this.cursor.ms + deltaSteps * MIN_ENTRY_MS;
        if (nextMs < bounds.startMs || nextMs > bounds.endMs) return;

        nextMs = this.snapAddCursorMs(nextMs, direction);
        this.cursor.ms = nextMs;

        const dayStr = this.timeContext.formatDate(new Date(nextMs));
        const dayIdx = this.weekDom?.days?.indexOf(dayStr) ?? -1;
        if (dayIdx >= 0) this.focusedDayIndex = dayIdx;
        this.updateCursorLine();
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Moves the add cursor across days while keeping the time.
     * Part of the week view interaction flow.
     * @param {number} deltaDays
     * @returns {void}
     */
    shiftAddCursorDay(deltaDays) {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;
        this.clearAddDraft();

        const dt = new Date(this.cursor.ms);
        if (Number.isNaN(dt.getTime())) return;
        const dayStr = this.timeContext.formatDate(dt);
        const minutes = hhmmToMinutes(this.timeContext.formatTime(dt));
        if (minutes === null) return;

        const nextDayStr = addIsoDays(dayStr, deltaDays);
        if (this.weekDom && !this.weekDom.days.includes(nextDayStr)) return;

        let nextMs = this.timeContext.dateFromLocalDayMinutes(nextDayStr, minutes).getTime();
        nextMs = Math.max(bounds.startMs, Math.min(bounds.endMs, nextMs));
        nextMs = this.snapAddCursorMs(nextMs, deltaDays < 0 ? -1 : 1);
        this.cursor.ms = nextMs;

        const idx = this.weekDom?.days?.indexOf(this.timeContext.formatDate(new Date(nextMs))) ?? -1;
        if (idx >= 0) this.focusedDayIndex = idx;
        this.updateCursorLine();
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Enters split mode and positions the split cursor inside the entry.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    enterSplitMode() {
        if (!this.selectedEntryId) return this.onToast("Select an entry first.");
        const entry = this.store.getEntryById(this.selectedEntryId);
        if (!entry) return;
        if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
        if (!(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) return;
        if (this.appState.weekStart && entry.weekStart !== this.appState.weekStart) return this.onToast("Split works only for entries in this week.");

        const startMs = entry.startDate.getTime();
        const endMs = entry.endDate.getTime();
        if (endMs - startMs < 2 * MIN_ENTRY_MS) return this.onToast("Entry too short to split (min 30 min).");

        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;
        const minMs = Math.max(bounds.startMs, startMs + MIN_ENTRY_MS);
        const maxMs = Math.min(bounds.endMs, endMs - MIN_ENTRY_MS);
        if (maxMs < minMs) return this.onToast("Cannot split outside the current week.");

        let ms = this.cursor && this.cursor.kind === "split" ? this.cursor.ms : startMs + MIN_ENTRY_MS;
        ms = Math.max(minMs, Math.min(maxMs, ms));
        this.cursor = { kind: "split", ms };
        this.setEditMode("split");

        const dayStr = this.timeContext.formatDate(new Date(ms));
        const dayIdx = this.weekDom?.days?.indexOf(dayStr) ?? -1;
        if (dayIdx >= 0) this.focusedDayIndex = dayIdx;
        this.updateCursorLine();
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Nudges the split cursor by fixed increments within the entry.
     * Part of the week view interaction flow.
     * @param {number} deltaSteps
     * @returns {void}
     */
    nudgeSplitCursor(deltaSteps) {
        if (!this.cursor || this.cursor.kind !== "split") return;
        const entry = this.selectedEntryId ? this.store.getEntryById(this.selectedEntryId) : null;
        if (!entry) return;
        if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
        if (!(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) return;

        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;

        const startMs = entry.startDate.getTime();
        const endMs = entry.endDate.getTime();
        const minMs = Math.max(bounds.startMs, startMs + MIN_ENTRY_MS);
        const maxMs = Math.min(bounds.endMs, endMs - MIN_ENTRY_MS);
        if (maxMs < minMs) return this.onToast("Entry too short to split (min 30 min).");

        let nextMs = this.cursor.ms + deltaSteps * MIN_ENTRY_MS;
        nextMs = Math.max(minMs, Math.min(maxMs, nextMs));
        this.cursor.ms = nextMs;

        const dayStr = this.timeContext.formatDate(new Date(nextMs));
        const dayIdx = this.weekDom?.days?.indexOf(dayStr) ?? -1;
        if (dayIdx >= 0) this.focusedDayIndex = dayIdx;
        this.updateCursorLine();
        this.applyWeekFocusAndSelection();
        this.scrollWeekFocusIntoView();
    }

    /**
     * Updates raw entry timestamps and duration fields.
     * Part of the week view interaction flow.
     * @param {Object} raw
     * @param {number} startMs
     * @param {number} endMs
     * @returns {void}
     */
    applyTimesToRaw(raw, startMs, endMs) {
        const start = new Date(startMs);
        const end = new Date(endMs);
        raw.start = this.timeContext.formatIsoWithOffset(start);
        raw.end = this.timeContext.formatIsoWithOffset(end);
        raw.is_running = false;
        raw.duration_seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
        raw.updated_at = raw.updated_at || this.timeContext.formatIsoWithOffset(new Date());
    }

    /**
     * Creates a new raw entry payload with default fields.
     * Part of the week view interaction flow.
     * @param {{id: number, startMs: number, endMs: number}} params
     * @returns {Object}
     */
    makeNewRawEntry(params) {
        const raw = {
            billable: null,
            client: null,
            client_id: null,
            created_at: null,
            description: "",
            duration_seconds: null,
            end: null,
            id: params.id,
            is_running: false,
            project: "",
            project_id: null,
            start: null,
            updated_at: null,
            user_id: null,
        };
        this.applyTimesToRaw(raw, params.startMs, params.endMs);
        return raw;
    }

    /**
     * Converts schedule nodes back into raw entry payloads.
     * Part of the week view interaction flow.
     * @param {Array<{id: number, startMs: number, endMs: number, editable: boolean, raw: Object | null}>} nodes
     * @returns {Object[]}
     */
    weekRawFromNodes(nodes) {
        const out = [];
        for (const node of nodes) {
            if (!node.editable) continue;
            if (!node.raw) throw new Error("Missing raw entry payload");
            this.applyTimesToRaw(node.raw, node.startMs, node.endMs);
            out.push(node.raw);
        }
        out.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")) || (a.id || 0) - (b.id || 0));
        return out;
    }

    /**
     * Validates that a node is editable and has a sane time range.
     * Part of the week view interaction flow.
     * @param {Object} node
     * @returns {void}
     */
    ensureEditableNode(node) {
        if (!node) throw new Error("Missing entry");
        if (!node.editable) throw new Error("Entry is outside this week; open its start week to edit.");
        if (!Number.isFinite(node.startMs) || !Number.isFinite(node.endMs)) throw new Error("Entry has invalid time range.");
        if (node.endMs <= node.startMs) throw new Error("Entry has end before start.");
    }

    /**
     * Ensures edits do not move entries across week boundaries.
     * Part of the week view interaction flow.
     * @param {Object} node
     * @param {{startMs: number, endMs: number}} bounds
     * @returns {void}
     */
    enforceEditableBounds(node, bounds) {
        if (!node.editable) return;
        if (node.startMs < bounds.startMs || node.startMs >= bounds.endMs) {
            throw new Error("Edit would move an entry across week boundaries.");
        }
    }

    /**
     * Resolves overlaps by shifting or compressing neighboring entries.
     * Part of the week view interaction flow.
     * @param {Array<{id: number, startMs: number, endMs: number, editable: boolean, raw: Object | null}>} nodes
     * @param {number} targetId
     * @param {{startMs: number, endMs: number}} bounds
     * @returns {void}
     */
    resolveNonOverlapping(nodes, targetId, bounds) {
        nodes.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
        const idx = nodes.findIndex((node) => node.id === targetId);
        if (idx < 0) throw new Error("Missing edited entry");

        for (const node of nodes) {
            if (node.editable) {
                this.ensureEditableNode(node);
                if (node.endMs - node.startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
                this.enforceEditableBounds(node, bounds);
            }
        }

        for (let i = idx - 1; i >= 0; i--) {
            const prev = nodes[i];
            const next = nodes[i + 1];
            if (prev.endMs <= next.startMs) continue;
            if (!prev.editable) throw new Error("Would need to modify an entry outside this week.");

            const overlap = prev.endMs - next.startMs;
            const minEnd = prev.startMs + MIN_ENTRY_MS;
            prev.endMs = Math.max(minEnd, prev.endMs - overlap);

            if (prev.endMs > next.startMs) {
                const remaining = prev.endMs - next.startMs;
                prev.startMs -= remaining;
                prev.endMs -= remaining;
            }

            if (prev.endMs > next.startMs) throw new Error("Failed to resolve overlap (backward).");
            if (prev.endMs - prev.startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
            this.enforceEditableBounds(prev, bounds);
        }

        for (let i = idx + 1; i < nodes.length; i++) {
            const prev = nodes[i - 1];
            const next = nodes[i];
            if (next.startMs >= prev.endMs) continue;
            if (!next.editable) throw new Error("Would need to modify an entry outside this week.");

            const shift = prev.endMs - next.startMs;
            next.startMs += shift;
            next.endMs += shift;

            if (next.startMs < prev.endMs) throw new Error("Failed to resolve overlap (forward).");
            if (next.endMs - next.startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
            this.enforceEditableBounds(next, bounds);
        }

        nodes.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
        for (let i = 1; i < nodes.length; i++) {
            if (nodes[i - 1].endMs > nodes[i].startMs) throw new Error("Overlaps remain after resolve.");
        }
    }

    /**
     * Applies an edit by recomputing the week snapshot and pushing undo state.
     * Part of the week view interaction flow.
     * @param {{weekStart: string, label: string, getAfterRaw: () => Object[], focusAfter: number | null}} params
     * @returns {void}
     */
    applyWeekEdit(params) {
        if (this.saveInFlight) return this.onToast("Saving in progress…");
        const before = this.store.snapshotWeekRaw(params.weekStart);
        const focusBefore = this.selectedEntryId;
        let after;
        try {
            after = params.getAfterRaw();
        } catch (err) {
            this.onToast(String(err));
            return;
        }

        if (!Array.isArray(after)) {
            this.onToast("Invalid edit payload.");
            return;
        }

        this.store.applyWeekSnapshot(params.weekStart, after);
        if (this.appState.weekStart === params.weekStart) {
            this.rebuildWeekView();
        }
        this.setLatestWeekStart(this.store.getLatestWeekStart());

        this.undoStack.push({
            weekStart: params.weekStart,
            before,
            after,
            label: params.label,
            focusBefore,
            focusAfter: params.focusAfter || null,
        });
        this.redoStack.length = 0;

        this.markDirty(params.weekStart);
        this.setEditMode("normal");
        if (params.focusAfter) {
            const entry = this.store.getEntryById(params.focusAfter);
            const day = entry?.startDate instanceof Date ? this.timeContext.formatDate(entry.startDate) : null;
            this.focusEntryByIdInWeek(params.focusAfter, day);
        }
        this.updateEditorBadge();
        this.onSearchDirty();
    }

    /**
     * Applies a stored undo/redo snapshot and refreshes selection.
     * Part of the week view interaction flow.
     * @param {string} weekStart
     * @param {Object[]} rawEntries
     * @param {number | null} focusEntryId
     * @returns {void}
     */
    applyEditorActionSnapshot(weekStart, rawEntries, focusEntryId) {
        if (!weekStart) return;
        this.store.applyWeekSnapshot(weekStart, rawEntries);
        if (this.appState.weekStart !== weekStart) {
            this.setWeekStart(weekStart);
        } else {
            this.rebuildWeekView();
        }
        this.setLatestWeekStart(this.store.getLatestWeekStart());
        this.setEditMode("normal");
        if (focusEntryId) {
            const entry = this.store.getEntryById(focusEntryId);
            const day = entry?.startDate instanceof Date ? this.timeContext.formatDate(entry.startDate) : null;
            this.focusEntryByIdInWeek(focusEntryId, day);
        }
        this.updateEditorBadge();
        this.onSearchDirty();
    }

    /**
     * Pops the undo stack and restores the previous snapshot.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    undo() {
        const action = this.undoStack.pop();
        if (!action) return;
        this.applyEditorActionSnapshot(action.weekStart, action.before, action.focusBefore || null);
        this.redoStack.push(action);
        this.markDirty(action.weekStart);
    }

    /**
     * Pops the redo stack and reapplies the next snapshot.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    redo() {
        const action = this.redoStack.pop();
        if (!action) return;
        this.applyEditorActionSnapshot(action.weekStart, action.after, action.focusAfter || null);
        this.undoStack.push(action);
        this.markDirty(action.weekStart);
    }

    /**
     * Marks a week as dirty and refreshes the save badge.
     * Part of the week view interaction flow.
     * @param {string} weekStart
     * @returns {void}
     */
    markDirty(weekStart) {
        if (!weekStart) return;
        this.dirtyWeekStarts.add(weekStart);
        this.updateEditorBadge();
    }

    /**
     * Saves all dirty weeks immediately if possible.
     * Part of the week view interaction flow.
     * @returns {Promise<void>}
     */
    async saveDirtyWeeksNow() {
        if (this.saveInFlight) return;
        const weekStarts = Array.from(this.dirtyWeekStarts).filter(Boolean);
        if (!weekStarts.length) {
            this.onToast("Nothing to save.");
            return;
        }

        this.saveInFlight = true;
        this.onBusy(true);
        this.updateEditorBadge();

        const sortedWeeks = weekStarts.slice().sort((a, b) => a.localeCompare(b));
        try {
            await this.saveWeeks(sortedWeeks);
            for (const ws of sortedWeeks) this.dirtyWeekStarts.delete(ws);
            this.onToast("Saved.", 2400, "success");
        } catch (err) {
            this.onToast(String(err), 5000);
        } finally {
            this.saveInFlight = false;
            this.onBusy(false);
            this.updateEditorBadge();
        }
    }

    /**
     * Serializes week files, writes them, and refreshes caches.
     * Part of the week view interaction flow.
     * @param {string[]} weekStarts
     * @returns {Promise<void>}
     */
    async saveWeeks(weekStarts) {
        const nowIso = utcNowIso();
        const weekFiles = this.store.serializeWeeks(weekStarts, nowIso);
        const oldManifest = this.store.getManifest();
        let manifest = this.store.buildManifest(weekFiles, nowIso);
        const manifestContent = manifest.toJson();
        const files = weekFiles.map((file) => ({ path: file.path, content: file.content }));
        files.push({ path: "data/index/entries-manifest.json", content: manifestContent });

        const message = this.buildWeekSaveMessage(weekFiles);
        const result = await this.dataSource.saveFiles(files, message);
        const savedFiles = Array.isArray(result?.files) ? result.files : files;
        const shaByPath = new Map();
        for (const file of savedFiles) {
            if (file?.path && file?.sha) shaByPath.set(file.path, file.sha);
        }
        const updatedWeekFiles = weekFiles.map((file) => {
            const sha = shaByPath.get(file.path);
            return sha ? { ...file, sha } : file;
        });

        if (!this.weekFilesMatchManifest(updatedWeekFiles, manifest)) {
            manifest = this.store.buildManifest(updatedWeekFiles, nowIso);
        }

        this.store.setManifest(manifest);
        await this.updateCachesAfterSave(updatedWeekFiles, oldManifest);
        this.onManifestUpdated();
    }

    /**
     * Builds a commit message for week save operations.
     * Part of the week view interaction flow.
     * @param {Array<import("./store.js").WeekFile>} weekFiles
     * @returns {string}
     */
    buildWeekSaveMessage(weekFiles) {
        const labels = weekFiles
            .map((file) => `${file.year}-W${String(file.week).padStart(2, "0")}`)
            .sort((a, b) => a.localeCompare(b))
            .join(", ");
        return labels ? `Edit time entries (${labels})` : "Edit time entries";
    }

    /**
     * Verifies that manifest shas match the saved week files.
     * Part of the week view interaction flow.
     * @param {Array<import("./store.js").WeekFile>} weekFiles
     * @param {import("./model.js").Manifest} manifest
     * @returns {boolean}
     */
    weekFilesMatchManifest(weekFiles, manifest) {
        const byKey = new Map();
        for (const chunk of manifest.chunks) {
            byKey.set(chunkKey(chunk.year, chunk.week), chunk.sha);
        }
        for (const file of weekFiles) {
            const sha = byKey.get(chunkKey(file.year, file.week));
            if (sha !== file.sha) return false;
        }
        return true;
    }

    /**
     * Updates in-memory and IndexedDB caches after saving.
     * Part of the week view interaction flow.
     * @param {Array<import("./store.js").WeekFile>} weekFiles
     * @param {import("./model.js").Manifest | null} oldManifest
     * @returns {Promise<void>}
     */
    async updateCachesAfterSave(weekFiles, oldManifest) {
        const existingByKey = new Map();
        if (oldManifest) {
            for (const chunk of oldManifest.chunks) {
                existingByKey.set(chunkKey(chunk.year, chunk.week), chunk.sha);
            }
        }

        for (const file of weekFiles) {
            const key = chunkKey(file.year, file.week);
            this.chunkCache.setMemory(key, { sha: file.sha, entriesRaw: file.payload.entries || [] });
            await this.chunkCache.putRawBySha(file.sha, file.content);

            const oldSha = existingByKey.get(key);
            if (oldSha && oldSha !== file.sha) {
                await this.chunkCache.deleteRawBySha(oldSha);
            }
        }

    }

    /**
     * Jumps to the week containing the entry and selects it.
     * Part of the week view interaction flow.
     * @param {import("./model.js").Entry} entry
     * @returns {void}
     */
    jumpToEntry(entry) {
        if (!entry || !(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
        const startDay = this.timeContext.formatDate(entry.startDate);
        const startWeek = isoWeekStart(startDay);
        const startDayIdx = isoWeekdayIndex(startDay);

        this.setWeekStart(startWeek, startDayIdx);
        this.focusEntryByIdInWeek(entry.id, startDay);
        try {
            this.weekScrollEl.focus();
        } catch {
            // ignore
        }
    }

    /**
     * Updates the billable total label for the active week.
     * Keeps the top bar stats aligned with edits and week navigation.
     * @param {string | null} weekStart
     * @returns {void}
     */
    updateWeekBillableTotal(weekStart) {
        if (!this.weekBillableEl) return;
        if (!weekStart) {
            this.weekBillableEl.textContent = "";
            return;
        }
        const bounds = this.timeContext.weekBoundsMs(weekStart);
        if (!bounds) {
            this.weekBillableEl.textContent = "";
            return;
        }

        const { entries } = this.store.collectEntriesForWeekWindow(weekStart, bounds);
        let totalSeconds = 0;
        for (const entry of entries) {
            if (entry.billable !== true) continue;
            if (!(entry.startDate instanceof Date)) continue;
            const startMs = entry.startDate.getTime();
            const endMs =
                entry.endDate instanceof Date && Number.isFinite(entry.endDate.getTime())
                    ? entry.endDate.getTime()
                    : entry.raw?.is_running
                      ? Date.now()
                      : null;
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
            const clippedStart = Math.max(bounds.startMs, startMs);
            const clippedEnd = Math.min(bounds.endMs, endMs);
            if (clippedEnd > clippedStart) {
                totalSeconds += Math.round((clippedEnd - clippedStart) / 1000);
            }
        }

        this.weekBillableEl.textContent = `Billable ${formatDuration(totalSeconds)}`;
    }

    /**
     * Builds and shows description suggestions as the user types.
     * Uses recent entries to recommend matching descriptions + projects.
     * @returns {void}
     */
    handleDescriptionInput() {
        if (!this.entryDialog.open) return;
        const suggestions = this.buildDescriptionSuggestions(this.entryDescInput.value);
        this.renderDescriptionSuggestions(suggestions);
    }

    /**
     * Moves focus into the suggestion list when the user presses ArrowDown.
     * Keeps text editing uninterrupted if no suggestions are shown.
     * @param {KeyboardEvent} ev
     * @returns {void}
     */
    handleDescriptionKeydown(ev) {
        if (ev.key !== "ArrowDown") return;
        if (this.entryDescSuggestionsEl.hidden || !this.descSuggestions.length) return;
        ev.preventDefault();
        this.focusSuggestionIndex(0);
    }

    /**
     * Prevents the textarea from losing focus while clicking suggestions.
     * Keeps the dialog editing flow stable for keyboard users.
     * @param {MouseEvent} ev
     * @returns {void}
     */
    handleSuggestionPointerDown(ev) {
        const target = ev.target instanceof HTMLElement ? ev.target : null;
        if (target && target.closest(".entry-suggestion")) {
            ev.preventDefault();
        }
    }

    /**
     * Applies a description suggestion when a suggestion is clicked.
     * Keeps the project and description fields in sync.
     * @param {MouseEvent} ev
     * @returns {void}
     */
    handleSuggestionClick(ev) {
        const target = ev.target instanceof HTMLElement ? ev.target : null;
        if (!target) return;
        const button = /** @type {HTMLButtonElement | null} */ (target.closest(".entry-suggestion"));
        if (!button) return;
        const index = Number(button.dataset.index);
        if (!Number.isFinite(index)) return;
        const suggestion = this.descSuggestions[index];
        if (!suggestion) return;
        this.applyDescriptionSuggestion(suggestion);
    }

    /**
     * Supports ArrowUp/ArrowDown navigation within suggestion buttons.
     * Returns focus to the description field when moving above the first item.
     * @param {KeyboardEvent} ev
     * @returns {void}
     */
    handleSuggestionKeydown(ev) {
        const key = String(ev.key || "");
        if (key !== "ArrowUp" && key !== "ArrowDown") return;
        const buttons = this.getSuggestionButtons();
        if (!buttons.length) return;
        const active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
        const currentIndex = active ? buttons.indexOf(active) : -1;
        if (key === "ArrowUp") {
            ev.preventDefault();
            if (currentIndex <= 0) {
                this.entryDescInput.focus();
                return;
            }
            this.focusSuggestionIndex(currentIndex - 1);
            return;
        }
        ev.preventDefault();
        if (currentIndex < 0) {
            this.focusSuggestionIndex(0);
            return;
        }
        this.focusSuggestionIndex(Math.min(buttons.length - 1, currentIndex + 1));
    }

    /**
     * Returns the current list of suggestion button elements.
     * Used for focus management and keyboard navigation.
     * @returns {HTMLButtonElement[]}
     */
    getSuggestionButtons() {
        return Array.from(this.entryDescSuggestionsEl.querySelectorAll(".entry-suggestion")).filter(
            (el) => el instanceof HTMLButtonElement,
        );
    }

    /**
     * Moves focus to a suggestion button at the given index.
     * Clamps indices to the available suggestion range.
     * @param {number} index
     * @returns {void}
     */
    focusSuggestionIndex(index) {
        const buttons = this.getSuggestionButtons();
        if (!buttons.length) return;
        const clamped = Math.max(0, Math.min(buttons.length - 1, Number(index) || 0));
        try {
            buttons[clamped].focus();
        } catch {
            // ignore
        }
    }

    /**
     * Gathers description suggestions from recent week entries.
     * Filters on the query text and de-duplicates similar pairs.
     * @param {string} query
     * @returns {{project: string, description: string}[]}
     */
    buildDescriptionSuggestions(query) {
        const trimmed = String(query || "").trim();
        if (trimmed.length < DESC_SUGGEST_MIN_CHARS) {
            return [];
        }
        if (!this.appState.weekStart) {
            return [];
        }

        const q = trimmed.toLowerCase();
        const seen = new Set();
        const suggestions = [];
        const weekStart = this.appState.weekStart;
        const hasProjectList = Boolean(this.store.getProjectList());

        for (let offset = 0; offset < 4; offset += 1) {
            const ws = addIsoDays(weekStart, -7 * offset);
            const week = this.store.getWeek(ws);
            if (!week) continue;
            for (const entry of week.entries) {
                const desc = safeText(entry.description).trim();
                if (!desc) continue;
                if (!desc.toLowerCase().includes(q)) continue;
                const project = safeText(entry.project).trim();
                if (project && hasProjectList && !this.store.getProjectByName(project)) continue;
                const key = `${project.toLowerCase()}|${desc.toLowerCase()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                suggestions.push({ project, description: desc });
                if (suggestions.length >= DESC_SUGGEST_LIMIT) {
                    return suggestions;
                }
            }
        }

        return suggestions;
    }

    /**
     * Renders description suggestions into the dialog list container.
     * Hides the container when there are no matching entries.
     * @param {{project: string, description: string}[]} suggestions
     * @returns {void}
     */
    renderDescriptionSuggestions(suggestions) {
        this.descSuggestions = suggestions.slice();
        this.entryDescSuggestionsEl.innerHTML = "";
        if (!suggestions.length) {
            this.entryDescSuggestionsEl.hidden = true;
            return;
        }

        suggestions.forEach((suggestion, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "entry-suggestion";
            button.dataset.index = String(index);

            const projectEl = document.createElement("span");
            projectEl.className = "suggestion-project";
            projectEl.textContent = suggestion.project ? suggestion.project : "No project";

            const descEl = document.createElement("span");
            descEl.className = "suggestion-desc";
            descEl.textContent = suggestion.description;

            button.append(projectEl, descEl);
            this.entryDescSuggestionsEl.append(button);
        });

        this.entryDescSuggestionsEl.hidden = false;
    }

    /**
     * Clears and hides the suggestion list.
     * Resets the suggestion cache for the next edit session.
     * @returns {void}
     */
    clearDescriptionSuggestions() {
        this.descSuggestions = [];
        if (this.entryDescSuggestionsEl) {
            this.entryDescSuggestionsEl.innerHTML = "";
            this.entryDescSuggestionsEl.hidden = true;
        }
    }

    /**
     * Applies a selected suggestion to the dialog fields.
     * Keeps focus in the description field for continued typing.
     * @param {{project: string, description: string}} suggestion
     * @returns {void}
     */
    applyDescriptionSuggestion(suggestion) {
        if (!suggestion) return;
        this.entryDescInput.value = suggestion.description || "";
        const projectValue = suggestion.project || "";
        if (projectValue && this.store.getProjectByName(projectValue)) {
            this.entryProjectInput.value = projectValue;
        } else {
            this.entryProjectInput.value = "";
        }
        this.clearDescriptionSuggestions();
        queueMicrotask(() => {
            try {
                const len = this.entryDescInput.value.length;
                this.entryDescInput.focus();
                this.entryDescInput.setSelectionRange(len, len);
            } catch {
                // ignore
            }
        });
    }

    /**
     * Validates and saves dialog edits back into the entry.
     * Part of the week view interaction flow.
     * @param {Event} ev
     * @returns {void}
     */
    handleEntryFormSubmit(ev) {
        ev.preventDefault();
        const id = this.dialogEntryId;
        if (!id) return this.closeEntryDialog();
        if (!this.appState.weekStart) return this.closeEntryDialog();

        const entry = this.store.getEntryById(id);
        if (!entry) return this.closeEntryDialog();
        if (entry.weekStart !== this.appState.weekStart) return this.closeEntryDialog();

        const project = this.entryProjectInput.value.trim();
        if (project && !this.store.getProjectByName(project) && !this.dialogAllowUnlistedProject) {
            this.onToast("Please select a project from the list (or choose No project).");
            return;
        }
        const description = this.entryDescInput.value.trim();

        let billable = null;
        if (project) {
            const projectDef = this.store.getProjectByName(project);
            if (projectDef) {
                billable = projectDef.billable;
            } else if (this.dialogAllowUnlistedProject) {
                billable = entry.billable === true ? true : entry.billable === false ? false : null;
            }
        }

        this.applyWeekEdit({
            weekStart: this.appState.weekStart,
            label: "details",
            focusAfter: id,
            getAfterRaw: () => {
                const raws = this.store.snapshotWeekRaw(this.appState.weekStart);
                const idx = raws.findIndex((raw) => Number(raw?.id) === id);
                if (idx < 0) throw new Error("Entry not found in this week");
                raws[idx].project = project;
                raws[idx].description = description;
                raws[idx].billable = billable;
                raws[idx].updated_at = this.timeContext.formatIsoWithOffset(new Date());
                return raws;
            },
        });

        this.closeEntryDialog();
    }

    /**
     * Builds the project completion list for the entry dialog.
     * Part of the week view interaction flow.
     * @param {{selected?: string, allowUnlisted?: boolean}} options
     * @returns {void}
     */
    populateProjectSelect(options) {
        const selected = String(options?.selected || "");
        const allowUnlisted = Boolean(options?.allowUnlisted);
        const projects = this.store.getProjects();
        const byName = new Map();
        for (const project of projects) {
            if (!project || !project.name) continue;
            byName.set(project.name, project);
        }

        this.entryProjectListEl.innerHTML = "";
        this.dialogAllowUnlistedProject = false;

        const sorted = projects.slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const project of sorted) {
            const opt = document.createElement("option");
            opt.value = project.name;
            opt.label = project.archived ? `${project.name} (archived)` : project.name;
            this.entryProjectListEl.append(opt);
        }

        if (selected && !byName.has(selected) && allowUnlisted) {
            const opt = document.createElement("option");
            opt.value = selected;
            opt.label = `${selected} (unlisted)`;
            this.entryProjectListEl.append(opt);
            this.dialogAllowUnlistedProject = true;
        }

        this.entryProjectInput.value = selected;
        if (!this.entryProjectInput.value) {
            this.entryProjectInput.value = "";
        }
    }

    /**
     * Closes the entry dialog and restores focus to the timeline.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    closeEntryDialog() {
        this.dialogEntryId = null;
        this.dialogAllowUnlistedProject = false;
        this.clearDescriptionSuggestions();
        if (this.entryDialog.open) this.entryDialog.close();
        queueMicrotask(() => {
            try {
                this.weekScrollEl.focus();
            } catch {
                // ignore
            }
        });
    }

    /**
     * Opens the entry dialog for the given entry id.
     * Part of the week view interaction flow.
     * @param {number} entryId
     * @returns {void}
     */
    openEntryDialog(entryId) {
        const id = Number(entryId);
        if (!Number.isFinite(id)) return;
        const entry = this.store.getEntryById(id);
        if (!entry) return;
        if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
        if (!(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) return;
        if (this.appState.weekStart && entry.weekStart !== this.appState.weekStart) {
            const info = isoWeekInfo(entry.weekStart);
            this.onToast(`This entry belongs to ${info.isoYear}-W${String(info.week).padStart(2, "0")}; open that week to edit.`);
            return;
        }

        this.dialogEntryId = id;
        this.populateProjectSelect({
            selected: safeText(entry.project),
            allowUnlisted: !this.store.getProjectByName(entry.project || ""),
        });
        this.entryDescInput.value = safeText(entry.description);

        const day = this.timeContext.formatDate(entry.startDate);
        const start = this.timeContext.formatTime(entry.startDate);
        const end = this.timeContext.formatTime(entry.endDate);
        const dur = formatDuration(entry.durationSeconds);
        this.entryMetaEl.textContent = `${day} ${start}–${end} • ${dur} • id ${id}`;

        this.clearDescriptionSuggestions();
        if (!this.entryDialog.open) this.entryDialog.showModal();
        queueMicrotask(() => {
            try {
                const len = this.entryDescInput.value.length;
                this.entryDescInput.focus();
                this.entryDescInput.setSelectionRange(len, len);
            } catch {
                // ignore
            }
        });
    }

    /**
     * Creates a new entry from the add-mode cursor position.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    addEntryFromCursor() {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;

        const id = this.store.reserveEntryId();
        let startMs = this.cursor.ms;
        let endMs = startMs + MIN_ENTRY_MS;
        if (this.addDraft) {
            startMs = this.timeContext.dateFromLocalDayMinutes(this.addDraft.dayStr, this.addDraft.startMinutes).getTime();
            endMs = this.timeContext.dateFromLocalDayMinutes(this.addDraft.dayStr, this.addDraft.endMinutes).getTime();
        }
        if (startMs < bounds.startMs || endMs > bounds.endMs) {
            return this.onToast("Cannot create entry outside the current week.");
        }
        if (endMs - startMs < MIN_ENTRY_MS) {
            return this.onToast("Entry shorter than 15 minutes.");
        }

        this.applyWeekEdit({
            weekStart: this.appState.weekStart,
            label: "add",
            focusAfter: id,
            getAfterRaw: () => {
                const week = this.store.buildWeekSchedule(this.appState.weekStart);
                const nodes = week.nodes;
                const newRaw = this.makeNewRawEntry({ id, startMs, endMs });
                nodes.push({ id, startMs, endMs, editable: true, raw: newRaw });
                this.resolveNonOverlapping(nodes, id, week.bounds);
                return this.weekRawFromNodes(nodes);
            },
        });

        this.setEditMode("normal");
        this.openEntryDialog(id);
    }

    /**
     * Splits the selected entry at the split cursor position.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    splitSelectedEntryAtCursor() {
        if (!this.cursor || this.cursor.kind !== "split") return;
        const entryId = this.selectedEntryId;
        if (!entryId) return;
        const weekStart = this.appState.weekStart;
        if (!weekStart) return;

        const splitMs = this.cursor.ms;
        const week = this.store.buildWeekSchedule(weekStart);
        const nodes = week.nodes;
        const node = nodes.find((n) => n.id === entryId);
        if (!node || !node.editable) return;
        if (!node.raw) return;

        this.ensureEditableNode(node);
        if (splitMs <= node.startMs || splitMs >= node.endMs) {
            return this.onToast("Invalid split position.");
        }
        const minMs = node.startMs + MIN_ENTRY_MS;
        const maxMs = node.endMs - MIN_ENTRY_MS;
        if (splitMs < minMs || splitMs > maxMs) {
            return this.onToast("Entry too short to split (min 30 min).");
        }

        const secondId = this.store.reserveEntryId();
        const secondRaw = cloneJson(node.raw);
        secondRaw.id = secondId;

        const secondNode = { id: secondId, startMs: splitMs, endMs: node.endMs, editable: true, raw: secondRaw };
        node.endMs = splitMs;

        this.enforceEditableBounds(node, week.bounds);
        this.enforceEditableBounds(secondNode, week.bounds);

        nodes.push(secondNode);
        this.resolveNonOverlapping(nodes, secondId, week.bounds);

        this.applyWeekEdit({
            weekStart,
            label: "split",
            focusAfter: secondId,
            getAfterRaw: () => this.weekRawFromNodes(nodes),
        });

        this.setEditMode("normal");
        this.openEntryDialog(secondId);
    }

    /**
     * Deletes the currently selected entry from the week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    deleteSelectedEntry() {
        const entryId = this.selectedEntryId;
        if (!entryId) return;
        const weekStart = this.appState.weekStart;
        if (!weekStart) return;

        this.applyWeekEdit({
            weekStart,
            label: "delete",
            focusAfter: null,
            getAfterRaw: () => {
                const raws = this.store.snapshotWeekRaw(weekStart);
                return raws.filter((raw) => Number(raw?.id) !== entryId);
            },
        });
    }

    /**
     * Extends the selected entry earlier or later in time.
     * Part of the week view interaction flow.
     * @param {number} extendStartBy
     * @param {number} extendEndBy
     * @returns {void}
     */
    extendSelectedEntry(extendStartBy, extendEndBy) {
        const entryId = this.selectedEntryId;
        if (!entryId) return;
        const weekStart = this.appState.weekStart;
        if (!weekStart) return;

        this.applyWeekEdit({
            weekStart,
            label: "extend",
            focusAfter: entryId,
            getAfterRaw: () => {
                const week = this.store.buildWeekSchedule(weekStart);
                const nodes = week.nodes;
                const node = nodes.find((n) => n.id === entryId);
                if (!node) throw new Error("Entry not found.");
                this.ensureEditableNode(node);

                node.startMs += extendStartBy;
                node.endMs += extendEndBy;

                if (node.endMs - node.startMs < MIN_ENTRY_MS) {
                    throw new Error("Entry shorter than 15 minutes.");
                }

                this.enforceEditableBounds(node, week.bounds);
                this.resolveNonOverlapping(nodes, entryId, week.bounds);
                return this.weekRawFromNodes(nodes);
            },
        });
    }

    /**
     * Moves the selected entry forward or backward in time.
     * Part of the week view interaction flow.
     * @param {number} deltaMs
     * @returns {void}
     */
    moveSelectedEntry(deltaMs) {
        const entryId = this.selectedEntryId;
        if (!entryId) return;
        const weekStart = this.appState.weekStart;
        if (!weekStart) return;

        this.applyWeekEdit({
            weekStart,
            label: "move",
            focusAfter: entryId,
            getAfterRaw: () => {
                const week = this.store.buildWeekSchedule(weekStart);
                const nodes = week.nodes;
                const node = nodes.find((n) => n.id === entryId);
                if (!node) throw new Error("Entry not found.");
                this.ensureEditableNode(node);

                node.startMs += deltaMs;
                node.endMs += deltaMs;

                this.enforceEditableBounds(node, week.bounds);
                this.resolveNonOverlapping(nodes, entryId, week.bounds);
                return this.weekRawFromNodes(nodes);
            },
        });
    }
}
