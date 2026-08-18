import { allocateExpenseByWeights } from "./model.js";
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
 * @property {HTMLElement} expenseDialogMeta
 * @property {HTMLButtonElement} expenseCloseBtn
 * @property {HTMLButtonElement} expenseCancelBtn
 * @property {HTMLButtonElement} expenseDeleteBtn
 * @property {HTMLInputElement} expenseDescription
 * @property {HTMLInputElement} expenseDate
 * @property {HTMLInputElement} expenseAmount
 * @property {HTMLInputElement} expenseCurrency
 * @property {HTMLSelectElement} expenseCategory
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
 * @property {HTMLButtonElement} expenseInventoryCloseBtn
 * @property {HTMLButtonElement} expenseInventoryCancelBtn
 * @property {HTMLButtonElement} expenseAddParticipantBtn
 * @property {HTMLButtonElement} expenseAddCategoryBtn
 * @property {HTMLElement} expenseParticipantList
 * @property {HTMLElement} expenseCategoryList
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
        this.expenseDialogMeta = options.elements.expenseDialogMeta;
        this.expenseCloseBtn = options.elements.expenseCloseBtn;
        this.expenseCancelBtn = options.elements.expenseCancelBtn;
        this.expenseDeleteBtn = options.elements.expenseDeleteBtn;
        this.expenseDescription = options.elements.expenseDescription;
        this.expenseDate = options.elements.expenseDate;
        this.expenseAmount = options.elements.expenseAmount;
        this.expenseCurrency = options.elements.expenseCurrency;
        this.expenseCategory = options.elements.expenseCategory;
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
        this.expenseInventoryCloseBtn = options.elements.expenseInventoryCloseBtn;
        this.expenseInventoryCancelBtn = options.elements.expenseInventoryCancelBtn;
        this.expenseAddParticipantBtn = options.elements.expenseAddParticipantBtn;
        this.expenseAddCategoryBtn = options.elements.expenseAddCategoryBtn;
        this.expenseParticipantList = options.elements.expenseParticipantList;
        this.expenseCategoryList = options.elements.expenseCategoryList;
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
        this.expenseAllocationType.addEventListener("change", () => this.convertAllocationInputs());
        this.expenseAmount.addEventListener("input", () => this.copyTotalToOnlyPayer());
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
            this.expenseSettlementCloseBtn,
            this.expenseInventoryCloseBtn,
            this.expenseInventoryCancelBtn,
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
            this.populateCategoryControl(current?.category_key || null);
            this.populateProjectControl(current?.project_key || null, current?.section_key || null);
            this.updateAllocationHeading();
        }
        if (this.expenseSettlementDialog.open) this.renderSettlementSuggestions();
        if (this.expenseInventoryDialog.open) this.renderInventory();
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
        this.render();
        this.updateSaveState();
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
     * Opens a blank expense editor using active participants, today's workspace-local date, EUR, and an equal split.
     * @returns {void}
     */
    openCreateDialog() {
        if (this.busy || this.saveInFlight) return;
        const participants = this.store.getParticipants().filter((participant) => !participant.archived);
        if (!participants.length) {
            this.onToast(this.locale.t("toast.expenseNeedsParticipant"));
            this.openInventoryDialog();
            return;
        }
        this.editingExpenseId = null;
        this.expenseDialogTitle.textContent = this.locale.t("expenses.add");
        this.expenseDialogMeta.textContent = this.locale.t("expenses.newExpense");
        this.expenseDescription.value = "";
        this.expenseDate.value = this.timeContext.formatDate(new Date());
        this.expenseAmount.value = "";
        this.expenseCurrency.value = "EUR";
        this.expenseAllocationType.value = "equal";
        this.expenseNotes.value = "";
        this.populateCategoryControl(null);
        this.populateProjectControl(null, null);
        this.renderSplitRows(null);
        const defaultPayer = this.expenseSplitRows.querySelector(".expense-paid-input");
        if (defaultPayer instanceof HTMLInputElement) defaultPayer.dataset.autoPayer = "true";
        this.expenseDeleteBtn.hidden = true;
        if (!this.expenseDialog.open) this.expenseDialog.showModal();
        queueMicrotask(() => this.expenseDescription.focus());
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
        this.expenseDialogMeta.textContent = expense.source
            ? this.locale.t("expenses.importedFrom", { provider: expense.source.provider })
            : this.locale.t("expenses.localExpense");
        this.expenseDescription.value = expense.description;
        this.expenseDate.value = expense.date;
        this.expenseCurrency.value = expense.currency;
        const digits = this.locale.currencyMinorDigits(expense.currency);
        this.expenseAmount.value = formatScaledInput(expense.amount_minor, digits);
        this.expenseAllocationType.value = expense.allocation_rule?.type || "exact";
        this.expenseNotes.value = expense.notes;
        this.populateCategoryControl(expense.category_key);
        this.populateProjectControl(expense.project_key, expense.section_key);
        this.renderSplitRows(expense);
        this.expenseDeleteBtn.hidden = false;
        if (!this.expenseDialog.open) this.expenseDialog.showModal();
        queueMicrotask(() => {
            const target = focusSplit
                ? this.expenseSplitRows.querySelector(".expense-owed-input")
                : this.expenseDescription;
            if (target instanceof HTMLInputElement) {
                target.focus();
                target.select();
            }
        });
    }

    /**
     * Closes the expense editor and restores list focus when expense mode remains active.
     * @returns {void}
     */
    closeExpenseDialog() {
        if (this.expenseDialog.open) this.expenseDialog.close();
        this.editingExpenseId = null;
        if (this.active) queueMicrotask(() => this.expenseList.focus({ preventScroll: true }));
    }

    /**
     * Rebuilds the category selector with active categories plus an archived current value when needed.
     * @param {string | null} selectedKey Category key to select.
     * @returns {void}
     */
    populateCategoryControl(selectedKey) {
        this.expenseCategory.innerHTML = "";
        this.expenseCategory.append(new Option(this.locale.t("expenses.noCategory"), ""));
        const categories = this.store
            .getCategories()
            .filter((category) => !category.archived || category.key === selectedKey)
            .sort((left, right) => this.locale.compare(left.name, right.name));
        for (const category of categories) {
            const suffix = category.archived ? ` (${this.locale.t("search.archived")})` : "";
            this.expenseCategory.append(new Option(`${category.name}${suffix}`, category.key));
        }
        this.expenseCategory.value = selectedKey || "";
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
     * Renders one paid and one owed/rule input for every active or currently referenced participant.
     * @param {import("./model.js").Expense | null} expense Existing expense or null for creation.
     * @returns {void}
     */
    renderSplitRows(expense) {
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
            const row = document.createElement("label");
            row.className = "expense-split-row";
            row.dataset.participantKey = participant.key;
            const name = document.createElement("span");
            name.className = "expense-split-name";
            name.textContent = participant.name;
            const paid = document.createElement("input");
            paid.type = "text";
            paid.inputMode = "decimal";
            paid.className = "expense-paid-input";
            paid.dataset.participantKey = participant.key;
            paid.setAttribute("aria-label", this.locale.t("expenses.paidBy", { participant: participant.name }));
            const paidValue = payerByKey.get(participant.key);
            paid.value = paidValue ? formatScaledInput(paidValue, digits) : "";
            paid.addEventListener("input", () => delete paid.dataset.autoPayer);
            const owed = document.createElement("input");
            owed.type = "text";
            owed.className = "expense-owed-input";
            owed.dataset.participantKey = participant.key;
            owed.setAttribute("aria-label", this.locale.t("expenses.owedBy", { participant: participant.name }));
            const allocationValue = allocationByKey.get(participant.key);
            const ruleValue = ruleByKey.get(participant.key);
            if (type === "equal") {
                owed.inputMode = "numeric";
                owed.value = allocationValue ? "1" : "";
            } else if (type === "percentage") {
                owed.inputMode = "decimal";
                owed.value = ruleValue ? formatScaledInput(ruleValue, 2) : "";
            } else if (type === "shares") {
                owed.inputMode = "numeric";
                owed.value = ruleValue ? String(ruleValue) : "";
            } else {
                owed.inputMode = "decimal";
                owed.value = allocationValue ? formatScaledInput(allocationValue, digits) : "";
            }
            row.append(name, paid, owed);
            this.expenseSplitRows.append(row);
        }
        this.updateAllocationHeading();
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
     * Converts existing owed inputs when the user changes split rule, using current exact amounts as weights where possible.
     * The model performs the final exact derivation and validation on submit.
     * @returns {void}
     */
    convertAllocationInputs() {
        const type = this.expenseAllocationType.value;
        const inputs = [...this.expenseSplitRows.querySelectorAll(".expense-owed-input")].filter(
            (input) => input instanceof HTMLInputElement,
        );
        const nonEmpty = inputs.filter((input) => input.value.trim());
        const included = new Set(nonEmpty);
        for (const input of inputs) {
            if (!(input instanceof HTMLInputElement)) continue;
            if (type === "equal") {
                input.inputMode = "numeric";
                input.value = input.value.trim() ? "1" : "";
            } else if (type === "percentage") {
                input.inputMode = "decimal";
                input.value = included.has(input)
                    ? formatScaledInput(Math.floor(10000 / nonEmpty.length), 2)
                    : "";
            } else if (type === "shares") {
                input.inputMode = "numeric";
                input.value = input.value.trim() ? "1" : "";
            } else {
                input.inputMode = "decimal";
                input.value = "";
            }
        }
        if (type === "percentage" && nonEmpty.length) {
            const remainder = 10000 - Math.floor(10000 / nonEmpty.length) * nonEmpty.length;
            nonEmpty[0].value = formatScaledInput(Math.floor(10000 / nonEmpty.length) + remainder, 2);
        }
        this.updateAllocationHeading();
    }

    /**
     * Copies the entered total into the first payer field only while no payer amount has been entered.
     * This optimizes the common single-payer case without overwriting an explicit multi-payer split.
     * @returns {void}
     */
    copyTotalToOnlyPayer() {
        const inputs = [...this.expenseSplitRows.querySelectorAll(".expense-paid-input")].filter(
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
     * Re-renders participant money inputs after a currency change so the new minor-unit precision is explicit.
     * Values are intentionally retained as entered because converting currencies is outside ledger semantics.
     * @returns {void}
     */
    reformatSplitMoneyInputs() {
        this.expenseCurrency.value = this.expenseCurrency.value.trim().toUpperCase();
        this.updateAllocationHeading();
    }

    /**
     * Reads one participant input collection as positive integer scaled values, omitting blank and zero rows.
     * @param {string} selector Input selector within the split rows.
     * @param {number} fractionDigits Decimal scaling precision.
     * @param {string} label Localized field label.
     * @returns {Array<{participant_key: string, value: number}>}
     */
    collectParticipantValues(selector, fractionDigits, label) {
        const values = [];
        for (const candidate of this.expenseSplitRows.querySelectorAll(selector)) {
            if (!(candidate instanceof HTMLInputElement)) continue;
            const text = candidate.value.trim();
            if (!text) continue;
            const value = parseScaledInteger(text, fractionDigits, label, true);
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
        const description = this.expenseDescription.value.trim();
        if (!description) throw new Error(this.locale.t("toast.expenseDescription"));
        const currency = this.expenseCurrency.value.trim().toUpperCase();
        const digits = this.locale.currencyMinorDigits(currency);
        const amountMinor = parseScaledInteger(this.expenseAmount.value, digits, this.locale.t("expenses.amount"));
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
            throw new Error(this.locale.t("toast.expensePayersTotal"));
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
                throw new Error(this.locale.t("toast.expensePercentageTotal"));
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
        if (!units.length) throw new Error(this.locale.t("toast.expenseNeedsAllocation"));
        const allocations =
            type === "exact"
                ? units.map((unit) => ({ participant_key: unit.participant_key, amount_minor: unit.value }))
                : allocateExpenseByWeights(amountMinor, units);
        if (allocations.reduce((sum, line) => sum + line.amount_minor, 0) !== amountMinor) {
            throw new Error(this.locale.t("toast.expenseAllocationsTotal"));
        }
        const assignment = this.projectStore.findAssignmentByLabel(this.expenseAssignment.value);
        if (!assignment) throw new Error(this.locale.t("toast.invalidAssignment"));
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
            category_key: this.expenseCategory.value || null,
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
            this.onToast(error instanceof Error ? error.message : String(error));
            return;
        }
        const editingId = this.editingExpenseId;
        let selectionAfter = editingId ? `expense:${editingId}` : null;
        const succeeded = this.applyMutation(editingId ? "Edit expense" : "Add expense", () => {
            if (editingId) {
                this.store.updateExpense(editingId, details);
            } else {
                const created = this.store.createExpense(details);
                selectionAfter = `expense:${created.id}`;
            }
        }, selectionAfter);
        if (!succeeded) return;
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
     * @returns {boolean} Whether the document changed.
     */
    applyMutation(label, mutation, selectionAfter = this.selectedRecordKey) {
        if (this.busy || this.saveInFlight) return false;
        const before = this.store.snapshotRaw();
        const selectionBefore = this.selectedRecordKey;
        try {
            mutation();
        } catch (error) {
            this.store.applySnapshot(before);
            this.onToast(error instanceof Error ? error.message : String(error));
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
     * @returns {void}
     */
    openInventoryDialog() {
        if (this.busy || this.saveInFlight) return;
        this.renderInventory();
        if (!this.expenseInventoryDialog.open) this.expenseInventoryDialog.showModal();
    }

    /**
     * Closes the inventory editor without applying form changes.
     * @returns {void}
     */
    closeInventoryDialog() {
        if (this.expenseInventoryDialog.open) this.expenseInventoryDialog.close();
        if (this.active) queueMicrotask(() => this.expenseList.focus({ preventScroll: true }));
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
            this.onToast(error instanceof Error ? error.message : String(error));
            return;
        }
        const succeeded = this.applyMutation("Update expense inventory", () => {
            this.store.updateInventory(inventory.participants, inventory.categories);
        });
        if (!succeeded) {
            this.closeInventoryDialog();
            return;
        }
        this.closeInventoryDialog();
        this.render();
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
