import assert from "node:assert/strict";
import test from "node:test";
import { ShellView } from "../shell.view.js";

test("app zoom and dialog viewport compensation always use the same normalized scale", (context) => {
    const body = new Map();
    const root = new Map();
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = {
        body: { style: { setProperty: (name, value) => body.set(name, value) } },
        documentElement: { style: { setProperty: (name, value) => root.set(name, value) } },
    };
    globalThis.window = { requestAnimationFrame: (callback) => callback() };
    context.after(() => {
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    });
    const shell = Object.assign(Object.create(ShellView.prototype), {
        locale: { formatNumber: String, t: (key) => key },
        elements: { appZoomLabelEl: {}, appZoomResetBtn: {}, appZoomOutBtn: {}, appZoomInBtn: {} },
        runtime: { config: {} }, state: { setConfig() {} }, updateResponsiveLayout() {},
        configService: { saveConfig() {} }, weekView: { handleResize() {} },
    });
    for (const zoom of [0.8, 1, 1.2, 1.6, 2, NaN]) {
        shell.setAppZoom(zoom);
        assert.equal(root.get("--app-zoom"), body.get("zoom"));
        assert.equal(Number(root.get("--app-zoom")), shell.uiZoom);
    }
});
