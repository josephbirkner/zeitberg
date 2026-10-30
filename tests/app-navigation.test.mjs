import assert from "node:assert/strict";
import test from "node:test";
import { App } from "../app.js";

/**
 * Builds a minimal application with the session-aware shell contract. A direct
 * state change cannot choose a compatible workspace; shell navigation can.
 * @param {boolean} hidden Whether the front page is currently displayed.
 * @returns {{app: App, events: string[]}}
 */
function navigationFixture(hidden) {
    const events = [];
    const app = Object.assign(Object.create(App.prototype), {
        workspaceSetup: false,
        workspace: { name: "Usedom", components: ["expenses"] },
        appSection: { hidden },
        state: { activeTab: "expenses", setActiveTab: assert.fail },
        writeCurrentRoute(mode) {
            assert.equal(this.appSection.hidden, false);
            events.push(`route:${mode}`);
        },
        shell: {
            setTab(tab) {
                events.push(`select:${tab}`);
                if (tab === "todos") app.workspace = { name: "Personal", components: ["todos"] };
                app.state.activeTab = tab;
            },
            showApplicationScreen() {
                events.push(`show:${app.workspace.name}`);
                app.appSection.hidden = false;
            },
        },
    });
    return { app, events };
}

test("front-page Tasks resume selects a compatible workspace before displaying it", async () => {
    const { app, events } = navigationFixture(true);
    await app.navigateToTab("todos");
    assert.deepEqual(events, ["select:todos", "show:Personal", "route:push"]);
    assert.equal(app.state.activeTab, "todos");
    assert.equal(app.appSection.hidden, false);
});

test("in-app navigation uses the same session-aware switch without reopening the screen", async () => {
    const { app, events } = navigationFixture(false);
    await app.navigateToTab("todos");
    assert.deepEqual(events, ["select:todos"]);
});

test("resuming the same workspace also writes its route after revealing the screen", async () => {
    const { app, events } = navigationFixture(true);
    await app.navigateToTab("expenses");
    assert.deepEqual(events, ["select:expenses", "show:Usedom", "route:push"]);
});

test("incomplete workspace setup does not allow component navigation", async () => {
    const { app, events } = navigationFixture(true);
    app.workspaceSetup = true;
    await app.navigateToTab("todos");
    assert.deepEqual(events, []);
});
