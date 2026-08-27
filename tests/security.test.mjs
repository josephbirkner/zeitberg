import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("the static application enforces first-party scripts and provider-aware connect policy", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] || "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /connect-src 'self' https:/);
    assert.match(csp, /object-src 'none'/);

    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 2);
    let importMapCount = 0;
    for (const [, attributes, body] of scripts) {
        if (/\btype="importmap"/.test(attributes)) {
            importMapCount += 1;
            assert.doesNotMatch(attributes, /\bsrc=/);
            const digest = createHash("sha256").update(body).digest("base64");
            assert.match(csp, new RegExp(`'sha256-${digest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
            assert.doesNotThrow(() => JSON.parse(body));
            continue;
        }
        assert.match(attributes, /\bsrc="\.\//);
        assert.equal(body.trim(), "");
        assert.doesNotMatch(attributes, /src="https?:/);
    }
    assert.equal(importMapCount, 1);
});

test("one release token versions every static runtime dependency", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const importMapBody = html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/)?.[1] || "";
    const importMap = JSON.parse(importMapBody);
    const topLevelAssets = [...html.matchAll(/(?:src|href)="\.\/[^"?#]+\.(?:js|css)\?v=([^"&]+)"/g)]
        .map((match) => match[1]);
    assert.ok(topLevelAssets.length >= 6);
    const versions = new Set(topLevelAssets);
    for (const destination of Object.values(importMap.imports || {})) {
        const version = new URL(destination, "https://zeitberg.io/").searchParams.get("v");
        assert.ok(version);
        versions.add(version);
    }
    assert.equal(versions.size, 1, `Mixed static asset versions: ${[...versions].join(", ")}`);
});

test("OAuth client ids are explicit public deployment configuration", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /name="zeitberg-oauth-gitlab-client-id" content=""/);
    assert.match(html, /name="zeitberg-oauth-codeberg-client-id" content=""/);
    assert.match(html, /id="loginOAuthBtn"/);
    assert.match(html, /id="workspaceCreateOAuthBtn"/);
});

test("workspace and project settings use distinct local Material Symbols", async () => {
    const [html, sprite] = await Promise.all([
        readFile(new URL("../index.html", import.meta.url), "utf8"),
        readFile(new URL("../icons/material-symbols.svg", import.meta.url), "utf8"),
    ]);
    assert.match(sprite, /<symbol id="widgets"/);
    assert.match(sprite, /<symbol id="account_tree"/);
    assert.match(
        html,
        /id="workspaceSettingsBtn"[\s\S]*?material-symbols\.svg#widgets[\s\S]*?<\/button>/,
    );
    assert.match(
        html,
        /id="projectsBtn"[\s\S]*?material-symbols\.svg#account_tree[\s\S]*?<\/button>/,
    );
});

test("the Zoidberg disclaimer uses a local image and identifies its template source", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /id="not-zoidberg"/);
    assert.match(html, /src="\.\/assets\/why-not-zeitberg-2\.png"/);
    assert.match(html, /href="https:\/\/imgflip\.com\/memegenerator\/Futurama-Zoidberg"/);
    assert.doesNotMatch(html, /<img\b[^>]*\bsrc="https?:\/\//);
    await access(new URL("../assets/why-not-zeitberg-2.png", import.meta.url));
});
