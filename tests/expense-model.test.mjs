import assert from "node:assert/strict";
import test from "node:test";

import { allocateExpenseByWeights, ExpenseDocument, ExpenseManifest } from "../model.js";
import { EntryStore, ExpenseStore } from "../store.js";
import { TimeContext } from "../utils.js";

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
