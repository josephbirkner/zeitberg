import assert from "node:assert/strict";
import test from "node:test";

import { CapabilityScanner } from "../capability-scanner.js";

/**
 * Minimal deterministic stand-in for the vendored camera decoder.
 * Tests control camera availability and image results without requesting hardware or creating workers.
 */
class FakeQrScanner {
    static cameraAvailable = true;
    static imageResult = "";
    static instance = null;

    static async hasCamera() {
        return this.cameraAvailable;
    }

    static async scanImage() {
        if (!this.imageResult) throw new Error("No QR code found");
        return { data: this.imageResult, cornerPoints: [] };
    }

    constructor(video, onDecode) {
        this.video = video;
        this.onDecode = onDecode;
        this.destroyed = false;
        FakeQrScanner.instance = this;
    }

    async start() {
        this.video.srcObject = null;
    }

    destroy() {
        this.destroyed = true;
    }

    emit(value) {
        this.onDecode({ data: value, cornerPoints: [] });
    }
}

/**
 * Installs the browser globals touched by camera feature detection and cleanup.
 * @param {import("node:test").TestContext} testContext Active test lifecycle.
 * @returns {void}
 */
function installCameraGlobals(testContext) {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const originalMediaStream = Object.getOwnPropertyDescriptor(globalThis, "MediaStream");
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { mediaDevices: { getUserMedia: async () => null } },
    });
    Object.defineProperty(globalThis, "MediaStream", {
        configurable: true,
        value: class FakeMediaStream {},
    });
    testContext.after(() => {
        if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
        else delete globalThis.navigator;
        if (originalMediaStream) Object.defineProperty(globalThis, "MediaStream", originalMediaStream);
        else delete globalThis.MediaStream;
    });
}

/**
 * Creates plain DOM-like elements sufficient for the scanner's visibility and resource lifecycle.
 * @returns {{container: any, fileInput: any, video: any}}
 */
function scannerElements() {
    return {
        container: {
            attributes: new Map(),
            hidden: true,
            setAttribute(name, value) {
                this.attributes.set(name, value);
            },
        },
        fileInput: { value: "" },
        video: { srcObject: null },
    };
}

test("camera and image QR results converge on one decoded capability callback", async (testContext) => {
    installCameraGlobals(testContext);
    FakeQrScanner.cameraAvailable = true;
    FakeQrScanner.imageResult = "image-capability";
    const elements = scannerElements();
    const results = [];
    const errors = [];
    const scanner = new CapabilityScanner({
        elements,
        scannerType: FakeQrScanner,
        onResult: async (value) => results.push(value),
        onError: (kind) => errors.push(kind),
        onClearError: () => {},
    });

    assert.equal(await scanner.start(), true);
    assert.equal(elements.container.hidden, false);
    const camera = FakeQrScanner.instance;
    camera.emit("camera-capability");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(results, ["camera-capability"]);
    assert.equal(camera.destroyed, true);
    assert.equal(elements.container.hidden, true);

    assert.equal(await scanner.scanFile(/** @type {any} */ ({})), true);
    assert.deepEqual(results, ["camera-capability", "image-capability"]);
    assert.deepEqual(errors, []);
});

test("camera absence keeps the QR image fallback open", async (testContext) => {
    installCameraGlobals(testContext);
    FakeQrScanner.cameraAvailable = false;
    const elements = scannerElements();
    const errors = [];
    const scanner = new CapabilityScanner({
        elements,
        scannerType: FakeQrScanner,
        onResult: () => {},
        onError: (kind) => errors.push(kind),
        onClearError: () => {},
    });

    assert.equal(await scanner.start(), false);
    assert.equal(elements.container.hidden, false);
    assert.deepEqual(errors, ["unavailable"]);
    scanner.close();
    assert.equal(elements.container.hidden, true);
});
