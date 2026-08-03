import {
    addIsoDays,
    cloneJson,
    createMaterialIcon,
    formatDuration,
    parseHexColor,
    hhmmToMinutes,
    chunkKey,
    isoWeekInfo,
    isoWeekStart,
    isoWeekdayIndex,
    isEditableTarget,
    jsonStringifySorted,
    minutesToHHMM,
    safeText,
    setVisible,
    utcNowIso,
} from "./utils.js";

const MIN_ENTRY_MINUTES = 15;
const MIN_ENTRY_MS = MIN_ENTRY_MINUTES * 60 * 1000;
const DEFAULT_GAP_ENTRY_MINUTES = 60;
const GAP_BUTTON_VIEWPORT_MARGIN_PX = 18;
const MIN_DAY_COLUMN_WIDTH = 136;
const ENTRY_DOUBLE_TAP_MAX_DELAY_MS = 450;
const ENTRY_DOUBLE_TAP_MAX_DISTANCE_PX = 28;
const ENTRY_TAP_MOVE_TOLERANCE_PX = 10;

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DESC_SUGGEST_MIN_CHARS = 2;
const DESC_SUGGEST_LIMIT = 8;

/**
 * Clamps the first visible day of a sliding window to the seven-day week.
 * This helper is exported so day-window edge behavior can be unit tested without constructing the DOM-heavy view.
 * @param {number} requestedStart
 * @param {number} visibleDayCount
 * @returns {number}
 */
export function clampDayWindowStart(requestedStart, visibleDayCount) {
    const count = Math.max(1, Math.min(7, Math.round(Number(visibleDayCount) || 1)));
    return Math.max(0, Math.min(7 - count, Math.round(Number(requestedStart) || 0)));
}

/**
 * Chooses a responsive day count from the actual timeline width.
 * The formula reserves the compact time axis, then fits as many readable 136 px day columns as possible without ever leaving the one-to-seven range.
 * @param {number} viewportWidth
 * @returns {number}
 */
export function calculateVisibleDayCount(viewportWidth) {
    const width = Math.max(0, Number(viewportWidth) || 0);
    const timeAxisWidth = width <= 760 ? 48 : 56;
    const availableDayWidth = Math.max(0, width - timeAxisWidth);
    return Math.max(1, Math.min(7, Math.floor(availableDayWidth / MIN_DAY_COLUMN_WIDTH)));
}

/**
 * Formats a tracked duration as compact decimal hours for the week-corner summary.
 * The value is rounded to one decimal place while whole-hour totals omit the redundant decimal suffix.
 * @param {number} seconds
 * @returns {string}
 */
export function formatTrackedHours(seconds) {
    const numericSeconds = Number(seconds);
    if (!Number.isFinite(numericSeconds) || numericSeconds <= 0) return "0h";
    const roundedHours = Math.round((numericSeconds / 3600) * 10) / 10;
    return `${roundedHours.toFixed(1).replace(/\.0$/, "")}h`;
}

/**
 * Computes free minute ranges for one day from potentially overlapping visual segments.
 * Adjacent and overlapping ranges are merged first, yielding stable gap buttons even for legacy data that is not perfectly normalized.
 * @param {Array<{startMinutes: number, endMinutes: number}>} segments
 * @returns {Array<{startMinutes: number, endMinutes: number}>}
 */
export function buildDayGaps(segments) {
    const occupied = (Array.isArray(segments) ? segments : [])
        .map((segment) => ({
            startMinutes: Math.max(0, Math.min(1440, Number(segment?.startMinutes) || 0)),
            endMinutes: Math.max(0, Math.min(1440, Number(segment?.endMinutes) || 0)),
        }))
        .filter((segment) => segment.endMinutes > segment.startMinutes)
        .sort((left, right) => left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes);

    const merged = [];
    for (const segment of occupied) {
        const previous = merged[merged.length - 1];
        if (previous && segment.startMinutes <= previous.endMinutes) {
            previous.endMinutes = Math.max(previous.endMinutes, segment.endMinutes);
        } else {
            merged.push({ ...segment });
        }
    }

    const gaps = [];
    let cursor = 0;
    for (const segment of merged) {
        if (segment.startMinutes - cursor >= MIN_ENTRY_MINUTES) {
            gaps.push({ startMinutes: cursor, endMinutes: segment.startMinutes });
        }
        cursor = Math.max(cursor, segment.endMinutes);
    }
    if (1440 - cursor >= MIN_ENTRY_MINUTES) {
        gaps.push({ startMinutes: cursor, endMinutes: 1440 });
    }
    return gaps;
}

/**
 * Chooses the default one-hour interval created by a gap button.
 * Leading gaps are anchored immediately before the day's first entry, while internal and trailing gaps begin immediately after the preceding entry; gaps shorter than one hour are used in full.
 * @param {number} gapStartMinutes Inclusive start of the free range in local minutes after midnight.
 * @param {number} gapEndMinutes Exclusive end of the free range in local minutes after midnight.
 * @returns {{startMinutes: number, endMinutes: number}}
 */
export function calculateDefaultGapEntryRange(gapStartMinutes, gapEndMinutes) {
    const gapStart = Math.max(0, Math.min(1440, Number(gapStartMinutes) || 0));
    const gapEnd = Math.max(gapStart, Math.min(1440, Number(gapEndMinutes) || 0));
    if (gapStart === 0 && gapEnd < 1440) {
        return {
            startMinutes: Math.max(gapStart, gapEnd - DEFAULT_GAP_ENTRY_MINUTES),
            endMinutes: gapEnd,
        };
    }
    return {
        startMinutes: gapStart,
        endMinutes: Math.min(gapEnd, gapStart + DEFAULT_GAP_ENTRY_MINUTES),
    };
}

/**
 * Keeps an edge-gap button inside the visible portion of its free range.
 * The preferred midpoint remains stable while visible and otherwise clamps just inside the viewport, avoiding distracting movement for ordinary internal-gap controls.
 * @param {number} gapStartMinutes Inclusive start of the full free range.
 * @param {number} gapEndMinutes Exclusive end of the full free range.
 * @param {number} preferredMinutes Normal button position, usually the full gap midpoint.
 * @param {number} visibleStartMinutes First timeline minute visible below the sticky header.
 * @param {number} visibleEndMinutes Last timeline minute visible above the viewport bottom.
 * @param {number} marginMinutes Inset that keeps the complete circular button visible when space permits.
 * @returns {number}
 */
export function calculateVisibleGapButtonMinute(
    gapStartMinutes,
    gapEndMinutes,
    preferredMinutes,
    visibleStartMinutes,
    visibleEndMinutes,
    marginMinutes = 0,
) {
    const gapStart = Math.max(0, Math.min(1440, Number(gapStartMinutes) || 0));
    const gapEnd = Math.max(gapStart, Math.min(1440, Number(gapEndMinutes) || 0));
    const preferred = Math.max(gapStart, Math.min(gapEnd, Number(preferredMinutes) || gapStart));
    const visibleStart = Math.max(0, Math.min(1440, Number(visibleStartMinutes) || 0));
    const visibleEnd = Math.max(visibleStart, Math.min(1440, Number(visibleEndMinutes) || 0));
    const intersectionStart = Math.max(gapStart, visibleStart);
    const intersectionEnd = Math.min(gapEnd, visibleEnd);
    if (intersectionEnd <= intersectionStart) return preferred;

    const margin = Math.max(0, Number(marginMinutes) || 0);
    if (intersectionEnd - intersectionStart < margin * 2) {
        return (intersectionStart + intersectionEnd) / 2;
    }
    return Math.max(intersectionStart + margin, Math.min(intersectionEnd - margin, preferred));
}

/**
 * Determines whether two touch taps form one double-tap on the same rendered entry segment.
 * Both elapsed time and screen-space distance are bounded so quick taps on neighboring entries do not open the wrong editor.
 * @param {{entryId: number, segmentKey: string, at: number, x: number, y: number} | null} previousTap
 * @param {{entryId: number, segmentKey: string, at: number, x: number, y: number}} currentTap
 * @param {number} [maxDelayMs]
 * @param {number} [maxDistancePx]
 * @returns {boolean}
 */
export function isMatchingEntryDoubleTap(
    previousTap,
    currentTap,
    maxDelayMs = ENTRY_DOUBLE_TAP_MAX_DELAY_MS,
    maxDistancePx = ENTRY_DOUBLE_TAP_MAX_DISTANCE_PX,
) {
    if (!previousTap || previousTap.entryId !== currentTap.entryId || previousTap.segmentKey !== currentTap.segmentKey) {
        return false;
    }
    const elapsed = currentTap.at - previousTap.at;
    if (elapsed < 0 || elapsed > Math.max(0, Number(maxDelayMs) || 0)) return false;
    const distance = Math.hypot(currentTap.x - previousTap.x, currentTap.y - previousTap.y);
    return distance <= Math.max(0, Number(maxDistancePx) || 0);
}

/**
 * Calculates snapped start/end timestamps for a pointer resize or move gesture.
 * Week bounds and the 15-minute minimum are enforced before collision resolution is run by the editor transaction.
 * @param {"start" | "end" | "move"} kind
 * @param {number} originalStartMs
 * @param {number} originalEndMs
 * @param {number} deltaMs
 * @param {{startMs: number, endMs: number}} weekBounds
 * @returns {{startMs: number, endMs: number}}
 */
export function calculatePointerEditTimes(kind, originalStartMs, originalEndMs, deltaMs, weekBounds) {
    const snappedDelta = Math.round(deltaMs / MIN_ENTRY_MS) * MIN_ENTRY_MS;
    let startMs = originalStartMs;
    let endMs = originalEndMs;
    if (kind === "start") {
        startMs = Math.min(originalStartMs + snappedDelta, endMs - MIN_ENTRY_MS);
    } else if (kind === "end") {
        endMs = Math.max(originalEndMs + snappedDelta, startMs + MIN_ENTRY_MS);
    } else {
        startMs += snappedDelta;
        endMs += snappedDelta;
    }

    if (kind === "move") {
        const duration = endMs - startMs;
        if (startMs < weekBounds.startMs) {
            startMs = weekBounds.startMs;
            endMs = startMs + duration;
        }
        if (endMs > weekBounds.endMs) {
            endMs = weekBounds.endMs;
            startMs = endMs - duration;
        }
    } else {
        startMs = Math.max(weekBounds.startMs, startMs);
        endMs = Math.min(weekBounds.endMs, endMs);
    }
    return { startMs, endMs };
}

/**
 * Builds an id-indexed map for a raw week snapshot.
 * Invalid rows are ignored because the EntryStore applies the same validation when loading snapshots.
 * @param {Array<Object>} rawEntries
 * @returns {Map<number, Object>}
 */
function rawEntriesById(rawEntries) {
    const byId = new Map();
    for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
        if (!raw || typeof raw !== "object") continue;
        const id = Number(raw.id);
        if (!Number.isFinite(id)) continue;
        byId.set(id, raw);
    }
    return byId;
}

/**
 * Compares two raw entry values with stable object-key ordering.
 * Property order in JSON must not make an otherwise identical entry appear dirty.
 * @param {Object | undefined} left
 * @param {Object | undefined} right
 * @returns {boolean}
 */
function rawEntriesEqual(left, right) {
    if (left === undefined || right === undefined) return left === right;
    return jsonStringifySorted(left) === jsonStringifySorted(right);
}

/**
 * Returns every entry id whose value or presence differs between two week snapshots.
 * The resulting set includes deletions even though deleted entries have no block to stripe.
 * @param {Array<Object>} baseline
 * @param {Array<Object>} current
 * @returns {Set<number>}
 */
function changedEntryIds(baseline, current) {
    const baselineById = rawEntriesById(baseline);
    const currentById = rawEntriesById(current);
    const ids = new Set([...baselineById.keys(), ...currentById.keys()]);
    const changed = new Set();
    for (const id of ids) {
        if (!rawEntriesEqual(baselineById.get(id), currentById.get(id))) {
            changed.add(id);
        }
    }
    return changed;
}

/**
 * Determines whether two raw week snapshots contain the same entries.
 * Entry ordering is intentionally ignored because weekly files are sorted during serialization.
 * @param {Array<Object>} left
 * @param {Array<Object>} right
 * @returns {boolean}
 */
function rawWeekSnapshotsEqual(left, right) {
    return changedEntryIds(left, right).size === 0;
}

