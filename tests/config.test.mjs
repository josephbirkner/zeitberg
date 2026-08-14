import assert from "node:assert/strict";
import test from "node:test";

import { getEffectiveUiViewportWidth, getRecommendedUiZoom } from "../config.js";

test("automatic app zoom remains at 100%", () => {
    assert.equal(getRecommendedUiZoom(), 1);
});

test("effective responsive width includes application zoom", () => {
    assert.equal(getEffectiveUiViewportWidth(874, 2), 437);
    assert.equal(getEffectiveUiViewportWidth(760, 1), 760);
    assert.equal(getEffectiveUiViewportWidth(760, 0), 760);
});
