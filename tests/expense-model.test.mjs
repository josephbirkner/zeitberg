import assert from "node:assert/strict";
import test from "node:test";

import {
    allocateExpenseByWeights,
    createDefaultExpenseCategories,
    ExpenseDocument,
    ExpenseManifest,
} from "../model.js";
import { EntryStore, ExpenseStore } from "../store.js";
import { TimeContext } from "../utils.js";
import { ExpenseView } from "../expense.view.js";

/**
 * Creates a compact two-person ledger used by exact-money and settlement tests.
 * @returns {import("../model.js").ExpensesFileRaw}
 */
function makeLedgerRaw() {
    return {
        schema_version: 1,
        generated_at: "2026-08-16T10:00:00Z",
        participants: [
            { key: "alex", name: "Alex", archived: false, source_refs: [] },
            { key: "bea", name: "Bea", archived: false, source_refs: [] },
        ],
        categories: [
            { key: "food", name: "Food", color: "#f97316", archived: false, source_refs: [] },
        ],
        expenses: [
            {
                id: "expense:1",
                description: "Dinner",
                date: "2026-08-15",
                currency: "EUR",
                amount_minor: 1001,
                payers: [{ participant_key: "alex", amount_minor: 1001 }],
                allocations: [
                    { participant_key: "alex", amount_minor: 501 },
                    { participant_key: "bea", amount_minor: 500 },
                ],
                allocation_rule: {
                    type: "equal",
                    units: [
                        { participant_key: "alex", value: 1 },
                        { participant_key: "bea", value: 1 },
                    ],
                },
                category_key: "food",
                project_key: null,
                section_key: null,
                notes: "",
                created_at: "2026-08-15T18:00:00Z",
                updated_at: "2026-08-15T18:00:00Z",
                source: { provider: "fixture", id: "1" },
            },
        ],
        transfers: [],
    };
}

test("templates round-trip without affecting balances or retaining transaction metadata", () => {
    const store = new ExpenseStore(new EntryStore(new TimeContext("Europe/Berlin")));
    store.setDocument(ExpenseDocument.fromRaw(makeLedgerRaw()));
    const before = store.snapshotRaw();
    const balances = store.calculateBalances();
    const template = store.createTemplate(store.getExpenses()[0].toRaw());
    const raw = template.toRaw();
    assert.equal(raw.description, "Dinner");
    assert.notEqual(raw.id, before.expenses[0].id);
    for (const field of ["date", "created_at", "updated_at", "source"]) assert.equal(field in raw, false);
    assert.deepEqual(store.snapshotRaw().expenses, before.expenses);
    assert.deepEqual(store.calculateBalances(), balances);
    const persistence = store.buildPersistenceFiles("data/expenses.json", "data/index/expenses-manifest.json");
    assert.equal(persistence.manifest.expenses, 1);
    const reloaded = ExpenseDocument.fromRaw(JSON.parse(persistence.document.toJson()));
    store.setDocument(reloaded);
    const dated = reloaded.templates[0].forDate("2026-10-30");
    assert.equal(dated.date, "2026-10-30");
    assert.equal(dated.source, null);
    const created = store.createExpense(dated.toRaw());
    assert.notEqual(created.id, dated.id);
    assert.equal(created.source, null);
    assert.deepEqual(created.allocation_rule, dated.allocation_rule);
    dated.payers[0].amount_minor = 42;
    assert.equal(reloaded.templates[0].toRaw().payers[0].amount_minor, 1001);
    assert.equal(store.deleteTemplate(template.id), true);
    assert.equal(store.deleteTemplate(template.id), false);
    assert.equal(store.getExpenses().length, 2);
    assert.equal(store.getDocument().templates.length, 0);
    assert.equal("templates" in store.snapshotRaw(), false);
    store.applySnapshot(before);
    assert.equal(store.getExpenses().length, 1);
});

