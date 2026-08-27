import { allocateExpenseByWeights, createDefaultExpenseCategories } from "./model.js";
import { cloneJson, createMaterialIcon, setVisible, utcNowIso } from "./utils.js";

const EXPENSE_DOCUMENT_NAME = "expenses";

/**
 * @typedef {Object} ExpenseViewElements
 * @property {HTMLElement} expenseView
 * @property {HTMLElement} expenseBalanceStrip
 * @property {HTMLElement} expenseCategoryFilters
 * @property {HTMLElement} expenseList
 * @property {HTMLInputElement} searchInput
 * @property {HTMLButtonElement} expenseAddBtn
 * @property {HTMLButtonElement} expenseSettleBtn
 * @property {HTMLButtonElement} expenseInventoryBtn
 * @property {HTMLButtonElement} editorBadge
 * @property {HTMLDialogElement} expenseDialog
 * @property {HTMLFormElement} expenseForm
 * @property {HTMLElement} expenseDialogTitle
 * @property {HTMLElement} expenseDialogError
 * @property {HTMLButtonElement} expenseCloseBtn
 * @property {HTMLButtonElement} expenseCancelBtn
 * @property {HTMLButtonElement} expenseDeleteBtn
 * @property {HTMLButtonElement} expenseSubmitBtn
 * @property {HTMLInputElement} expenseDescription
 * @property {HTMLInputElement} expenseDate
 * @property {HTMLInputElement} expenseAmount
 * @property {HTMLInputElement} expenseCurrency
 * @property {HTMLInputElement} expenseCategory
 * @property {HTMLDataListElement} expenseCategoryOptions
 * @property {HTMLElement} expenseCategoryHint
 * @property {HTMLButtonElement} expensePayerSummaryBtn
 * @property {HTMLElement} expensePayerSummary
 * @property {HTMLElement} expensePayerSummaryMeta
 * @property {HTMLSelectElement} expensePayer
 * @property {HTMLElement} expensePayerPanel
 * @property {HTMLButtonElement} expensePayerPanelCloseBtn
 * @property {HTMLElement} expensePayerCustomFields
 * @property {HTMLElement} expensePayerRows
 * @property {HTMLElement} expensePayerRemaining
 * @property {HTMLButtonElement} expenseSplitSummaryBtn
 * @property {HTMLElement} expenseSplitSummary
 * @property {HTMLElement} expenseSplitSummaryMeta
 * @property {HTMLElement} expenseSplitPanel
 * @property {HTMLButtonElement} expenseSplitPanelCloseBtn
 * @property {HTMLElement} expenseAllocationChoices
 * @property {HTMLElement} expenseSplitRemaining
 * @property {HTMLElement} expenseOutcome
 * @property {HTMLElement} expenseOutcomeSummary
 * @property {HTMLElement} expenseOutcomeDetails
 * @property {HTMLDetailsElement} expenseAdvancedDetails
 * @property {HTMLInputElement} expenseAssignment
 * @property {HTMLDataListElement} expenseAssignmentList
 * @property {HTMLSelectElement} expenseAllocationType
 * @property {HTMLTextAreaElement} expenseNotes
 * @property {HTMLElement} expenseOwedHeading
 * @property {HTMLElement} expenseSplitRows
 * @property {HTMLDialogElement} expenseSettlementDialog
 * @property {HTMLButtonElement} expenseSettlementCloseBtn
 * @property {HTMLElement} expenseSettlementList
 * @property {HTMLDialogElement} expenseInventoryDialog
 * @property {HTMLFormElement} expenseInventoryForm
 * @property {HTMLElement} expenseInventoryTitle
 * @property {HTMLElement} expenseInventoryMeta
 * @property {HTMLElement} expenseInventoryError
 * @property {HTMLButtonElement} expenseInventoryCloseBtn
 * @property {HTMLButtonElement} expenseInventoryCancelBtn
 * @property {HTMLButtonElement} expenseInventorySubmitBtn
 * @property {HTMLButtonElement} expenseAddParticipantBtn
 * @property {HTMLButtonElement} expenseAddCategoryBtn
 * @property {HTMLElement} expenseParticipantList
 * @property {HTMLElement} expenseCategoryList
 * @property {HTMLElement} expenseInventoryCategoriesSection
 */

/**
 * @typedef {Object} ExpenseViewOptions
 * @property {import("./store.js").ExpenseStore} store
 * @property {import("./store.js").EntryStore} projectStore
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {import("./cache.js").DraftJournal} draftJournal
 * @property {string} draftNamespace
 * @property {import("./utils.js").TimeContext} timeContext
 * @property {import("./locale.js").LocaleService} locale
 * @property {ExpenseViewElements} elements
 * @property {(message: string, timeout?: number, tone?: "error" | "success") => void} onToast
 * @property {(isBusy: boolean) => void} onBusy
 * @property {() => void} onSaved
 * @property {(summary: string) => void} onStatsChanged
 * @property {() => void} [onStateChange]
 */

/**
 * @typedef {Object} ExpenseEditorAction
 * @property {string} label
 * @property {import("./model.js").ExpensesFileRaw} before
 * @property {import("./model.js").ExpensesFileRaw} after
 * @property {string | null} selectionBefore
 * @property {string | null} selectionAfter
 */

/**
 * @typedef {Object} ExpenseVisibleRecord
 * @property {"expense" | "transfer"} kind
 * @property {string} key
 * @property {string} id
 * @property {string} date
 * @property {import("./model.js").Expense | import("./model.js").ExpenseTransfer} model
 */

/**
 * Compares complete normalized expense snapshots without depending on model object identity.
 * Stable model serialization makes JSON equality suitable for undo and dirty-state checks.
 * @param {import("./model.js").ExpensesFileRaw} left First complete snapshot.
 * @param {import("./model.js").ExpensesFileRaw} right Second complete snapshot.
 * @returns {boolean}
 */
function expenseSnapshotsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Parses a non-negative localized decimal string into an exact integer at the requested scale.
 * A comma or period is accepted as the decimal separator, but grouping separators and excess fractional digits are rejected to prevent ambiguous money input.
 * @param {string} value User-entered decimal text.
 * @param {number} fractionDigits Number of decimal minor-unit places.
 * @param {string} label Human-readable field label for errors.
 * @param {boolean} [allowZero] Whether zero is accepted.
 * @returns {number}
 */