/**
 * @typedef {Object} WeekViewOptions
 * @description Dependency bundle for week view rendering and editing.
 * @property {import("./store.js").EntryStore} store
 * @property {import("./cache.js").ChunkCache} chunkCache
 * @property {import("./cache.js").DraftJournal} draftJournal
 * @property {string} draftNamespace
 * @property {import("./appstate.js").AppState} appState
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {Object} elements
 * @property {HTMLElement} elements.weekViewSection
 * @property {HTMLElement} elements.weekControls
 * @property {HTMLElement} elements.weekBillable
 * @property {HTMLButtonElement} elements.weekReqBtn
 * @property {HTMLElement} elements.weekScroll
 * @property {HTMLButtonElement} elements.prevWeekBtn
 * @property {HTMLButtonElement} elements.nextWeekBtn
 * @property {HTMLButtonElement} elements.latestWeekBtn
 * @property {HTMLButtonElement} elements.weekNormalBtn
 * @property {HTMLButtonElement} elements.weekAddBtn
 * @property {HTMLButtonElement} elements.weekSplitBtn
 * @property {HTMLButtonElement} elements.weekUndoBtn
 * @property {HTMLButtonElement} elements.weekRedoBtn
 * @property {HTMLButtonElement} elements.weekZoomOutBtn
 * @property {HTMLButtonElement} elements.weekZoomInBtn
 * @property {HTMLInputElement} elements.zoomInput
 * @property {HTMLButtonElement} elements.editorBadge
 * @property {HTMLDialogElement} elements.weekReqDialog
 * @property {HTMLFormElement} elements.weekReqForm
 * @property {HTMLButtonElement} elements.weekReqCloseBtn
 * @property {HTMLButtonElement} elements.weekReqCancelBtn
 * @property {HTMLButtonElement} elements.weekReqOkBtn
 * @property {HTMLElement} elements.weekReqMeta
 * @property {HTMLElement} elements.weekReqSummary
 * @property {HTMLInputElement} elements.weekReqHours
 * @property {HTMLTextAreaElement} elements.weekReqComment
 * @property {HTMLDialogElement} elements.entryDialog
 * @property {HTMLFormElement} elements.entryForm
 * @property {HTMLButtonElement} elements.entryCloseBtn
 * @property {HTMLButtonElement} elements.entryDeleteBtn
 * @property {HTMLButtonElement} elements.entryCancelBtn
 * @property {HTMLElement} elements.entryMeta
 * @property {HTMLInputElement} elements.entryAssignment
 * @property {HTMLDataListElement} elements.entryAssignmentList
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
        this.draftJournal = options.draftJournal;
        this.draftNamespace = String(options.draftNamespace || "").trim();
        this.appState = options.appState;
        this.timeContext = options.timeContext;
        this.dataSource = options.dataSource;

        this.weekViewSection = options.elements.weekViewSection;
        this.weekControlsEl = options.elements.weekControls;
        this.weekBillableEl = options.elements.weekBillable;
        this.weekReqBtn = options.elements.weekReqBtn;
        this.weekScrollEl = options.elements.weekScroll;
        this.prevWeekBtn = options.elements.prevWeekBtn;
        this.nextWeekBtn = options.elements.nextWeekBtn;
        this.latestWeekBtn = options.elements.latestWeekBtn;
        this.weekNormalBtn = options.elements.weekNormalBtn;
        this.weekAddBtn = options.elements.weekAddBtn;
        this.weekSplitBtn = options.elements.weekSplitBtn;
        this.weekUndoBtn = options.elements.weekUndoBtn;
        this.weekRedoBtn = options.elements.weekRedoBtn;
        this.weekZoomOutBtn = options.elements.weekZoomOutBtn;
        this.weekZoomInBtn = options.elements.weekZoomInBtn;
        this.zoomInput = options.elements.zoomInput;
        this.editorBadgeEl = options.elements.editorBadge;

        this.weekReqDialog = options.elements.weekReqDialog;
        this.weekReqForm = options.elements.weekReqForm;
        this.weekReqCloseBtn = options.elements.weekReqCloseBtn;
        this.weekReqCancelBtn = options.elements.weekReqCancelBtn;
        this.weekReqOkBtn = options.elements.weekReqOkBtn;
        this.weekReqMetaEl = options.elements.weekReqMeta;
        this.weekReqSummaryEl = options.elements.weekReqSummary;
        this.weekReqHoursInput = options.elements.weekReqHours;
        this.weekReqCommentInput = options.elements.weekReqComment;

        this.entryDialog = options.elements.entryDialog;
        this.entryForm = options.elements.entryForm;
        this.entryCloseBtn = options.elements.entryCloseBtn;
        this.entryDeleteBtn = options.elements.entryDeleteBtn;
        this.entryCancelBtn = options.elements.entryCancelBtn;
        this.entryMetaEl = options.elements.entryMeta;
        this.entryAssignmentInput = options.elements.entryAssignment;
        this.entryAssignmentListEl = options.elements.entryAssignmentList;
        this.entryDescInput = options.elements.entryDesc;
        this.entryDescSuggestionsEl = options.elements.entryDescSuggestions;

        this.onToast = options.onToast;
        this.onBusy = options.onBusy;
        this.onSearchDirty = options.onSearchDirty;
        this.onManifestUpdated = options.onManifestUpdated;

        this.active = false;
        this.busy = false;
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
        this.descSuggestions = [];

        this.dirtyWeekStarts = new Set();
        /** @type {Map<string, Set<number>>} */
        this.dirtyEntryIdsByWeek = new Map();
        /** @type {Map<string, Array<Object>>} */
        this.cleanWeekSnapshots = new Map();
        /** @type {Map<string, string>} */
        this.cleanWeekShas = new Map();
        this.draftWriteChain = Promise.resolve();
        this.draftWarningShown = false;
        this.saveInFlight = false;
        this.toastTimer = 0;
        this.nowTimer = 0;
        this.nowLineEl = null;
        this.nowLineDayIdx = -1;
        this.visibleDayCount = calculateVisibleDayCount(window.innerWidth);
        this.dayWindowStart = clampDayWindowStart(this.focusedDayIndex, this.getVisibleDayCount());
        this.pointerEdit = null;
        /** @type {{distance: number, zoom: number} | null} */
        this.pinchZoom = null;
        this.suppressEntryClickUntil = 0;
        this.gapPositionRaf = 0;
        /** @type {{entryId: number, segmentKey: string, at: number, x: number, y: number} | null} */
        this.lastEntryTap = null;

        this.undoStack = [];
        this.redoStack = [];

        const initialZoom = Number.parseFloat(this.zoomInput.value || "1");
        this.zoom = Number.isFinite(initialZoom) && initialZoom >= 1 ? initialZoom : 1;

        this.bindEvents();
        this.updateTopbarActions();
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
     * Applies application-wide busy state to controls owned by the week view.
     * Selection-sensitive actions are recalculated here so finishing a save restores only actions that are actually available.
     * @param {boolean} isBusy
     * @returns {void}
     */
    setBusy(isBusy) {
        this.busy = Boolean(isBusy);
        this.prevWeekBtn.disabled = this.busy;
        this.nextWeekBtn.disabled = this.busy;
        this.latestWeekBtn.disabled =
            this.busy || Boolean(this.appState.latestWeekStart && this.appState.latestWeekStart === this.appState.weekStart);
        this.zoomInput.disabled = this.busy;
        this.weekReqBtn.disabled = this.busy;
        this.entryAssignmentInput.disabled = this.busy;
        this.entryDeleteBtn.disabled = this.busy;
        for (const button of this.weekScrollEl.querySelectorAll(".entry-control, .entry-resize-handle, .entry-gap-add")) {
            if (button instanceof HTMLButtonElement) button.disabled = this.busy;
        }
        this.updateEditorBadge();
    }

    /**
     * Restores focus to the timeline without throwing when the view is currently detached or hidden.
     * Pointer and top-bar commands share this helper to keep subsequent keyboard navigation available.
     * @returns {void}
     */
    focusTimeline() {
        queueMicrotask(() => {
            try {
                this.weekScrollEl.focus({ preventScroll: true });
            } catch {
                // Ignore browsers that do not support focus options on this element.
            }
        });
    }

    /**
     * Selects the browser-draft namespace for the active local folder or GitHub repository branch.
     * Namespaces keep drafts from different repositories from being restored into each other.
     * @param {string} namespace
     * @returns {void}
     */
    setDraftNamespace(namespace) {
        this.draftNamespace = String(namespace || "").trim();
        this.draftWarningShown = false;
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
                this.populateAssignmentCombobox({
                    projectKey: entry.projectKey,
                    sectionKey: entry.sectionKey,
                });
            }
        }
        if (this.appState.weekStart) {
            this.rebuildWeekView();
        }
    }

    /**
     * Applies new week requirement settings and refreshes summary labels.
     * Part of the week view interaction flow.
     * @param {import("./model.js").WeekRequirements | null} weekRequirements
     * @returns {void}
     */
    setWeekRequirements(weekRequirements) {
        this.store.setWeekRequirements(weekRequirements);
        if (this.appState.weekStart) {
            this.updateWeekSummary(this.appState.weekStart);
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
        this.weekScrollEl.addEventListener("wheel", (ev) => this.handleZoomWheel(ev), { passive: false });
        this.weekScrollEl.addEventListener("touchstart", (ev) => this.handlePinchStart(ev), { passive: false });
        this.weekScrollEl.addEventListener("touchmove", (ev) => this.handlePinchMove(ev), { passive: false });
        this.weekScrollEl.addEventListener("touchend", (ev) => this.handlePinchEnd(ev));
        this.weekScrollEl.addEventListener("touchcancel", (ev) => this.handlePinchEnd(ev));
        this.weekScrollEl.addEventListener("scroll", () => this.scheduleGapButtonReposition(), { passive: true });
        this.weekReqBtn.addEventListener("click", () => this.openWeekRequirementsDialog());
        this.weekNormalBtn.addEventListener("click", () => {
            this.setEditMode("normal");
            this.focusTimeline();
        });
        this.weekAddBtn.addEventListener("click", () => {
            this.enterAddMode();
            this.focusTimeline();
        });
        this.weekSplitBtn.addEventListener("click", () => {
            this.enterSplitMode();
            this.focusTimeline();
        });
        this.weekUndoBtn.addEventListener("click", () => {
            this.undo();
            this.focusTimeline();
        });
        this.weekRedoBtn.addEventListener("click", () => {
            this.redo();
            this.focusTimeline();
        });
        this.weekZoomOutBtn.addEventListener("click", () => {
            this.nudgeZoom(-1);
            this.focusTimeline();
        });
        this.weekZoomInBtn.addEventListener("click", () => {
            this.nudgeZoom(1);
            this.focusTimeline();
        });

        this.weekReqCloseBtn.addEventListener("click", () => this.closeWeekRequirementsDialog());
        this.weekReqCancelBtn.addEventListener("click", () => this.closeWeekRequirementsDialog());
        this.weekReqDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.closeWeekRequirementsDialog();
        });
        this.weekReqForm.addEventListener("submit", (ev) => this.handleWeekRequirementsSubmit(ev));

        this.entryCloseBtn.addEventListener("click", () => this.closeEntryDialog());
        this.entryDeleteBtn.addEventListener("click", () => this.handleEntryDialogDelete());
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

        window.addEventListener("pointermove", (ev) => this.handleEntryPointerMove(ev));
        window.addEventListener("pointerup", (ev) => this.finishEntryPointerEdit(ev));
        window.addEventListener("pointercancel", (ev) => this.cancelEntryPointerEdit(ev));
    }

    /**
     * Shows or hides the week view and repositions the timeline.
     * Part of the week view interaction flow.
     * @param {boolean} isActive
     * @returns {void}
     */
    setActive(isActive) {
        this.active = Boolean(isActive);
        setVisible(this.weekViewSection, this.active);
        if (this.active) {
            this.updateVisibleDayCount();
            this.updateEditorBadge();
            this.ensureFocusedDayInWindow();
            this.applyDayWindow();
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
        if (this.weekBillableEl) {
            this.weekBillableEl.replaceChildren();
        }
        this.weekReqBtn.removeAttribute("aria-label");
        this.weekReqBtn.title = "Edit required hours";
        this.weekDom = null;
        this.segmentsIndex = new Map();
        this.projectColorCache.clear();
        this.focusedDayIndex = 0;
        this.focusedEntryIndexByDay = Array(7).fill(0);
        this.selectedSegKey = null;
        this.selectedEntryId = null;
        this.dialogEntryId = null;
        this.saveInFlight = false;
        this.dirtyWeekStarts.clear();
        this.dirtyEntryIdsByWeek.clear();
        this.cleanWeekSnapshots.clear();
        this.cleanWeekShas.clear();
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.dayWindowStart = clampDayWindowStart(0, this.getVisibleDayCount());
        this.pointerEdit = null;
        this.pinchZoom = null;
        this.lastEntryTap = null;
        if (this.gapPositionRaf) {
            window.cancelAnimationFrame(this.gapPositionRaf);
            this.gapPositionRaf = 0;
        }
        document.body.classList.remove("is-entry-dragging");
        document.body.classList.remove("is-entry-moving");
        this.setEditMode("normal");
        this.updateEditorBadge();
        this.updateTopbarActions();
        this.clearDescriptionSuggestions();
        this.clearAddDraft();
        this.stopNowTimer();
        this.clearNowMarker();
        this.closeWeekRequirementsDialog();
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
        this.ensureFocusedDayInWindow();
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
        this.latestWeekBtn.disabled =
            this.busy || Boolean(latestWeekStart && this.appState.weekStart === latestWeekStart);
    }

    /**
     * Returns the number of day columns currently displayed.
     * The value is derived from the timeline's measured width and remains stable until activation or resize recalculates it.
     * @returns {number}
     */
    getVisibleDayCount() {
        return this.visibleDayCount;
    }

    /**
     * Recalculates how many readable day columns fit in the timeline.
     * The focused day remains visible when crossing a responsive threshold, and existing DOM nodes are reused rather than rebuilding the week.
     * @returns {boolean} true when the visible day count changed
     */
    updateVisibleDayCount() {
        const effectiveViewportWidth = Number(this.appState.effectiveViewportWidth);
        const measuredWidth = this.weekScrollEl.clientWidth || effectiveViewportWidth || window.innerWidth;
        const availableWidth =
            Number.isFinite(effectiveViewportWidth) && effectiveViewportWidth > 0
                ? Math.min(measuredWidth, effectiveViewportWidth)
                : measuredWidth;
        const nextCount = calculateVisibleDayCount(availableWidth);
        if (nextCount === this.visibleDayCount) return false;
        this.visibleDayCount = nextCount;
        this.ensureFocusedDayInWindow();
        this.applyDayWindow();
        return true;
    }

    /**
     * Keeps the focused day inside the sliding narrow-view window.
     * The window moves only as far as necessary, preserving its position while selection stays within it.
     * @returns {void}
     */
    ensureFocusedDayInWindow() {
        const count = this.getVisibleDayCount();
        if (count >= 7) {
            this.dayWindowStart = 0;
            return;
        }
        if (this.focusedDayIndex < this.dayWindowStart) {
            this.dayWindowStart = this.focusedDayIndex;
        } else if (this.focusedDayIndex >= this.dayWindowStart + count) {
            this.dayWindowStart = this.focusedDayIndex - count + 1;
        }
        this.dayWindowStart = clampDayWindowStart(this.dayWindowStart, count);
    }

    /**
     * Applies the current day-window visibility to an already-built week grid.
     * Hidden day nodes remain indexed for keyboard navigation and overflow calculations but no longer consume grid columns.
     * @returns {void}
     */
    applyDayWindow() {
        if (!this.weekDom) return;
        const count = this.getVisibleDayCount();
        this.dayWindowStart = clampDayWindowStart(this.dayWindowStart, count);
        const end = this.dayWindowStart + count;
        this.weekDom.gridEl.style.setProperty("--visible-day-count", String(count));
        this.weekDom.gridEl.classList.toggle("is-narrow-window", count < 7);
        for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
            const hidden = dayIdx < this.dayWindowStart || dayIdx >= end;
            this.weekDom.dayHeaderEls[dayIdx]?.classList.toggle("is-window-hidden", hidden);
            this.weekDom.dayColEls[dayIdx]?.classList.toggle("is-window-hidden", hidden);
        }

        const sideRailDay = end - 1;
        for (const el of this.weekDom.entryElsByKey.values()) {
            const dayIdx = Number.parseInt(el.dataset.dayIdx || "-1", 10);
            el.classList.toggle("controls-on-left", dayIdx === sideRailDay);
        }
    }

    /**
     * Moves a narrow sliding window by one day, crossing to the adjacent week only at the week boundary.
     * In the seven-day layout this retains the original previous/next-week behavior.
     * @param {-1 | 1} direction
     * @returns {void}
     */
    navigateDayWindow(direction) {
        if (!this.appState.weekStart) return;
        const count = this.getVisibleDayCount();
        if (count >= 7) {
            this.setWeekStart(addIsoDays(this.appState.weekStart, direction * 7));
            return;
        }

        const maxStart = 7 - count;
        const nextStart = this.dayWindowStart + direction;
        if (nextStart >= 0 && nextStart <= maxStart) {
            this.dayWindowStart = nextStart;
            if (this.focusedDayIndex < nextStart) {
                this.focusedDayIndex = nextStart;
            } else if (this.focusedDayIndex >= nextStart + count) {
                this.focusedDayIndex = nextStart + count - 1;
            }
            this.applyDayWindow();
            this.applyWeekFocusAndSelection();
            this.scrollWeekFocusIntoView();
            return;
        }

        if (direction < 0) {
            this.dayWindowStart = maxStart;
            this.setWeekStart(addIsoDays(this.appState.weekStart, -7), 6);
        } else {
            this.dayWindowStart = 0;
            this.setWeekStart(addIsoDays(this.appState.weekStart, 7), 0);
        }
    }

    /**
     * Moves focus to the previous week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    handlePrevWeek() {
        this.navigateDayWindow(-1);
    }

    /**
     * Moves focus to the next week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    handleNextWeek() {
        this.navigateDayWindow(1);
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
        const rect = this.weekScrollEl.getBoundingClientRect();
        this.setZoomLevel(nextZoom, rect.top + rect.height / 2);
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

        const rect = this.weekScrollEl.getBoundingClientRect();
        this.setZoomLevel(next, rect.top + rect.height / 2);
    }

    /**
     * Applies a clamped zoom factor while keeping the timeline minute beneath an optional screen coordinate stationary.
     * Preserving that focal point makes wheel, trackpad, slider, and touch zoom feel like scaling the calendar rather than jumping its scroll position.
     * @param {number} requestedZoom
     * @param {number | null} [anchorClientY]
     * @returns {void}
     */
    setZoomLevel(requestedZoom, anchorClientY = null) {
        const min = Number.parseFloat(this.zoomInput.min || "1");
        const max = Number.parseFloat(this.zoomInput.max || "4");
        let next = Number(requestedZoom);
        if (!Number.isFinite(next)) return;
        if (Number.isFinite(min)) next = Math.max(min, next);
        if (Number.isFinite(max)) next = Math.min(max, next);
        next = Number(next.toFixed(3));
        if (Math.abs(next - this.zoom) < 0.0005) {
            this.updateTopbarActions();
            return;
        }

        const oldMetrics = this.weekDom?.metrics || this.computeWeekMetrics();
        const containerRect = this.weekScrollEl.getBoundingClientRect();
        const localAnchorY =
            Number.isFinite(anchorClientY) && anchorClientY !== null
                ? Number(anchorClientY) - containerRect.top
                : containerRect.height / 2;
        const anchorMinutes = oldMetrics
            ? Math.max(
                  0,
                  Math.min(
                      1440,
                      (this.weekScrollEl.scrollTop + localAnchorY - oldMetrics.headerHeight) / oldMetrics.pxPerMinute,
                  ),
              )
            : null;

        this.zoom = next;
        this.appState.setZoom(next);
        this.zoomInput.value = String(next);
        this.updateWeekScaleAndReposition(false);

        const newMetrics = this.weekDom?.metrics;
        if (newMetrics && anchorMinutes !== null) {
            const nextScrollTop = newMetrics.headerHeight + anchorMinutes * newMetrics.pxPerMinute - localAnchorY;
            this.weekScrollEl.scrollTop = Math.max(0, nextScrollTop);
            this.updateGapButtonPositions(newMetrics);
        }
        this.updateTopbarActions();
    }

    /**
     * Converts Ctrl+wheel events, including desktop trackpad pinch gestures, into timeline zoom.
     * Preventing the event only while the Week view is active leaves ordinary scrolling untouched and stops browser page zoom in the calendar.
     * @param {WheelEvent} ev
     * @returns {void}
     */
    handleZoomWheel(ev) {
        if (!this.active || !ev.ctrlKey) return;
        ev.preventDefault();
        if (this.busy || this.saveInFlight) return;
        const boundedDelta = Math.max(-120, Math.min(120, ev.deltaY));
        const scale = Math.exp(-boundedDelta * 0.0025);
        this.setZoomLevel(this.zoom * scale, ev.clientY);
    }

    /**
     * Measures the distance between the first two active touches.
     * @param {TouchList} touches
     * @returns {number}
     */
    getTouchDistance(touches) {
        const first = touches.item(0);
        const second = touches.item(1);
        if (!first || !second) return 0;
        return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
    }

    /**
     * Starts a two-finger zoom gesture and cancels any one-finger entry preview that preceded it.
     * @param {TouchEvent} ev
     * @returns {void}
     */
    handlePinchStart(ev) {
        if (!this.active || ev.touches.length !== 2 || this.busy || this.saveInFlight) return;
        const distance = this.getTouchDistance(ev.touches);
        if (distance <= 0) return;
        if (ev.cancelable) ev.preventDefault();
        this.abortEntryPointerEdit();
        this.pinchZoom = { distance, zoom: this.zoom };
    }

    /**
     * Scales the timeline around the midpoint of an active two-finger gesture.
     * @param {TouchEvent} ev
     * @returns {void}
     */
    handlePinchMove(ev) {
        if (!this.pinchZoom || ev.touches.length !== 2) return;
        const distance = this.getTouchDistance(ev.touches);
        if (distance <= 0) return;
        if (ev.cancelable) ev.preventDefault();
        const first = ev.touches.item(0);
        const second = ev.touches.item(1);
        if (!first || !second) return;
        const midpointY = (first.clientY + second.clientY) / 2;
        this.setZoomLevel(this.pinchZoom.zoom * (distance / this.pinchZoom.distance), midpointY);
    }

    /**
     * Ends touch zoom once fewer than two fingers remain.
     * @param {TouchEvent} ev
     * @returns {void}
     */
    handlePinchEnd(ev) {
        if (ev.touches.length < 2) {
            this.pinchZoom = null;
        }
    }

    /**
     * Updates the shared top-bar save control with the current persistence state.
     * Edit mode is represented exclusively by the pressed mode button, leaving this control focused on its Saved/Changed action.
     * @returns {void}
     */
    updateEditorBadge() {
        const dirty = this.dirtyWeekStarts.size > 0;
        this.updateTopbarActions();
        if (!this.active) return;
        const save = this.saveInFlight ? "Saving…" : dirty ? "Changed" : "Saved";
        this.editorBadgeEl.classList.toggle("is-dirty", dirty);
        this.editorBadgeEl.disabled = this.busy || this.saveInFlight;
        this.editorBadgeEl.title = dirty ? "Save changes (Ctrl+S)" : "No unsaved week changes";
        this.editorBadgeEl.setAttribute("aria-label", dirty ? "Save changed weeks" : "Week changes saved");
        this.editorBadgeEl.innerHTML = `<span class="dot"></span><span class="save">${save}</span>`;
    }

    /**
     * Synchronizes top-bar mode, undo/redo, and zoom buttons with editor state.
     * These controls mirror keyboard commands and expose pressed/disabled semantics to assistive technology.
     * @returns {void}
     */
    updateTopbarActions() {
        const blocked = this.busy || this.saveInFlight;
        const selectedEntry = this.selectedEntryId ? this.store.getEntryById(this.selectedEntryId) : null;
        const canSplit =
            Boolean(selectedEntry) &&
            selectedEntry?.weekStart === this.appState.weekStart &&
            selectedEntry?.durationSeconds >= 2 * MIN_ENTRY_MINUTES * 60;

        for (const [button, mode] of [
            [this.weekNormalBtn, "normal"],
            [this.weekAddBtn, "add"],
            [this.weekSplitBtn, "split"],
        ]) {
            button.classList.toggle("is-active", this.editMode === mode);
            button.setAttribute("aria-pressed", this.editMode === mode ? "true" : "false");
        }

        this.weekNormalBtn.disabled = blocked;
        this.weekAddBtn.disabled = blocked || !this.appState.weekStart;
        this.weekSplitBtn.disabled = blocked || !canSplit;
        this.weekUndoBtn.disabled = blocked || this.undoStack.length === 0;
        this.weekRedoBtn.disabled = blocked || this.redoStack.length === 0;
        const zoom = Number.parseFloat(this.zoomInput.value || String(this.zoom));
        const minZoom = Number.parseFloat(this.zoomInput.min || "1");
        const maxZoom = Number.parseFloat(this.zoomInput.max || "4");
        this.weekZoomOutBtn.disabled = blocked || zoom <= minZoom;
        this.weekZoomInBtn.disabled = blocked || zoom >= maxZoom;
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
        let dayStr = this.timeContext.formatDate(dt);
        let minutes = hhmmToMinutes(this.timeContext.formatTime(dt));
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (bounds && this.cursor.kind === "add" && this.cursor.ms === bounds.endMs && this.weekDom.days.length) {
            dayStr = this.weekDom.days[this.weekDom.days.length - 1];
            minutes = 1440;
        }
        if (!dayStr || minutes === null) {
            this.clearCursor();
            return;
        }

        const dayIdx = this.weekDom.days.indexOf(dayStr);
        if (dayIdx < 0) {
            this.clearCursor();
            return;
        }

        if (!this.cursorEl) {
            this.cursorEl = document.createElement("div");
            this.cursorEl.className = "cursor-line";
        }

        this.cursorEl.classList.toggle("is-split", this.cursor.kind === "split");
        const topMinutes = minutes === 1440 ? 1439.9 : minutes;
        this.cursorEl.style.top = `${topMinutes * this.weekDom.metrics.pxPerMinute}px`;

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
        if (this.appState.weekStart) {
            this.updateWeekSummary(this.appState.weekStart);
        }
        this.nowTimer = window.setInterval(() => {
            this.updateNowMarker();
            if (this.appState.weekStart) {
                this.updateWeekSummary(this.appState.weekStart);
            }
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
        for (let i = 0; i < this.weekDom.dayHeaderEls.length; i++) {
            this.weekDom.dayHeaderEls[i].classList.toggle("is-today", this.weekDom.days[i] === dayStr);
        }
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
        this.ensureFocusedDayInWindow();
        this.applyDayWindow();

        for (let i = 0; i < this.weekDom.dayColEls.length; i++) {
            this.weekDom.dayColEls[i].classList.toggle("is-focused", i === this.focusedDayIndex);
            const header = this.weekDom.dayHeaderEls?.[i];
            if (header) {
                header.classList.toggle("is-focused", i === this.focusedDayIndex);
            }
        }

        const dayKeys = this.weekDom.dayKeys[this.focusedDayIndex] || [];
        const selectedKey = dayKeys.length ? dayKeys[this.focusedEntryIndexByDay[this.focusedDayIndex] || 0] : null;
        for (let i = 0; i < this.weekDom.dayColEls.length; i++) {
            this.weekDom.dayColEls[i].classList.toggle(
                "has-selected-entry",
                i === this.focusedDayIndex && Boolean(selectedKey),
            );
        }
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
        this.updateTopbarActions();
    }

    /**
     * Resolves which element should be kept in view (cursor or selected entry).
     * Part of the week view interaction flow.
     * @returns {HTMLElement | null}
     */
    getWeekScrollTarget() {
        if (this.cursorEl && this.cursorEl.isConnected) {
            return this.cursorEl;
        }
        if (!this.weekDom) return null;
        const dayKeys = this.weekDom.dayKeys[this.focusedDayIndex] || [];
        const selectedKey = dayKeys.length ? dayKeys[this.focusedEntryIndexByDay[this.focusedDayIndex] || 0] : null;
        if (!selectedKey) return null;
        return this.weekDom.entryElsByKey.get(selectedKey) || null;
    }

    /**
     * Scrolls the focused day or entry into view.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    scrollWeekFocusIntoView() {
        if (!this.weekDom) return;
        const target = this.getWeekScrollTarget();
        if (!target) return;
        const containerRect = this.weekScrollEl.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const inViewVertical = targetRect.top >= containerRect.top && targetRect.bottom <= containerRect.bottom;
        const inViewHorizontal = targetRect.left >= containerRect.left && targetRect.right <= containerRect.right;
        if (inViewVertical && inViewHorizontal) return;
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
        const headerHeight = headerEl ? headerEl.offsetHeight : 50;
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
     * Coalesces high-frequency timeline scroll events into one edge-gap positioning pass per animation frame.
     * Only lightweight style updates occur in that pass, so scrolling remains smooth even in weeks with many entries.
     * @returns {void}
     */
    scheduleGapButtonReposition() {
        if (this.gapPositionRaf) return;
        this.gapPositionRaf = window.requestAnimationFrame(() => {
            this.gapPositionRaf = 0;
            this.updateGapButtonPositions(undefined, true);
        });
    }

    /**
     * Positions every gap control at its preferred midpoint and pins leading/trailing controls inside the visible portion of their gap.
     * Internal gaps deliberately retain a fixed midpoint, while edge controls account for the sticky header and current timeline zoom.
     * @param {{baseHeight: number, headerHeight: number, timelineHeight: number, pxPerMinute: number} | null} [metrics]
     * @param {boolean} [pinnedOnly] Whether to skip fixed internal controls during scroll-only updates.
     * @returns {void}
     */
    updateGapButtonPositions(metrics = this.weekDom?.metrics || null, pinnedOnly = false) {
        if (!this.weekDom || !metrics || metrics.pxPerMinute <= 0) return;
        const visibleStartMinutes = Math.max(0, this.weekScrollEl.scrollTop / metrics.pxPerMinute);
        const visibleEndMinutes = Math.min(
            1440,
            (this.weekScrollEl.scrollTop + metrics.baseHeight) / metrics.pxPerMinute,
        );
        const marginMinutes = GAP_BUTTON_VIEWPORT_MARGIN_PX / metrics.pxPerMinute;

        for (const button of this.weekDom.gapButtonEls || []) {
            const midpoint = Number.parseFloat(button.dataset.midpoint || "0");
            const pinToViewport = button.dataset.pinToViewport === "true";
            if (pinnedOnly && !pinToViewport) continue;
            let buttonMinutes = midpoint;
            if (pinToViewport) {
                buttonMinutes = calculateVisibleGapButtonMinute(
                    Number.parseFloat(button.dataset.gapStart || "0"),
                    Number.parseFloat(button.dataset.gapEnd || "1440"),
                    midpoint,
                    visibleStartMinutes,
                    visibleEndMinutes,
                    marginMinutes,
                );
            }
            button.style.top = `${buttonMinutes * metrics.pxPerMinute}px`;
        }
    }

    /**
     * Repositions entry blocks after zoom or resize changes.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    updateWeekScaleAndReposition(shouldScrollFocus = true) {
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

        this.updateGapButtonPositions(metrics);

        this.updateCursorLine();
        this.updateAddDraftPreview();
        this.updateNowMarker();
        if (shouldScrollFocus) this.scrollWeekFocusIntoView();
    }

    /**
     * Rebuilds the week DOM from the store segment index.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    rebuildWeekView() {
        const prevScrollTop = this.weekScrollEl.scrollTop;
        const prevScrollLeft = this.weekScrollEl.scrollLeft;
        this.weekScrollEl.innerHTML = "";
        this.weekDom = null;
        this.clearNowMarker();
        this.addDraftEl = null;

        const weekStart = this.appState.weekStart;
        const hasProjectList = Boolean(this.store.getProjectList());
        if (!weekStart) {
            if (this.weekBillableEl) {
                this.weekBillableEl.textContent = "";
            }
            return;
        }

        this.updateVisibleDayCount();
        this.segmentsIndex = this.store.getWeekSegmentsIndex(weekStart);

        const days = Array.from({ length: 7 }, (_, i) => addIsoDays(weekStart, i));
        const today = this.timeContext.formatDate(new Date());
        const { week } = isoWeekInfo(weekStart);
        this.updateWeekSummary(weekStart);

        const gridEl = document.createElement("div");
        gridEl.className = "week-grid";

        const timeHeader = document.createElement("div");
        timeHeader.className = "wg-header wg-week-summary";
        const weekNumberEl = document.createElement("div");
        weekNumberEl.className = "wg-week-number";
        weekNumberEl.textContent = `W${String(week).padStart(2, "0")}`;
        const trackedSeconds = this.store.getWeekTrackedSeconds(weekStart);
        const weekTrackedEl = document.createElement("div");
        weekTrackedEl.className = "wg-week-tracked";
        weekTrackedEl.textContent = formatTrackedHours(trackedSeconds);
        timeHeader.title = `${formatDuration(trackedSeconds)} tracked in week ${week}`;
        timeHeader.setAttribute("aria-label", `Week ${week}, ${formatDuration(trackedSeconds)} tracked`);
        timeHeader.append(weekNumberEl, weekTrackedEl);
        gridEl.append(timeHeader);

        const dayHeaderEls = [];
        for (let i = 0; i < 7; i++) {
            const header = document.createElement("div");
            header.className = "wg-header";
            header.dataset.dayIdx = String(i);
            header.classList.toggle("is-today", days[i] === today);

            const dowEl = document.createElement("div");
            dowEl.className = "wg-dow";
            dowEl.textContent = DOW_LABELS[i];
            const totalEl = document.createElement("div");
            totalEl.className = "wg-day-total";
            const billableSeconds = this.store.getDayBillableSeconds(weekStart, days[i]);
            totalEl.classList.toggle("is-empty", billableSeconds === 0);
            totalEl.textContent = `€ ${formatDuration(billableSeconds)}`;
            totalEl.title = `${formatDuration(billableSeconds)} billable`;
            const headerTopEl = document.createElement("div");
            headerTopEl.className = "wg-header-top";
            headerTopEl.append(dowEl, totalEl);
            const dateEl = document.createElement("div");
            dateEl.className = "wg-date";
            dateEl.textContent = days[i];

            header.append(headerTopEl, dateEl);
            header.addEventListener("click", () => {
                this.focusedDayIndex = i;
                this.applyWeekFocusAndSelection();
                this.scrollWeekFocusIntoView();
                this.weekScrollEl.focus();
            });
            dayHeaderEls.push(header);
            gridEl.append(header);
        }

        const timeAxisEl = document.createElement("div");
        timeAxisEl.className = "wg-timeaxis";
        gridEl.append(timeAxisEl);

        const dayColEls = [];
        const entryElsByKey = new Map();
        const keyToIndexByDay = Array.from({ length: 7 }, () => new Map());
        const dayKeys = Array.from({ length: 7 }, () => []);
        const gapButtonEls = [];

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
        this.weekDom = {
            days,
            dayColEls,
            dayHeaderEls,
            dayKeys,
            entryElsByKey,
            gapButtonEls,
            gridEl,
            keyToIndexByDay,
            metrics: null,
            timeAxisEl,
        };
        this.applyDayWindow();

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
                    (a.entry?.projectKey || "").localeCompare(b.entry?.projectKey || "") ||
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
                const projectLabel = this.store.getAssignmentLabel(entry.projectKey, entry.sectionKey) || "No project";
                const description = entry.description || "";

                dayKeys[dayIdx].push(seg.key);
                keyToIndexByDay[dayIdx].set(seg.key, idx);

                const el = document.createElement("div");
                el.className = "entry-block";
                if (this.isEntryDirty(entry)) {
                    el.classList.add("is-dirty");
                }
                el.dataset.key = seg.key;
                el.dataset.entryId = String(entry.id || "");
                el.dataset.dayIdx = String(dayIdx);
                el.dataset.start = String(seg.startMinutes);
                el.dataset.end = String(seg.endMinutes);

                const colors = this.projectColors(entry.projectKey, entry.sectionKey);
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
                const contentEl = document.createElement("div");
                contentEl.className = "entry-content";
                contentEl.append(projectEl, descEl);
                el.append(contentEl, timeEl);
                contentEl.addEventListener("pointerdown", (ev) => {
                    if (this.editMode !== "normal") return;
                    if (ev.pointerType === "mouse" && ev.button !== 0) return;
                    this.selectRenderedSegment(dayIdx, seg.key);
                    this.startEntryPointerEdit(ev, Number(entry.id), "move", el);
                });
                this.appendEntryPointerControls(el, seg, dateStr);

                el.title = `${dateStr} ${minutesToHHMM(seg.startMinutes)}–${minutesToHHMM(seg.endMinutes)} • ${projectLabel}${
                    description ? ` • ${description}` : ""
                }`;

                el.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    if (performance.now() < this.suppressEntryClickUntil) return;
                    if (this.editMode === "split" && this.selectedEntryId === Number(entry.id)) {
                        this.splitEntryFromPointer(ev, seg, el);
                        return;
                    }
                    this.focusedDayIndex = dayIdx;
                    const idxInDay = keyToIndexByDay[dayIdx].get(seg.key);
                    if (typeof idxInDay === "number") this.focusedEntryIndexByDay[dayIdx] = idxInDay;
                    this.applyWeekFocusAndSelection();
                    this.scrollWeekFocusIntoView();
                    this.weekScrollEl.focus();
                });
                el.addEventListener("dblclick", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (this.editMode !== "normal" || this.busy || this.saveInFlight) return;
                    this.selectRenderedSegment(dayIdx, seg.key);
                    this.openEntryDialog(Number(entry.id));
                });

                dayColEls[dayIdx].append(el);
                entryElsByKey.set(seg.key, el);
            }

            this.appendGapButtons(dayIdx, dateStr, segs, gapButtonEls);
        }

        this.weekScrollEl.scrollTop = prevScrollTop;
        this.weekScrollEl.scrollLeft = prevScrollLeft;
        this.updateGapButtonPositions();
        this.applyDayWindow();
        this.applyWeekFocusAndSelection();
        this.updateCursorLine();
        this.updateAddDraftPreview();
        this.scrollWeekFocusIntoView();
        this.updateEditorBadge();
        this.updateNowMarker();
        if (this.appState.activeTab === "week" && !this.weekViewSection.hidden) {
            this.startNowTimer();
        }

        this.latestWeekBtn.disabled =
            this.busy || Boolean(this.appState.latestWeekStart && this.appState.latestWeekStart === weekStart);
    }

    /**
     * Creates a compact SVG icon used by pointer-edit controls.
     * Icons are assembled from fixed paths rather than HTML strings, keeping dynamic entry content separate from UI markup.
     * @param {"edit" | "trash" | "split" | "plus"} name
     * @returns {SVGSVGElement}
     */
    createControlIcon(name) {
        const namespace = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(namespace, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");

        /**
         * Appends one stroked path to the icon.
         * @param {string} d
         * @returns {void}
         */
        const addPath = (d) => {
            const path = document.createElementNS(namespace, "path");
            path.setAttribute("d", d);
            svg.append(path);
        };
        if (name === "edit") {
            addPath("M4 20h4L19 9l-4-4L4 16v4");
            addPath("m13.5 6.5 4 4");
        } else if (name === "trash") {
            addPath("M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5");
        } else if (name === "split") {
            addPath("M7 4v5c0 2 2 3 5 3s5 1 5 3v5M17 4v5c0 2-2 3-5 3s-5 1-5 3v5");
        } else {
            addPath("M12 5v14M5 12h14");
        }
        return svg;
    }

    /**
     * Builds one icon-only entry action with a full accessible label.
     * @param {"edit" | "trash" | "split" | "plus"} icon
     * @param {string} label
     * @param {string} className
     * @returns {HTMLButtonElement}
     */
    createEntryControlButton(icon, label, className) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className;
        button.setAttribute("aria-label", label);
        button.title = label;
        button.append(this.createControlIcon(icon));
        return button;
    }

    /**
     * Selects one rendered segment and updates the day-level keyboard focus index.
     * Pointer controls call this before mutation so undo metadata and post-edit focus match ordinary entry clicks.
     * @param {number} dayIdx
     * @param {string} segmentKey
     * @returns {void}
     */
    selectRenderedSegment(dayIdx, segmentKey) {
        if (!this.weekDom) return;
        this.focusedDayIndex = Math.max(0, Math.min(6, dayIdx));
        const idxInDay = this.weekDom.keyToIndexByDay[dayIdx]?.get(segmentKey);
        if (typeof idxInDay === "number") {
            this.focusedEntryIndexByDay[dayIdx] = idxInDay;
        }
        this.applyWeekFocusAndSelection();
    }

    /**
     * Adds boundary resize handles and a side action rail to an editable entry segment.
     * The entry content itself is the move surface; boundary handles are shown only on the segment containing the real start or end of a multi-day entry.
     * @param {HTMLElement} entryEl
     * @param {import("./store.js").Segment} segment
     * @param {string} dayStr
     * @returns {void}
     */
    appendEntryPointerControls(entryEl, segment, dayStr) {
        const entry = segment.entry;
        if (!entry || entry.weekStart !== this.appState.weekStart) return;
        if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
        if (!(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) return;

        const dayIdx = Number.parseInt(entryEl.dataset.dayIdx || "-1", 10);
        const segmentStartMs = this.timeContext.dateFromLocalDayMinutes(dayStr, segment.startMinutes).getTime();
        const segmentEndMs = this.timeContext.dateFromLocalDayMinutes(dayStr, segment.endMinutes).getTime();
        const ownsStartBoundary = Math.abs(entry.startDate.getTime() - segmentStartMs) < 60_000;
        const ownsEndBoundary = Math.abs(entry.endDate.getTime() - segmentEndMs) < 60_000;

        if (ownsStartBoundary) {
            const startHandle = document.createElement("button");
            startHandle.type = "button";
            startHandle.className = "entry-resize-handle entry-resize-start";
            startHandle.setAttribute("aria-label", "Drag entry start");
            startHandle.title = "Drag start";
            startHandle.addEventListener("click", (ev) => ev.stopPropagation());
            startHandle.addEventListener("pointerdown", (ev) => {
                this.selectRenderedSegment(dayIdx, segment.key);
                this.startEntryPointerEdit(ev, Number(entry.id), "start", entryEl);
            });
            entryEl.append(startHandle);
        }

        if (ownsEndBoundary) {
            const endHandle = document.createElement("button");
            endHandle.type = "button";
            endHandle.className = "entry-resize-handle entry-resize-end";
            endHandle.setAttribute("aria-label", "Drag entry end");
            endHandle.title = "Drag end";
            endHandle.addEventListener("click", (ev) => ev.stopPropagation());
            endHandle.addEventListener("pointerdown", (ev) => {
                this.selectRenderedSegment(dayIdx, segment.key);
                this.startEntryPointerEdit(ev, Number(entry.id), "end", entryEl);
            });
            entryEl.append(endHandle);
        }

        const actions = document.createElement("div");
        actions.className = "entry-action-rail";
        const editButton = this.createEntryControlButton("edit", "Edit entry", "entry-control");
        editButton.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.selectRenderedSegment(dayIdx, segment.key);
            this.openEntryDialog(Number(entry.id));
        });
        const splitButton = this.createEntryControlButton("split", "Split entry", "entry-control");
        splitButton.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.selectRenderedSegment(dayIdx, segment.key);
            this.enterSplitMode();
            if (this.editMode === "split") {
                this.onToast("Tap the desired split point inside the entry.", 3000, "success");
            }
        });
        const deleteButton = this.createEntryControlButton("trash", "Delete entry", "entry-control entry-delete-control");
        deleteButton.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.selectRenderedSegment(dayIdx, segment.key);
            this.deleteSelectedEntry();
            this.focusTimeline();
        });
        actions.append(editButton, splitButton, deleteButton);
        entryEl.append(actions);
    }

    /**
     * Adds subtle buttons for every free range in a day.
     * An entirely empty day receives one central control for an 08:00–09:00 entry; other controls create one hour adjacent to an existing entry, or the complete gap when it is shorter.
     * Leading and trailing gap controls carry their full free-range bounds so scrolling can keep them inside the visible part of long edge gaps.
     * @param {number} dayIdx
     * @param {string} dayStr
     * @param {Array<import("./store.js").Segment>} segments
     * @param {HTMLButtonElement[]} output
     * @returns {void}
     */
    appendGapButtons(dayIdx, dayStr, segments, output) {
        if (!this.weekDom) return;
        const gaps = buildDayGaps(segments);
        const ranges =
            segments.length === 0
                ? [
                      {
                          gapStartMinutes: 0,
                          gapEndMinutes: 1440,
                          startMinutes: 8 * 60,
                          endMinutes: 9 * 60,
                          midpoint: 12 * 60,
                          empty: true,
                          pinToViewport: false,
                      },
                  ]
                : gaps.map((gap) => {
                      const entryRange = calculateDefaultGapEntryRange(gap.startMinutes, gap.endMinutes);
                      return {
                          gapStartMinutes: gap.startMinutes,
                          gapEndMinutes: gap.endMinutes,
                          startMinutes: entryRange.startMinutes,
                          endMinutes: entryRange.endMinutes,
                          midpoint: (gap.startMinutes + gap.endMinutes) / 2,
                          empty: false,
                          pinToViewport: gap.startMinutes === 0 || gap.endMinutes === 1440,
                      };
                  });

        for (const range of ranges) {
            if (range.endMinutes - range.startMinutes < MIN_ENTRY_MINUTES) continue;
            const intervalLabel = `${minutesToHHMM(range.startMinutes)}–${minutesToHHMM(range.endMinutes)}`;
            const button = this.createEntryControlButton(
                "plus",
                `Add ${intervalLabel} entry on ${dayStr}`,
                `entry-gap-add${range.empty ? " is-empty-day" : ""}`,
            );
            button.dataset.midpoint = String(range.midpoint);
            button.dataset.gapStart = String(range.gapStartMinutes);
            button.dataset.gapEnd = String(range.gapEndMinutes);
            button.dataset.pinToViewport = String(range.pinToViewport);
            button.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this.focusedDayIndex = dayIdx;
                this.addEntryForGap(dayStr, range.startMinutes, range.endMinutes);
            });
            const pxPerMinute = this.weekDom.metrics?.pxPerMinute || 1;
            button.style.top = `${range.midpoint * pxPerMinute}px`;
            this.weekDom.dayColEls[dayIdx].append(button);
            output.push(button);
        }
    }

    /**
     * Converts a pointer tap inside the selected segment into a snapped split timestamp.
     * The existing split transaction performs minimum-duration validation and selects the newly created second half.
     * @param {MouseEvent} ev
     * @param {import("./store.js").Segment} segment
     * @param {HTMLElement} entryEl
     * @returns {void}
     */
    splitEntryFromPointer(ev, segment, entryEl) {
        if (!this.weekDom?.metrics || !this.selectedEntryId) return;
        const dayIdx = Number.parseInt(entryEl.dataset.dayIdx || "-1", 10);
        const dayStr = this.weekDom.days[dayIdx];
        if (!dayStr) return;

        const colRect = this.weekDom.dayColEls[dayIdx].getBoundingClientRect();
        const rawMinutes = (ev.clientY - colRect.top) / this.weekDom.metrics.pxPerMinute;
        const snappedMinutes = Math.max(0, Math.min(1440, Math.round(rawMinutes / MIN_ENTRY_MINUTES) * MIN_ENTRY_MINUTES));
        const entry = this.store.getEntryById(this.selectedEntryId);
        if (!entry?.startDate || !entry?.endDate) return;
        const minMs = entry.startDate.getTime() + MIN_ENTRY_MS;
        const maxMs = entry.endDate.getTime() - MIN_ENTRY_MS;
        let splitMs = this.timeContext.dateFromLocalDayMinutes(dayStr, snappedMinutes).getTime();
        splitMs = Math.max(minMs, Math.min(maxMs, splitMs));
        this.cursor = { kind: "split", ms: splitMs };
        this.updateCursorLine();
        this.splitSelectedEntryAtCursor();
    }

    /**
     * Creates a new time entry from a visible free range and opens its details dialog.
     * The range is already non-overlapping, but it still passes through collision resolution for one consistent mutation path.
     * @param {string} dayStr
     * @param {number} startMinutes
     * @param {number} endMinutes
     * @returns {void}
     */
    addEntryForGap(dayStr, startMinutes, endMinutes) {
        const startMs = this.timeContext.dateFromLocalDayMinutes(dayStr, startMinutes).getTime();
        const endMs = this.timeContext.dateFromLocalDayMinutes(dayStr, endMinutes).getTime();
        const id = this.createEntryAt(startMs, endMs);
        if (id && this.store.getEntryById(id)) {
            this.openEntryDialog(id);
        }
    }

    /**
     * Creates one blank entry at an explicit interval and records a normal undoable add action.
     * @param {number} startMs
     * @param {number} endMs
     * @returns {number | null}
     */
    createEntryAt(startMs, endMs) {
        if (this.busy || this.saveInFlight) {
            this.onToast("Saving in progress…");
            return null;
        }
        const weekStart = this.appState.weekStart;
        const bounds = this.timeContext.weekBoundsMs(weekStart);
        if (!weekStart || !bounds) return null;
        if (startMs < bounds.startMs || endMs > bounds.endMs) {
            this.onToast("Cannot create entry outside the current week.");
            return null;
        }
        if (endMs - startMs < MIN_ENTRY_MS) {
            this.onToast("Entry shorter than 15 minutes.");
            return null;
        }

        const id = this.store.reserveEntryId();
        this.applyWeekEdit({
            weekStart,
            label: "add",
            focusAfter: id,
            getAfterRaw: () => {
                const week = this.store.buildWeekSchedule(weekStart);
                const newRaw = this.makeNewRawEntry({ id, startMs, endMs });
                week.nodes.push({ id, startMs, endMs, editable: true, raw: newRaw });
                this.resolveNonOverlapping(week.nodes, id, week.bounds);
                return this.weekRawFromNodes(week.nodes);
            },
        });
        return this.store.getEntryById(id) ? id : null;
    }

    /**
     * Begins a pointer gesture for start resize, end resize, or whole-entry movement.
     * No store mutation occurs until pointerup, keeping a drag to one undo action and avoiding repeated schedule rebuilds.
     * @param {PointerEvent} ev
     * @param {number} entryId
     * @param {"start" | "end" | "move"} kind
     * @param {HTMLElement} sourceEntryEl
     * @returns {void}
     */
    startEntryPointerEdit(ev, entryId, kind, sourceEntryEl) {
        if (this.busy || this.saveInFlight || !this.weekDom?.metrics) return;
        const entry = this.store.getEntryById(entryId);
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (!entry || !bounds || entry.weekStart !== this.appState.weekStart) return;
        if (!(entry.startDate instanceof Date) || !(entry.endDate instanceof Date)) return;

        ev.preventDefault();
        ev.stopPropagation();
        if (ev.currentTarget instanceof Element && typeof ev.currentTarget.setPointerCapture === "function") {
            try {
                ev.currentTarget.setPointerCapture(ev.pointerId);
            } catch {
                // Window-level listeners still complete the gesture when capture is unavailable.
            }
        }
        this.pointerEdit = {
            pointerId: ev.pointerId,
            pointerType: ev.pointerType,
            kind,
            entryId,
            segmentKey: sourceEntryEl.dataset.key || "",
            startClientX: ev.clientX,
            startClientY: ev.clientY,
            maxPointerTravel: 0,
            originalStartMs: entry.startDate.getTime(),
            originalEndMs: entry.endDate.getTime(),
            candidateStartMs: entry.startDate.getTime(),
            candidateEndMs: entry.endDate.getTime(),
            sourceEntryEl,
            bounds,
        };
        document.body.classList.add("is-entry-dragging");
        document.body.classList.toggle("is-entry-moving", kind === "move");
    }

    /**
     * Updates the visual preview for an active pointer gesture using the current timeline scale.
     * Collision resolution remains deferred until pointerup, so pointermove touches only DOM for the selected entry.
     * @param {PointerEvent} ev
     * @returns {void}
     */
    handleEntryPointerMove(ev) {
        const gesture = this.pointerEdit;
        if (!gesture || ev.pointerId !== gesture.pointerId || !this.weekDom?.metrics) return;
        ev.preventDefault();
        gesture.maxPointerTravel = Math.max(
            gesture.maxPointerTravel,
            Math.hypot(ev.clientX - gesture.startClientX, ev.clientY - gesture.startClientY),
        );
        const deltaMinutes = (ev.clientY - gesture.startClientY) / this.weekDom.metrics.pxPerMinute;
        const candidate = calculatePointerEditTimes(
            gesture.kind,
            gesture.originalStartMs,
            gesture.originalEndMs,
            deltaMinutes * 60_000,
            gesture.bounds,
        );
        gesture.candidateStartMs = candidate.startMs;
        gesture.candidateEndMs = candidate.endMs;
        this.previewPointerEdit(gesture.entryId, candidate.startMs, candidate.endMs);
    }

    /**
     * Repositions only the dragged entry's visible segments during pointermove.
     * Other entries remain untouched until the normal collision resolver commits the edit.
     * @param {number} entryId
     * @param {number} startMs
     * @param {number} endMs
     * @returns {void}
     */
    previewPointerEdit(entryId, startMs, endMs) {
        if (!this.weekDom?.metrics) return;
        for (const el of this.weekDom.entryElsByKey.values()) {
            if (Number(el.dataset.entryId) !== entryId) continue;
            const dayIdx = Number.parseInt(el.dataset.dayIdx || "-1", 10);
            const dayStr = this.weekDom.days[dayIdx];
            if (!dayStr) continue;
            const dayStartMs = this.timeContext.dateFromLocalDayMinutes(dayStr, 0).getTime();
            const dayEndMs = this.timeContext.dateFromLocalDayMinutes(dayStr, 1440).getTime();
            const visibleStartMs = Math.max(startMs, dayStartMs);
            const visibleEndMs = Math.min(endMs, dayEndMs);
            if (visibleEndMs <= visibleStartMs) {
                el.style.visibility = "hidden";
                continue;
            }
            el.style.visibility = "";
            const startMinutes = visibleStartMs <= dayStartMs ? 0 : hhmmToMinutes(this.timeContext.formatTime(new Date(visibleStartMs))) ?? 0;
            const endMinutes = visibleEndMs >= dayEndMs ? 1440 : hhmmToMinutes(this.timeContext.formatTime(new Date(visibleEndMs))) ?? 1440;
            el.style.top = `${startMinutes * this.weekDom.metrics.pxPerMinute}px`;
            el.style.height = `${Math.max(1, (endMinutes - startMinutes) * this.weekDom.metrics.pxPerMinute)}px`;
            const timesEl = el.querySelector(".entry-times");
            if (timesEl instanceof HTMLElement) {
                timesEl.textContent = `${this.timeContext.formatTime(new Date(startMs))}–${this.timeContext.formatTime(new Date(endMs))}`;
            }
        }
    }

    /**
     * Records a completed touch/pen tap and opens the editor when it completes a nearby second tap on the same segment.
     * Mouse users continue through the native dblclick path, while suppressing the compatibility click after a recognized touch double-tap prevents focus from returning behind the modal dialog.
     * @param {{pointerType: string, entryId: number, segmentKey: string, sourceEntryEl: HTMLElement}} gesture
     * @param {PointerEvent} ev
     * @returns {boolean} Whether the entry editor was opened.
     */
    handleEntryTap(gesture, ev) {
        const pointerType = gesture.pointerType || ev.pointerType;
        if (pointerType === "mouse") return false;
        const currentTap = {
            entryId: gesture.entryId,
            segmentKey: gesture.segmentKey,
            at: performance.now(),
            x: ev.clientX,
            y: ev.clientY,
        };
        const isDoubleTap = isMatchingEntryDoubleTap(this.lastEntryTap, currentTap);
        this.lastEntryTap = isDoubleTap ? null : currentTap;
        if (!isDoubleTap || this.editMode !== "normal" || this.busy || this.saveInFlight) return false;

        this.suppressEntryClickUntil = performance.now() + 500;
        const dayIdx = Number.parseInt(gesture.sourceEntryEl.dataset.dayIdx || "-1", 10);
        if (dayIdx >= 0 && gesture.segmentKey) {
            this.selectRenderedSegment(dayIdx, gesture.segmentKey);
        }
        this.openEntryDialog(gesture.entryId);
        return this.entryDialog.open;
    }

    /**
     * Commits an active pointer gesture as one editor transaction.
     * Neighbor compression/movement, dirty tracking, durable drafts, and undo history are delegated to the existing edit pipeline.
     * @param {PointerEvent} ev
     * @returns {void}
     */
    finishEntryPointerEdit(ev) {
        const gesture = this.pointerEdit;
        if (!gesture || ev.pointerId !== gesture.pointerId) return;
        this.pointerEdit = null;
        document.body.classList.remove("is-entry-dragging");
        document.body.classList.remove("is-entry-moving");
        if (
            gesture.candidateStartMs === gesture.originalStartMs &&
            gesture.candidateEndMs === gesture.originalEndMs
        ) {
            this.restoreEntryPointerPreview(gesture.entryId);
            const isEntryTap = gesture.kind === "move" && gesture.maxPointerTravel <= ENTRY_TAP_MOVE_TOLERANCE_PX;
            const openedEditor = isEntryTap ? this.handleEntryTap(gesture, ev) : false;
            if (!isEntryTap) this.lastEntryTap = null;
            if (!openedEditor) this.focusTimeline();
            return;
        }
        this.lastEntryTap = null;
        this.suppressEntryClickUntil = performance.now() + 500;
        this.setSelectedEntryTimes(
            gesture.candidateStartMs,
            gesture.candidateEndMs,
            gesture.kind === "move" ? "move" : "resize",
        );
        this.focusTimeline();
    }

    /**
     * Abandons a pointer gesture and restores the store-backed rendering.
     * @param {PointerEvent} ev
     * @returns {void}
     */
    cancelEntryPointerEdit(ev) {
        const gesture = this.pointerEdit;
        if (!gesture || ev.pointerId !== gesture.pointerId) return;
        this.abortEntryPointerEdit();
        this.focusTimeline();
    }

    /**
     * Drops an active pointer preview without committing it and restores the store-backed entry geometry.
     * Touch pinch initialization also uses this helper when its first finger happened to begin on an entry.
     * @returns {void}
     */
    abortEntryPointerEdit() {
        if (!this.pointerEdit) return;
        const entryId = this.pointerEdit.entryId;
        this.pointerEdit = null;
        document.body.classList.remove("is-entry-dragging");
        document.body.classList.remove("is-entry-moving");
        this.restoreEntryPointerPreview(entryId);
    }

    /**
     * Restores one entry's rendered segments from their immutable layout data after a canceled or zero-distance drag.
     * Avoiding a DOM rebuild preserves touch targets for an emerging pinch gesture and leaves the user's scroll position untouched.
     * @param {number} entryId
     * @returns {void}
     */
    restoreEntryPointerPreview(entryId) {
        if (!this.weekDom?.metrics) return;
        for (const el of this.weekDom.entryElsByKey.values()) {
            if (Number(el.dataset.entryId) !== entryId) continue;
            const startMinutes = Number.parseFloat(el.dataset.start || "0");
            const endMinutes = Number.parseFloat(el.dataset.end || "0");
            el.style.visibility = "";
            el.style.top = `${startMinutes * this.weekDom.metrics.pxPerMinute}px`;
            el.style.height = `${Math.max(1, (endMinutes - startMinutes) * this.weekDom.metrics.pxPerMinute)}px`;
            const timesEl = el.querySelector(".entry-times");
            if (timesEl instanceof HTMLElement) {
                timesEl.textContent = `${minutesToHHMM(startMinutes)}–${minutesToHHMM(endMinutes)}`;
            }
        }
    }

    /**
     * Sets explicit boundaries on the selected entry through the standard collision-aware mutation path.
     * @param {number} startMs
     * @param {number} endMs
     * @param {string} label
     * @returns {void}
     */
    setSelectedEntryTimes(startMs, endMs, label) {
        const entryId = this.selectedEntryId;
        const weekStart = this.appState.weekStart;
        if (!entryId || !weekStart) return;
        this.applyWeekEdit({
            weekStart,
            label,
            focusAfter: entryId,
            getAfterRaw: () => {
                const week = this.store.buildWeekSchedule(weekStart);
                const node = week.nodes.find((candidate) => candidate.id === entryId);
                if (!node) throw new Error("Entry not found.");
                this.ensureEditableNode(node);
                node.startMs = startMs;
                node.endMs = endMs;
                this.ensureEditableNode(node);
                if (node.endMs - node.startMs < MIN_ENTRY_MS) {
                    throw new Error("Entry shorter than 15 minutes.");
                }
                this.enforceEditableBounds(node, week.bounds);
                this.resolveNonOverlapping(week.nodes, entryId, week.bounds);
                return this.weekRawFromNodes(week.nodes);
            },
        });
    }

    /**
     * Returns a cached color pair for one canonical project/section assignment.
     * Part of the week view interaction flow.
     * @param {string | null | undefined} projectKey
     * @param {string | null | undefined} sectionKey
     * @returns {{bg: string, border: string}}
     */
    projectColors(projectKey, sectionKey) {
        const key = `${projectKey || ""}/${sectionKey || ""}`;
        const cached = this.projectColorCache.get(key);
        if (cached) return cached;

        if (!projectKey) {
            const neutral = { bg: "rgba(255, 255, 255, 0.06)", border: "rgba(255, 255, 255, 0.16)" };
            this.projectColorCache.set(key, neutral);
            return neutral;
        }

        const configuredColor = this.store.getAssignmentColor(projectKey, sectionKey);
        if (configuredColor) {
            const rgb = parseHexColor(configuredColor);
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
     * Reports whether an entry differs from the last loaded or successfully saved week snapshot.
     * Overflow segments use the entry's owning week, so every visible segment receives the same dirty styling.
     * @param {import("./model.js").Entry | Object} entry
     * @returns {boolean}
     */
    isEntryDirty(entry) {
        const weekStart = typeof entry?.weekStart === "string" ? entry.weekStart : "";
        const entryId = Number(entry?.id);
        if (!weekStart || !Number.isFinite(entryId)) return false;
        return this.dirtyEntryIdsByWeek.get(weekStart)?.has(entryId) === true;
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
            this.updateVisibleDayCount();
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
        if (this.entryDialog.open || this.weekReqDialog.open) return;
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
        const bounds = this.timeContext.weekBoundsMs(this.appState.weekStart);
        if (bounds && this.cursor.ms === bounds.endMs && this.weekDom?.days?.length) {
            return { dayStr: this.weekDom.days[this.weekDom.days.length - 1], minutes: 1440 };
        }
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
            project_key: null,
            project_id: null,
            section_key: null,
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

        this.rememberCleanWeekBaseline(params.weekStart, before);
        this.store.applyWeekSnapshot(params.weekStart, after);
        this.undoStack.push({
            weekStart: params.weekStart,
            before,
            after,
            label: params.label,
            focusBefore,
            focusAfter: params.focusAfter || null,
        });
        this.redoStack.length = 0;

        this.refreshDirtyWeekState(params.weekStart);
        if (this.appState.weekStart === params.weekStart) {
            this.rebuildWeekView();
        }
        this.setLatestWeekStart(this.store.getLatestWeekStart());
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
        this.rememberCleanWeekBaseline(weekStart, this.store.snapshotWeekRaw(weekStart));
        this.store.applyWeekSnapshot(weekStart, rawEntries);
        this.refreshDirtyWeekState(weekStart);
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
        this.updateTopbarActions();
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
        this.updateTopbarActions();
    }

    /**
     * Finds the manifest blob sha that represents the currently loaded version of a week.
     * New weeks intentionally return an empty sha because they have no persisted chunk yet.
     * @param {string} weekStart
     * @returns {string}
     */
    getManifestShaForWeek(weekStart) {
        const manifest = this.store.getManifest();
        if (!manifest || !weekStart) return "";
        const info = isoWeekInfo(weekStart);
        const chunk = manifest.chunks.find((item) => item.year === info.isoYear && item.week === info.week);
        return chunk ? String(chunk.sha || "") : "";
    }

    /**
     * Captures the last persisted snapshot before the first unsaved edit to a week.
     * Later edits keep the original baseline so undo can accurately return the week to a clean state.
     * @param {string} weekStart
     * @param {Array<Object>} rawEntries
     * @param {string} [baseSha]
     * @returns {void}
     */
    rememberCleanWeekBaseline(weekStart, rawEntries, baseSha = this.getManifestShaForWeek(weekStart)) {
        if (!weekStart || this.cleanWeekSnapshots.has(weekStart)) return;
        this.cleanWeekSnapshots.set(weekStart, cloneJson(rawEntries));
        this.cleanWeekShas.set(weekStart, String(baseSha || ""));
    }

    /**
     * Queues one draft-journal operation behind earlier edits to preserve write order.
     * A single warning is shown when browser durability is unavailable, while editing remains enabled.
     * @param {() => Promise<boolean>} operation
     * @param {string} failureMessage
     * @returns {void}
     */
    enqueueDraftOperation(operation, failureMessage) {
        this.draftWriteChain = this.draftWriteChain
            .catch(() => undefined)
            .then(async () => {
                let succeeded = false;
                try {
                    succeeded = await operation();
                } catch {
                    succeeded = false;
                }
                if (!succeeded && !this.draftWarningShown) {
                    this.draftWarningShown = true;
                    this.onToast(failureMessage, 5000);
                }
            });
    }

    /**
     * Stores the current dirty week together with the clean snapshot used for comparison and merging.
     * Values are cloned when queued so later keyboard edits cannot mutate an in-flight IndexedDB write.
     * @param {string} weekStart
     * @returns {void}
     */
    queueDraftWrite(weekStart) {
        const namespace = this.draftNamespace;
        const baseline = this.cleanWeekSnapshots.get(weekStart);
        if (!namespace || !baseline) return;
        const draft = {
            weekStart,
            baseSha: this.cleanWeekShas.get(weekStart) || "",
            baseEntriesRaw: cloneJson(baseline),
            entriesRaw: cloneJson(this.store.snapshotWeekRaw(weekStart)),
            updatedAt: Date.now(),
        };
        this.enqueueDraftOperation(
            () => this.draftJournal.putWeekDraft(namespace, draft),
            "Browser draft storage is unavailable; unsaved edits may not survive a reload.",
        );
    }

    /**
     * Removes a durable week draft after its entries are clean or have been saved successfully.
     * The namespace is captured immediately so a later login cannot delete another repository's draft.
     * @param {string} weekStart
     * @returns {void}
     */
    queueDraftDelete(weekStart) {
        const namespace = this.draftNamespace;
        if (!namespace || !weekStart) return;
        this.enqueueDraftOperation(
            () => this.draftJournal.deleteWeekDraft(namespace, weekStart),
            "The saved browser draft could not be cleaned up.",
        );
    }

    /**
     * Waits for all draft writes currently queued by synchronous editor commands.
     * Reload and save flows use this barrier so the latest keystroke is durable before data is replaced.
     * @returns {Promise<void>}
     */
    async flushDraftWrites() {
        await this.draftWriteChain.catch(() => undefined);
    }

    /**
     * Recomputes dirty entries for one week by comparing it with the persisted baseline.
     * Returning to the baseline clears both visual state and the IndexedDB draft automatically.
     * @param {string} weekStart
     * @param {boolean} [persist]
     * @returns {boolean}
     */
    refreshDirtyWeekState(weekStart, persist = true) {
        const baseline = this.cleanWeekSnapshots.get(weekStart);
        if (!baseline) return false;
        const current = this.store.snapshotWeekRaw(weekStart);
        const changed = changedEntryIds(baseline, current);

        if (changed.size === 0) {
            this.dirtyWeekStarts.delete(weekStart);
            this.dirtyEntryIdsByWeek.delete(weekStart);
            this.cleanWeekSnapshots.delete(weekStart);
            this.cleanWeekShas.delete(weekStart);
            if (persist) this.queueDraftDelete(weekStart);
            this.updateEditorBadge();
            return false;
        }

        this.dirtyWeekStarts.add(weekStart);
        this.dirtyEntryIdsByWeek.set(weekStart, changed);
        if (persist) this.queueDraftWrite(weekStart);
        this.updateEditorBadge();
        return true;
    }

    /**
     * Merges an unsaved browser snapshot onto a newer loaded week using its original baseline.
     * Remote-only changes are preserved, local changes win conflicts, and colliding new ids are reassigned.
     * @param {Array<Object>} baseline
     * @param {Array<Object>} localDraft
     * @param {Array<Object>} remoteCurrent
     * @returns {Array<Object>}
     */
    mergeDraftEntries(baseline, localDraft, remoteCurrent) {
        const baselineById = rawEntriesById(baseline);
        const localById = rawEntriesById(localDraft);
        const remoteById = rawEntriesById(remoteCurrent);
        const ids = Array.from(new Set([...baselineById.keys(), ...localById.keys(), ...remoteById.keys()])).sort((a, b) => a - b);
        const merged = [];

        for (const id of ids) {
            const baseRaw = baselineById.get(id);
            const localRaw = localById.get(id);
            const remoteRaw = remoteById.get(id);

            if (!baseRaw && localRaw && remoteRaw && !rawEntriesEqual(localRaw, remoteRaw)) {
                merged.push(cloneJson(remoteRaw));
                const reassigned = cloneJson(localRaw);
                reassigned.id = this.store.reserveEntryId();
                merged.push(reassigned);
                continue;
            }

            const localChanged = !rawEntriesEqual(baseRaw, localRaw);
            const selected = localChanged ? localRaw : remoteRaw;
            if (selected) merged.push(cloneJson(selected));
        }

        merged.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")) || Number(a.id || 0) - Number(b.id || 0));
        return merged;
    }

    /**
     * Restores every durable draft for the active data source after fresh repository data has loaded.
     * Obsolete drafts are deleted; drafts based on older blobs are merged without dropping remote additions.
     * @returns {Promise<{restored: number, merged: number}>}
     */
    async restoreDrafts() {
        await this.flushDraftWrites();
        if (!this.draftNamespace) return { restored: 0, merged: 0 };
        const drafts = await this.draftJournal.getWeekDrafts(this.draftNamespace);
        let restored = 0;
        let mergedCount = 0;

        for (const draft of drafts) {
            const weekStart = String(draft.weekStart || "");
            if (!this.timeContext.weekBoundsMs(weekStart)) continue;
            const remoteCurrent = this.store.snapshotWeekRaw(weekStart);
            const localDraft = Array.isArray(draft.entriesRaw) ? draft.entriesRaw : [];

            if (rawWeekSnapshotsEqual(remoteCurrent, localDraft)) {
                await this.draftJournal.deleteWeekDraft(this.draftNamespace, weekStart);
                continue;
            }

            const currentSha = this.getManifestShaForWeek(weekStart);
            const baseline = Array.isArray(draft.baseEntriesRaw) ? draft.baseEntriesRaw : [];
            const baseStillCurrent = currentSha === String(draft.baseSha || "") || rawWeekSnapshotsEqual(remoteCurrent, baseline);
            const restoredEntries = baseStillCurrent
                ? cloneJson(localDraft)
                : this.mergeDraftEntries(baseline, localDraft, remoteCurrent);

            this.rememberCleanWeekBaseline(weekStart, remoteCurrent, currentSha);
            this.store.applyWeekSnapshot(weekStart, restoredEntries);
            if (this.refreshDirtyWeekState(weekStart)) {
                restored += 1;
                if (!baseStillCurrent) mergedCount += 1;
            }
        }

        this.store.recomputeNextEntryId();
        await this.flushDraftWrites();
        if (restored > 0) {
            const mergedLabel = mergedCount > 0 ? `; merged newer data in ${mergedCount}` : "";
            this.onToast(`Restored unsaved edits for ${restored} week(s)${mergedLabel}.`, 5000, "success");
            this.onSearchDirty();
        }
        return { restored, merged: mergedCount };
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
            await this.flushDraftWrites();
            await this.saveWeeks(sortedWeeks);
            for (const ws of sortedWeeks) {
                this.dirtyWeekStarts.delete(ws);
                this.dirtyEntryIdsByWeek.delete(ws);
                this.cleanWeekSnapshots.delete(ws);
                this.cleanWeekShas.delete(ws);
                this.queueDraftDelete(ws);
            }
            await this.flushDraftWrites();
            if (this.appState.weekStart) this.rebuildWeekView();
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
     * Formats a signed duration string for week delta labels.
     * Keeps under/over-time output compact and consistent.
     * @param {number} seconds
     * @returns {string}
     */
    formatSignedDuration(seconds) {
        const num = Number(seconds);
        if (!Number.isFinite(num)) {
            return "—";
        }
        const sign = num < 0 ? "-" : "+";
        return `${sign}${formatDuration(Math.abs(num))}`;
    }

    /**
     * Formats required-hours values with trimmed decimal precision.
     * Keeps top-bar labels concise for fractional-hour targets.
     * @param {number} hours
     * @returns {string}
     */
    formatRequiredHours(hours) {
        const num = Number(hours);
        if (!Number.isFinite(num) || num < 0) return "0";
        const rounded = Math.round(num * 100) / 100;
        return String(rounded).replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");
    }

    /**
     * Collects week accounting values using today's date as the cutoff for the current week.
     * One data shape feeds both the compact top-bar control and the detailed requirements dialog.
     * @param {string} weekStart
     * @returns {{
     *     billableSeconds: number,
     *     configuredRequiredHours: number,
     *     dueRequiredHours: number,
     *     weekDeltaSeconds: number,
     *     accumulatedSeconds: number,
     *     comment: string,
     *     requirementText: string
     * }}
     */
    getWeekSummaryData(weekStart) {
        const today = this.timeContext.formatDate(new Date());
        const configuredRequiredHours = this.store.getWeekRequiredHours(weekStart);
        const dueRequiredHours = this.store.getRequiredHoursThroughDate(weekStart, today);
        const billableSeconds = this.store.getWeekBillableSecondsThroughDate(weekStart, today);
        const weekDeltaSeconds = this.store.getWeekBalanceSeconds(weekStart, today);
        const accumulatedSeconds = this.store.getAccumulatedBalanceSeconds(weekStart, today);
        const comment = this.store.getWeekComment(weekStart);
        const configuredText = this.formatRequiredHours(configuredRequiredHours);
        const dueText = this.formatRequiredHours(dueRequiredHours);
        const requirementText =
            dueRequiredHours < configuredRequiredHours ? `Due ${dueText}/${configuredText}h` : `Required ${configuredText}h`;
        return {
            billableSeconds,
            configuredRequiredHours,
            dueRequiredHours,
            weekDeltaSeconds,
            accumulatedSeconds,
            comment,
            requirementText,
        };
    }

    /**
     * Updates the compact overtime button in the top bar.
     * Detailed billable and requirement values deliberately live in the dialog, leaving only total balance, trend, and this week's delta here.
     * @param {string | null} weekStart
     * @returns {void}
     */
    updateWeekSummary(weekStart) {
        if (!this.weekBillableEl) return;
        if (!weekStart) {
            this.weekBillableEl.replaceChildren();
            this.weekReqBtn.removeAttribute("aria-label");
            this.weekReqSummaryEl.replaceChildren();
            return;
        }

        const summary = this.getWeekSummaryData(weekStart);
        const directionIcon =
            summary.weekDeltaSeconds > 0
                ? "trending_up"
                : summary.weekDeltaSeconds < 0
                  ? "trending_down"
                  : "trending_flat";
        const tone = summary.weekDeltaSeconds > 0 ? "is-positive" : summary.weekDeltaSeconds < 0 ? "is-negative" : "is-neutral";

        const totalEl = document.createElement("span");
        totalEl.className = "overtime-total";
        totalEl.textContent = `€ ${this.formatSignedDuration(summary.accumulatedSeconds)}`;
        const directionEl = document.createElement("span");
        directionEl.className = `overtime-direction ${tone}`;
        directionEl.append(createMaterialIcon(directionIcon, "app-icon overtime-direction-icon"));
        directionEl.setAttribute("aria-hidden", "true");
        const deltaEl = document.createElement("span");
        deltaEl.className = `overtime-week ${tone}`;
        deltaEl.textContent = this.formatSignedDuration(summary.weekDeltaSeconds);
        this.weekBillableEl.replaceChildren(totalEl, directionEl, deltaEl);

        const fullSummary = [
            `Billable ${formatDuration(summary.billableSeconds)}`,
            summary.requirementText,
            `Week ${this.formatSignedDuration(summary.weekDeltaSeconds)}`,
            `Total ${this.formatSignedDuration(summary.accumulatedSeconds)}`,
        ];
        if (summary.comment) fullSummary.push(summary.comment);
        const summaryText = fullSummary.join(" • ");
        this.weekReqBtn.setAttribute("aria-label", `${summaryText}. Edit required hours.`);
        this.weekReqBtn.title = `${summaryText} • Edit required hours`;
        this.renderWeekRequirementsSummary(summary);
    }

    /**
     * Renders detailed accounting rows inside the week requirements dialog.
     * @param {{
     *     billableSeconds: number,
     *     weekDeltaSeconds: number,
     *     accumulatedSeconds: number,
     *     requirementText: string
     * }} summary
     * @returns {void}
     */
    renderWeekRequirementsSummary(summary) {
        const rows = [
            ["Billable through current day", formatDuration(summary.billableSeconds)],
            ["Requirement", summary.requirementText],
            ["This week", this.formatSignedDuration(summary.weekDeltaSeconds)],
            ["Accumulated overtime", this.formatSignedDuration(summary.accumulatedSeconds)],
        ];
        const elements = rows.map(([label, value]) => {
            const row = document.createElement("div");
            row.className = "week-requirements-row";
            const labelEl = document.createElement("span");
            labelEl.textContent = label;
            const valueEl = document.createElement("strong");
            valueEl.textContent = value;
            row.append(labelEl, valueEl);
            return row;
        });
        this.weekReqSummaryEl.replaceChildren(...elements);
    }

    /**
     * Opens the week requirements dialog for the active week.
     * Lets the user set required hours and an optional note.
     * @returns {void}
     */
    openWeekRequirementsDialog() {
        const weekStart = this.appState.weekStart;
        if (!weekStart) {
            this.onToast("No week selected.");
            return;
        }

        const info = isoWeekInfo(weekStart);
        this.weekReqMetaEl.textContent = `${info.isoYear}-W${String(info.week).padStart(2, "0")} • ${weekStart}`;
        this.renderWeekRequirementsSummary(this.getWeekSummaryData(weekStart));
        this.weekReqHoursInput.value = this.formatRequiredHours(this.store.getWeekRequiredHours(weekStart));
        this.weekReqCommentInput.value = this.store.getWeekComment(weekStart);

        if (!this.weekReqDialog.open) {
            this.weekReqDialog.showModal();
        }
        queueMicrotask(() => {
            try {
                this.weekReqHoursInput.focus();
                this.weekReqHoursInput.select();
            } catch {
                // ignore
            }
        });
    }

    /**
     * Closes the week requirements dialog.
     * Restores focus to the week timeline.
     * @returns {void}
     */
    closeWeekRequirementsDialog() {
        if (this.weekReqDialog.open) {
            this.weekReqDialog.close();
        }
        queueMicrotask(() => {
            try {
                this.weekScrollEl.focus();
            } catch {
                // ignore
            }
        });
    }

    /**
     * Validates and saves week requirement settings through the save pipeline.
     * Writes data/week-requirements.json in both local and GitHub modes.
     * @param {Event} ev
     * @returns {Promise<void>}
     */
    async handleWeekRequirementsSubmit(ev) {
        ev.preventDefault();
        if (this.saveInFlight) {
            this.onToast("Saving in progress…");
            return;
        }

        const weekStart = this.appState.weekStart;
        if (!weekStart) {
            this.closeWeekRequirementsDialog();
            return;
        }

        const requiredHours = Number.parseFloat(this.weekReqHoursInput.value || "");
        if (!Number.isFinite(requiredHours) || requiredHours < 0 || requiredHours > 168) {
            this.onToast("Required hours must be between 0 and 168.");
            return;
        }

        const comment = this.weekReqCommentInput.value.trim();
        const nowIso = utcNowIso();
        const nextWeekRequirements = this.store.getWeekRequirements().withUpdatedWeek(weekStart, requiredHours, comment, nowIso);
        const fileContent = nextWeekRequirements.toJson();
        const info = isoWeekInfo(weekStart);
        const message = `Update week requirements (${info.isoYear}-W${String(info.week).padStart(2, "0")})`;

        this.onBusy(true);
        try {
            await this.dataSource.saveFiles([{ path: "data/week-requirements.json", content: fileContent }], message);
            this.store.setWeekRequirements(nextWeekRequirements);
            this.updateWeekSummary(weekStart);
            this.closeWeekRequirementsDialog();
            this.onToast("Week requirements saved.", 2400, "success");
        } catch (err) {
            this.onToast(String(err), 5000);
        } finally {
            this.onBusy(false);
        }
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
     * @returns {{projectKey: string | null, sectionKey: string | null, label: string, description: string}[]}
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
        for (let offset = 0; offset < 4; offset += 1) {
            const ws = addIsoDays(weekStart, -7 * offset);
            const week = this.store.getWeek(ws);
            if (!week) continue;
            for (const entry of week.entries) {
                const desc = safeText(entry.description).trim();
                if (!desc) continue;
                if (!desc.toLowerCase().includes(q)) continue;
                const projectKey = entry.projectKey;
                const sectionKey = entry.sectionKey;
                const label = this.store.getAssignmentLabel(projectKey, sectionKey);
                const key = `${projectKey || ""}/${sectionKey || ""}|${desc.toLowerCase()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                suggestions.push({ projectKey, sectionKey, label, description: desc });
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
     * @param {{projectKey: string | null, sectionKey: string | null, label: string, description: string}[]} suggestions
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
            projectEl.textContent = suggestion.label || "No project";

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
     * @param {{projectKey: string | null, sectionKey: string | null, label: string, description: string}} suggestion
     * @returns {void}
     */
    applyDescriptionSuggestion(suggestion) {
        if (!suggestion) return;
        this.entryDescInput.value = suggestion.description || "";
        this.entryAssignmentInput.value = suggestion.label || "";
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

        const selectedKeys = this.store.findAssignmentByLabel(this.entryAssignmentInput.value);
        if (!selectedKeys) {
            this.onToast("Please select a project or section from the list (or clear the field for No project).");
            this.entryAssignmentInput.focus();
            return;
        }
        const { projectKey, sectionKey } = selectedKeys;
        const assignment = this.store.resolveAssignment(projectKey, sectionKey);
        if (!assignment) {
            this.onToast("The selected project or section no longer exists.");
            this.entryAssignmentInput.focus();
            return;
        }
        const description = this.entryDescInput.value.trim();
        const assignmentChanged = entry.projectKey !== projectKey || entry.sectionKey !== sectionKey;
        const billable = assignmentChanged ? assignment.billable : entry.billable;

        this.applyWeekEdit({
            weekStart: this.appState.weekStart,
            label: "details",
            focusAfter: id,
            getAfterRaw: () => {
                const raws = this.store.snapshotWeekRaw(this.appState.weekStart);
                const idx = raws.findIndex((raw) => Number(raw?.id) === id);
                if (idx < 0) throw new Error("Entry not found in this week");
                raws[idx].project_key = projectKey;
                raws[idx].section_key = sectionKey;
                raws[idx].description = description;
                raws[idx].billable = billable;
                raws[idx].updated_at = this.timeContext.formatIsoWithOffset(new Date());
                return raws;
            },
        });

        this.closeEntryDialog();
    }

    /**
     * Deletes the entry currently shown in the editor and closes the dialog after the undoable transaction succeeds.
     * No confirmation is shown because the normal week undo stack retains the complete deleted entry snapshot.
     * @returns {void}
     */
    handleEntryDialogDelete() {
        const entryId = this.dialogEntryId;
        if (!entryId) return;
        if (this.deleteEntryById(entryId)) {
            this.closeEntryDialog();
        }
    }

    /**
     * Builds the entry editor's single searchable project/section combobox.
     * Active root projects and sections share one flat list; an archived assignment remains visible only for the entry already using it.
     * @param {{projectKey?: string | null, sectionKey?: string | null}} options
     * @returns {void}
     */
    populateAssignmentCombobox(options) {
        const selectedProjectKey = options?.projectKey || null;
        const selectedSectionKey = options?.sectionKey || null;
        const selectedLabel = this.store.getAssignmentLabel(selectedProjectKey, selectedSectionKey);

        this.entryAssignmentListEl.innerHTML = "";
        for (const assignment of this.store.getAssignmentOptions()) {
            const isSelected =
                assignment.projectKey === selectedProjectKey && assignment.sectionKey === selectedSectionKey;
            if (assignment.archived && !isSelected) continue;
            const opt = document.createElement("option");
            opt.value = assignment.label;
            opt.label = assignment.archived ? `${assignment.label} (archived)` : assignment.label;
            this.entryAssignmentListEl.append(opt);
        }
        this.entryAssignmentInput.value = selectedLabel.startsWith("[Missing:") ? "" : selectedLabel;
    }

    /**
     * Closes the entry dialog and restores focus to the timeline.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    closeEntryDialog() {
        this.dialogEntryId = null;
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

        this.lastEntryTap = null;
        this.dialogEntryId = id;
        this.populateAssignmentCombobox({
            projectKey: entry.projectKey,
            sectionKey: entry.sectionKey,
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
        let startMs = this.cursor.ms;
        let endMs = startMs + MIN_ENTRY_MS;
        if (this.addDraft) {
            startMs = this.timeContext.dateFromLocalDayMinutes(this.addDraft.dayStr, this.addDraft.startMinutes).getTime();
            endMs = this.timeContext.dateFromLocalDayMinutes(this.addDraft.dayStr, this.addDraft.endMinutes).getTime();
        }
        const id = this.createEntryAt(startMs, endMs);
        if (id) this.openEntryDialog(id);
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
     * Deletes one entry through the shared undoable week-edit pipeline.
     * Both the selected-entry command and the modal editor use this path so dirty tracking, drafts, and undo history remain identical.
     * @param {number} entryId
     * @returns {boolean} Whether the entry was removed from the store.
     */
    deleteEntryById(entryId) {
        const id = Number(entryId);
        if (!Number.isFinite(id)) return false;
        if (this.busy || this.saveInFlight) {
            this.onToast("Saving in progress…");
            return false;
        }
        const weekStart = this.appState.weekStart;
        if (!weekStart) return false;
        const entry = this.store.getEntryById(id);
        if (!entry || entry.weekStart !== weekStart) return false;
        this.lastEntryTap = null;

        this.applyWeekEdit({
            weekStart,
            label: "delete",
            focusAfter: null,
            getAfterRaw: () => {
                const raws = this.store.snapshotWeekRaw(weekStart);
                return raws.filter((raw) => Number(raw?.id) !== id);
            },
        });
        return !this.store.getEntryById(id);
    }

    /**
     * Deletes the currently selected entry from the week.
     * Part of the week view interaction flow.
     * @returns {void}
     */
    deleteSelectedEntry() {
        const entryId = this.selectedEntryId;
        if (!entryId) return;
        this.deleteEntryById(entryId);
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
