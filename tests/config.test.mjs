import assert from "node:assert/strict";
import test from "node:test";

import { getRecommendedUiZoom } from "../docs/config.js";

test("compact coarse-pointer viewports receive 200% automatic zoom", () => {
    assert.equal(getRecommendedUiZoom(390, 844, true), 2);
    assert.equal(getRecommendedUiZoom(844, 390, true), 2);
});

test("automatic zoom does not treat pixel density or viewport width alone as a phone", () => {
    assert.equal(getRecommendedUiZoom(390, 844, false), 1);
    assert.equal(getRecommendedUiZoom(1024, 768, true), 1);
    assert.equal(getRecommendedUiZoom(1024, 600, true), 1);
    assert.equal(getRecommendedUiZoom(0, 844, true), 1);
});
