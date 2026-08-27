import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Reserves an available loopback port for an isolated development-server test.
 *
 * @returns {Promise<number>} Available TCP port.
 */
function reservePort() {
    return new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.once("error", reject);
        socket.listen(0, "127.0.0.1", () => {
            const address = socket.address();
            const port = address && typeof address === "object" ? address.port : 0;
            socket.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
}

/**
 * Waits until the static application root responds or the child process fails.
 *
 * @param {string} baseUrl Loopback server origin.
 * @param {import("node:child_process").ChildProcess} server Spawned Python server.
 * @returns {Promise<void>}
 */
async function waitForServer(baseUrl, server) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`Development server exited with code ${server.exitCode}.`);
        try {
            const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
            await response.arrayBuffer();
            if (response.ok) return;
        } catch {
            // The listener may not have bound yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Timed out waiting for the development server.");
}

/**
 * Stops a spawned development server without leaving a process behind after a failed assertion.
 *
 * @param {import("node:child_process").ChildProcess} server Spawned Python server.
 * @returns {Promise<void>}
 */
async function stopServer(server) {
    if (server.exitCode !== null) return;
    server.kill("SIGTERM");
    const exited = await Promise.race([
        new Promise((resolve) => server.once("exit", () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!exited && server.exitCode === null) server.kill("SIGKILL");
}

test("--no-local serves provider login and SPA routes without workspace APIs", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = spawn(
        "python3",
        ["server.py", "--no-local", "--host", "127.0.0.1", "--port", String(port)],
        { cwd: APP_ROOT, stdio: "ignore" },
    );

    try {
        await waitForServer(baseUrl, server);

        const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
        assert.equal(root.status, 200);
        assert.equal(root.headers.get("cache-control"), "no-store");
        assert.match(await root.text(), /id="loginSection"/);

        const applicationModule = await fetch(`${baseUrl}/app.js?v=test`, { redirect: "manual" });
        assert.equal(applicationModule.status, 200);
        assert.equal(applicationModule.headers.get("cache-control"), "no-store");
        await applicationModule.arrayBuffer();

        const component = await fetch(`${baseUrl}/time`, { redirect: "manual" });
        assert.equal(component.status, 200);
        assert.equal(component.headers.get("cache-control"), "no-store");
        assert.match(await component.text(), /id="loginSection"/);

        const callback = await fetch(`${baseUrl}/?oauth_provider=gitlab&code=test&state=test`, {
            redirect: "manual",
        });
        assert.equal(callback.status, 200);
        await callback.arrayBuffer();

        const localWorkspaces = await fetch(`${baseUrl}/local-workspaces`);
        assert.equal(localWorkspaces.status, 404);
        await localWorkspaces.arrayBuffer();

        const save = await fetch(`${baseUrl}/save`, { method: "POST", body: "{}" });
        assert.equal(save.status, 404);
        await save.arrayBuffer();
    } finally {
        await stopServer(server);
    }
});
