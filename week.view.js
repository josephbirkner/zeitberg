import {
    addIsoDays,
    cloneJson,
    formatDuration,
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

/**
 * @typedef {Object} WeekViewOptions
 * @property {import("./store.js").EntryStore} store
 * @property {import("./cache.js").ChunkCache} chunkCache
 * @property {import("./appstate.js").AppState} appState
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {Object} elements
 * @property {HTMLElement} elements.weekViewSection
 * @property {HTMLElement} elements.weekControls
 * @property {HTMLElement} elements.weekLabel
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
 * @property {HTMLInputElement} elements.entryTags
 * @property {HTMLTextAreaElement} elements.entryDesc
 * @property {HTMLInputElement} elements.entryBillable
 * @property {(message: string, timeout?: number) => void} onToast
 * @property {(isBusy: boolean) => void} onBusy
 * @property {() => void} onSearchDirty
 * @property {() => void} onManifestUpdated
 */

/**
 * Renders the week view and manages editor interactions.
 */
export class WeekView {
    /**
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
        this.entryTagsInput = options.elements.entryTags;
        this.entryDescInput = options.elements.entryDesc;
        this.entryBillableInput = options.elements.entryBillable;

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
        this.dialogEntryId = null;

        this.dirtyWeekStarts = new Set();
        this.lastEditAt = 0;
        this.autosaveTimer = 0;
        this.saveInFlight = false;
        this.toastTimer = 0;

        this.undoStack = [];
        this.redoStack = [];

        const initialZoom = Number.parseFloat(this.zoomInput.value || "1");
        this.zoom = Number.isFinite(initialZoom) && initialZoom >= 1 ? initialZoom : 1;

        this.bindEvents();
    }

    /**
     * @param {import("./datasource.js").DataSource} dataSource
     * @returns {void}
     */
    setDataSource(dataSource) {
        this.dataSource = dataSource;
    }

    /**
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
    }

    /**
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
        }
    }

    /**
     * Resets view state for logout or reload.
     * @returns {void}
     */
    reset() {
        this.weekScrollEl.innerHTML = "";
        this.weekLabelEl.textContent = "";
        this.weekDom = null;
        this.segmentsIndex = new Map();
        this.projectColorCache.clear();
        this.focusedDayIndex = 0;
        this.focusedEntryIndexByDay = Array(7).fill(0);
        this.selectedSegKey = null;
        this.selectedEntryId = null;
        this.dialogEntryId = null;
        this.saveInFlight = false;
        window.clearTimeout(this.autosaveTimer);
        this.autosaveTimer = 0;
        this.dirtyWeekStarts.clear();
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.setEditMode("normal");
        this.updateEditorBadge();
    }

    /**
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
     * @returns {void}
     */
    handlePrevWeek() {
        if (!this.appState.weekStart) return;
        this.setWeekStart(addIsoDays(this.appState.weekStart, -7));
    }

    /**
     * @returns {void}
     */
    handleNextWeek() {
        if (!this.appState.weekStart) return;
        this.setWeekStart(addIsoDays(this.appState.weekStart, 7));
    }

    /**
     * @returns {void}
     */
    handleLatestWeek() {
        if (!this.appState.latestWeekStart) return;
        this.setWeekStart(this.appState.latestWeekStart);
    }

    /**
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
     * @returns {void}
     */
    clearCursor() {
        this.cursor = null;
        if (this.cursorEl) this.cursorEl.remove();
        this.cursorEl = null;
    }

    /**
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
     * @param {"normal" | "add" | "split"} nextMode
     * @returns {void}
     */
    setEditMode(nextMode) {
        const next = nextMode === "add" ? "add" : nextMode === "split" ? "split" : "normal";
        this.editMode = next;
        if (next === "normal") this.clearCursor();
        this.updateCursorLine();
        this.updateEditorBadge();
    }

    /**
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
     * @returns {{baseHeight: number, headerHeight: number, timelineHeight: number, pxPerMinute: number} | null}
     */
    computeWeekMetrics() {
        if (!this.weekDom) return null;
        const headerEl = this.weekDom.gridEl.querySelector(".wg-header");
        const headerHeight = headerEl ? headerEl.offsetHeight : 48;
        const baseHeight = Math.max(240, this.weekScrollEl.clientHeight - headerHeight);
        const timelineHeight = Math.max(240, Math.round(baseHeight * this.zoom));
        return { baseHeight, headerHeight, timelineHeight, pxPerMinute: timelineHeight / 1440 };
    }

    /**
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
        this.scrollWeekFocusIntoView();
    }

    /**
     * @returns {void}
     */
    rebuildWeekView() {
        this.weekScrollEl.innerHTML = "";
        this.weekDom = null;

        const weekStart = this.appState.weekStart;
        if (!weekStart) {
            this.weekLabelEl.textContent = "";
            return;
        }

        this.segmentsIndex = this.store.getWeekSegmentsIndex(weekStart);

        const days = Array.from({ length: 7 }, (_, i) => addIsoDays(weekStart, i));
        const weekEnd = days[6];
        const { isoYear, week } = isoWeekInfo(weekStart);
        this.weekLabelEl.textContent = `${isoYear}-W${String(week).padStart(2, "0")} • ${weekStart} → ${weekEnd}`;

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
                const project = entry.project || "—";
                const description = entry.description || "";

                dayKeys[dayIdx].push(seg.key);
                keyToIndexByDay[dayIdx].set(seg.key, idx);

                const el = document.createElement("div");
                el.className = "entry-block";
                el.dataset.key = seg.key;
                el.dataset.dayIdx = String(dayIdx);
                el.dataset.start = String(seg.startMinutes);
                el.dataset.end = String(seg.endMinutes);

                const colors = this.projectColors(project);
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
                projectEl.textContent = project;
                const descEl = document.createElement("div");
                descEl.className = "entry-desc";
                descEl.textContent = description;
                el.append(projectEl, descEl);

                el.title = `${dateStr} ${minutesToHHMM(seg.startMinutes)}–${minutesToHHMM(seg.endMinutes)} • ${project}${
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
        this.scrollWeekFocusIntoView();
        this.updateEditorBadge();

        this.latestWeekBtn.disabled = Boolean(this.appState.latestWeekStart && this.appState.latestWeekStart === weekStart);
    }

    /**
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
     * @returns {void}
     */
    handleResize() {
        if (this.appState.activeTab === "week") {
            this.updateWeekScaleAndReposition();
        }
    }

    /**
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
                this.saveDirtyWeeksNow("manual");
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
            if (key === "ArrowUp") {
                ev.preventDefault();
                this.nudgeAddCursor(-1);
                this.weekScrollEl.focus();
                return;
            }
            if (key === "ArrowDown") {
                ev.preventDefault();
                this.nudgeAddCursor(1);
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
            if (key === "ArrowUp") this.extendSelectedEntry(-MIN_ENTRY_MS, 0);
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
     * @returns {void}
     */
    enterAddMode() {
        const weekStart = this.appState.weekStart;
        if (!weekStart) return;
        const bounds = this.timeContext.weekBoundsMs(weekStart);
        if (!bounds) return;

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
     * @param {number} deltaSteps
     * @returns {void}
     */
    nudgeAddCursor(deltaSteps) {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;

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
     * @param {number} deltaDays
     * @returns {void}
     */
    shiftAddCursorDay(deltaDays) {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;

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
        if (!Array.isArray(raw.tags)) raw.tags = [];
        raw.updated_at = raw.updated_at || this.timeContext.formatIsoWithOffset(new Date());
    }

    /**
     * @param {{id: number, startMs: number, endMs: number}} params
     * @returns {Object}
     */
    makeNewRawEntry(params) {
        const raw = {
            billable: false,
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
            tags: [],
            updated_at: null,
            user_id: null,
        };
        this.applyTimesToRaw(raw, params.startMs, params.endMs);
        return raw;
    }

    /**
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
     * @param {string} weekStart
     * @param {Object[]} rawEntries
     * @param {number | null} focusEntryId
     * @returns {void}
     */
    applyEditorActionSnapshot(weekStart, rawEntries, focusEntryId) {
        if (!weekStart) return;
        if (this.appState.weekStart !== weekStart) this.setWeekStart(weekStart);
        this.store.applyWeekSnapshot(weekStart, rawEntries);
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
     * @param {string} weekStart
     * @returns {void}
     */
    markDirty(weekStart) {
        if (!weekStart) return;
        this.dirtyWeekStarts.add(weekStart);
        this.lastEditAt = Date.now();
        this.updateEditorBadge();
        this.scheduleAutosave();
    }

    /**
     * @returns {void}
     */
    scheduleAutosave() {
        window.clearTimeout(this.autosaveTimer);
        this.autosaveTimer = 0;
        if (!this.dirtyWeekStarts.size) return;

        const sinceLastEdit = Date.now() - this.lastEditAt;
        const dueIn = Math.max(500, 30_000 - (Number.isFinite(sinceLastEdit) ? sinceLastEdit : 0));
        this.autosaveTimer = window.setTimeout(() => {
            this.autosaveTimer = 0;
            if (!this.dirtyWeekStarts.size) return;
            if (this.saveInFlight) return this.scheduleAutosave();
            if (Date.now() - this.lastEditAt < 30_000) return this.scheduleAutosave();
            this.saveDirtyWeeksNow("autosave");
        }, dueIn);
    }

    /**
     * @param {"manual" | "autosave"} reason
     * @returns {Promise<void>}
     */
    async saveDirtyWeeksNow(reason) {
        if (this.saveInFlight) return;
        const weekStarts = Array.from(this.dirtyWeekStarts).filter(Boolean);
        if (!weekStarts.length) {
            if (reason === "manual") this.onToast("Nothing to save.");
            return;
        }

        window.clearTimeout(this.autosaveTimer);
        this.autosaveTimer = 0;

        this.saveInFlight = true;
        this.onBusy(true);
        this.updateEditorBadge();

        const sortedWeeks = weekStarts.slice().sort((a, b) => a.localeCompare(b));
        try {
            await this.saveWeeks(sortedWeeks, reason);
            for (const ws of sortedWeeks) this.dirtyWeekStarts.delete(ws);
            if (reason === "manual") this.onToast("Saved.");
        } catch (err) {
            this.onToast(String(err), 5000);
        } finally {
            this.saveInFlight = false;
            this.onBusy(false);
            this.updateEditorBadge();
        }
    }

    /**
     * @param {string[]} weekStarts
     * @param {"manual" | "autosave"} reason
     * @returns {Promise<void>}
     */
    async saveWeeks(weekStarts, reason) {
        const nowIso = utcNowIso();
        const weekFiles = this.store.serializeWeeks(weekStarts, nowIso);
        const oldManifest = this.store.getManifest();
        let manifest = this.store.buildManifest(weekFiles, nowIso);
        const result = await this.dataSource.saveWeeks(weekFiles, manifest, reason);
        const updatedWeekFiles = Array.isArray(result?.weekFiles) ? result.weekFiles : weekFiles;

        if (!this.weekFilesMatchManifest(updatedWeekFiles, manifest)) {
            manifest = this.store.buildManifest(updatedWeekFiles, nowIso);
        }

        this.store.setManifest(manifest);
        await this.updateCachesAfterSave(updatedWeekFiles, oldManifest);
        this.onManifestUpdated();
    }

    /**
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
        const description = this.entryDescInput.value.trim();
        const tags = this.textToTags(this.entryTagsInput.value);
        const billable = this.entryBillableInput.checked;

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
                raws[idx].tags = tags;
                raws[idx].billable = billable;
                raws[idx].updated_at = this.timeContext.formatIsoWithOffset(new Date());
                return raws;
            },
        });

        this.closeEntryDialog();
    }

    /**
     * @param {string[]} tags
     * @returns {string}
     */
    tagsToText(tags) {
        if (!Array.isArray(tags)) return "";
        return tags.filter((tag) => typeof tag === "string" && tag.trim()).join(", ");
    }

    /**
     * @param {string} text
     * @returns {string[]}
     */
    textToTags(text) {
        return String(text || "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
    }

    /**
     * @returns {void}
     */
    closeEntryDialog() {
        this.dialogEntryId = null;
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
        this.entryProjectInput.value = safeText(entry.project);
        this.entryDescInput.value = safeText(entry.description);
        this.entryTagsInput.value = this.tagsToText(entry.tags);
        this.entryBillableInput.checked = entry.billable === true;

        const day = this.timeContext.formatDate(entry.startDate);
        const start = this.timeContext.formatTime(entry.startDate);
        const end = this.timeContext.formatTime(entry.endDate);
        const dur = formatDuration(entry.durationSeconds);
        this.entryMetaEl.textContent = `${day} ${start}–${end} • ${dur} • id ${id}`;

        if (!this.entryDialog.open) this.entryDialog.showModal();
        queueMicrotask(() => {
            try {
                this.entryProjectInput.focus();
                this.entryProjectInput.select();
            } catch {
                // ignore
            }
        });
    }

    /**
     * @returns {void}
     */
    addEntryFromCursor() {
        if (!this.cursor || this.cursor.kind !== "add") return;
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!bounds) return;

        const id = this.store.reserveEntryId();
        const startMs = this.cursor.ms;
        const endMs = startMs + MIN_ENTRY_MS;
        if (startMs < bounds.startMs || endMs > bounds.endMs) {
            return this.onToast("Cannot create entry outside the current week.");
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
            return this.onToast("Entry too short to split (min 30 min)." );
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