test("template validation shares expense invariants and rejects dangling assignments", () => {
    const store = new ExpenseStore(new EntryStore(new TimeContext("Europe/Berlin")));
    store.setDocument(ExpenseDocument.fromRaw(makeLedgerRaw()));
    const template = store.createTemplate(store.getExpenses()[0].toRaw()).toRaw();
    const valid = store.snapshotRaw();
    assert.throws(() => ExpenseDocument.fromRaw({ ...valid, templates: {} }), /array/);
    assert.throws(() => ExpenseDocument.fromRaw({ ...valid, templates: [template, template] }), /duplicate template id/);
    assert.throws(() => store.createTemplate({ ...store.getExpenses()[0].toRaw(), amount_minor: 5 }), /contributions/);
    assert.throws(() => store.createTemplate({ ...store.getExpenses()[0].toRaw(), project_key: "missing" }), /assignment/);
    assert.throws(() => store.updateInventory([], valid.categories), /participant/);
    assert.throws(() => ExpenseDocument.fromRaw({ ...valid, templates: [{ ...template, category_key: "missing" }] }), /category/);
    const onlyTemplates = { ...valid, expenses: [] };
    store.applySnapshot(onlyTemplates);
    assert.throws(() => store.updateInventory([], valid.categories), /participant/);
    store.updateInventory(valid.participants.map((participant) => ({ ...participant, archived: true })), valid.categories);
    assert.equal(store.getDocument().templates.length, 1);
});

test("template snapshots support undo, redo, draft merge and workspace isolation", () => {
    const store = new ExpenseStore(new EntryStore(new TimeContext("Europe/Berlin")));
    store.setDocument(ExpenseDocument.fromRaw(makeLedgerRaw()));
    const otherStore = new ExpenseStore(new EntryStore(new TimeContext("Europe/Berlin")));
    otherStore.setDocument(ExpenseDocument.fromRaw(makeLedgerRaw()));
    const view = Object.assign(Object.create(ExpenseView.prototype), {
        store, busy: false, selectedRecordKey: null, undoStack: [], redoStack: [],
        refreshDirtyState() {}, render() {}, selectRecord() {}, onToast(message) { assert.fail(message); },
    });
    const baseline = store.snapshotRaw();
    view.applyMutation("Template", () => store.createTemplate(store.getExpenses()[0].toRaw()));
    const local = store.snapshotRaw();
    assert.equal(otherStore.getDocument().templates.length, 0);
    view.undo();
    assert.deepEqual(store.snapshotRaw(), baseline);
    view.redo();
    assert.deepEqual(store.snapshotRaw(), local);
    otherStore.createTemplate({ ...otherStore.getExpenses()[0].toRaw(), description: "Remote preset" });
    const merged = view.mergeDraft(baseline, local, otherStore.snapshotRaw());
    store.applySnapshot(merged);
    assert.deepEqual(store.getDocument().templates.map((template) => template.description).sort(), ["Dinner", "Remote preset"]);
    const withTemplates = store.snapshotRaw();
    store.deleteTemplate(store.getDocument().templates[0].id);
    const deletedMerge = view.mergeDraft(withTemplates, store.snapshotRaw(), withTemplates);
    assert.equal(deletedMerge.templates.length, 1);
});

test("new expense ledgers receive stable starter categories", () => {
    const categories = createDefaultExpenseCategories();
    assert.deepEqual(categories.map((category) => category.key), [
        "groceries",
        "food-drink",
        "transport",
        "accommodation",
        "activities",
        "household",
        "other",
    ]);
    assert.equal(new Set(categories.map((category) => category.color)).size, categories.length);
    assert.doesNotThrow(() =>
        ExpenseDocument.fromRaw({
            categories,
            expenses: [],
            generated_at: "",
            participants: [],
            schema_version: 1,
            transfers: [],
        }),
    );
});

