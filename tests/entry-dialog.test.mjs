import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { WeekView } from "../week.view.js";
import { EntryStore } from "../store.js";
import { TimeContext } from "../utils.js";

/** Creates an editor using real stores/collision rules and an observable transaction boundary.
 * @returns {{view: WeekView, store: EntryStore, transactions: object[]}}
 */
function editor() {
    const timeContext = new TimeContext("Europe/Berlin");
    const store = new EntryStore(timeContext);
    const raw = (id, start, end) => ({ id, start, end, description: "Original", project_key: null,
        section_key: null, billable: false, duration_seconds: (Date.parse(end) - Date.parse(start)) / 1000, is_running: false });
    store.applyWeekSnapshot("2026-10-26", [
        raw(1, "2026-10-27T09:00:00+01:00", "2026-10-27T10:00:00+01:00"),
        raw(2, "2026-10-27T10:00:00+01:00", "2026-10-27T11:00:00+01:00"),
        raw(3, "2026-10-27T11:00:00+01:00", "2026-10-27T12:00:00+01:00"),
    ]);
    const transactions = [];
    const view = Object.assign(Object.create(WeekView.prototype), {
        store, timeContext, appState: { weekStart: "2026-10-26" }, dialogEntryId: 2,
        entryStartInput: { value: "2026-10-27T10:00" }, entryEndInput: { value: "2026-10-27T11:00" },
        entryAssignmentInput: { value: "", focus() {} }, entryDescInput: { value: "Edited" },
        entryErrorEl: { hidden: true, textContent: "" }, locale: { t: (key) => key, localizeError: String },
        closeEntryDialog() { this.closed = true; }, onToast: assert.fail,
        applyWeekEdit(edit) {
            transactions.push({ before: store.snapshotWeekRaw(edit.weekStart), after: edit.getAfterRaw() });
            store.applyWeekSnapshot(edit.weekStart, transactions.at(-1).after);
        },
    });
    return { view, store, transactions };
}

test("dialog times and details share one collision-aware undo snapshot", () => {
    const { view, store, transactions } = editor();
    view.entryStartInput.value = "2026-10-27T09:30";
    view.entryEndInput.value = "2026-10-27T11:30";
    view.handleEntryFormSubmit({ preventDefault() {} });
    assert.equal(transactions.length, 1);
    assert.equal(store.getEntryById(1).endDate.toISOString(), "2026-10-27T08:30:00.000Z");
    assert.equal(store.getEntryById(3).startDate.toISOString(), "2026-10-27T10:30:00.000Z");
    assert.equal(store.getEntryById(2).description, "Edited");
    store.applyWeekSnapshot("2026-10-26", transactions[0].before);
    assert.equal(store.getEntryById(1).endDate.toISOString(), "2026-10-27T09:00:00.000Z");
    assert.equal(store.getEntryById(2).description, "Original");
});

test("invalid, too-short, and out-of-week dialog edits leave every entry untouched", () => {
    for (const [start, end] of [["", "2026-10-27T11:00"], ["2026-10-27T10:00", "2026-10-27T10:10"],
        ["2026-10-25T10:00", "2026-10-27T11:00"], ["2026-10-27T10:00", "2026-11-02T01:00"]]) {
        const { view, store, transactions } = editor();
        const before = store.snapshotWeekRaw("2026-10-26");
        view.entryStartInput.value = start;
        view.entryEndInput.value = end;
        view.handleEntryFormSubmit({ preventDefault() {} });
        assert.equal(transactions.length, 0);
        assert.equal(view.entryErrorEl.hidden, false);
        assert.deepEqual(store.snapshotWeekRaw("2026-10-26"), before);
    }
});

test("wall-clock editing preserves seconds and DST occurrence when unchanged, rejecting missing DST times", () => {
    const { view } = editor();
    const original = new Date("2026-10-25T02:30:42+02:00");
    assert.equal(view.parseDialogTime("2026-10-25T02:30", original), original.getTime());
    assert.throws(() => view.parseDialogTime("2026-03-29T02:30", original), /invalidTime/);
    assert.throws(() => view.parseDialogTime("2026-02-30T12:00", original), /invalidTime/);
});

test("entry actions place Save first and Delete last in keyboard order", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const editor = html.split('id="entryDialog"')[1].split("</dialog>")[0];
    assert.ok(editor.indexOf('id="entrySaveBtn"') < editor.indexOf('id="entryCancelBtn"'));
    assert.ok(editor.indexOf('id="entryCancelBtn"') < editor.indexOf('id="entryDeleteBtn"'));
});

test("entry times precede the default-focused description and editors share safe action ordering", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const entry = html.split('id="entryDialog"')[1].split("</dialog>")[0];
    assert.ok(entry.indexOf('id="entryStart"') < entry.indexOf('id="entryEnd"'));
    assert.ok(entry.indexOf('id="entryEnd"') < entry.indexOf('id="entryDesc"'));
    for (const id of ["entryDialog", "todoDialog", "expenseDialog"]) {
        const dialog = html.split(`id="${id}"`)[1].split("</dialog>")[0];
        const actions = dialog.split('class="row dialog-actions editor-actions"')[1];
        assert.ok(actions, `${id} must use the shared footer`);
        assert.ok(actions.indexOf('type="submit"') < actions.indexOf('data-i18n="common.cancel"'));
        if (actions.includes("dialog-delete-action")) {
            assert.ok(actions.indexOf('data-i18n="common.cancel"') < actions.indexOf("dialog-delete-action"));
        }
    }
});
