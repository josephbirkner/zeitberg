import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const vendorDirectory = fileURLToPath(new URL("../vendor/qr-scanner/", import.meta.url));
const packageDirectory = new URL("../node_modules/qr-scanner/", import.meta.url);

/**
 * Copies the pinned QR scanner browser runtime and its license into the static application tree.
 * Keeping these generated files local preserves the first-party content-security policy and prevents capability links from reaching a third-party CDN.
 * @returns {Promise<void>}
 */
async function main() {
    await mkdir(vendorDirectory, { recursive: true });
    await Promise.all([
        copyFile(new URL("qr-scanner.min.js", packageDirectory), `${vendorDirectory}qr-scanner.min.js`),
        copyFile(new URL("qr-scanner-worker.min.js", packageDirectory), `${vendorDirectory}qr-scanner-worker.min.js`),
        copyFile(new URL("LICENSE", packageDirectory), `${vendorDirectory}LICENSE`),
    ]);
}

await main();
