import assert from "node:assert/strict";
import test from "node:test";
import { DraftJournal } from "../cache.js";
import { WeekView } from "../week.view.js";
import { TodoView } from "../todo.view.js";
import { ExpenseView } from "../expense.view.js";

for (const View of [WeekView, TodoView, ExpenseView]) {
    test(`${View.name}: intentionally disabled playground drafts are silent and never written`, async () => {
        const view = Object.assign(Object.create(View.prototype), {
            draftJournal: new DraftJournal(false), draftWriteChain: Promise.resolve(),
            draftWarningShown: false, onToast: () => assert.fail("No playground durability warning"),
        });
        view.enqueueDraftOperation(async () => assert.fail("No playground persistence attempt"), "unavailable");
        await view.draftWriteChain;
        assert.equal(view.draftWarningShown, false);
    });

    test(`${View.name}: real persistence failures still warn once without blocking later writes`, async () => {
        const warnings = [];
        const operations = [];
        const view = Object.assign(Object.create(View.prototype), {
            draftJournal: new DraftJournal(), draftWriteChain: Promise.resolve(),
            draftWarningShown: false, onToast: (message) => warnings.push(message),
        });
        view.enqueueDraftOperation(async () => { operations.push(1); return false; }, "unavailable");
        view.enqueueDraftOperation(async () => { operations.push(2); throw new Error("quota"); }, "unavailable");
        view.enqueueDraftOperation(async () => { operations.push(3); return true; }, "unavailable");
        await view.draftWriteChain;
        assert.deepEqual(warnings, ["unavailable"]);
        assert.deepEqual(operations, [1, 2, 3]);
    });
}
