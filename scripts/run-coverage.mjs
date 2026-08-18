import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const C8_BIN = fileURLToPath(new URL("../node_modules/c8/bin/c8.js", import.meta.url));
const BROWSER_SMOKE = fileURLToPath(new URL("../tests/browser-smoke.mjs", import.meta.url));

/**
 * Runs one validation subprocess with inherited terminal output.
 *
 * @param {string} command Executable path.
 * @param {string[]} args Command arguments.
 * @returns {Promise<number>} Numeric exit status, normalized to one when terminated by a signal.
 */
function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: APP_ROOT, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => resolve(Number.isInteger(code) ? Number(code) : 1));
    });
}

const testDirectory = fileURLToPath(new URL("../tests", import.meta.url));
const unitTests = (await readdir(testDirectory))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url)));

// Run both layers even if the first fails: c8 still emits a useful report, while
// the browser result remains visible in the same local/CI invocation.
const coverageStatus = await run(process.execPath, [C8_BIN, process.execPath, "--test", ...unitTests]);
const browserStatus = await run(process.execPath, [BROWSER_SMOKE]);
if (coverageStatus !== 0 || browserStatus !== 0) process.exitCode = 1;
