import QrScanner from "qr-scanner";

import { setVisible } from "./utils.js";

/**
 * @typedef {"camera" | "image" | "unavailable"} CapabilityScannerErrorKind
 * @description Stable failure categories translated by the owning workspace UI without coupling camera mechanics to application copy.
 */

/**
 * @typedef {Object} CapabilityScannerElements
 * @description Camera and file-picker elements used by the embedded workspace QR surface.
 * @property {HTMLElement} container Scanner surface shown while the user is importing a QR code.
 * @property {HTMLInputElement} fileInput Optional QR image picker used when a camera is unavailable or inconvenient.
 * @property {HTMLVideoElement} video Live rear-camera preview supplied to the decoder.
 */

/**
 * @typedef {Object} CapabilityScannerOptions
 * @description DOM and callbacks required by the capability scanner.
 * @property {CapabilityScannerElements} elements Scanner-owned elements.
 * @property {(value: string) => Promise<void> | void} onResult Receives one decoded QR payload after camera resources have been released.
 * @property {(kind: CapabilityScannerErrorKind, error: unknown) => void} onError Reports a user-actionable camera or image failure.
 * @property {() => void} onClearError Clears stale scanner feedback before a new attempt.
 * @property {typeof QrScanner} [scannerType] Injectable decoder implementation used by deterministic tests; production uses the pinned local qr-scanner package.
 */

/**
 * Owns the short-lived camera stream and QR image decoder used by Workspace settings.
 * The scanner is deliberately independent from capability parsing: it returns text only, releases camera and worker resources immediately, and lets WorkspaceController apply the same validation path used for pasted links.
 */
export class CapabilityScanner {
    /**
     * Captures scanner DOM and result/error callbacks without requesting camera permission.
     * Camera access remains strictly user-triggered through start(), which keeps initial page loading quiet and browser permission prompts contextual.
     * @param {CapabilityScannerOptions} options Scanner dependencies.
     */
    constructor(options) {
        this.elements = options.elements;
        this.onResult = options.onResult;
        this.onError = options.onError;
        this.onClearError = options.onClearError;
        this.Scanner = options.scannerType || QrScanner;
        /** @type {QrScanner | null} */
        this.scanner = null;
        this.acceptingResult = false;
    }

    /**
     * Reveals the scanner and starts the preferred rear-facing camera when browser and device support permit it.
     * The file picker remains available after a camera failure, so desktop browsers, denied permissions, and devices without cameras still have a complete import path.
     * @returns {Promise<boolean>} Whether a live camera stream started successfully.
     */
    async start() {
        this.stopCamera();
        this.onClearError();
        this.elements.container.classList?.remove("is-camera-unavailable");
        setVisible(this.elements.container, true);
        this.elements.container.setAttribute("aria-busy", "true");
        this.elements.container.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
        if (!navigator.mediaDevices?.getUserMedia) {
            this.elements.container.classList?.add("is-camera-unavailable");
            this.elements.container.setAttribute("aria-busy", "false");
            this.onError("unavailable", null);
            return false;
        }

        try {
            if (!(await this.Scanner.hasCamera())) {
                this.elements.container.classList?.add("is-camera-unavailable");
                this.elements.container.setAttribute("aria-busy", "false");
                this.onError("unavailable", null);
                return false;
            }
            const scanner = new this.Scanner(
                this.elements.video,
                (result) => void this.acceptResult(result.data),
                {
                    highlightCodeOutline: true,
                    highlightScanRegion: false,
                    maxScansPerSecond: 10,
                    onDecodeError: () => {},
                    preferredCamera: "environment",
                    returnDetailedScanResult: true,
                },
            );
            this.scanner = scanner;
            await scanner.start();
            if (this.scanner !== scanner) {
                scanner.destroy();
                return false;
            }
            this.elements.container.setAttribute("aria-busy", "false");
            return true;
        } catch (error) {
            this.stopCamera();
            this.elements.container.classList?.add("is-camera-unavailable");
            this.elements.container.setAttribute("aria-busy", "false");
            this.onError("camera", error);
            return false;
        }
    }

    /**
     * Decodes one user-selected image with the same local worker used by live camera scanning.
     * A successful image and a successful camera frame both converge on acceptResult(), ensuring secrets receive identical cleanup and capability validation.
     * @param {File | null} file Selected image file, or null when the picker was cancelled.
     * @returns {Promise<boolean>} Whether the image contained and delivered a QR payload.
     */
    async scanFile(file) {
        if (!file) return false;
        this.stopCamera();
        this.onClearError();
        this.elements.container.setAttribute("aria-busy", "true");
        try {
            const result = await this.Scanner.scanImage(file, { returnDetailedScanResult: true });
            await this.acceptResult(result.data);
            return true;
        } catch (error) {
            this.onError("image", error);
            return false;
        } finally {
            this.elements.fileInput.value = "";
            this.elements.container.setAttribute("aria-busy", "false");
        }
    }

    /**
     * Stops active decoding, releases every camera track and worker, and hides the embedded scanner surface.
     * This method is safe to call repeatedly from explicit cancellation, workspace-dialog closure, navigation, or a successful scan.
     * @returns {void}
     */
    close() {
        this.stopCamera();
        this.acceptingResult = false;
        this.elements.fileInput.value = "";
        this.elements.container.classList?.remove("is-camera-unavailable");
        this.elements.container.setAttribute("aria-busy", "false");
        setVisible(this.elements.container, false);
        this.onClearError();
    }

    /**
     * Destroys only the active camera decoder while leaving the scanner surface and image fallback available.
     * @returns {void}
     */
    stopCamera() {
        if (this.scanner) {
            this.scanner.destroy();
            this.scanner = null;
        }
        const stream = this.elements.video.srcObject;
        if (typeof MediaStream !== "undefined" && stream instanceof MediaStream) {
            for (const track of stream.getTracks()) track.stop();
        }
        this.elements.video.srcObject = null;
    }

    /**
     * Accepts the first decoded payload, tears down camera resources before exposing the value, and delegates parsing to WorkspaceController.
     * Duplicate frame callbacks are ignored while the asynchronous workspace connection begins.
     * @param {unknown} value Decoder result text.
     * @returns {Promise<void>}
     */
    async acceptResult(value) {
        const decoded = String(value || "").trim();
        if (!decoded || this.acceptingResult) return;
        this.acceptingResult = true;
        this.stopCamera();
        setVisible(this.elements.container, false);
        try {
            await this.onResult(decoded);
        } finally {
            this.acceptingResult = false;
        }
    }
}
