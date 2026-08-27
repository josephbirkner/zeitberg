import assert from "node:assert/strict";
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
    for (const [, attributes, body] of scripts) {
        assert.match(attributes, /\bsrc="\.\//);
        assert.equal(body.trim(), "");
        assert.doesNotMatch(attributes, /src="https?:/);
    }
});

test("OAuth client ids are explicit public deployment configuration", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /name="zeitberg-oauth-gitlab-client-id" content=""/);
    assert.match(html, /name="zeitberg-oauth-codeberg-client-id" content=""/);
    assert.match(html, /id="loginOAuthBtn"/);
    assert.match(html, /id="workspaceCreateOAuthBtn"/);
});

test("the Zoidberg disclaimer uses a local image and identifies its template source", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /id="not-zoidberg"/);
    assert.match(html, /src="\.\/assets\/why-not-zeitberg-2\.png"/);
    assert.match(html, /href="https:\/\/imgflip\.com\/memegenerator\/Futurama-Zoidberg"/);
    assert.doesNotMatch(html, /<img\b[^>]*\bsrc="https?:\/\//);
    await access(new URL("../assets/why-not-zeitberg-2.png", import.meta.url));
});
