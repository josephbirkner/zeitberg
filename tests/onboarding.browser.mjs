import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium, firefox } from "playwright";
import { gitBlobSha1 } from "../utils.js";

const root = new URL("..", import.meta.url).pathname;
const port = await new Promise((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        socket.close(() => resolve(address.port));
    });
});
const origin = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["server.py", "--no-local", "--port", String(port), "--host", "127.0.0.1"], { cwd: root, stdio: "ignore" });
let browser;
try {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const response = await fetch(origin);
            await response.arrayBuffer();
            if (response.ok) break;
        } catch { /* Wait for the isolated local server. */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const useFirefox = process.argv.includes("--firefox");
    browser = await (useFirefox ? firefox : chromium).launch({ headless: true,
        executablePath: useFirefox ? process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH : undefined });
    const scenarios = ["success", "existing-workspace", "duplicate", "validation", "stalled", "post-write-stalled", "initialization-failed"];
    for (const [provider, scenario] of ["gitlab", "codeberg"].flatMap((provider) => scenarios.map((scenario) => [provider, scenario]))) {
        const page = await browser.newPage({ locale: "de-DE", viewport: useFirefox ? null : { width: 1280, height: 720 } });
        const files = new Map();
        const requests = [];
        const errors = [];
        let creations = 0;
        const succeeds = ["success", "existing-workspace"].includes(scenario);
        const host = provider === "gitlab" ? "gitlab.com" : "codeberg.org";
        const repositoryUrl = `https://${host}/person/new-space`;
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(({ provider, origin, scenario }) => {
            window.onboardingProgress = [];
            document.addEventListener("DOMContentLoaded", () => {
                const label = document.getElementById("loadProgressLabel");
                new MutationObserver(() => window.onboardingProgress.push(label.textContent))
                    .observe(label, { childList: true, subtree: true, characterData: true });
            });
            if (["stalled", "post-write-stalled"].includes(scenario)) {
                const timeout = AbortSignal.timeout.bind(AbortSignal);
                AbortSignal.timeout = () => timeout(500);
            }
            sessionStorage.setItem("zeitberg:oauth-pending:v1", JSON.stringify({
                version: 1, provider, client_id: "test-public-id", state: "test-state",
                verifier: "v".repeat(86), created_at: Date.now(),
                redirect_uri: `${origin}/?oauth_provider=${provider}`,
                intent: { mode: "create", repositoryUrl: "", ref: "main", workspacePath: "zeitberg.json",
                    expectedWorkspaceId: "", remember: false, repositoryName: "new-space",
                    workspaceName: "OAuth workspace", timezone: "Europe/Berlin" },
            }));
        }, { provider, origin, scenario });
        await page.route("**/*", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin === origin) return route.continue();
            requests.push(`${request.method()} ${url.pathname}`);
            /**
             * Returns fictional API data without contacting the real provider.
             * @param {object} body Response document.
             * @param {number} [status] HTTP result code.
             * @returns {Promise<void>}
             */
            const respond = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
            if (url.hostname !== host) {
                errors.push(`Unexpected host: ${url.hostname}`);
                return route.abort();
            }
            if (url.pathname.endsWith("/oauth/token") || url.pathname.endsWith("/oauth/access_token")) {
                return respond({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 7200, token_type: "Bearer" });
            }
            if (url.pathname.includes("old-space")) return respond({ message: "Access revoked" }, 403);
            if (["/api/v4/projects", "/api/v1/user/repos"].includes(url.pathname)) {
                creations++;
                if (scenario === "duplicate") return respond(provider === "gitlab"
                    ? { message: { name: ["has already been taken"], path: ["has already been taken"] } }
                    : { message: "The repository with the same name already exists." }, 400);
                if (scenario === "validation") return respond({ message: { name: ["is invalid"] } }, 400);
                return respond({ web_url: repositoryUrl, html_url: repositoryUrl }, 201);
            }
            if (url.pathname.endsWith("/repository/commits")) {
                for (const action of request.postDataJSON().actions) files.set(action.file_path, action.content);
                return respond({ id: "a".repeat(40) }, 201);
            }
            const marker = provider === "gitlab" ? "/repository/files/" : "/contents/";
            if (url.pathname.includes(marker)) {
                if (scenario === "stalled") {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    return route.abort().catch(() => {});
                }
                if (scenario === "initialization-failed") return respond({ message: "Temporarily unavailable" }, 503);
                const filePath = decodeURIComponent(url.pathname.split(marker)[1]);
                // GitLab verifies committed files; Forgejo must receive the final write response.
                // Both can stall even though every seed file is already visible in the provider UI.
                if (scenario === "post-write-stalled" && provider === "gitlab" && files.has("zeitberg.json")) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    return route.abort().catch(() => {});
                }
                if (request.method() !== "GET") {
                    const content = Buffer.from(request.postDataJSON().content, "base64").toString("utf8");
                    files.set(filePath, content);
                    if (scenario === "post-write-stalled" && filePath === "zeitberg.json") {
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                        return route.abort().catch(() => {});
                    }
                    return respond({ content: { sha: gitBlobSha1(content) } }, 201);
                }
                if (!files.has(filePath)) return respond({ message: "Not found" }, 404);
                let content = files.get(filePath);
                if (url.pathname.includes("another-space") && filePath === "zeitberg.json") {
                    content = JSON.stringify({ ...JSON.parse(content), name: "Another workspace", workspace_id: "another-workspace" });
                }
                return respond({ encoding: "base64", content: Buffer.from(content).toString("base64"),
                    sha: gitBlobSha1(content), blob_id: gitBlobSha1(content), last_commit_id: "a".repeat(40) });
            }
            if (url.pathname.endsWith("/user")) return respond({ login: "person", username: "person" });
            if (["/api/v4/projects/person%2Fnew-space", "/api/v1/repos/person/new-space",
                "/api/v4/projects/person%2Fanother-space", "/api/v1/repos/person/another-space"].includes(url.pathname)) {
                return respond({ full_name: "person/new-space", path_with_namespace: "person/new-space" });
            }
            errors.push(`Unexpected endpoint: ${url.pathname}`);
            return respond({ message: "Unexpected endpoint" }, 500);
        });
        if (scenario === "existing-workspace") {
            await page.goto(origin);
            await page.locator("#loginSection:not([hidden])").waitFor();
            await page.evaluate(async ({ provider, host }) => {
                const { ConfigService, WorkspaceRegistry } = await import("/config.js");
                const { configForRouteWorkspace } = await import("/workspace.js");
                const config = new ConfigService();
                const registry = new WorkspaceRegistry();
                const previous = registry.upsert({ provider, repositoryUrl: `https://${host}/person/old-space`,
                    ref: "main", workspacePath: "zeitberg.json", expectedWorkspaceId: "" }, { displayName: "Previous workspace" });
                registry.setActive(previous.id);
                config.saveWorkspaceRegistry(registry);
                config.saveConfig(configForRouteWorkspace(config.loadConfig(), previous.toLocator()));
                config.saveWorkspaceCredential(previous.id, "previous-token", true);
            }, { provider, host });
        }
        await page.goto(`${origin}/?oauth_provider=${provider}&code=test-code&state=test-state`);
        try {
            await page.locator(succeeds ? "#appSection:not([hidden])" : "#loginError:not([hidden])").waitFor({ timeout: 10000 });
        } catch (error) {
            console.error({ provider, errors, requests, body: (await page.locator("body").innerText()).slice(-2000) });
            throw error;
        }
        assert.equal(creations, 1);
        const progress = await page.evaluate(() => window.onboardingProgress.join("\n"));
        assert.match(progress, /Privates Repository wird erstellt/);
        if (!["duplicate", "validation"].includes(scenario)) assert.match(progress, /Workspace-Dateien werden nach/);
        if (succeeds) {
            assert.ok(files.has("zeitberg.json"));
            assert.equal(await page.locator("#documentWorkspaceName").textContent(), "OAuth workspace");
            const registry = await page.evaluate(async () => {
                const { ConfigService } = await import("/config.js");
                const config = new ConfigService();
                const registry = config.loadWorkspaceRegistry();
                return { repository: registry.getActive()?.repositoryUrl, count: registry.list().length,
                    token: config.loadWorkspaceCredential(registry.getActive()?.id) };
            });
            assert.equal(registry.repository, repositoryUrl);
            assert.equal(registry.token, "test-access");
            assert.equal(registry.count, scenario === "existing-workspace" ? 2 : 1);
            if (scenario === "success") {
                // The welcome page retains mounted sessions. Opening another repository
                // from its workspace dialog must reveal the document, not just load it.
                await page.locator("#appHomeLink").click();
                await page.locator("#workspaceSettingsBtn").click();
                await page.locator("#workspaceProvider").selectOption(provider);
                await page.locator("#workspaceRepository").fill(`https://${host}/person/another-space`);
                await page.locator("#workspaceToken").fill("another-token");
                await page.locator("#workspaceAddForm").evaluate((form) => form.requestSubmit());
                await page.locator("#workspaceDialog").waitFor({ state: "hidden" });
                await page.locator("#appSection:not([hidden])").waitFor({ timeout: 3000 });
                assert.equal(await page.locator("#documentWorkspaceName").textContent(), "Another workspace");
                assert.equal(await page.locator("#loginSection").isVisible(), false);
                await page.locator("#appHomeLink").click();
                await page.locator("#workspaceSettingsBtn").click();
                const requestCount = requests.length;
                await page.locator('.workspace-row', { hasText: 'OAuth workspace' }).locator('[data-workspace-action="open"]').click();
                await page.locator("#appSection:not([hidden])").waitFor({ timeout: 3000 });
                assert.equal(await page.locator("#documentWorkspaceName").textContent(), "OAuth workspace");
                assert.equal(await page.locator("#loginSection").isVisible(), false);
                assert.equal(requests.length, requestCount, "Opening a ready session must not re-fetch its data");
            }
        }
        else {
            const message = await page.locator("#loginError").innerText();
            assert.doesNotMatch(message, /\[object Object\]/);
            if (scenario === "duplicate") assert.match(message, /bereits vergeben/);
            if (scenario === "validation") assert.match(message, /name: is invalid/);
            if (["stalled", "post-write-stalled", "initialization-failed"].includes(scenario)) {
                assert.ok(message.includes(repositoryUrl));
                assert.match(message, /bestehende Repository/);
                assert.ok(await page.evaluate(() => Object.values(sessionStorage).some((value) => value.includes("test-access"))), "Keep the grant for reconnecting to the created repository");
            }
            if (["stalled", "post-write-stalled"].includes(scenario)) assert.match(message, /zu lange gedauert/);
            if (scenario === "post-write-stalled") assert.ok(files.has("zeitberg.json"));
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.locator("#loadingSection").isVisible(), false);
        await page.close();
        console.log(`${provider} OAuth creation: ${scenario} passed`);
    }
} finally {
    await browser?.close();
    server.kill("SIGTERM");
}
