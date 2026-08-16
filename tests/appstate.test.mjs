import assert from "node:assert/strict";
import test from "node:test";

import { AppState } from "../appstate.js";

test("AppState keeps runtime navigation values normalized and repository config detached", () => {
    const initialConfig = { provider: "github", ref: "main" };
    const state = new AppState(initialConfig, false);

    initialConfig.ref = "changed-after-construction";
    assert.deepEqual(state.config, { provider: "github", ref: "main" });
    assert.equal(state.activeTab, "week");
    assert.equal(state.isLocalMode, false);

    const nextConfig = { provider: "gitlab", ref: "release/data" };
    state.setConfig(nextConfig);
    nextConfig.ref = "mutated";
    state.setToken("session-token");
    state.setWeekStart("2026-08-10");
    state.setLatestWeekStart("2026-08-17");
    state.setZoom(1.75);
    state.setEffectiveViewportWidth(840);
    state.setActiveTab("todos");

    assert.deepEqual(state.config, { provider: "gitlab", ref: "release/data" });
    assert.equal(state.token, "session-token");
    assert.equal(state.weekStart, "2026-08-10");
    assert.equal(state.latestWeekStart, "2026-08-17");
    assert.equal(state.zoom, 1.75);
    assert.equal(state.effectiveViewportWidth, 840);
    assert.equal(state.activeTab, "todos");

    state.setEffectiveViewportWidth(0);
    assert.equal(state.effectiveViewportWidth, null);
    state.setActiveTab(/** @type {any} */ ("unknown"));
    assert.equal(state.activeTab, "week");
});