test("weighted allocation uses deterministic integer largest remainders", () => {
    assert.deepEqual(
        allocateExpenseByWeights(1001, [
            { participant_key: "alex", value: 6000 },
            { participant_key: "bea", value: 4000 },
        ]),
        [
            { participant_key: "alex", amount_minor: 601 },
            { participant_key: "bea", amount_minor: 400 },
        ],
    );
    assert.deepEqual(
        allocateExpenseByWeights(1, [
            { participant_key: "bea", value: 1 },
            { participant_key: "alex", value: 1 },
        ]),
        [{ participant_key: "alex", amount_minor: 1 }],
    );

    const tiny = makeLedgerRaw();
    tiny.expenses[0].amount_minor = 1;
    tiny.expenses[0].payers = [{ participant_key: "alex", amount_minor: 1 }];
    tiny.expenses[0].allocations = [{ participant_key: "alex", amount_minor: 1 }];
    tiny.expenses[0].allocation_rule = {
        type: "equal",
        units: [
            { participant_key: "bea", value: 1 },
            { participant_key: "alex", value: 1 },
        ],
    };
    assert.equal(ExpenseDocument.fromRaw(tiny).expenses[0].allocations.length, 1);
});

test("expense documents reject floating amounts, inconsistent totals, and duplicate source identities", () => {
    const floating = makeLedgerRaw();
    floating.expenses[0].amount_minor = 10.5;
    assert.throws(() => ExpenseDocument.fromRaw(floating), /integer minor-unit amount/);

    const inconsistent = makeLedgerRaw();
    inconsistent.expenses[0].allocations[1].amount_minor = 499;
    assert.throws(() => ExpenseDocument.fromRaw(inconsistent), /allocations do not equal/);

    const duplicate = makeLedgerRaw();
    duplicate.expenses.push({
        ...structuredClone(duplicate.expenses[0]),
        id: "expense:2",
    });
    assert.throws(() => ExpenseDocument.fromRaw(duplicate), /duplicate expense source identity/);
});

test("balances and settlement suggestions use exact payer-minus-owed arithmetic", () => {
    const projectStore = new EntryStore(new TimeContext("Europe/Berlin"));
    const store = new ExpenseStore(projectStore);
    store.setDocument(ExpenseDocument.fromRaw(makeLedgerRaw()));

    assert.deepEqual(store.calculateBalances(), [
        { participantKey: "alex", currency: "EUR", amountMinor: 500 },
        { participantKey: "bea", currency: "EUR", amountMinor: -500 },
    ]);
    assert.deepEqual(store.suggestSettlements(), [
        {
            currency: "EUR",
            amountMinor: 500,
            fromParticipantKey: "bea",
            toParticipantKey: "alex",
        },
    ]);

    store.createTransfer({
        date: "2026-08-16",
        currency: "EUR",
        amount_minor: 500,
        from_participant_key: "bea",
        to_participant_key: "alex",
        notes: "Settled",
    });
    assert.deepEqual(store.calculateBalances(), []);
    assert.deepEqual(store.suggestSettlements(), []);
});

test("expense persistence builds an integrity manifest from the exact serialized blob", () => {
    const projectStore = new EntryStore(new TimeContext("Europe/Berlin"));
    const store = new ExpenseStore(projectStore);
    store.setDocument(ExpenseDocument.fromRaw(makeLedgerRaw()));

    const persistence = store.buildPersistenceFiles(
        "data/expenses.json",
        "data/index/expenses-manifest.json",
        "2026-08-16T12:00:00Z",
    );
    assert.equal(persistence.files.length, 2);
    assert.equal(persistence.manifest.expenses, 1);
    assert.deepEqual(persistence.manifest.currencies, ["EUR"]);
    persistence.manifest.verifyContent(persistence.files[0].content);
    assert.deepEqual(
        ExpenseManifest.fromRaw(JSON.parse(persistence.files[1].content), "data/expenses.json").toObject(),
        persistence.manifest.toObject(),
    );
});
