import assert from "node:assert/strict";
import test from "node:test";

import {
    addIsoDays,
    chunkKey,
    cloneJson,
    createMaterialIcon,
    formatDuration,
    formatIsoDate,
    getRequiredElement,
    getSourceMode,
    hashColorHex,
    hhmmToMinutes,
    isoWeekInfo,
    isoWeekStart,
    isoWeekStartFromYearWeek,
    isoWeekdayIndex,
    isEditableTarget,
    jsonStringifySorted,
    minutesToHHMM,
    parseHexColor,
    parseIsoDate,
    safeText,
    setVisible,
    sortJsonValue,
    TimeContext,
    utcNowIso,
    utf8ByteLength,
} from "../utils.js";

class FakeElement {
    constructor(tag = "div") {
        this.tag = tag;
        this.hidden = false;
        this.attributes = new Map();
        this.children = [];
        this.editable = false;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    append(child) {
        this.children.push(child);
    }

    closest() {
        return this.editable ? this : null;
    }
}

class ExpectedElement extends FakeElement {}

test("general utility helpers normalize text, colors, JSON, and calendar keys", () => {
    assert.equal(safeText(null), "");
    assert.equal(safeText(undefined), "");
    assert.equal(safeText(42), "42");
    assert.equal(formatDuration(3661), "1:01");
    assert.equal(formatDuration(-1), "—");
    assert.equal(formatDuration(Number.NaN), "—");
    assert.deepEqual(parseHexColor(" #A0b1C2 "), { r: 160, g: 177, b: 194 });
    assert.equal(parseHexColor("red"), null);
    for (const seed of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"]) {
        assert.match(hashColorHex(seed), /^#[0-9a-f]{6}$/);
    }
    assert.equal(hashColorHex(""), "#7c5cff");

    const original = { z: 1, nested: { b: 2, a: 1 }, list: [{ d: 4, c: 3 }] };
    const cloned = cloneJson(original);
    cloned.nested.a = 99;
    assert.equal(original.nested.a, 1);
    assert.deepEqual(sortJsonValue(original), { list: [{ c: 3, d: 4 }], nested: { a: 1, b: 2 }, z: 1 });
    assert.equal(jsonStringifySorted({ b: 2, a: 1 }), "{\n  \"a\": 1,\n  \"b\": 2\n}\n");
    assert.equal(utf8ByteLength("€"), 3);
    assert.match(utcNowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    assert.equal(chunkKey(2026, 3), "2026-W03");
    assert.deepEqual(parseIsoDate("2026-08-16"), { year: 2026, month: 8, day: 16 });
    assert.throws(() => parseIsoDate("16.08.2026"), /Invalid ISO date/);
    assert.equal(formatIsoDate(7, 2, 3), "0007-02-03");
    assert.equal(addIsoDays("2025-12-31", 1), "2026-01-01");
    assert.equal(isoWeekdayIndex("2026-08-16"), 6);
    assert.equal(isoWeekStart("2026-08-16"), "2026-08-10");
    assert.deepEqual(isoWeekInfo("2025-12-29"), { isoYear: 2026, week: 1 });
    assert.equal(isoWeekStartFromYearWeek(2026, 1), "2025-12-29");
    assert.equal(hhmmToMinutes("8:05"), 485);
    assert.equal(hhmmToMinutes("24:00"), null);
    assert.equal(hhmmToMinutes("bad"), null);
    assert.equal(minutesToHHMM(485), "08:05");
    assert.equal(minutesToHHMM(1441), "24:00");
    assert.equal(minutesToHHMM(Number.NaN), "—");
});

test("DOM utility helpers validate required elements and build local sprite icons", () => {
    const previousDocument = globalThis.document;
    const previousElement = globalThis.Element;
    const expected = new ExpectedElement();
    const wrong = new FakeElement();
    globalThis.Element = FakeElement;
    globalThis.document = /** @type {any} */ ({
        getElementById(id) {
            if (id === "expected") return expected;
            if (id === "wrong") return wrong;
            return null;
        },
        createElementNS(_namespace, tag) {
            return new FakeElement(tag);
        },
    });
    try {
        assert.equal(getRequiredElement("expected", ExpectedElement), expected);
        assert.throws(() => getRequiredElement("missing"), /Missing element/);
        assert.throws(() => getRequiredElement("wrong", ExpectedElement), /not ExpectedElement/);

        setVisible(expected, false);
        assert.equal(expected.hidden, true);
        setVisible(expected, true);
        assert.equal(expected.hidden, false);

        const icon = createMaterialIcon("search", "icon compact");
        assert.equal(icon.attributes.get("class"), "icon compact");
        assert.equal(icon.attributes.get("aria-hidden"), "true");
        assert.match(icon.children[0].attributes.get("href"), /material-symbols\.svg#search$/);

        expected.editable = true;
        assert.equal(isEditableTarget(expected), true);
        expected.editable = false;
        assert.equal(isEditableTarget(expected), false);
        assert.equal(isEditableTarget(null), false);
    } finally {
        globalThis.document = previousDocument;
        globalThis.Element = previousElement;
    }
});

test("source detection and timezone math preserve local calendar semantics across DST", () => {
    const previousWindow = globalThis.window;
    globalThis.window = /** @type {any} */ ({ location: { search: "?source=local" } });
    assert.equal(getSourceMode(), "local");
    globalThis.window = /** @type {any} */ ({ location: { search: "?source=github" } });
    assert.equal(getSourceMode(), "github");
    globalThis.window = /** @type {any} */ ({
        get location() {
            throw new Error("blocked");
        },
    });
    assert.equal(getSourceMode(), "github");
    globalThis.window = previousWindow;

    const context = new TimeContext("Europe/Berlin");
    const morning = context.dateFromLocalDayMinutes("2026-03-29", 8 * 60 + 30);
    assert.equal(context.formatDate(morning), "2026-03-29");
    assert.equal(context.formatTime(morning), "08:30");
    assert.equal(context.formatIsoWithOffset(morning), "2026-03-29T08:30:00+02:00");
    assert.equal(context.zonedParts(morning).hour, 8);
    assert.equal(context.tzOffsetMinutesAt(morning), 120);

    const bounds = context.weekBoundsMs("2026-03-23");
    assert.ok(bounds && bounds.endMs > bounds.startMs);
    assert.equal(context.weekBoundsMs(""), null);
    context.setTimeZone("UTC");
    assert.equal(context.formatIsoWithOffset(new Date("2026-08-16T10:00:00Z")), "2026-08-16T10:00:00+00:00");
});