function parseScaledInteger(value, fractionDigits, label, allowZero = false) {
    const text = String(value || "").trim().replace(",", ".");
    const pattern = new RegExp(`^\\d+(?:\\.\\d{0,${fractionDigits}})?$`);
    if (!pattern.test(text)) throw new Error(`${label} must be a non-negative decimal value.`);
    const [wholeText, fractionText = ""] = text.split(".");
    const scale = 10n ** BigInt(fractionDigits);
    const amount = BigInt(wholeText) * scale + BigInt((fractionText + "0".repeat(fractionDigits)).slice(0, fractionDigits) || "0");
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range.`);
    const numeric = Number(amount);
    if (!allowZero && numeric <= 0) throw new Error(`${label} must be greater than zero.`);
    return numeric;
}

/**
 * Formats an integer minor-unit value for a plain dialog input without currency decoration.
 * @param {number} amountMinor Integer minor-unit amount.
 * @param {number} fractionDigits Number of currency fraction digits.
 * @returns {string}
 */
function formatScaledInput(amountMinor, fractionDigits) {
    const amount = Number(amountMinor);
    if (!Number.isSafeInteger(amount) || amount < 0) return "";
    if (fractionDigits === 0) return String(amount);
    const scale = 10 ** fractionDigits;
    return `${Math.floor(amount / scale)}.${String(amount % scale).padStart(fractionDigits, "0")}`;
}

/**
 * Canonical starter-category vocabulary used only until a workspace has enough expense history for personalized suggestions.
 * Both English and German words are included because category keys are stable even when the interface language changes.
 * @type {Record<string, string[]>}
 */
const DEFAULT_CATEGORY_KEYWORDS = {
    groceries: ["grocery", "groceries", "supermarket", "market", "foodshop", "einkauf", "lebensmittel", "supermarkt", "rewe", "edeka", "aldi", "lidl"],
    "food-drink": ["food", "dinner", "lunch", "breakfast", "restaurant", "cafe", "coffee", "drink", "essen", "abendessen", "mittagessen", "frühstück", "kaffee", "kneipe"],
    transport: ["train", "bus", "taxi", "fuel", "flight", "ticket", "parking", "bahn", "zug", "benzin", "flug", "parken"],
    accommodation: ["hotel", "hostel", "apartment", "camping", "room", "unterkunft", "ferienwohnung", "zimmer"],
    activities: ["museum", "cinema", "concert", "activity", "tour", "kino", "konzert", "ausflug", "eintritt"],
    household: ["household", "rent", "electricity", "cleaning", "furniture", "haushalt", "miete", "strom", "reinigung", "möbel"],
};

/**
 * Reduces free-form text to meaningful case-insensitive words for local category matching.
 * Unicode letters and numbers are retained so German descriptions and names remain useful without external services.
 * @param {string} value Description or category text.
 * @returns {Set<string>}
 */
function tokenizeExpenseSuggestion(value) {
    const words = String(value || "")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu) || [];
    return new Set(words.filter((word) => word.length >= 3));
}

/**
 * Computes the greatest common divisor for two non-negative safe integers.
 * It is used to turn exact allocation amounts into compact share ratios when users switch editing modes.
 * @param {number} left First integer.
 * @param {number} right Second integer.
 * @returns {number}
 */
function greatestCommonDivisor(left, right) {
    let a = Math.abs(Math.trunc(left));
    let b = Math.abs(Math.trunc(right));
    while (b) [a, b] = [b, a % b];
    return a || 1;
}

/**
 * Produces a stable slug suitable for a new participant or category key.
 * Unicode display names remain untouched; the key falls back to a readable prefix when transliteration yields no ASCII characters.
 * @param {string} name Display name used as the slug source.
 * @param {string} prefix Fallback key prefix.
 * @param {Set<string>} used Existing keys that must not be reused.
 * @returns {string}
 */
function reserveDefinitionKey(name, prefix, used) {
    const base = String(name || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || prefix;
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
        key = `${base}-${suffix}`;
        suffix += 1;
    }
    used.add(key);
    return key;
}

/**
 * Merges one id-keyed draft collection over a newer remote collection.
 * Rows changed or deleted locally win per identity, while untouched rows receive remote updates and remote additions.
 * @template T
 * @param {T[]} baseline Rows present when editing began.
 * @param {T[]} localDraft Locally edited rows.
 * @param {T[]} remoteCurrent Newly loaded repository rows.
 * @param {(row: T) => string} getId Stable identity accessor.
 * @returns {T[]}
 */
function mergeDraftCollection(baseline, localDraft, remoteCurrent, getId) {
    const toMap = (rows) => new Map(rows.map((row) => [getId(row), row]));
    const baselineById = toMap(baseline);
    const localById = toMap(localDraft);
    const remoteById = toMap(remoteCurrent);
    const ids = [];
    const seen = new Set();
    for (const row of [...localDraft, ...remoteCurrent, ...baseline]) {
        const id = getId(row);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    const merged = [];
    for (const id of ids) {
        const baselineRow = baselineById.get(id);
        const localRow = localById.get(id);
        const remoteRow = remoteById.get(id);
        const localChanged = JSON.stringify(localRow ?? null) !== JSON.stringify(baselineRow ?? null);
        const selected = localChanged ? localRow : remoteRow;
        if (selected) merged.push(cloneJson(selected));
    }
    return merged;
}

/**
 * Carries a validation message together with the exact control and progressive-disclosure section that need attention.
 * Keeping this navigation metadata out of localized strings lets submit handling reveal and focus the right field without brittle message matching.
 */
class ExpenseFormError extends Error {
    /**
     * Creates one guided expense-form error.
     * @param {string} message Localized validation message shown inside the modal.
     * @param {HTMLElement} control Control that should receive focus.
     * @param {HTMLElement | null} [disclosure] Collapsed contextual section that must be opened before focus moves.
     */
    constructor(message, control, disclosure = null) {
        super(message);
        this.name = "ExpenseFormError";
        this.control = control;
        this.disclosure = disclosure;
    }
}

/**
 * Manages the keyboard-first expense ledger, exact split editing, balances, settlements, inventory, undo history, saves, and durable browser drafts.
 * ExpenseStore remains responsible for all money invariants; this class owns only presentation and interaction state.
 */
export class ExpenseView {
    /**
     * Captures dependencies and concrete DOM controls, then installs view-local event handlers.
     * @param {ExpenseViewOptions} options View dependencies and elements.
     */
    constructor(options) {
        this.store = options.store;
        this.projectStore = options.projectStore;
        this.dataSource = options.dataSource;
        this.draftJournal = options.draftJournal;
        this.draftNamespace = options.draftNamespace;
        this.timeContext = options.timeContext;
        this.locale = options.locale;
        this.onToast = options.onToast;
        this.onBusy = options.onBusy;
        this.onSaved = options.onSaved;
        this.onStatsChanged = options.onStatsChanged;
        this.onStateChange = options.onStateChange || (() => {});

        this.expenseView = options.elements.expenseView;
        this.expenseBalanceStrip = options.elements.expenseBalanceStrip;
        this.expenseCategoryFilters = options.elements.expenseCategoryFilters;
        this.expenseList = options.elements.expenseList;
        this.searchInput = options.elements.searchInput;
        this.expenseAddBtn = options.elements.expenseAddBtn;
        this.expenseSettleBtn = options.elements.expenseSettleBtn;
        this.expenseInventoryBtn = options.elements.expenseInventoryBtn;
        this.editorBadge = options.elements.editorBadge;
        this.expenseDialog = options.elements.expenseDialog;
        this.expenseForm = options.elements.expenseForm;
        this.expenseDialogTitle = options.elements.expenseDialogTitle;
        this.expenseDialogError = options.elements.expenseDialogError;
        this.expenseCloseBtn = options.elements.expenseCloseBtn;
        this.expenseCancelBtn = options.elements.expenseCancelBtn;
        this.expenseDeleteBtn = options.elements.expenseDeleteBtn;
        this.expenseSubmitBtn = options.elements.expenseSubmitBtn;
        this.expenseDescription = options.elements.expenseDescription;
        this.expenseDate = options.elements.expenseDate;
        this.expenseAmount = options.elements.expenseAmount;
        this.expenseCurrency = options.elements.expenseCurrency;
        this.expenseCategory = options.elements.expenseCategory;
        this.expenseCategoryOptions = options.elements.expenseCategoryOptions;
        this.expenseCategoryHint = options.elements.expenseCategoryHint;
        this.expensePayerSummaryBtn = options.elements.expensePayerSummaryBtn;
        this.expensePayerSummary = options.elements.expensePayerSummary;
        this.expensePayerSummaryMeta = options.elements.expensePayerSummaryMeta;
        this.expensePayer = options.elements.expensePayer;
        this.expensePayerPanel = options.elements.expensePayerPanel;
        this.expensePayerPanelCloseBtn = options.elements.expensePayerPanelCloseBtn;
        this.expensePayerCustomFields = options.elements.expensePayerCustomFields;
        this.expensePayerRows = options.elements.expensePayerRows;
        this.expensePayerRemaining = options.elements.expensePayerRemaining;
        this.expenseSplitSummaryBtn = options.elements.expenseSplitSummaryBtn;
        this.expenseSplitSummary = options.elements.expenseSplitSummary;
        this.expenseSplitSummaryMeta = options.elements.expenseSplitSummaryMeta;
        this.expenseSplitPanel = options.elements.expenseSplitPanel;
        this.expenseSplitPanelCloseBtn = options.elements.expenseSplitPanelCloseBtn;
        this.expenseAllocationChoices = options.elements.expenseAllocationChoices;
        this.expenseSplitRemaining = options.elements.expenseSplitRemaining;
        this.expenseOutcome = options.elements.expenseOutcome;
        this.expenseOutcomeSummary = options.elements.expenseOutcomeSummary;
        this.expenseOutcomeDetails = options.elements.expenseOutcomeDetails;
        this.expenseAdvancedDetails = options.elements.expenseAdvancedDetails;
        this.expenseAssignment = options.elements.expenseAssignment;
        this.expenseAssignmentList = options.elements.expenseAssignmentList;
        this.expenseAllocationType = options.elements.expenseAllocationType;
        this.expenseNotes = options.elements.expenseNotes;
        this.expenseOwedHeading = options.elements.expenseOwedHeading;
        this.expenseSplitRows = options.elements.expenseSplitRows;
        this.expenseSettlementDialog = options.elements.expenseSettlementDialog;
        this.expenseSettlementCloseBtn = options.elements.expenseSettlementCloseBtn;
        this.expenseSettlementList = options.elements.expenseSettlementList;
        this.expenseInventoryDialog = options.elements.expenseInventoryDialog;
        this.expenseInventoryForm = options.elements.expenseInventoryForm;
        this.expenseInventoryTitle = options.elements.expenseInventoryTitle;
        this.expenseInventoryMeta = options.elements.expenseInventoryMeta;
        this.expenseInventoryError = options.elements.expenseInventoryError;
        this.expenseInventoryCloseBtn = options.elements.expenseInventoryCloseBtn;
        this.expenseInventoryCancelBtn = options.elements.expenseInventoryCancelBtn;
        this.expenseInventorySubmitBtn = options.elements.expenseInventorySubmitBtn;
        this.expenseAddParticipantBtn = options.elements.expenseAddParticipantBtn;
        this.expenseAddCategoryBtn = options.elements.expenseAddCategoryBtn;
        this.expenseParticipantList = options.elements.expenseParticipantList;
        this.expenseCategoryList = options.elements.expenseCategoryList;
        this.expenseInventoryCategoriesSection = options.elements.expenseInventoryCategoriesSection;
        this.active = false;
        this.busy = false;
        this.saveInFlight = false;
        this.searchQuery = "";
        this.categoryFilterKey = "*";
        this.selectedRecordKey = null;
        this.editingExpenseId = null;
        /** @type {import("./model.js").ExpensesFileRaw} */
        this.cleanSnapshot = this.store.snapshotRaw();
        this.dirty = false;
        /** @type {ExpenseEditorAction[]} */
        this.undoStack = [];
        /** @type {ExpenseEditorAction[]} */
        this.redoStack = [];
        this.draftWriteChain = Promise.resolve();
        this.draftWarningShown = false;
        this.restoringRoute = false;
        this.resumeCreateAfterInventory = false;
        this.categorySelectionIsAutomatic = false;
        this.suggestedCategoryKey = null;
        /** @type {Map<string, string>} */
        this.categoryKeyByNormalizedLabel = new Map();
        /** @type {Map<string, string>} */
        this.categoryLabelByKey = new Map();
        this.lastSimplePayerKey = "";

        this.bindEvents();
        this.updateSaveState();
    }

    /**
     * Installs click, keyboard, filter, and dialog handlers owned by the expense component.
     * Global application shortcuts continue to be dispatched by App.
     * @returns {void}
     */
    bindEvents() {
        this.expenseAddBtn.addEventListener("click", () => this.openCreateDialog());
        this.expenseSettleBtn.addEventListener("click", () => this.openSettlementDialog());
        this.expenseInventoryBtn.addEventListener("click", () => this.openInventoryDialog());
        this.searchInput.addEventListener("input", () => {
            if (!this.active) return;
            this.searchQuery = this.searchInput.value;
            this.render();
        });
        this.expenseCategoryFilters.addEventListener("click", (event) => this.handleCategoryFilterClick(event));
        this.expenseList.addEventListener("click", (event) => this.handleListClick(event));
        this.expenseList.addEventListener("dblclick", (event) => this.handleListDoubleClick(event));
        this.expenseCloseBtn.addEventListener("click", () => this.closeExpenseDialog());
        this.expenseCancelBtn.addEventListener("click", () => this.closeExpenseDialog());
        this.expenseDeleteBtn.addEventListener("click", () => this.deleteEditingExpense());
        this.expenseDialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            this.closeExpenseDialog();
        });
        this.expenseForm.addEventListener("submit", (event) => this.handleExpenseSubmit(event));
        this.expenseForm.addEventListener("input", () => this.clearExpenseDialogError());
        this.expensePayerSummaryBtn.addEventListener("click", () => this.toggleExpenseContextPanel("payer"));
        this.expenseSplitSummaryBtn.addEventListener("click", () => this.toggleExpenseContextPanel("split"));
        this.expensePayerPanelCloseBtn.addEventListener("click", () => this.setExpenseContextPanel(null));
        this.expenseSplitPanelCloseBtn.addEventListener("click", () => this.setExpenseContextPanel(null));
        this.expenseAllocationChoices.addEventListener("click", (event) => this.handleAllocationChoice(event));
        this.expenseAmount.addEventListener("input", () => {
            this.copyTotalToOnlyPayer();
            this.updateAutomaticRemainders();
            this.refreshExpenseComposer();
        });
        this.expenseDescription.addEventListener("input", () => this.applySuggestedCategory());
        this.expenseCategory.addEventListener("input", () => {
            this.categorySelectionIsAutomatic = false;
            this.suggestedCategoryKey = null;
            this.updateCategoryHint();
        });
        this.expensePayer.addEventListener("change", () => {
            this.applySelectedPayer();
            this.refreshExpenseComposer();
        });
        this.expensePayerRows.addEventListener("input", (event) => this.handlePayerInput(event));
        this.expenseSplitRows.addEventListener("input", (event) => this.handleSplitInput(event));
        this.expenseSplitRows.addEventListener("change", (event) => this.handleSplitInput(event));
        this.expenseCurrency.addEventListener("input", () => this.refreshExpenseComposer());
        this.expenseCurrency.addEventListener("change", () => this.reformatSplitMoneyInputs());
        this.expenseSettlementCloseBtn.addEventListener("click", () => this.closeSettlementDialog());
        this.expenseSettlementDialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            this.closeSettlementDialog();
        });
        this.expenseSettlementList.addEventListener("click", (event) => this.handleSettlementClick(event));
        this.expenseInventoryCloseBtn.addEventListener("click", () => this.closeInventoryDialog());
        this.expenseInventoryCancelBtn.addEventListener("click", () => this.closeInventoryDialog());
        this.expenseInventoryDialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            this.closeInventoryDialog();
        });
        this.expenseInventoryForm.addEventListener("submit", (event) => this.handleInventorySubmit(event));
        this.expenseInventoryForm.addEventListener("input", () => this.setInlineError(this.expenseInventoryError, ""));
        this.expenseAddParticipantBtn.addEventListener("click", () => this.addParticipantRow());
        this.expenseAddCategoryBtn.addEventListener("click", () => this.addCategoryRow());
    }

    /**
     * Replaces the persistence backend when a different workspace is mounted.
     * @param {import("./datasource.js").DataSource} dataSource New active data source.
     * @returns {void}
     */
    setDataSource(dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Changes the IndexedDB namespace that isolates unsaved ledger edits by workspace and branch.
     * @param {string} namespace Draft namespace.
     * @returns {void}
     */
    setDraftNamespace(namespace) {
        this.draftNamespace = String(namespace || "").trim();
    }

    /**
     * Shows or hides the component and restores list focus when activated.
     * @param {boolean} isActive Whether expense mode is active.
     * @returns {void}
     */
    setActive(isActive) {
        this.active = Boolean(isActive);
        setVisible(this.expenseView, this.active);
        if (!this.active) return;
        this.render();
        this.updateSaveState();
        queueMicrotask(() => {
            if (!this.expenseDialog.open && !this.expenseSettlementDialog.open && !this.expenseInventoryDialog.open) {
                this.expenseList.focus({ preventScroll: true });
            }
        });
    }

    /**
     * Applies application-wide busy state without discarding in-memory edits.
     * @param {boolean} isBusy Whether network or workspace switching is active.
     * @returns {void}
     */
    setBusy(isBusy) {
        this.busy = Boolean(isBusy);
        for (const control of [
            this.expenseAddBtn,
            this.expenseSettleBtn,
            this.expenseInventoryBtn,
            this.searchInput,
            this.expenseCloseBtn,
            this.expenseCancelBtn,
            this.expenseDeleteBtn,
            this.expenseSubmitBtn,
            this.expensePayerSummaryBtn,
            this.expenseSplitSummaryBtn,
            this.expensePayerPanelCloseBtn,
            this.expenseSplitPanelCloseBtn,
            this.expenseSettlementCloseBtn,
            this.expenseInventoryCloseBtn,
            this.expenseInventoryCancelBtn,
            this.expenseInventorySubmitBtn,
            this.expenseAddParticipantBtn,
            this.expenseAddCategoryBtn,
        ]) {
            control.disabled = this.busy;
        }
        this.updateSaveState();
    }

    /**
     * Clears transient UI and history after logout while retaining durable IndexedDB drafts.
     * @returns {void}
     */
    reset() {
        this.closeExpenseDialog();
        this.closeSettlementDialog();
        this.closeInventoryDialog();
        this.selectedRecordKey = null;
        this.editingExpenseId = null;
        this.searchQuery = "";
        this.categoryFilterKey = "*";
        this.cleanSnapshot = this.store.snapshotRaw();
        this.dirty = false;
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.expenseList.innerHTML = "";
        this.expenseBalanceStrip.innerHTML = "";
        this.expenseCategoryFilters.innerHTML = "";
        this.onStatsChanged("");
        this.updateSaveState();
    }

    /**
     * Re-renders locale-sensitive labels, dates, money, summaries, and any open expense dialogs.
     * @returns {void}
     */
    refreshLocale() {
        this.render();
        if (this.expenseDialog.open) {
            const current = this.editingExpenseId ? this.store.getExpenseById(this.editingExpenseId) : null;
            const selectedCategoryKey = current ? current.category_key : this.getCategoryControlKey();
            this.expenseDialogTitle.textContent = this.locale.t(current ? "expenses.editTitle" : "expenses.add");
            this.expenseSubmitBtn.textContent = this.locale.t(current ? "expenses.saveAction" : "expenses.createAction");
            this.populateCategoryControl(selectedCategoryKey === undefined ? null : selectedCategoryKey, false);
            const customPayer = [...this.expensePayer.options].find((option) => option.value === "__custom__");
            if (customPayer) customPayer.text = this.locale.t("expenses.multiplePayers");
            this.populateProjectControl(current?.project_key || null, current?.section_key || null);
            this.updateAllocationHeading();
            this.refreshExpenseComposer();
        }
        if (this.expenseSettlementDialog.open) this.renderSettlementSuggestions();
        if (this.expenseInventoryDialog.open) {
            this.updateInventoryDialogMode();
            this.renderInventory();
            if (this.resumeCreateAfterInventory && !this.expenseParticipantList.children.length) this.addParticipantRow();
        }
        this.updateSaveState();
    }

    /**
     * Rebuilds project assignment choices after the shared project inventory changes.
     * @returns {void}
     */
    setProjects() {
        this.populateProjectControl(null, null);
        this.render();
    }

    /**
     * Establishes a clean baseline after repository loading and restores any durable browser draft.
     * @returns {Promise<void>}
     */
    async initializeLoadedData() {
        this.cleanSnapshot = this.store.snapshotRaw();
        this.dirty = false;
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        await this.restoreDraft();
        this.ensureDefaultCategories();
        this.render();
        this.updateSaveState();
    }

    /**
     * Adds the canonical starter categories to an older blank ledger while preserving every participant and record.
     * New workspaces already contain these categories in expenses.json; this one-time browser-side migration keeps previously initialized empty ledgers equally usable and marks the resulting document for an explicit manual save.
     * @returns {boolean} Whether starter categories were added.
     */
    ensureDefaultCategories() {
        if (this.store.getCategories().length) return false;
        this.store.updateInventory(
            this.store.getParticipants().map((participant) => participant.toRaw()),
            createDefaultExpenseCategories(),
        );
        this.dirty = !expenseSnapshotsEqual(this.cleanSnapshot, this.store.snapshotRaw());
        if (this.dirty) this.queueDraftWrite();
        return true;
    }

    /**
     * Returns the expense query independently of the shared search input's active component.
     * @returns {string}
     */
    getSearchQuery() {
        return this.searchQuery;
    }

    /**
     * Returns compact route state for filters and selection without embedding workspace data in the URL.
     * @returns {{query: string, category: string, selectedExpenseId: string | null}}
     */
    getRouteState() {
        return {
            query: this.searchQuery,
            category: this.categoryFilterKey,
            selectedExpenseId: this.selectedRecordKey,
        };
    }

    /**
     * Restores expense filters and selection after the ledger has loaded.
     * @param {Object.<string, unknown>} state Parsed route state.
     * @returns {void}
     */
    restoreRouteState(state) {
        const routeState = state && typeof state === "object" ? state : {};
        this.restoringRoute = true;
        try {
            this.searchQuery = String(routeState.query || "");
            this.searchInput.value = this.searchQuery;
            this.categoryFilterKey = String(routeState.category || "*");
            this.selectedRecordKey = routeState.selectedExpenseId ? String(routeState.selectedExpenseId) : null;
            this.render();
            this.selectRecord(this.selectedRecordKey, false);
        } finally {
            this.restoringRoute = false;
        }
    }

    /**
     * Returns all records matching the current query and category filter in deterministic newest-first order.
     * @returns {ExpenseVisibleRecord[]}
     */
    getVisibleRecords() {
        const query = this.searchQuery.trim().toLowerCase();
        const participantNames = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        const categoryNames = new Map(this.store.getCategories().map((category) => [category.key, category.name]));
        /** @type {ExpenseVisibleRecord[]} */
        const records = [];
        for (const expense of this.store.getExpenses()) {
            if (this.categoryFilterKey !== "*" && expense.category_key !== this.categoryFilterKey) continue;
            const people = [...expense.payers, ...expense.allocations]
                .map((line) => participantNames.get(line.participant_key) || line.participant_key)
                .join(" ");
            const category = expense.category_key ? categoryNames.get(expense.category_key) || expense.category_key : "";
            if (query && !`${expense.searchHaystack} ${people} ${category}`.toLowerCase().includes(query)) continue;
            records.push({ kind: "expense", key: `expense:${expense.id}`, id: expense.id, date: expense.date, model: expense });
        }
        if (this.categoryFilterKey === "*") {
            for (const transfer of this.store.getTransfers()) {
                const people = [transfer.from_participant_key, transfer.to_participant_key]
                    .map((key) => participantNames.get(key) || key)
                    .join(" ");
                if (query && !`${transfer.searchHaystack} ${people} ${this.locale.t("expenses.settlement")}`.toLowerCase().includes(query)) continue;
                records.push({ kind: "transfer", key: `transfer:${transfer.id}`, id: transfer.id, date: transfer.date, model: transfer });
            }
        }
        return records.sort((left, right) => right.date.localeCompare(left.date) || left.key.localeCompare(right.key));
    }

    /**
     * Rebuilds balances, filters, rows, selection, and the shared bottom-right statistics overlay.
     * @returns {void}
     */
    render() {
        this.renderBalances();
        this.renderCategoryFilters();
        const records = this.getVisibleRecords();
        this.expenseList.innerHTML = "";
        if (!records.length) {
            const empty = document.createElement("div");
            empty.className = "expense-empty muted";
            empty.textContent = this.locale.t("expenses.empty");
            this.expenseList.append(empty);
            this.selectedRecordKey = null;
        } else {
            if (!records.some((record) => record.key === this.selectedRecordKey)) this.selectedRecordKey = records[0].key;
            const fragment = document.createDocumentFragment();
            for (const record of records) fragment.append(this.buildRecordRow(record));
            this.expenseList.append(fragment);
        }
        this.selectRecord(this.selectedRecordKey, false);
        this.onStatsChanged(
            this.locale.t("expenses.stats", {
                shown: this.locale.formatNumber(records.length),
                expenses: this.locale.formatNumber(this.store.getExpenses().length),
                settlements: this.locale.formatNumber(this.store.getTransfers().length),
            }),
        );
        if (!this.restoringRoute) this.onStateChange();
    }

    /**
     * Renders every non-zero participant balance as a compact per-currency chip.
     * @returns {void}
     */
    renderBalances() {
        this.expenseBalanceStrip.innerHTML = "";
        const balances = this.store.calculateBalances();
        if (!balances.length) {
            const balanced = document.createElement("span");
            balanced.className = "expense-balance-balanced";
            balanced.textContent = this.locale.t("expenses.balanced");
            this.expenseBalanceStrip.append(balanced);
            return;
        }
        const names = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        for (const balance of balances) {
            const chip = document.createElement("span");
            chip.className = `expense-balance-chip ${balance.amountMinor > 0 ? "is-positive" : "is-negative"}`;
            chip.textContent = `${names.get(balance.participantKey) || balance.participantKey} ${this.locale.formatMinorCurrency(balance.amountMinor, balance.currency, { signDisplay: "always" })}`;
            this.expenseBalanceStrip.append(chip);
        }
    }

    /**
     * Renders category filter buttons while preserving an existing valid selection.
     * @returns {void}
     */
    renderCategoryFilters() {
        const categories = this.store.getCategories().filter((category) => !category.archived);
        if (this.categoryFilterKey !== "*" && !categories.some((category) => category.key === this.categoryFilterKey)) {
            this.categoryFilterKey = "*";
        }
        this.expenseCategoryFilters.innerHTML = "";
        const options = [{ key: "*", name: this.locale.t("expenses.all"), color: "" }, ...categories];
        for (const category of options) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "expense-category-filter";
            button.dataset.categoryKey = category.key;
            button.textContent = category.name;
            button.setAttribute("aria-pressed", String(category.key === this.categoryFilterKey));
            if (category.color) button.style.setProperty("--expense-category-color", category.color);
            this.expenseCategoryFilters.append(button);
        }
    }

    /**
     * Builds one accessible expense or transfer row with pointer actions revealed on selection.
     * @param {ExpenseVisibleRecord} record Record descriptor to render.
     * @returns {HTMLElement}
     */
    buildRecordRow(record) {
        const row = document.createElement("div");
        row.className = `expense-row is-${record.kind}`;
        row.dataset.recordKey = record.key;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(record.key === this.selectedRecordKey));

        const date = document.createElement("time");
        date.className = "expense-row-date";
        date.dateTime = record.date;
        date.textContent = this.locale.formatDate(`${record.date}T12:00:00Z`, "UTC", { dateStyle: "medium" });

        const body = document.createElement("div");
        body.className = "expense-row-body";
        const title = document.createElement("div");
        title.className = "expense-row-title";
        const meta = document.createElement("div");
        meta.className = "expense-row-meta muted";
        const amount = document.createElement("div");
        amount.className = "expense-row-amount";
        const actions = document.createElement("div");
        actions.className = "expense-row-actions";

        const participantNames = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        if (record.kind === "expense") {
            const expense = /** @type {import("./model.js").Expense} */ (record.model);
            const category = expense.category_key
                ? this.store.getCategories().find((candidate) => candidate.key === expense.category_key)
                : null;
            title.textContent = expense.description;
            const payers = expense.payers.map((line) => participantNames.get(line.participant_key) || line.participant_key).join(", ");
            const allocation = expense.allocations.map((line) => participantNames.get(line.participant_key) || line.participant_key).join(", ");
            meta.textContent = [category?.name || this.locale.t("expenses.noCategory"), `${payers} → ${allocation}`].join(" • ");
            if (category) row.style.setProperty("--expense-category-color", category.color);
            amount.textContent = this.locale.formatMinorCurrency(expense.amount_minor, expense.currency);
            actions.append(
                this.buildRowAction("edit", "arrow_selector_tool", this.locale.t("expenses.edit")),
                this.buildRowAction("split", "call_split", this.locale.t("expenses.editSplit")),
                this.buildRowAction("delete", "close", this.locale.t("common.delete"), true),
            );
        } else {
            const transfer = /** @type {import("./model.js").ExpenseTransfer} */ (record.model);
            title.textContent = this.locale.t("expenses.settlement");
            meta.textContent = `${participantNames.get(transfer.from_participant_key) || transfer.from_participant_key} → ${participantNames.get(transfer.to_participant_key) || transfer.to_participant_key}${transfer.notes ? ` • ${transfer.notes}` : ""}`;
            amount.textContent = this.locale.formatMinorCurrency(transfer.amount_minor, transfer.currency);
            actions.append(this.buildRowAction("delete", "close", this.locale.t("common.delete"), true));
        }
        body.append(title, meta);
        row.append(date, body, amount, actions);
        return row;
    }

    /**
     * Builds one icon-only pointer action for a selected ledger row.
     * @param {string} action Action identifier consumed by handleListClick().
     * @param {string} icon Material Symbol sprite id.
     * @param {string} label Accessible action label.
     * @param {boolean} [danger] Whether to apply destructive styling.
     * @returns {HTMLButtonElement}
     */
    buildRowAction(action, icon, label, danger = false) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `expense-row-action${danger ? " is-danger" : ""}`;
        button.dataset.expenseAction = action;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.append(createMaterialIcon(icon));
        return button;
    }

    /**
     * Applies a clicked category filter and rebuilds the visible ledger rows.
     * @param {MouseEvent} event Delegated click event.
     * @returns {void}
     */
    handleCategoryFilterClick(event) {
        const target = event.target instanceof Element ? event.target.closest("[data-category-key]") : null;
        if (!(target instanceof HTMLButtonElement)) return;
        this.categoryFilterKey = target.dataset.categoryKey || "*";
        this.render();
    }

    /**
     * Selects rows or executes their edit, split, and delete actions through event delegation.
     * @param {MouseEvent} event Delegated click event.
     * @returns {void}
     */
    handleListClick(event) {
        const row = event.target instanceof Element ? event.target.closest(".expense-row") : null;
        if (!(row instanceof HTMLElement)) return;
        const recordKey = row.dataset.recordKey || "";
        this.selectRecord(recordKey, false);
        const actionButton = event.target instanceof Element ? event.target.closest("[data-expense-action]") : null;
        if (!(actionButton instanceof HTMLButtonElement)) return;
        const action = actionButton.dataset.expenseAction;
        if (action === "edit") this.openSelectedExpenseDialog(false);
        else if (action === "split") this.openSelectedExpenseDialog(true);
        else if (action === "delete") this.deleteSelectedRecord();
    }

    /**
     * Opens an expense editor on double-click while leaving transfer rows as ordinary selectable history.
     * @param {MouseEvent} event Delegated double-click event.
     * @returns {void}
     */
    handleListDoubleClick(event) {
        const row = event.target instanceof Element ? event.target.closest(".expense-row") : null;
        if (!(row instanceof HTMLElement)) return;
        this.selectRecord(row.dataset.recordKey || "", false);
        this.openSelectedExpenseDialog(false);
    }

    /**
     * Updates selection styling and optionally scrolls the selected row into view.
     * @param {string | null} recordKey Encoded expense:ID or transfer:ID key.
     * @param {boolean} [ensureVisible] Whether keyboard navigation should reveal the selected row.
     * @returns {void}
     */
    selectRecord(recordKey, ensureVisible = true) {
        const key = recordKey && this.getVisibleRecords().some((record) => record.key === recordKey) ? recordKey : null;
        this.selectedRecordKey = key;
        for (const row of this.expenseList.querySelectorAll(".expense-row")) {
            if (!(row instanceof HTMLElement)) continue;
            const selected = row.dataset.recordKey === key;
            row.classList.toggle("is-selected", selected);
            row.setAttribute("aria-selected", String(selected));
            if (selected && ensureVisible) row.scrollIntoView({ block: "nearest" });
        }
        if (!this.restoringRoute) this.onStateChange();
    }

    /**
     * Moves the current selection by one visible row, clamping at both ends.
     * @param {number} delta Positive for newer-to-older movement, negative for the reverse.
     * @returns {void}
     */
    moveSelection(delta) {
        const records = this.getVisibleRecords();
        if (!records.length) return;
        let index = records.findIndex((record) => record.key === this.selectedRecordKey);
        if (index < 0) index = delta > 0 ? -1 : records.length;
        index = Math.max(0, Math.min(records.length - 1, index + delta));
        this.selectRecord(records[index].key);
    }

    /**
     * Handles keyboard navigation and editor commands while expense mode owns focus.
     * @param {KeyboardEvent} event Browser key event.
     * @returns {boolean} Whether the event was handled.
     */
    handleKeydown(event) {
        if (!this.active || this.busy) return false;
        const ctrl = event.ctrlKey || event.metaKey;
        const key = event.key;
        const lower = key.toLowerCase();
        if (ctrl && lower === "z" && !event.shiftKey) {
            event.preventDefault();
            this.undo();
            return true;
        }
        if ((ctrl && lower === "y") || (ctrl && event.shiftKey && lower === "z")) {
            event.preventDefault();
            this.redo();
            return true;
        }
        if (ctrl && lower === "s") {
            event.preventDefault();
            void this.saveNow();
            return true;
        }
        if (key === "ArrowDown" || key === "ArrowUp") {
            event.preventDefault();
            this.moveSelection(key === "ArrowDown" ? 1 : -1);
            return true;
        }
        if (key === "Enter") {
            event.preventDefault();
            this.openSelectedExpenseDialog(false);
            return true;
        }
        if (!ctrl && !event.altKey && lower === "a") {
            event.preventDefault();
            this.openCreateDialog();
            return true;
        }
        if (!ctrl && !event.altKey && lower === "s") {
            event.preventDefault();
            this.openSettlementDialog();
            return true;
        }
        if (!ctrl && !event.altKey && (lower === "d" || key === "Delete")) {
            event.preventDefault();
            this.deleteSelectedRecord();
            return true;
        }
        if (!ctrl && !event.altKey && key === "/") {
            event.preventDefault();
            this.searchInput.focus();
            this.searchInput.select();
            return true;
        }
        return false;
    }

    /**
     * Returns recent expenses in deterministic newest-first order for lightweight local defaults.
     * No preference data leaves the ledger: currency and payer suggestions are derived solely from already loaded records.
     * @returns {import("./model.js").Expense[]}
     */
    getRecentExpenses() {
        return this.store
            .getExpenses()
            .sort((left, right) => right.date.localeCompare(left.date) || right.updated_at.localeCompare(left.updated_at));
    }

    /**
     * Chooses the currency from the newest expense and falls back to EUR for a new ledger.
     * @returns {string}
     */
    getDefaultCurrency() {
        return this.getRecentExpenses()[0]?.currency || "EUR";
    }

    /**
     * Chooses the participant most often used as the sole payer in recent expenses.
     * Recency-weighted scores make the current trip or household convention win quickly, while the stable participant order remains the final fallback.
     * @param {import("./model.js").ExpenseParticipant[]} participants Active selectable participants.
     * @returns {string}
     */
    getDefaultPayerKey(participants) {
        const allowed = new Set(participants.map((participant) => participant.key));
        const scores = new Map(participants.map((participant) => [participant.key, 0]));
        for (const [index, expense] of this.getRecentExpenses().slice(0, 24).entries()) {
            if (expense.payers.length !== 1) continue;
            const key = expense.payers[0].participant_key;
            if (!allowed.has(key)) continue;
            scores.set(key, (scores.get(key) || 0) + 24 - index);
        }
        return [...participants]
            .sort((left, right) => (scores.get(right.key) || 0) - (scores.get(left.key) || 0))[0]?.key || "";
    }

    /**
     * Chooses the category used most often in recent expenses, falling back to the canonical Other category.
     * The score is deliberately local and recency weighted so a travel workspace quickly adopts its current convention without storing separate preference data.
     * @param {import("./model.js").ExpenseCategory[]} categories Active selectable categories.
     * @returns {string}
     */
    getDefaultCategoryKey(categories) {
        const allowed = new Set(categories.map((category) => category.key));
        const scores = new Map(categories.map((category) => [category.key, 0]));
        for (const [index, expense] of this.getRecentExpenses().slice(0, 24).entries()) {
            const key = expense.category_key || "";
            if (!allowed.has(key)) continue;
            scores.set(key, (scores.get(key) || 0) + 24 - index);
        }
        const ranked = [...categories].sort(
            (left, right) => (scores.get(right.key) || 0) - (scores.get(left.key) || 0),
        );
        if ((scores.get(ranked[0]?.key || "") || 0) > 0) return ranked[0].key;
        return categories.find((category) => category.key === "other")?.key || categories[0]?.key || "";
    }

    /**
     * Suggests a category from similar historical descriptions and starter-category vocabulary.
     * Historical matches take priority, allowing the suggestion behavior to personalize itself naturally as the ledger grows.
     * @param {string} description Current free-form expense description.
     * @returns {string | null}
     */
    findSuggestedCategoryKey(description) {
        const descriptionTokens = tokenizeExpenseSuggestion(description);
        if (!descriptionTokens.size) return null;
        const categories = this.store.getCategories().filter((category) => !category.archived);
        const allowed = new Set(categories.map((category) => category.key));
        const scores = new Map(categories.map((category) => [category.key, 0]));

        for (const category of categories) {
            const vocabulary = new Set([
                ...tokenizeExpenseSuggestion(category.name),
                ...(DEFAULT_CATEGORY_KEYWORDS[category.key] || []),
            ]);
            const overlap = [...descriptionTokens].filter((token) => vocabulary.has(token)).length;
            if (overlap) scores.set(category.key, overlap * 55);
        }

        const normalizedDescription = String(description || "").trim().toLocaleLowerCase();
        for (const [index, expense] of this.getRecentExpenses().slice(0, 80).entries()) {
            const key = expense.category_key || "";
            if (!allowed.has(key)) continue;
            const historicalTokens = tokenizeExpenseSuggestion(expense.description);
            const overlap = [...descriptionTokens].filter((token) => historicalTokens.has(token)).length;
            if (!overlap) continue;
            const unionSize = new Set([...descriptionTokens, ...historicalTokens]).size || 1;
            const exactBonus = expense.description.trim().toLocaleLowerCase() === normalizedDescription ? 180 : 0;
            const score = overlap * 60 + Math.round((overlap / unionSize) * 45) + Math.max(0, 40 - index) + exactBonus;
            scores.set(key, Math.max(scores.get(key) || 0, score));
        }

        const ranked = [...categories].sort(
            (left, right) => (scores.get(right.key) || 0) - (scores.get(left.key) || 0),
        );
        return (scores.get(ranked[0]?.key || "") || 0) >= 45 ? ranked[0].key : null;
    }

    /**
     * Applies a description-derived category while the category remains under automatic control.
     * Removing the matching words restores the ordinary recent-category default, while a manual selector change permanently disables suggestions for the current dialog session so user intent always wins.
     * @returns {void}
     */
    applySuggestedCategory() {
        if (!this.categorySelectionIsAutomatic) return;
        const previousSuggestion = this.suggestedCategoryKey;
        const suggestion = this.findSuggestedCategoryKey(this.expenseDescription.value);
        if (suggestion && this.categoryLabelByKey.has(suggestion)) {
            this.setCategoryControlValue(suggestion);
            this.suggestedCategoryKey = suggestion;
        } else {
            if (previousSuggestion && this.getCategoryControlKey() === previousSuggestion) {
                const categories = this.store.getCategories().filter((category) => !category.archived);
                this.setCategoryControlValue(this.getDefaultCategoryKey(categories));
            }
            this.suggestedCategoryKey = null;
        }
        this.updateCategoryHint();
    }

    /**
     * Explains when the currently selected category came from description matching.
     * The hint stays empty for ordinary defaults to avoid presenting every automatic choice as a notification.
     * @returns {void}
     */
    updateCategoryHint() {
        this.expenseCategoryHint.textContent =
            this.categorySelectionIsAutomatic && this.suggestedCategoryKey === this.getCategoryControlKey()
                ? this.locale.t("expenses.categorySuggested")
                : "";
    }

    /**
     * Opens a blank receipt composer with personalized defaults and a complete equal split.
     * A workspace without participants enters a focused first-use step and automatically resumes this exact action afterward.
     * @returns {void}
     */
    openCreateDialog() {
        if (this.busy || this.saveInFlight) return;
        const participants = this.store.getParticipants().filter((participant) => !participant.archived);
        if (!participants.length) {
            this.openInventoryDialog(true);
            return;
        }
        this.editingExpenseId = null;
        this.expenseDialogTitle.textContent = this.locale.t("expenses.add");
        this.expenseSubmitBtn.textContent = this.locale.t("expenses.createAction");
        this.clearExpenseDialogError();
        this.expenseDescription.value = "";
        this.expenseDate.value = this.timeContext.formatDate(new Date());
        this.expenseAmount.value = "";
        this.expenseCurrency.value = this.getDefaultCurrency();
        this.expenseAllocationType.value = "equal";
        this.expenseNotes.value = "";
        this.expenseAdvancedDetails.open = false;
        this.categorySelectionIsAutomatic = true;
        this.suggestedCategoryKey = null;
        this.populateCategoryControl(null, true);
        this.populateProjectControl(null, null);
        this.populatePayerControl(null);
        this.renderParticipantEditors(null);
        this.applySelectedPayer();
        this.setExpenseContextPanel(null);
        this.refreshExpenseComposer();
        this.expenseDeleteBtn.hidden = true;
        if (!this.expenseDialog.open) this.expenseDialog.showModal();
        this.focusExpensePrimaryField(this.expenseAmount);
    }

    /**
     * Resolves the selected record and opens its editor when it is an expense.
     * @param {boolean} focusSplit Whether focus should move directly to the first owed-allocation input.
     * @returns {void}
     */
    openSelectedExpenseDialog(focusSplit) {
        if (!this.selectedRecordKey?.startsWith("expense:")) return;
        const id = this.selectedRecordKey.slice("expense:".length);
        const expense = this.store.getExpenseById(id);
        if (expense) this.openEditDialog(expense, focusSplit);
    }

    /**
     * Opens the modal editor populated losslessly from one existing expense.
     * Imported expenses without editing-rule metadata are represented as exact splits.
     * @param {import("./model.js").Expense} expense Expense to edit.
     * @param {boolean} [focusSplit] Whether to focus the split controls instead of description.
     * @returns {void}
     */
    openEditDialog(expense, focusSplit = false) {
        if (this.busy || this.saveInFlight) return;
        this.editingExpenseId = expense.id;
        this.expenseDialogTitle.textContent = this.locale.t("expenses.editTitle");
        this.expenseSubmitBtn.textContent = this.locale.t("expenses.saveAction");
        this.clearExpenseDialogError();
        this.expenseDescription.value = expense.description;
        this.expenseDate.value = expense.date;
        this.expenseCurrency.value = expense.currency;
        const digits = this.locale.currencyMinorDigits(expense.currency);
        this.expenseAmount.value = formatScaledInput(expense.amount_minor, digits);
        this.expenseAllocationType.value = expense.allocation_rule?.type || "exact";
        this.expenseNotes.value = expense.notes;
        this.categorySelectionIsAutomatic = false;
        this.suggestedCategoryKey = null;
        this.populateCategoryControl(expense.category_key);
        this.populateProjectControl(expense.project_key, expense.section_key);
        this.populatePayerControl(expense);
        this.renderParticipantEditors(expense);
        this.markAutomaticSinglePayer(expense);
        if (this.expensePayer.value === "__custom__") this.configurePayerAutoBalance();
        if (["exact", "percentage"].includes(this.expenseAllocationType.value)) this.configureSplitAutoBalance();
        this.expenseAdvancedDetails.open =
            Boolean(expense.project_key || expense.section_key || expense.notes.trim());
        this.updateCategoryHint();
        this.setExpenseContextPanel(focusSplit ? "split" : null);
        this.refreshExpenseComposer();
        this.expenseDeleteBtn.hidden = false;
        if (!this.expenseDialog.open) this.expenseDialog.showModal();
        const target = focusSplit
            ? this.expenseSplitRows.querySelector(".expense-owed-input")
            : this.expenseAmount;
        if (target instanceof HTMLInputElement) this.focusExpensePrimaryField(target);
    }

    /**
     * Moves focus to the principal field after the browser completes the dialog-opening focus algorithm.
     * The animation-frame handoff is intentional: Safari and Chromium may otherwise restore focus to the first dialog button after a synchronous `showModal()` call.
     * @param {HTMLInputElement} target Input that should become the active editing control.
     * @returns {void}
     */
    focusExpensePrimaryField(target) {
        requestAnimationFrame(() => {
            if (!this.expenseDialog.open) return;
            this.expenseForm.scrollTop = 0;
            target.focus({ preventScroll: true });
            target.select();
        });
    }

    /**
     * Closes the expense editor and restores list focus when expense mode remains active.
     * @returns {void}
     */
    closeExpenseDialog() {
        if (this.expenseDialog.open) this.expenseDialog.close();
        this.editingExpenseId = null;
        this.clearExpenseDialogError();
        this.setExpenseContextPanel(null);
        if (this.active) queueMicrotask(() => this.expenseList.focus({ preventScroll: true }));
    }

    /**
     * Shows one contextual participant editor and closes the other without affecting entered values.
     * The summary cards remain visible as stable anchors, while `aria-expanded` keeps the interaction understandable to assistive technology.
     * @param {"payer" | "split" | null} panel Editor to show, or null to collapse both.
     * @returns {void}
     */
    setExpenseContextPanel(panel) {
        const showPayer = panel === "payer";
        const showSplit = panel === "split";
        this.expensePayerPanel.hidden = !showPayer;
        this.expenseSplitPanel.hidden = !showSplit;
        this.expensePayerSummaryBtn.setAttribute("aria-expanded", String(showPayer));
        this.expenseSplitSummaryBtn.setAttribute("aria-expanded", String(showSplit));
        if (!this.expenseDialog.open || !panel) return;
        queueMicrotask(() => {
            const panelElement = showPayer ? this.expensePayerPanel : this.expenseSplitPanel;
            panelElement.scrollIntoView({ block: "nearest" });
            const target = showPayer
                ? this.expensePayer
                : this.expenseAllocationChoices.querySelector('[aria-pressed="true"]');
            if (target instanceof HTMLElement) target.focus({ preventScroll: true });
        });
    }

    /**
     * Toggles a payer or split editor from its human-readable summary card.
     * @param {"payer" | "split"} panel Requested contextual editor.
     * @returns {void}
     */
    toggleExpenseContextPanel(panel) {
        const currentlyOpen = panel === "payer" ? !this.expensePayerPanel.hidden : !this.expenseSplitPanel.hidden;
        this.setExpenseContextPanel(currentlyOpen ? null : panel);
    }

    /**
     * Normalizes a visible category label for case-insensitive datalist resolution.
     * Unicode compatibility normalization makes copied names and keyboard-entered names compare consistently without changing their displayed spelling.
     * @param {string} label User-visible category label.
     * @returns {string}
     */
    normalizeCategoryLabel(label) {
        return String(label || "").normalize("NFKC").trim().toLocaleLowerCase();
    }

    /**
     * Rebuilds the searchable category datalist from active categories plus an archived current value.
     * The text input displays names while these maps preserve stable keys for persistence; duplicate names receive a visible key suffix so every choice remains unambiguous.
     * @param {string | null} selectedKey Category key to select, or null for no category.
     * @param {boolean} [useDefault] Whether a new expense should use its personalized recent-category default.
     * @returns {void}
     */
    populateCategoryControl(selectedKey, useDefault = false) {
        this.expenseCategoryOptions.innerHTML = "";
        this.categoryKeyByNormalizedLabel.clear();
        this.categoryLabelByKey.clear();
        const categories = this.store
            .getCategories()
            .filter((category) => !category.archived || category.key === selectedKey)
            .sort((left, right) => this.locale.compare(left.name, right.name));
        const normalizedNameCounts = new Map();
        for (const category of categories) {
            const name = this.normalizeCategoryLabel(category.name);
            normalizedNameCounts.set(name, (normalizedNameCounts.get(name) || 0) + 1);
        }
        for (const category of categories) {
            const duplicate = (normalizedNameCounts.get(this.normalizeCategoryLabel(category.name)) || 0) > 1;
            const keySuffix = duplicate ? ` · ${category.key}` : "";
            const archiveSuffix = category.archived ? ` (${this.locale.t("search.archived")})` : "";
            const label = `${category.name}${keySuffix}${archiveSuffix}`;
            this.expenseCategoryOptions.append(new Option(label, label));
            this.categoryKeyByNormalizedLabel.set(this.normalizeCategoryLabel(label), category.key);
            this.categoryLabelByKey.set(category.key, label);
        }
        this.expenseCategory.placeholder = this.locale.t("expenses.noCategory");
        const defaultKey = useDefault ? this.getDefaultCategoryKey(categories) : "";
        this.setCategoryControlValue(selectedKey || defaultKey || null);
        this.updateCategoryHint();
    }

    /**
     * Displays a persisted category choice in the searchable text control.
     * @param {string | null} categoryKey Stable category key, or null to clear the optional field.
     * @returns {void}
     */
    setCategoryControlValue(categoryKey) {
        this.expenseCategory.value = categoryKey ? this.categoryLabelByKey.get(categoryKey) || "" : "";
    }

    /**
     * Resolves the current category text back to a stable key.
     * Blank input explicitly means no category; undefined identifies arbitrary text that is not an existing selectable category.
     * @returns {string | null | undefined}
     */
    getCategoryControlKey() {
        const normalized = this.normalizeCategoryLabel(this.expenseCategory.value);
        if (!normalized) return null;
        return this.categoryKeyByNormalizedLabel.get(normalized);
    }

    /**
     * Rebuilds the common-case single-payer selector, retaining archived participants referenced by the edited record.
     * Complex existing payer contributions are represented by a localized synthetic option and remain lossless in the detailed grid.
     * @param {import("./model.js").Expense | null} expense Existing expense or null for creation.
     * @returns {void}
     */
    populatePayerControl(expense) {
        const referenced = new Set((expense?.payers || []).map((line) => line.participant_key));
        const participants = this.store
            .getParticipants()
            .filter((participant) => !participant.archived || referenced.has(participant.key))
            .sort((left, right) => this.locale.compare(left.name, right.name));
        this.expensePayer.innerHTML = "";
        for (const participant of participants) {
            this.expensePayer.append(new Option(participant.name, participant.key));
        }
        const simplePayer =
            expense?.payers.length === 1 && expense.payers[0].amount_minor === expense.amount_minor
                ? expense.payers[0].participant_key
                : "";
        if (participants.length > 1) this.ensureMultiplePayerOption();
        if (expense && !simplePayer) {
            this.expensePayer.value = "__custom__";
            return;
        }
        this.expensePayer.value = simplePayer || this.getDefaultPayerKey(participants);
        this.lastSimplePayerKey = this.expensePayer.value;
    }

    /**
     * Adds the synthetic multiple-payer option only when detailed paid amounts require it.
     * @returns {void}
     */
    ensureMultiplePayerOption() {
        if ([...this.expensePayer.options].some((option) => option.value === "__custom__")) return;
        this.expensePayer.append(new Option(this.locale.t("expenses.multiplePayers"), "__custom__"));
    }

    /**
     * Applies the quick payer selection to the detailed paid-amount inputs.
     * The selected participant remains automatic until a detailed payer amount is edited, so changing the total keeps the common one-payer case internally consistent.
     * @returns {void}
     */
    applySelectedPayer() {
        const selectedKey = this.expensePayer.value;
        if (!selectedKey) return;
        if (selectedKey === "__custom__") {
            this.expensePayerCustomFields.hidden = false;
            this.configurePayerAutoBalance();
            this.refreshExpenseComposer();
            return;
        }
        this.lastSimplePayerKey = selectedKey;
        this.expensePayerCustomFields.hidden = true;
        for (const candidate of this.expensePayerRows.querySelectorAll(".expense-paid-input")) {
            if (!(candidate instanceof HTMLInputElement)) continue;
            delete candidate.dataset.autoPayer;
            delete candidate.dataset.autoRemainder;
            candidate.readOnly = false;
            candidate.closest(".expense-person-row")?.classList.remove("is-auto");
            if (candidate.dataset.participantKey === selectedKey) {
                candidate.value = this.expenseAmount.value;
                candidate.dataset.autoPayer = "true";
            } else {
                candidate.value = "";
            }
        }
        this.refreshExpenseComposer();
    }

    /**
     * Marks a simple existing full payer as automatic so subsequent total edits do not create an avoidable validation error.
     * @param {import("./model.js").Expense} expense Existing expense represented by the current split rows.
     * @returns {void}
     */
    markAutomaticSinglePayer(expense) {
        if (expense.payers.length !== 1 || expense.payers[0].amount_minor !== expense.amount_minor) return;
        const input = this.expensePayerRows.querySelector(
            `.expense-paid-input[data-participant-key="${CSS.escape(expense.payers[0].participant_key)}"]`,
        );
        if (input instanceof HTMLInputElement) input.dataset.autoPayer = "true";
    }

    /**
     * Rebalances the calculated payer row after a manual custom-payment edit.
     * @param {Event} event Delegated input event from the payer editor.
     * @returns {void}
     */
    handlePayerInput(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.classList.contains("expense-paid-input")) return;
        delete input.dataset.autoPayer;
        this.updatePayerAutoRemainder();
        this.refreshExpenseComposer();
    }

    /**
     * Rebalances an exact split after a manual owed-amount edit and refreshes every monetary explanation.
     * @param {Event} event Delegated input or change event from the split editor.
     * @returns {void}
     */
    handleSplitInput(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.classList.contains("expense-owed-input")) return;
        if (["exact", "percentage"].includes(this.expenseAllocationType.value)) this.updateSplitAutoRemainder();
        this.refreshExpenseComposer();
    }

    /**
     * Reads the total and currency only when both are currently valid enough for a preview.
     * Validation remains authoritative on submit; this tolerant reader merely keeps partially typed forms calm.
     * @returns {{amountMinor: number, currency: string, digits: number} | null}
     */
    getDraftAmountState() {
        const currency = this.expenseCurrency.value.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency) || !this.expenseAmount.value.trim()) return null;
        try {
            const digits = this.locale.currencyMinorDigits(currency);
            return {
                amountMinor: parseScaledInteger(this.expenseAmount.value, digits, this.locale.t("expenses.amount")),
                currency,
                digits,
            };
        } catch {
            return null;
        }
    }

    /**
     * Parses an optional draft money input without surfacing validation while the user is still typing.
     * @param {HTMLInputElement} input Monetary participant input.
     * @param {number} digits Currency minor-unit precision.
     * @returns {number | null}
     */
    readDraftMoneyInput(input, digits) {
        if (!input.value.trim()) return 0;
        try {
            return parseScaledInteger(input.value, digits, this.locale.t("expenses.amount"), true);
        } catch {
            return null;
        }
    }

    /**
     * Returns currently entered payer contributions, or null when any visible value is syntactically incomplete.
     * @returns {Array<{participant_key: string, amount_minor: number}> | null}
     */
    getDraftPayers() {
        const amountState = this.getDraftAmountState();
        if (!amountState) return null;
        const payers = [];
        for (const candidate of this.expensePayerRows.querySelectorAll(".expense-paid-input")) {
            if (!(candidate instanceof HTMLInputElement)) continue;
            const amountMinor = this.readDraftMoneyInput(candidate, amountState.digits);
            if (amountMinor === null) return null;
            if (amountMinor > 0) {
                payers.push({ participant_key: candidate.dataset.participantKey || "", amount_minor: amountMinor });
            }
        }
        return payers;
    }

    /**
     * Formats a compact participant list for summary cards while preserving full names for small groups.
     * @param {string[]} participantKeys Stable participant keys.
     * @returns {string}
     */
    formatParticipantList(participantKeys) {
        const names = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        const labels = [...new Set(participantKeys)].map((key) => names.get(key) || key).filter(Boolean);
        if (labels.length <= 2) return labels.join(" + ");
        return this.locale.t("expenses.peopleSummary", {
            people: labels.slice(0, 2).join(", "),
            count: this.locale.formatNumber(labels.length - 2),
        });
    }

    /**
     * Updates the payer summary card from actual contribution rows rather than merely echoing a select value.
     * @returns {void}
     */
    updatePayerSummary() {
        const amountState = this.getDraftAmountState();
        const payers = this.getDraftPayers();
        const names = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        const selectedKey = this.expensePayer.value;
        if (selectedKey !== "__custom__") {
            this.expensePayerSummary.textContent = names.get(selectedKey) || this.locale.t("expenses.choosePayer");
        } else if (payers?.length) {
            this.expensePayerSummary.textContent = this.formatParticipantList(
                payers.map((payer) => payer.participant_key),
            );
        } else {
            this.expensePayerSummary.textContent = this.locale.t("expenses.multiplePayers");
        }
        if (!amountState) {
            this.expensePayerSummaryMeta.textContent = this.locale.t("expenses.enterAmountShort");
            return;
        }
        const payerTotal = payers?.reduce((sum, payer) => sum + payer.amount_minor, 0);
        if (!payers || payerTotal !== amountState.amountMinor) {
            this.expensePayerSummaryMeta.textContent = this.locale.t("expenses.paymentIncomplete");
            return;
        }
        const people = this.formatParticipantList(payers.map((payer) => payer.participant_key));
        this.expensePayerSummaryMeta.textContent = this.locale.t(
            payers.length === 1 ? "expenses.payerAmountSummary" : "expenses.payersAmountSummary",
            {
                participant: people,
                count: this.locale.formatNumber(payers.length),
                amount: this.locale.formatMinorCurrency(amountState.amountMinor, amountState.currency),
            },
        );
    }

    /**
     * Updates the split card with both the selected rule and its real monetary consequence.
     * @returns {void}
     */
    updateSplitSummary() {
        const type = this.expenseAllocationType.value;
        const amountState = this.getDraftAmountState();
        const allocations = this.getDraftAllocations();
        const participantKeys = allocations?.map((allocation) => allocation.participant_key) || this.getIncludedParticipantKeys();
        const people = this.formatParticipantList(participantKeys);
        const keys = {
            equal: "expenses.splitEqualPeople",
            percentage: "expenses.splitPercentageSummary",
            shares: "expenses.splitSharesSummary",
            exact: "expenses.splitExactSummary",
        };
        this.expenseSplitSummary.textContent = this.locale.t(keys[type] || "expenses.splitExactSummary", { people });
        if (!amountState) {
            this.expenseSplitSummaryMeta.textContent = this.locale.t("expenses.enterAmountShort");
            return;
        }
        if (!allocations?.length) {
            this.expenseSplitSummaryMeta.textContent = this.locale.t("expenses.splitIncomplete");
            return;
        }
        const distinctAmounts = new Set(allocations.map((allocation) => allocation.amount_minor));
        if (distinctAmounts.size === 1) {
            this.expenseSplitSummaryMeta.textContent = this.locale.t("expenses.eachAmount", {
                amount: this.locale.formatMinorCurrency(allocations[0].amount_minor, amountState.currency),
            });
            return;
        }
        const names = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        this.expenseSplitSummaryMeta.textContent = allocations
            .slice(0, 2)
            .map((allocation) => `${names.get(allocation.participant_key) || allocation.participant_key} ${this.locale.formatMinorCurrency(allocation.amount_minor, amountState.currency)}`)
            .join(" · ");
    }

    /**
     * Shows or clears one modal-local validation message.
     * @param {HTMLElement} element Inline error surface inside the active dialog.
     * @param {string} message Message to show, or an empty string to hide the surface.
     * @returns {void}
     */
    setInlineError(element, message) {
        const text = String(message || "").trim();
        element.textContent = text;
        element.hidden = !text;
    }

    /**
     * Clears stale expense validation as soon as the user changes any form value.
     * @returns {void}
     */
    clearExpenseDialogError() {
        this.setInlineError(this.expenseDialogError, "");
    }

    /**
     * Reveals a guided validation error inside the top-layer modal and focuses its responsible control.
     * @param {unknown} error Validation or model error.
     * @returns {void}
     */
    showExpenseDialogError(error) {
        const guided = error instanceof ExpenseFormError ? error : null;
        const message = error instanceof Error ? error.message : String(error);
        this.setInlineError(this.expenseDialogError, message);
        if (guided?.disclosure instanceof HTMLDetailsElement) guided.disclosure.open = true;
        else if (guided?.disclosure === this.expensePayerPanel) this.setExpenseContextPanel("payer");
        else if (guided?.disclosure === this.expenseSplitPanel) this.setExpenseContextPanel("split");
        queueMicrotask(() => {
            this.expenseDialogError.scrollIntoView({ block: "nearest" });
            const control = guided?.control;
            if (!control) return;
            control.focus({ preventScroll: true });
            if (control instanceof HTMLInputElement && control.type !== "checkbox") control.select();
        });
    }

    /**
     * Parses one monetary or weighted control and attaches field-navigation metadata to any syntax error.
     * @param {HTMLInputElement} input Source control.
     * @param {number} fractionDigits Decimal scaling precision.
     * @param {string} label Localized value label.
     * @param {boolean} [allowZero] Whether zero is accepted.
     * @param {HTMLElement | null} [disclosure] Progressive section containing the control.
     * @returns {number}
     */
    parseFormScaledInteger(input, fractionDigits, label, allowZero = false, disclosure = null) {
        try {
            return parseScaledInteger(input.value, fractionDigits, label, allowZero);
        } catch (error) {
            throw new ExpenseFormError(error instanceof Error ? error.message : String(error), input, disclosure);
        }
    }

    /**
     * Rebuilds the shared project/section datalist and selects one assignment by stable keys.
     * @param {string | null} projectKey Project key.
     * @param {string | null} sectionKey Section key.
     * @returns {void}
     */
    populateProjectControl(projectKey, sectionKey) {
        this.expenseAssignmentList.innerHTML = "";
        for (const option of this.projectStore.getAssignmentOptions()) {
            if (option.archived && (option.projectKey !== projectKey || option.sectionKey !== sectionKey)) continue;
            this.expenseAssignmentList.append(new Option(option.label, option.label));
        }
        const assignment = this.projectStore.resolveAssignment(projectKey, sectionKey);
        this.expenseAssignment.value = assignment?.label || "";
    }

    /**
     * Builds the avatar-and-name identity shared by payer and split rows.
     * @param {import("./model.js").ExpenseParticipant} participant Participant represented by the row.
     * @returns {HTMLElement}
     */
    buildParticipantIdentity(participant) {
        const identity = document.createElement("span");
        identity.className = "expense-person-name";
        const avatar = document.createElement("span");
        avatar.className = "expense-person-avatar";
        avatar.textContent = participant.name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0] || "")
            .join("")
            .toLocaleUpperCase();
        const name = document.createElement("span");
        name.textContent = participant.name;
        identity.append(avatar, name);
        return identity;
    }

    /**
     * Wraps a participant input with a small dynamic unit label.
     * @param {HTMLInputElement} input Participant amount, percentage, share, or checkbox control.
     * @param {string} unit Unit displayed inside the control.
     * @returns {HTMLElement}
     */
    buildParticipantInputWrap(input, unit) {
        const wrap = document.createElement("span");
        wrap.className = `expense-person-input-wrap${input.type === "checkbox" ? " is-checkbox" : ""}`;
        const unitLabel = document.createElement("span");
        unitLabel.className = "expense-person-unit";
        unitLabel.textContent = unit;
        wrap.append(input, unitLabel);
        return wrap;
    }

    /**
     * Renders independent payer and split editors for every active or referenced participant.
     * Separating the two concepts prevents the persisted ledger matrix from leaking into the common entry flow while retaining lossless imported records.
     * @param {import("./model.js").Expense | null} expense Existing expense or null for creation.
     * @returns {void}
     */
    renderParticipantEditors(expense) {
        this.expensePayerRows.innerHTML = "";
        this.expenseSplitRows.innerHTML = "";
        const referenced = new Set([
            ...(expense?.payers || []).map((line) => line.participant_key),
            ...(expense?.allocations || []).map((line) => line.participant_key),
        ]);
        const participants = this.store
            .getParticipants()
            .filter((participant) => !participant.archived || referenced.has(participant.key))
            .sort((left, right) => this.locale.compare(left.name, right.name));
        const payerByKey = new Map((expense?.payers || []).map((line) => [line.participant_key, line.amount_minor]));
        const allocationByKey = new Map((expense?.allocations || []).map((line) => [line.participant_key, line.amount_minor]));
        const ruleByKey = new Map((expense?.allocation_rule?.units || []).map((unit) => [unit.participant_key, unit.value]));
        const currency = expense?.currency || this.expenseCurrency.value || "EUR";
        const digits = this.locale.currencyMinorDigits(currency);
        const type = this.expenseAllocationType.value;

        for (const participant of participants) {
            const payerRow = document.createElement("div");
            payerRow.className = "expense-person-row expense-payer-row";
            payerRow.dataset.participantKey = participant.key;
            const paid = document.createElement("input");
            paid.type = "text";
            paid.inputMode = "decimal";
            paid.className = "expense-paid-input";
            paid.dataset.participantKey = participant.key;
            paid.setAttribute("aria-label", this.locale.t("expenses.paidBy", { participant: participant.name }));
            const paidValue = payerByKey.get(participant.key);
            paid.value = paidValue ? formatScaledInput(paidValue, digits) : "";
            const payerResult = document.createElement("span");
            payerResult.className = "expense-person-result expense-payer-result";
            payerResult.dataset.participantKey = participant.key;
            payerRow.append(this.buildParticipantIdentity(participant), this.buildParticipantInputWrap(paid, currency), payerResult);
            this.expensePayerRows.append(payerRow);

            const splitRow = document.createElement("div");
            splitRow.className = "expense-person-row expense-split-row";
            splitRow.dataset.participantKey = participant.key;
            const owed = document.createElement("input");
            owed.className = "expense-owed-input";
            owed.dataset.participantKey = participant.key;
            owed.setAttribute("aria-label", this.locale.t("expenses.owedBy", { participant: participant.name }));
            const allocationValue = allocationByKey.get(participant.key);
            const ruleValue = ruleByKey.get(participant.key);
            let unit = "";
            if (type === "equal") {
                owed.type = "checkbox";
                owed.value = "1";
                owed.checked = expense ? ruleByKey.has(participant.key) || allocationByKey.has(participant.key) : true;
            } else if (type === "percentage") {
                owed.type = "text";
                owed.inputMode = "decimal";
                owed.value = ruleValue ? formatScaledInput(ruleValue, 2) : "";
                unit = "%";
            } else if (type === "shares") {
                owed.type = "text";
                owed.inputMode = "numeric";
                owed.value = ruleValue ? String(ruleValue) : "";
                unit = "×";
            } else {
                owed.type = "text";
                owed.inputMode = "decimal";
                owed.value = allocationValue ? formatScaledInput(allocationValue, digits) : "";
                unit = currency;
            }
            const splitResult = document.createElement("span");
            splitResult.className = "expense-person-result expense-split-result";
            splitResult.dataset.participantKey = participant.key;
            splitRow.append(this.buildParticipantIdentity(participant), this.buildParticipantInputWrap(owed, unit), splitResult);
            this.expenseSplitRows.append(splitRow);
        }
        this.expensePayerCustomFields.hidden = this.expensePayer.value !== "__custom__";
        this.updateAllocationHeading();
        this.updateAllocationChoices();
        this.updateParticipantInputUnits();
    }

    /**
     * Changes the owed-column label to explain the active split-rule units.
     * @returns {void}
     */
    updateAllocationHeading() {
        const keys = {
            equal: "expenses.included",
            percentage: "expenses.percentage",
            shares: "expenses.shares",
            exact: "expenses.owed",
        };
        this.expenseOwedHeading.textContent = this.locale.t(keys[this.expenseAllocationType.value] || "expenses.owed");
    }

    /**
     * Returns participant keys currently included by the visible split controls.
     * @returns {string[]}
     */
    getIncludedParticipantKeys() {
        const keys = [];
        for (const input of this.expenseSplitRows.querySelectorAll(".expense-owed-input")) {
            if (!(input instanceof HTMLInputElement)) continue;
            const included = input.type === "checkbox" ? input.checked : Number(input.value.replace(",", ".")) > 0;
            if (included) keys.push(input.dataset.participantKey || "");
        }
        return keys.filter(Boolean);
    }

    /**
     * Resolves the currently displayed split controls into exact allocations for previews and mode conversion.
     * Invalid or incomplete draft controls return null; authoritative validation remains in collectExpenseDetails.
     * @returns {Array<{participant_key: string, amount_minor: number}> | null}
     */
    getDraftAllocations() {
        const amountState = this.getDraftAmountState();
        if (!amountState) return null;
        const type = this.expenseAllocationType.value;
        const units = [];
        for (const input of this.expenseSplitRows.querySelectorAll(".expense-owed-input")) {
            if (!(input instanceof HTMLInputElement)) continue;
            const key = input.dataset.participantKey || "";
            if (!key) continue;
            if (type === "equal") {
                if (input.checked) units.push({ participant_key: key, value: 1 });
                continue;
            }
            if (!input.value.trim()) continue;
            try {
                const digits = type === "percentage" ? 2 : type === "exact" ? amountState.digits : 0;
                const value = parseScaledInteger(input.value, digits, this.locale.t("expenses.owed"), true);
                if (value) units.push({ participant_key: key, value });
            } catch {
                return null;
            }
        }
        if (!units.length) return null;
        if (type === "percentage" && units.reduce((sum, unit) => sum + unit.value, 0) !== 10000) return null;
        if (type === "exact") {
            const allocations = units.map((unit) => ({
                participant_key: unit.participant_key,
                amount_minor: unit.value,
            }));
            return allocations.reduce((sum, allocation) => sum + allocation.amount_minor, 0) === amountState.amountMinor
                ? allocations
                : null;
        }
        try {
            return allocateExpenseByWeights(amountState.amountMinor, units);
        } catch {
            return null;
        }
    }

    /**
     * Handles one segmented split-rule button without exposing the hidden serialization select.
     * @param {Event} event Delegated click event from the split-rule group.
     * @returns {void}
     */
    handleAllocationChoice(event) {
        const button = event.target instanceof Element ? event.target.closest("[data-allocation-type]") : null;
        if (!(button instanceof HTMLButtonElement)) return;
        const type = button.dataset.allocationType || "";
        if (!["equal", "percentage", "shares", "exact"].includes(type)) return;
        this.changeAllocationType(type);
    }

    /**
     * Converts the split editor to another rule while preserving the current monetary result wherever possible.
     * Exact and percentage modes designate one calculated remainder row, eliminating ordinary total-mismatch errors by construction.
     * @param {string} nextType New allocation rule.
     * @returns {void}
     */
    changeAllocationType(nextType) {
        if (nextType === this.expenseAllocationType.value) return;
        const amountState = this.getDraftAmountState();
        const includedBefore = new Set(this.getIncludedParticipantKeys());
        const currentAllocations = this.getDraftAllocations();
        const allocationByKey = new Map(
            (currentAllocations || []).map((allocation) => [allocation.participant_key, allocation.amount_minor]),
        );
        if (!allocationByKey.size && amountState && includedBefore.size) {
            const fallback = allocateExpenseByWeights(
                amountState.amountMinor,
                [...includedBefore].map((participantKey) => ({ participant_key: participantKey, value: 1 })),
            );
            for (const allocation of fallback) allocationByKey.set(allocation.participant_key, allocation.amount_minor);
        }
        this.expenseAllocationType.value = nextType;
        const inputs = [...this.expenseSplitRows.querySelectorAll(".expense-owed-input")].filter(
            (input) => input instanceof HTMLInputElement,
        );
        const positiveAllocations = [...allocationByKey.values()].filter((value) => value > 0);
        const divisor = positiveAllocations.reduce((result, value) => greatestCommonDivisor(result, value), 0) || 1;
        const percentageByKey = new Map();
        if (nextType === "percentage" && amountState && allocationByKey.size) {
            let assigned = 0;
            for (const [key, amountMinor] of allocationByKey) {
                const basisPoints = Math.floor((amountMinor * 10000) / amountState.amountMinor);
                percentageByKey.set(key, basisPoints);
                assigned += basisPoints;
            }
            const firstKey = allocationByKey.keys().next().value;
            if (firstKey) percentageByKey.set(firstKey, (percentageByKey.get(firstKey) || 0) + 10000 - assigned);
        }
        for (const input of inputs) {
            const key = input.dataset.participantKey || "";
            const amountMinor = allocationByKey.get(key) || 0;
            input.readOnly = false;
            delete input.dataset.autoRemainder;
            input.closest(".expense-person-row")?.classList.remove("is-auto");
            if (nextType === "equal") {
                input.type = "checkbox";
                input.value = "1";
                input.checked = allocationByKey.size ? amountMinor > 0 : includedBefore.has(key);
            } else if (nextType === "percentage") {
                input.type = "text";
                input.inputMode = "decimal";
                input.value = amountMinor ? formatScaledInput(percentageByKey.get(key) || 0, 2) : "";
            } else if (nextType === "shares") {
                input.type = "text";
                input.inputMode = "numeric";
                input.value = amountMinor ? String(Math.max(1, Math.round(amountMinor / divisor))) : "";
            } else {
                input.type = "text";
                input.inputMode = "decimal";
                input.value = amountMinor && amountState ? formatScaledInput(amountMinor, amountState.digits) : "";
            }
        }
        if (["exact", "percentage"].includes(nextType)) this.configureSplitAutoBalance();
        this.updateAllocationHeading();
        this.updateAllocationChoices();
        this.updateParticipantInputUnits();
        this.refreshExpenseComposer();
    }

    /**
     * Reflects the hidden allocation value into the visible segmented rule buttons.
     * @returns {void}
     */
    updateAllocationChoices() {
        const selected = this.expenseAllocationType.value;
        for (const button of this.expenseAllocationChoices.querySelectorAll("[data-allocation-type]")) {
            if (!(button instanceof HTMLButtonElement)) continue;
            button.setAttribute("aria-pressed", String(button.dataset.allocationType === selected));
        }
    }

    /**
     * Updates participant input suffixes and checkbox layout after split-rule or currency changes.
     * @returns {void}
     */
    updateParticipantInputUnits() {
        const currency = this.expenseCurrency.value.trim().toUpperCase() || "—";
        for (const row of this.expensePayerRows.querySelectorAll(".expense-person-row")) {
            const unit = row.querySelector(".expense-person-unit");
            if (unit instanceof HTMLElement) unit.textContent = currency;
        }
        const type = this.expenseAllocationType.value;
        const splitUnit = type === "percentage" ? "%" : type === "shares" ? "×" : type === "exact" ? currency : "";
        for (const row of this.expenseSplitRows.querySelectorAll(".expense-person-row")) {
            const input = row.querySelector(".expense-owed-input");
            const wrap = row.querySelector(".expense-person-input-wrap");
            const unit = row.querySelector(".expense-person-unit");
            if (wrap instanceof HTMLElement) wrap.classList.toggle("is-checkbox", input instanceof HTMLInputElement && input.type === "checkbox");
            if (unit instanceof HTMLElement) unit.textContent = splitUnit;
        }
    }

    /**
     * Designates one custom payer as the calculated remainder so payment contributions always add up to the receipt total.
     * @returns {void}
     */
    configurePayerAutoBalance() {
        const inputs = [...this.expensePayerRows.querySelectorAll(".expense-paid-input")].filter(
            (input) => input instanceof HTMLInputElement,
        );
        for (const input of inputs) {
            input.readOnly = false;
            delete input.dataset.autoPayer;
            delete input.dataset.autoRemainder;
            input.closest(".expense-person-row")?.classList.remove("is-auto");
        }
        const autoInput = [...inputs].reverse().find((input) => input.dataset.participantKey !== this.lastSimplePayerKey) || inputs[inputs.length - 1];
        if (!autoInput) return;
        autoInput.readOnly = true;
        autoInput.dataset.autoRemainder = "true";
        autoInput.closest(".expense-person-row")?.classList.add("is-auto");
        this.updatePayerAutoRemainder();
    }

    /**
     * Recalculates the custom payer remainder from all manually editable payer rows.
     * @returns {void}
     */
    updatePayerAutoRemainder() {
        if (this.expensePayer.value !== "__custom__") return;
        const autoInput = this.expensePayerRows.querySelector('.expense-paid-input[data-auto-remainder="true"]');
        if (!(autoInput instanceof HTMLInputElement)) return;
        const amountState = this.getDraftAmountState();
        if (!amountState) {
            autoInput.value = "";
            return;
        }
        let assigned = 0;
        for (const input of this.expensePayerRows.querySelectorAll(".expense-paid-input")) {
            if (!(input instanceof HTMLInputElement) || input === autoInput) continue;
            const value = this.readDraftMoneyInput(input, amountState.digits);
            if (value === null) {
                autoInput.value = "";
                return;
            }
            assigned += value;
        }
        const remainder = amountState.amountMinor - assigned;
        autoInput.value = remainder >= 0 ? formatScaledInput(remainder, amountState.digits) : "";
    }

    /**
     * Designates the final included percentage row, or final exact-allocation row, as the calculated remainder.
     * Existing imported allocations remain lossless because the remainder is derived from their already validated total; blank percentage rows stay excluded.
     * @returns {void}
     */
    configureSplitAutoBalance() {
        const type = this.expenseAllocationType.value;
        if (!["exact", "percentage"].includes(type)) return;
        const inputs = [...this.expenseSplitRows.querySelectorAll(".expense-owed-input")].filter(
            (input) => input instanceof HTMLInputElement,
        );
        for (const input of inputs) {
            input.readOnly = false;
            delete input.dataset.autoRemainder;
            input.closest(".expense-person-row")?.classList.remove("is-auto");
        }
        const populatedInputs = inputs.filter((input) => input.value.trim());
        const autoInput = type === "percentage"
            ? populatedInputs[populatedInputs.length - 1] || inputs[inputs.length - 1]
            : inputs[inputs.length - 1];
        if (!autoInput) return;
        autoInput.readOnly = true;
        autoInput.dataset.autoRemainder = "true";
        autoInput.closest(".expense-person-row")?.classList.add("is-auto");
        this.updateSplitAutoRemainder();
    }

    /**
     * Recalculates the exact-money or percentage remainder from all manually editable allocation rows.
     * Percentage values use basis points, so the generated final field closes to exactly 100.00 without floating-point drift.
     * @returns {void}
     */
    updateSplitAutoRemainder() {
        const type = this.expenseAllocationType.value;
        if (!["exact", "percentage"].includes(type)) return;
        const autoInput = this.expenseSplitRows.querySelector('.expense-owed-input[data-auto-remainder="true"]');
        if (!(autoInput instanceof HTMLInputElement)) return;
        const amountState = type === "exact" ? this.getDraftAmountState() : null;
        if (type === "exact" && !amountState) {
            autoInput.value = "";
            return;
        }
        const digits = type === "percentage" ? 2 : amountState?.digits || 0;
        const target = type === "percentage" ? 10000 : amountState?.amountMinor || 0;
        let assigned = 0;
        for (const input of this.expenseSplitRows.querySelectorAll(".expense-owed-input")) {
            if (!(input instanceof HTMLInputElement) || input === autoInput) continue;
            const value = this.readDraftMoneyInput(input, digits);
            if (value === null) {
                autoInput.value = "";
                return;
            }
            assigned += value;
        }
        const remainder = target - assigned;
        autoInput.value = remainder >= 0 ? formatScaledInput(remainder, digits) : "";
    }

    /**
     * Recalculates every active automatic remainder after the receipt total changes.
     * @returns {void}
     */
    updateAutomaticRemainders() {
        this.updatePayerAutoRemainder();
        this.updateSplitAutoRemainder();
    }

    /**
     * Copies the entered total into the first payer field only while no payer amount has been entered.
     * This optimizes the common single-payer case without overwriting an explicit multi-payer split.
     * @returns {void}
     */
    copyTotalToOnlyPayer() {
        if (this.expensePayer.value === "__custom__") {
            this.updatePayerAutoRemainder();
            return;
        }
        const inputs = [...this.expensePayerRows.querySelectorAll(".expense-paid-input")].filter(
            (input) => input instanceof HTMLInputElement,
        );
        if (!inputs.length) return;
        const automatic = inputs.find((input) => input.dataset.autoPayer === "true");
        if (automatic) {
            automatic.value = this.expenseAmount.value;
            return;
        }
        if (inputs.some((input) => input.value.trim())) return;
        inputs[0].dataset.autoPayer = "true";
        inputs[0].value = this.expenseAmount.value;
    }

    /**
     * Applies a message and semantic tone to one payer or split completion status.
     * @param {HTMLElement} element Status surface.
     * @param {string} message Localized status text.
     * @param {"neutral" | "complete" | "invalid"} tone Semantic status tone.
     * @returns {void}
     */
    setEditorStatus(element, message, tone = "neutral") {
        element.textContent = message;
        element.classList.toggle("is-complete", tone === "complete");
        element.classList.toggle("is-invalid", tone === "invalid");
    }

    /**
     * Updates calculated monetary values shown beside participant controls.
     * @returns {void}
     */
    updateParticipantResults() {
        const amountState = this.getDraftAmountState();
        const payers = this.getDraftPayers() || [];
        const allocations = this.getDraftAllocations() || [];
        const payerByKey = new Map(payers.map((payer) => [payer.participant_key, payer.amount_minor]));
        const allocationByKey = new Map(allocations.map((allocation) => [allocation.participant_key, allocation.amount_minor]));
        for (const result of this.expensePayerRows.querySelectorAll(".expense-payer-result")) {
            if (!(result instanceof HTMLElement)) continue;
            const amountMinor = payerByKey.get(result.dataset.participantKey || "") || 0;
            result.textContent = amountState && amountMinor ? this.locale.formatMinorCurrency(amountMinor, amountState.currency) : "—";
            const input = result.closest(".expense-person-row")?.querySelector(".expense-paid-input");
            result.classList.toggle("is-auto", input instanceof HTMLInputElement && input.dataset.autoRemainder === "true");
        }
        for (const result of this.expenseSplitRows.querySelectorAll(".expense-split-result")) {
            if (!(result instanceof HTMLElement)) continue;
            const amountMinor = allocationByKey.get(result.dataset.participantKey || "") || 0;
            result.textContent = amountState && amountMinor ? this.locale.formatMinorCurrency(amountMinor, amountState.currency) : "—";
            const input = result.closest(".expense-person-row")?.querySelector(".expense-owed-input");
            result.classList.toggle("is-auto", input instanceof HTMLInputElement && input.dataset.autoRemainder === "true");
        }
    }

    /**
     * Explains whether payer and split totals are complete, including which participant pays or is assigned an automatic remainder.
     * @returns {void}
     */
    updateEditorStatuses() {
        const amountState = this.getDraftAmountState();
        if (!amountState) {
            this.setEditorStatus(this.expensePayerRemaining, this.locale.t("expenses.enterAmountShort"));
            this.setEditorStatus(this.expenseSplitRemaining, this.locale.t("expenses.enterAmountShort"));
            return;
        }
        const names = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        const payers = this.getDraftPayers();
        const payerTotal = payers?.reduce((sum, payer) => sum + payer.amount_minor, 0);
        if (this.expensePayer.value === "__custom__") {
            const autoInput = this.expensePayerRows.querySelector('.expense-paid-input[data-auto-remainder="true"]');
            const manualTotal = [...this.expensePayerRows.querySelectorAll(".expense-paid-input")].reduce((sum, input) => {
                if (!(input instanceof HTMLInputElement) || input === autoInput) return sum;
                return sum + (this.readDraftMoneyInput(input, amountState.digits) || 0);
            }, 0);
            if (manualTotal > amountState.amountMinor) {
                this.setEditorStatus(
                    this.expensePayerRemaining,
                    this.locale.t("expenses.overTotal", {
                        amount: this.locale.formatMinorCurrency(manualTotal - amountState.amountMinor, amountState.currency),
                    }),
                    "invalid",
                );
            } else if (payers && payerTotal === amountState.amountMinor && autoInput instanceof HTMLInputElement) {
                const remaining = amountState.amountMinor - manualTotal;
                this.setEditorStatus(
                    this.expensePayerRemaining,
                    remaining
                        ? this.locale.t("expenses.autoBalanceSummary", {
                              participant: names.get(autoInput.dataset.participantKey || "") || "",
                              amount: this.locale.formatMinorCurrency(remaining, amountState.currency),
                          })
                        : this.locale.t("expenses.paymentAssigned", {
                              amount: this.locale.formatMinorCurrency(amountState.amountMinor, amountState.currency),
                          }),
                    "complete",
                );
            } else {
                this.setEditorStatus(this.expensePayerRemaining, this.locale.t("expenses.paymentIncomplete"), "invalid");
            }
        }

        const allocations = this.getDraftAllocations();
        if (allocations?.length) {
            const autoInput = this.expenseSplitRows.querySelector('.expense-owed-input[data-auto-remainder="true"]');
            if (this.expenseAllocationType.value === "exact" && autoInput instanceof HTMLInputElement) {
                const autoAmount = this.readDraftMoneyInput(autoInput, amountState.digits) || 0;
                this.setEditorStatus(
                    this.expenseSplitRemaining,
                    autoAmount
                        ? this.locale.t("expenses.autoSplitSummary", {
                              participant: names.get(autoInput.dataset.participantKey || "") || "",
                              amount: this.locale.formatMinorCurrency(autoAmount, amountState.currency),
                          })
                        : this.locale.t("expenses.splitAssigned", {
                              amount: this.locale.formatMinorCurrency(amountState.amountMinor, amountState.currency),
                          }),
                    "complete",
                );
            } else {
                this.setEditorStatus(
                    this.expenseSplitRemaining,
                    this.locale.t("expenses.splitAssigned", {
                        amount: this.locale.formatMinorCurrency(amountState.amountMinor, amountState.currency),
                    }),
                    "complete",
                );
            }
        } else {
            this.setEditorStatus(this.expenseSplitRemaining, this.locale.t("expenses.splitIncomplete"), "invalid");
        }
    }

    /**
     * Computes the settlement effect of this single draft expense and presents it in ordinary language.
     * @returns {void}
     */
    updateOutcomePreview() {
        const amountState = this.getDraftAmountState();
        this.expenseOutcome.hidden = true;
        this.expenseOutcome.classList.remove("is-ready");
        this.expenseOutcomeSummary.textContent = "";
        this.expenseOutcomeDetails.textContent = "";
        if (!amountState) return;
        const payers = this.getDraftPayers();
        const allocations = this.getDraftAllocations();
        if (
            !payers?.length ||
            payers.reduce((sum, payer) => sum + payer.amount_minor, 0) !== amountState.amountMinor ||
            !allocations?.length
        ) return;
        const balances = new Map();
        for (const payer of payers) balances.set(payer.participant_key, (balances.get(payer.participant_key) || 0) + payer.amount_minor);
        for (const allocation of allocations) balances.set(allocation.participant_key, (balances.get(allocation.participant_key) || 0) - allocation.amount_minor);
        const debtors = [...balances]
            .filter(([, amount]) => amount < 0)
            .map(([key, amount]) => ({ key, amount: -amount }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const creditors = [...balances]
            .filter(([, amount]) => amount > 0)
            .map(([key, amount]) => ({ key, amount }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const transfers = [];
        let debtorIndex = 0;
        let creditorIndex = 0;
        while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
            const debtor = debtors[debtorIndex];
            const creditor = creditors[creditorIndex];
            const amountMinor = Math.min(debtor.amount, creditor.amount);
            transfers.push({ from: debtor.key, to: creditor.key, amountMinor });
            debtor.amount -= amountMinor;
            creditor.amount -= amountMinor;
            if (!debtor.amount) debtorIndex += 1;
            if (!creditor.amount) creditorIndex += 1;
        }
        const names = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        this.expenseOutcome.hidden = false;
        if (!transfers.length) {
            this.expenseOutcomeSummary.textContent = this.locale.t("expenses.outcomeEven");
            this.expenseOutcome.classList.add("is-ready");
            return;
        }
        const lines = transfers.map((transfer) => this.locale.t("expenses.outcomeTransfer", {
            from: names.get(transfer.from) || transfer.from,
            to: names.get(transfer.to) || transfer.to,
            amount: this.locale.formatMinorCurrency(transfer.amountMinor, amountState.currency),
        }));
        this.expenseOutcomeSummary.textContent = lines[0];
        this.expenseOutcomeDetails.textContent = lines.slice(1).join(" · ");
        this.expenseOutcome.classList.add("is-ready");
    }

    /**
     * Refreshes every explanation derived from the current receipt draft.
     * Keeping this orchestration in one method makes amount, currency, participant, and rule edits converge on identical UI state.
     * @returns {void}
     */
    refreshExpenseComposer() {
        this.updateAllocationChoices();
        this.updateParticipantInputUnits();
        this.updateParticipantResults();
        this.updatePayerSummary();
        this.updateSplitSummary();
        this.updateEditorStatuses();
        this.updateOutcomePreview();
    }

    /**
     * Re-renders participant money inputs after a currency change so the new minor-unit precision is explicit.
     * Values are intentionally retained as entered because converting currencies is outside ledger semantics.
     * @returns {void}
     */
    reformatSplitMoneyInputs() {
        this.expenseCurrency.value = this.expenseCurrency.value.trim().toUpperCase();
        this.updateAllocationHeading();
        this.updateAutomaticRemainders();
        this.refreshExpenseComposer();
    }

    /**
     * Reads one participant input collection as positive integer scaled values, omitting blank and zero rows.
     * @param {string} selector Input selector within the payer or split rows.
     * @param {number} fractionDigits Decimal scaling precision.
     * @param {string} label Localized field label.
     * @returns {Array<{participant_key: string, value: number}>}
     */
    collectParticipantValues(selector, fractionDigits, label) {
        const values = [];
        const isPayer = selector.includes("expense-paid-input");
        const root = isPayer ? this.expensePayerRows : this.expenseSplitRows;
        const disclosure = isPayer ? this.expensePayerPanel : this.expenseSplitPanel;
        for (const candidate of root.querySelectorAll(selector)) {
            if (!(candidate instanceof HTMLInputElement)) continue;
            const text = candidate.type === "checkbox" ? (candidate.checked ? candidate.value || "1" : "") : candidate.value.trim();
            if (!text) continue;
            let value;
            try {
                value = parseScaledInteger(text, fractionDigits, label, true);
            } catch (error) {
                throw new ExpenseFormError(
                    error instanceof Error ? error.message : String(error),
                    candidate,
                    disclosure,
                );
            }
            if (!value) continue;
            values.push({ participant_key: candidate.dataset.participantKey || "", value });
        }
        return values;
    }

    /**
     * Collects and normalizes all expense dialog fields into exact store details.
     * Payer contributions and exact allocations are checked against the total before ExpenseStore reruns full model validation.
     * @returns {import("./store.js").ExpenseDetails}
     */
    collectExpenseDetails() {
        const currency = this.expenseCurrency.value.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
            throw new ExpenseFormError(
                this.locale.t("toast.expenseCurrency"),
                this.expenseCurrency,
                this.expenseAdvancedDetails,
            );
        }
        let digits;
        try {
            digits = this.locale.currencyMinorDigits(currency);
        } catch {
            throw new ExpenseFormError(
                this.locale.t("toast.expenseCurrency"),
                this.expenseCurrency,
                this.expenseAdvancedDetails,
            );
        }
        const amountMinor = this.parseFormScaledInteger(
            this.expenseAmount,
            digits,
            this.locale.t("expenses.amount"),
        );
        const description = this.expenseDescription.value.trim();
        if (!description) {
            throw new ExpenseFormError(this.locale.t("toast.expenseDescription"), this.expenseDescription);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(this.expenseDate.value)) {
            throw new ExpenseFormError(this.locale.t("toast.expenseDate"), this.expenseDate);
        }
        const categoryKey = this.getCategoryControlKey();
        if (categoryKey === undefined) {
            throw new ExpenseFormError(
                this.locale.t("toast.expenseCategorySelection"),
                this.expenseCategory,
            );
        }
        const payerValues = this.collectParticipantValues(
            ".expense-paid-input",
            digits,
            this.locale.t("expenses.paid"),
        );
        const payers = payerValues.map((line) => ({
            participant_key: line.participant_key,
            amount_minor: line.value,
        }));
        if (payers.reduce((sum, line) => sum + line.amount_minor, 0) !== amountMinor) {
            const customPayer = this.expensePayer.value === "__custom__";
            const payerInput = customPayer
                ? this.expensePayerRows.querySelector(".expense-paid-input:not([readonly])")
                : this.expensePayer;
            throw new ExpenseFormError(
                this.locale.t("toast.expensePayersTotal"),
                payerInput instanceof HTMLElement ? payerInput : this.expensePayer,
                customPayer ? this.expensePayerPanel : null,
            );
        }

        const type = this.expenseAllocationType.value;
        let units;
        if (type === "percentage") {
            units = this.collectParticipantValues(
                ".expense-owed-input",
                2,
                this.locale.t("expenses.percentage"),
            );
            if (units.reduce((sum, unit) => sum + unit.value, 0) !== 10000) {
                const input = this.expenseSplitRows.querySelector(".expense-owed-input");
                throw new ExpenseFormError(
                    this.locale.t("toast.expensePercentageTotal"),
                    input instanceof HTMLElement ? input : this.expenseAllocationType,
                    this.expenseSplitPanel,
                );
            }
        } else if (type === "exact") {
            units = this.collectParticipantValues(
                ".expense-owed-input",
                digits,
                this.locale.t("expenses.owed"),
            );
        } else {
            units = this.collectParticipantValues(
                ".expense-owed-input",
                0,
                this.locale.t(type === "shares" ? "expenses.shares" : "expenses.included"),
            );
            if (type === "equal") units = units.map((unit) => ({ ...unit, value: 1 }));
        }
        if (!units.length) {
            const input = this.expenseSplitRows.querySelector(".expense-owed-input");
            throw new ExpenseFormError(
                this.locale.t("toast.expenseNeedsAllocation"),
                input instanceof HTMLElement ? input : this.expenseAllocationType,
                this.expenseSplitPanel,
            );
        }
        const allocations =
            type === "exact"
                ? units.map((unit) => ({ participant_key: unit.participant_key, amount_minor: unit.value }))
                : allocateExpenseByWeights(amountMinor, units);
        if (allocations.reduce((sum, line) => sum + line.amount_minor, 0) !== amountMinor) {
            const input = this.expenseSplitRows.querySelector(".expense-owed-input");
            throw new ExpenseFormError(
                this.locale.t("toast.expenseAllocationsTotal"),
                input instanceof HTMLElement ? input : this.expenseAllocationType,
                this.expenseSplitPanel,
            );
        }
        const assignment = this.projectStore.findAssignmentByLabel(this.expenseAssignment.value);
        if (!assignment) {
            throw new ExpenseFormError(
                this.locale.t("toast.invalidAssignment"),
                this.expenseAssignment,
                this.expenseAdvancedDetails,
            );
        }
        return {
            description,
            date: this.expenseDate.value,
            currency,
            amount_minor: amountMinor,
            payers,
            allocations,
            allocation_rule: {
                type: /** @type {import("./model.js").ExpenseAllocationRuleType} */ (type),
                units,
            },
            category_key: categoryKey,
            project_key: assignment.projectKey,
            section_key: assignment.sectionKey,
            notes: this.expenseNotes.value,
        };
    }

    /**
     * Creates or updates one expense as a single undoable action.
     * @param {SubmitEvent} event Expense form submission.
     * @returns {void}
     */
    handleExpenseSubmit(event) {
        event.preventDefault();
        if (this.busy || this.saveInFlight) return;
        let details;
        try {
            details = this.collectExpenseDetails();
        } catch (error) {
            this.showExpenseDialogError(error);
            return;
        }
        const editingId = this.editingExpenseId;
        let selectionAfter = editingId ? `expense:${editingId}` : null;
        let mutationError = null;
        const succeeded = this.applyMutation(
            editingId ? "Edit expense" : "Add expense",
            () => {
                if (editingId) {
                    this.store.updateExpense(editingId, details);
                } else {
                    const created = this.store.createExpense(details);
                    selectionAfter = `expense:${created.id}`;
                }
            },
            selectionAfter,
            (error) => {
                mutationError = error;
                this.showExpenseDialogError(error);
            },
        );
        if (!succeeded) {
            if (!mutationError) this.closeExpenseDialog();
            return;
        }
        const action = this.undoStack[this.undoStack.length - 1];
        if (action) action.selectionAfter = selectionAfter;
        this.selectedRecordKey = selectionAfter;
        this.closeExpenseDialog();
        this.render();
        this.selectRecord(selectionAfter);
    }

    /**
     * Deletes the expense currently open in the modal and relies on undo instead of confirmation.
     * @returns {void}
     */
    deleteEditingExpense() {
        if (!this.editingExpenseId) return;
        this.selectedRecordKey = `expense:${this.editingExpenseId}`;
        this.closeExpenseDialog();
        this.deleteSelectedRecord();
    }

    /**
     * Deletes the selected expense or transfer and chooses a nearby remaining row.
     * @returns {void}
     */
    deleteSelectedRecord() {
        const key = this.selectedRecordKey;
        if (!key) return;
        const visible = this.getVisibleRecords();
        const oldIndex = Math.max(0, visible.findIndex((record) => record.key === key));
        const [kind, ...idParts] = key.split(":");
        const id = idParts.join(":");
        const succeeded = this.applyMutation("Delete ledger record", () => {
            const deleted = kind === "transfer" ? this.store.deleteTransfer(id) : this.store.deleteExpense(id);
            if (!deleted) throw new Error(this.locale.t("toast.expenseMissing"));
        }, null);
        if (!succeeded) return;
        const next = this.getVisibleRecords();
        this.selectedRecordKey = next[Math.min(oldIndex, Math.max(0, next.length - 1))]?.key || null;
        this.render();
        this.selectRecord(this.selectedRecordKey);
    }

    /**
     * Applies one store mutation, records before/after snapshots, and refreshes durable dirty state.
     * @param {string} label Human-readable history label.
     * @param {() => void} mutation Synchronous validated store operation.
     * @param {string | null} [selectionAfter] Desired encoded selection after mutation.
     * @param {(error: unknown) => void} [onError] Optional modal-local error sink; ordinary list mutations continue using the global toast.
     * @returns {boolean} Whether the document changed.
     */
    applyMutation(label, mutation, selectionAfter = this.selectedRecordKey, onError = null) {
        if (this.busy || this.saveInFlight) return false;
        const before = this.store.snapshotRaw();
        const selectionBefore = this.selectedRecordKey;
        try {
            mutation();
        } catch (error) {
            this.store.applySnapshot(before);
            if (onError) onError(error);
            else this.onToast(error instanceof Error ? error.message : String(error));
            return false;
        }
        const after = this.store.snapshotRaw();
        if (expenseSnapshotsEqual(before, after)) return false;
        this.undoStack.push({ label, before, after, selectionBefore, selectionAfter });
        this.redoStack.length = 0;
        this.selectedRecordKey = selectionAfter;
        this.refreshDirtyState();
        this.render();
        return true;
    }

    /**
     * Restores the previous complete expense snapshot and records it for redo.
     * @returns {void}
     */
    undo() {
        if (this.busy || this.saveInFlight) return;
        const action = this.undoStack.pop();
        if (!action) return;
        this.store.applySnapshot(action.before);
        this.selectedRecordKey = action.selectionBefore;
        this.redoStack.push(action);
        this.refreshDirtyState();
        this.render();
        this.selectRecord(this.selectedRecordKey);
    }

    /**
     * Reapplies the next complete expense snapshot from redo history.
     * @returns {void}
     */
    redo() {
        if (this.busy || this.saveInFlight) return;
        const action = this.redoStack.pop();
        if (!action) return;
        this.store.applySnapshot(action.after);
        this.selectedRecordKey = action.selectionAfter;
        this.undoStack.push(action);
        this.refreshDirtyState();
        this.render();
        this.selectRecord(this.selectedRecordKey);
    }

    /**
     * Opens the deterministic settlement panel and renders current balance-reducing payments.
     * @returns {void}
     */
    openSettlementDialog() {
        if (this.busy || this.saveInFlight) return;
        this.renderSettlementSuggestions();
        if (!this.expenseSettlementDialog.open) this.expenseSettlementDialog.showModal();
    }

    /**
     * Closes the settlement panel and returns focus to the ledger.
     * @returns {void}
     */
    closeSettlementDialog() {
        if (this.expenseSettlementDialog.open) this.expenseSettlementDialog.close();
        if (this.active) queueMicrotask(() => this.expenseList.focus({ preventScroll: true }));
    }

    /**
     * Renders one actionable row per deterministic settlement suggestion.
     * @returns {void}
     */
    renderSettlementSuggestions() {
        this.expenseSettlementList.innerHTML = "";
        const suggestions = this.store.suggestSettlements();
        const names = new Map(this.store.getParticipants().map((participant) => [participant.key, participant.name]));
        if (!suggestions.length) {
            const empty = document.createElement("div");
            empty.className = "expense-empty muted";
            empty.textContent = this.locale.t("expenses.balancedLong");
            this.expenseSettlementList.append(empty);
            return;
        }
        for (const [index, suggestion] of suggestions.entries()) {
            const row = document.createElement("div");
            row.className = "expense-settlement-row";
            const description = document.createElement("span");
            description.textContent = this.locale.t("expenses.paymentSuggestion", {
                from: names.get(suggestion.fromParticipantKey) || suggestion.fromParticipantKey,
                to: names.get(suggestion.toParticipantKey) || suggestion.toParticipantKey,
                amount: this.locale.formatMinorCurrency(suggestion.amountMinor, suggestion.currency),
            });
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn btn-secondary";
            button.dataset.settlementIndex = String(index);
            button.textContent = this.locale.t("expenses.recordPayment");
            row.append(description, button);
            this.expenseSettlementList.append(row);
        }
    }

    /**
     * Records a clicked settlement suggestion as an ordinary undoable transfer dated today.
     * @param {MouseEvent} event Delegated click event.
     * @returns {void}
     */
    handleSettlementClick(event) {
        const button = event.target instanceof Element ? event.target.closest("[data-settlement-index]") : null;
        if (!(button instanceof HTMLButtonElement)) return;
        const suggestions = this.store.suggestSettlements();
        const suggestion = suggestions[Number(button.dataset.settlementIndex)];
        if (!suggestion) return;
        let selectionAfter = null;
        const succeeded = this.applyMutation("Record settlement", () => {
            const transfer = this.store.createTransfer({
                date: this.timeContext.formatDate(new Date()),
                currency: suggestion.currency,
                amount_minor: suggestion.amountMinor,
                from_participant_key: suggestion.fromParticipantKey,
                to_participant_key: suggestion.toParticipantKey,
                notes: this.locale.t("expenses.settlement"),
            });
            selectionAfter = `transfer:${transfer.id}`;
        }, selectionAfter);
        if (!succeeded) return;
        const action = this.undoStack[this.undoStack.length - 1];
        if (action) action.selectionAfter = selectionAfter;
        this.selectedRecordKey = selectionAfter;
        this.renderSettlementSuggestions();
        this.render();
    }

    /**
     * Opens the participant/category inventory editor with detached form rows.
     * First-use mode focuses only participant setup and remembers that expense creation must resume after submission.
     * @param {boolean} [resumeCreate] Whether successful participant setup should continue into a new expense.
     * @returns {void}
     */
    openInventoryDialog(resumeCreate = false) {
        if (this.busy || this.saveInFlight) return;
        this.resumeCreateAfterInventory = Boolean(resumeCreate);
        this.setInlineError(this.expenseInventoryError, "");
        this.updateInventoryDialogMode();
        this.renderInventory();
        if (this.resumeCreateAfterInventory && !this.expenseParticipantList.children.length) this.addParticipantRow();
        if (!this.expenseInventoryDialog.open) this.expenseInventoryDialog.showModal();
        queueMicrotask(() => {
            this.expenseInventoryForm.scrollTop = 0;
            const target = this.expenseParticipantList.querySelector(".expense-inventory-name");
            if (target instanceof HTMLInputElement) target.focus();
        });
    }

    /**
     * Applies ordinary inventory labels or the focused first-use participant language.
     * @returns {void}
     */
    updateInventoryDialogMode() {
        const onboarding = this.resumeCreateAfterInventory;
        this.expenseInventoryTitle.textContent = this.locale.t(onboarding ? "expenses.setupParticipantsTitle" : "expenses.inventory");
        this.expenseInventoryMeta.textContent = this.locale.t(onboarding ? "expenses.setupParticipantsMeta" : "expenses.inventoryMeta");
        this.expenseInventoryCategoriesSection.hidden = onboarding;
        this.expenseInventorySubmitBtn.textContent = this.locale.t(onboarding ? "common.continue" : "common.ok");
    }

    /**
     * Closes the inventory editor without applying form changes.
     * @returns {void}
     */
    closeInventoryDialog() {
        if (this.expenseInventoryDialog.open) this.expenseInventoryDialog.close();
        this.setInlineError(this.expenseInventoryError, "");
        this.resumeCreateAfterInventory = false;
        this.expenseInventoryCategoriesSection.hidden = false;
        if (this.active) queueMicrotask(() => this.expenseList.focus({ preventScroll: true }));
    }

    /**
     * Keeps inventory validation visible in its own top-layer dialog and focuses the first incomplete name when possible.
     * @param {unknown} error Validation or model error.
     * @returns {void}
     */
    showInventoryError(error) {
        this.setInlineError(
            this.expenseInventoryError,
            error instanceof Error ? error.message : String(error),
        );
        const firstEmpty = [...this.expenseInventoryForm.querySelectorAll(".expense-inventory-name")].find(
            (candidate) => candidate instanceof HTMLInputElement && !candidate.value.trim(),
        );
        queueMicrotask(() => {
            this.expenseInventoryError.scrollIntoView({ block: "nearest" });
            if (firstEmpty instanceof HTMLInputElement) firstEmpty.focus({ preventScroll: true });
        });
    }

    /**
     * Rebuilds participant and category rows from the current validated document.
     * @returns {void}
     */
    renderInventory() {
        this.expenseParticipantList.innerHTML = "";
        this.expenseCategoryList.innerHTML = "";
        for (const participant of this.store.getParticipants()) {
            this.expenseParticipantList.append(this.buildParticipantRow(participant.toRaw()));
        }
        for (const category of this.store.getCategories()) {
            this.expenseCategoryList.append(this.buildCategoryRow(category.toRaw()));
        }
    }

    /**
     * Builds one editable participant row while retaining provider source references outside visible controls.
     * @param {import("./model.js").ExpenseParticipantRaw} participant Participant definition.
     * @returns {HTMLElement}
     */
    buildParticipantRow(participant) {
        const row = document.createElement("div");
        row.className = "expense-inventory-row expense-participant-row";
        row.dataset.key = participant.key || "";
        row.dataset.sourceRefs = JSON.stringify(participant.source_refs || []);
        const name = document.createElement("input");
        name.type = "text";
        name.className = "expense-inventory-name";
        name.value = participant.name || "";
        name.placeholder = this.locale.t("expenses.participantName");
        const archivedLabel = document.createElement("label");
        archivedLabel.className = "checkbox expense-inventory-archived";
        const archived = document.createElement("input");
        archived.type = "checkbox";
        archived.className = "expense-inventory-archived-input";
        archived.checked = participant.archived === true;
        archivedLabel.append(archived, document.createTextNode(this.locale.t("projects.archived")));
        row.append(name, archivedLabel);
        return row;
    }

    /**
     * Builds one editable category row with color and archive controls.
     * @param {import("./model.js").ExpenseCategoryRaw} category Category definition.
     * @returns {HTMLElement}
     */
    buildCategoryRow(category) {
        const row = document.createElement("div");
        row.className = "expense-inventory-row expense-category-row";
        row.dataset.key = category.key || "";
        row.dataset.sourceRefs = JSON.stringify(category.source_refs || []);
        const name = document.createElement("input");
        name.type = "text";
        name.className = "expense-inventory-name";
        name.value = category.name || "";
        name.placeholder = this.locale.t("expenses.categoryName");
        const color = document.createElement("input");
        color.type = "color";
        color.className = "expense-inventory-color";
        color.value = /^#[0-9a-f]{6}$/i.test(category.color || "") ? String(category.color) : "#64748b";
        const archivedLabel = document.createElement("label");
        archivedLabel.className = "checkbox expense-inventory-archived";
        const archived = document.createElement("input");
        archived.type = "checkbox";
        archived.className = "expense-inventory-archived-input";
        archived.checked = category.archived === true;
        archivedLabel.append(archived, document.createTextNode(this.locale.t("projects.archived")));
        row.append(name, color, archivedLabel);
        return row;
    }

    /**
     * Adds a blank participant row and focuses its name field.
     * @returns {void}
     */
    addParticipantRow() {
        const row = this.buildParticipantRow({ key: "", name: "", archived: false, source_refs: [] });
        this.expenseParticipantList.append(row);
        const input = row.querySelector(".expense-inventory-name");
        if (input instanceof HTMLInputElement) input.focus();
    }

    /**
     * Adds a blank category row and focuses its name field.
     * @returns {void}
     */
    addCategoryRow() {
        const row = this.buildCategoryRow({ key: "", name: "", color: "#64748b", archived: false, source_refs: [] });
        this.expenseCategoryList.append(row);
        const input = row.querySelector(".expense-inventory-name");
        if (input instanceof HTMLInputElement) input.focus();
    }

    /**
     * Reads a serialized source-reference dataset without exposing provider identifiers in visible form fields.
     * @param {HTMLElement} row Inventory row.
     * @returns {import("./model.js").ExternalReferenceRaw[]}
     */
    readSourceRefs(row) {
        try {
            const parsed = JSON.parse(row.dataset.sourceRefs || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    /**
     * Collects and validates participant and category form rows, reserving stable keys only for new definitions.
     * @returns {{participants: import("./model.js").ExpenseParticipantRaw[], categories: import("./model.js").ExpenseCategoryRaw[]}}
     */
    collectInventory() {
        const participantRows = [...this.expenseParticipantList.querySelectorAll(".expense-participant-row")].filter(
            (row) => row instanceof HTMLElement,
        );
        const categoryRows = [...this.expenseCategoryList.querySelectorAll(".expense-category-row")].filter(
            (row) => row instanceof HTMLElement,
        );
        const usedParticipantKeys = new Set(participantRows.map((row) => row.dataset.key || "").filter(Boolean));
        const usedCategoryKeys = new Set(categoryRows.map((row) => row.dataset.key || "").filter(Boolean));
        const participants = participantRows.map((row) => {
            const name = row.querySelector(".expense-inventory-name");
            const archived = row.querySelector(".expense-inventory-archived-input");
            if (!(name instanceof HTMLInputElement) || !(archived instanceof HTMLInputElement)) {
                throw new Error(this.locale.t("toast.invalidEditPayload"));
            }
            const displayName = name.value.trim();
            if (!displayName) throw new Error(this.locale.t("toast.expenseParticipantName"));
            return {
                key: row.dataset.key || reserveDefinitionKey(displayName, "participant", usedParticipantKeys),
                name: displayName,
                archived: archived.checked,
                source_refs: this.readSourceRefs(row),
            };
        });
        const categories = categoryRows.map((row) => {
            const name = row.querySelector(".expense-inventory-name");
            const color = row.querySelector(".expense-inventory-color");
            const archived = row.querySelector(".expense-inventory-archived-input");
            if (!(name instanceof HTMLInputElement) || !(color instanceof HTMLInputElement) || !(archived instanceof HTMLInputElement)) {
                throw new Error(this.locale.t("toast.invalidEditPayload"));
            }
            const displayName = name.value.trim();
            if (!displayName) throw new Error(this.locale.t("toast.expenseCategoryName"));
            return {
                key: row.dataset.key || reserveDefinitionKey(displayName, "category", usedCategoryKeys),
                name: displayName,
                color: color.value,
                archived: archived.checked,
                source_refs: this.readSourceRefs(row),
            };
        });
        return { participants, categories };
    }

    /**
     * Applies inventory edits as one undoable document mutation.
     * @param {SubmitEvent} event Inventory form submission.
     * @returns {void}
     */
    handleInventorySubmit(event) {
        event.preventDefault();
        let inventory;
        try {
            inventory = this.collectInventory();
        } catch (error) {
            this.showInventoryError(error);
            return;
        }
        let mutationError = null;
        const succeeded = this.applyMutation(
            "Update expense inventory",
            () => {
                this.store.updateInventory(inventory.participants, inventory.categories);
            },
            this.selectedRecordKey,
            (error) => {
                mutationError = error;
                this.showInventoryError(error);
            },
        );
        if (!succeeded && mutationError) return;
        const resumeCreate = this.resumeCreateAfterInventory;
        this.closeInventoryDialog();
        this.render();
        if (resumeCreate) queueMicrotask(() => this.openCreateDialog());
    }

    /**
     * Compares the current ledger with its last successful save and schedules the matching IndexedDB draft operation.
     * @returns {void}
     */
    refreshDirtyState() {
        this.dirty = !expenseSnapshotsEqual(this.cleanSnapshot, this.store.snapshotRaw());
        if (this.dirty) this.queueDraftWrite();
        else this.queueDraftDelete();
        this.updateSaveState();
    }

    /**
     * Synchronizes the shared top-bar save badge while expense mode is active.
     * @returns {void}
     */
    updateSaveState() {
        const status = this.locale.t(
            this.saveInFlight ? "status.saving" : this.dirty ? "status.changed" : "status.saved",
        );
        this.expenseView.classList.toggle("is-dirty", this.dirty);
        if (!this.active) return;
        this.editorBadge.classList.toggle("is-dirty", this.dirty);
        this.editorBadge.disabled = this.busy || this.saveInFlight;
        this.editorBadge.title = this.dirty
            ? this.locale.t("topbar.saveTitle")
            : this.locale.t("status.expenseNoUnsaved");
        this.editorBadge.setAttribute(
            "aria-label",
            this.locale.t(this.dirty ? "status.expenseSaveChanged" : "status.expenseChangesSaved"),
        );
        this.editorBadge.innerHTML = `<span class="dot"></span><span class="save">${status}</span>`;
    }

    /**
     * Queues a durable complete-document draft behind earlier writes so rapid edits cannot arrive out of order.
     * @returns {void}
     */
    queueDraftWrite() {
        const namespace = this.draftNamespace;
        if (!namespace) return;
        const baseValue = { expenses: cloneJson(this.cleanSnapshot) };
        const value = { expenses: cloneJson(this.store.snapshotRaw()) };
        this.enqueueDraftOperation(
            () =>
                this.draftJournal.putDocumentDraft(namespace, EXPENSE_DOCUMENT_NAME, {
                    baseValue,
                    value,
                    updatedAt: Date.now(),
                }),
            this.locale.t("toast.expenseDraftUnavailable"),
        );
    }

    /**
     * Queues draft removal after a successful save or complete undo back to the clean baseline.
     * @returns {void}
     */
    queueDraftDelete() {
        const namespace = this.draftNamespace;
        if (!namespace) return;
        this.enqueueDraftOperation(
            () => this.draftJournal.deleteDocumentDraft(namespace, EXPENSE_DOCUMENT_NAME),
            this.locale.t("toast.expenseDraftCleanup"),
        );
    }

    /**
     * Serializes one IndexedDB operation and reports at most one durability warning per mounted workspace.
     * @param {() => Promise<boolean>} operation Draft write/delete operation.
     * @param {string} failureMessage Localized warning text.
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
     * Waits for all synchronous editor changes to reach IndexedDB before saving or switching workspaces.
     * @returns {Promise<void>}
     */
    async flushDraftWrites() {
        await this.draftWriteChain.catch(() => undefined);
    }

    /**
     * Three-way merges a browser draft over newer repository content independently by participant, category, expense, and transfer identity.
     * @param {import("./model.js").ExpensesFileRaw} baseline Document at the start of local editing.
     * @param {import("./model.js").ExpensesFileRaw} localDraft Locally edited document.
     * @param {import("./model.js").ExpensesFileRaw} remoteCurrent Newly loaded repository document.
     * @returns {import("./model.js").ExpensesFileRaw}
     */
    mergeDraft(baseline, localDraft, remoteCurrent) {
        return {
            schema_version: 1,
            generated_at: remoteCurrent.generated_at || baseline.generated_at || "",
            participants: mergeDraftCollection(
                baseline.participants || [],
                localDraft.participants || [],
                remoteCurrent.participants || [],
                (row) => row.key,
            ),
            categories: mergeDraftCollection(
                baseline.categories || [],
                localDraft.categories || [],
                remoteCurrent.categories || [],
                (row) => row.key,
            ),
            expenses: mergeDraftCollection(
                baseline.expenses || [],
                localDraft.expenses || [],
                remoteCurrent.expenses || [],
                (row) => row.id,
            ),
            transfers: mergeDraftCollection(
                baseline.transfers || [],
                localDraft.transfers || [],
                remoteCurrent.transfers || [],
                (row) => row.id,
            ),
        };
    }

    /**
     * Restores a durable unsaved ledger draft, merging per identity when repository content advanced independently.
     * @returns {Promise<boolean>} Whether a draft changed the loaded document.
     */
    async restoreDraft() {
        await this.flushDraftWrites();
        if (!this.draftNamespace) return false;
        const draft = await this.draftJournal.getDocumentDraft(this.draftNamespace, EXPENSE_DOCUMENT_NAME);
        const localDraft = draft?.value?.expenses;
        const baseline = draft?.baseValue?.expenses;
        if (!localDraft || typeof localDraft !== "object" || !baseline || typeof baseline !== "object") return false;
        const remoteCurrent = this.store.snapshotRaw();
        if (expenseSnapshotsEqual(remoteCurrent, localDraft)) {
            await this.draftJournal.deleteDocumentDraft(this.draftNamespace, EXPENSE_DOCUMENT_NAME);
            return false;
        }
        const baseStillCurrent = expenseSnapshotsEqual(remoteCurrent, baseline);
        const restored = baseStillCurrent
            ? cloneJson(localDraft)
            : this.mergeDraft(baseline, localDraft, remoteCurrent);
        try {
            this.store.applySnapshot(restored);
        } catch (error) {
            this.onToast(
                this.locale.t("toast.expenseDraftConflict", {
                    error: error instanceof Error ? error.message : String(error),
                }),
                6000,
            );
            return false;
        }
        this.dirty = !expenseSnapshotsEqual(this.cleanSnapshot, restored);
        if (this.dirty) this.queueDraftWrite();
        this.onToast(
            this.locale.t(baseStillCurrent ? "toast.expenseRestored" : "toast.expenseRestoredMerged"),
            5000,
            "success",
        );
        this.updateSaveState();
        return true;
    }

    /**
     * Atomically saves expenses.json and its integrity manifest through the active local or hosted Git data source.
     * @returns {Promise<void>}
     */
    async saveNow() {
        if (this.busy || this.saveInFlight) return;
        if (!this.dirty) {
            this.onToast(this.locale.t("toast.nothingToSave"));
            return;
        }
        this.saveInFlight = true;
        this.onBusy(true);
        this.updateSaveState();
        try {
            await this.flushDraftWrites();
            const persistence = this.store.buildPersistenceFiles(
                this.dataSource.getExpensesPath(),
                this.dataSource.getExpensesManifestPath(),
                utcNowIso(),
            );
            await this.dataSource.saveFiles(persistence.files, "Update expenses");
            this.store.setDocument(persistence.document);
            this.store.setManifest(persistence.manifest);
            this.cleanSnapshot = this.store.snapshotRaw();
            this.dirty = false;
            this.queueDraftDelete();
            await this.flushDraftWrites();
            this.onSaved();
            this.onToast(this.locale.t("toast.expensesSaved"), 2400, "success");
        } catch (error) {
            this.onToast(error instanceof Error ? error.message : String(error), 5000);
        } finally {
            this.saveInFlight = false;
            this.onBusy(false);
            this.updateSaveState();
            this.render();
        }
    }
}
