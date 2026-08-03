import assert from "node:assert/strict";
import test from "node:test";

import {
    buildDayGaps,
    calculateDefaultGapEntryRange,
    calculatePointerEditTimes,
    calculateVisibleGapButtonMinute,
    calculateVisibleDayCount,
    clampDayWindowStart,
    formatTrackedHours,
} from "../docs/week.view.js";

const MINUTE_MS = 60_000;

test("day windows clamp to the seven-day week", () => {
    assert.equal(clampDayWindowStart(-4, 1), 0);
    assert.equal(clampDayWindowStart(5, 2), 5);
    assert.equal(clampDayWindowStart(6, 2), 5);
    assert.equal(clampDayWindowStart(3, 7), 0);
});

test("visible day count fits readable columns to the measured timeline width", () => {
    assert.equal(calculateVisibleDayCount(280), 1);
    assert.equal(calculateVisibleDayCount(320), 2);
    assert.equal(calculateVisibleDayCount(375), 2);
    assert.equal(calculateVisibleDayCount(600), 4);
    assert.equal(calculateVisibleDayCount(760), 5);
    assert.equal(calculateVisibleDayCount(1024), 7);
    assert.equal(calculateVisibleDayCount(1200), 7);
});

test("tracked week totals use compact decimal hours", () => {
    assert.equal(formatTrackedHours(0), "0h");
    assert.equal(formatTrackedHours(40 * 3600), "40h");
    assert.equal(formatTrackedHours(120.5 * 3600), "120.5h");
});

test("day gaps merge occupied ranges before finding free time", () => {
    const gaps = buildDayGaps([
        { startMinutes: 60, endMinutes: 120 },
        { startMinutes: 100, endMinutes: 180 },
        { startMinutes: 240, endMinutes: 300 },
    ]);

    assert.deepEqual(gaps, [
        { startMinutes: 0, endMinutes: 60 },
        { startMinutes: 180, endMinutes: 240 },
        { startMinutes: 300, endMinutes: 1440 },
    ]);
});

test("gap buttons create at most one hour adjacent to existing entries", () => {
    assert.deepEqual(calculateDefaultGapEntryRange(0, 9 * 60), {
        startMinutes: 8 * 60,
        endMinutes: 9 * 60,
    });
    assert.deepEqual(calculateDefaultGapEntryRange(10 * 60, 12 * 60), {
        startMinutes: 10 * 60,
        endMinutes: 11 * 60,
    });
    assert.deepEqual(calculateDefaultGapEntryRange(10 * 60, 10 * 60 + 30), {
        startMinutes: 10 * 60,
        endMinutes: 10 * 60 + 30,
    });
});

test("edge-gap buttons clamp into the visible part of their gap", () => {
    assert.equal(calculateVisibleGapButtonMinute(0, 9 * 60, 4.5 * 60, 8 * 60, 12 * 60, 15), 8 * 60 + 15);
    assert.equal(calculateVisibleGapButtonMinute(17 * 60, 24 * 60, 20.5 * 60, 12 * 60, 18 * 60, 15), 18 * 60 - 15);
    assert.equal(calculateVisibleGapButtonMinute(10 * 60, 11 * 60, 10.5 * 60, 8 * 60, 12 * 60, 15), 10.5 * 60);
    assert.equal(calculateVisibleGapButtonMinute(0, 9 * 60, 4.5 * 60, 10 * 60, 12 * 60, 15), 4.5 * 60);
});

test("pointer edits snap to 15 minutes and respect minimum duration", () => {
    const bounds = { startMs: 0, endMs: 7 * 24 * 60 * MINUTE_MS };
    const startMs = 8 * 60 * MINUTE_MS;
    const endMs = 9 * 60 * MINUTE_MS;

    assert.deepEqual(calculatePointerEditTimes("end", startMs, endMs, 8 * MINUTE_MS, bounds), {
        startMs,
        endMs: endMs + 15 * MINUTE_MS,
    });
    assert.deepEqual(calculatePointerEditTimes("start", startMs, endMs, 59 * MINUTE_MS, bounds), {
        startMs: endMs - 15 * MINUTE_MS,
        endMs,
    });
});

test("whole-entry pointer moves clamp without changing duration", () => {
    const bounds = { startMs: 0, endMs: 7 * 24 * 60 * MINUTE_MS };
    const duration = 90 * MINUTE_MS;
    const result = calculatePointerEditTimes("move", 30 * MINUTE_MS, 30 * MINUTE_MS + duration, -60 * MINUTE_MS, bounds);

    assert.deepEqual(result, { startMs: 0, endMs: duration });
});
