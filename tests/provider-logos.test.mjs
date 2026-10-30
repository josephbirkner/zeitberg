import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider cards display local decorative logos before their region flags", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    for (const provider of ["github", "gitlab", "codeberg"]) {
        const card = html.match(new RegExp(`<button[^>]*data-provider="${provider}"[^>]*>([\\s\\S]*?)</button>`))[1];
        const logo = `./assets/providers/${provider}.svg`;
        assert.ok(card.indexOf(logo) < card.indexOf('class="setup-region"'));
        assert.match(card, /class="setup-provider-icons" aria-hidden="true"/);
        assert.match(card, /class="setup-provider-logo[^"\n]*"[^>]*alt="" width="24" height="24"/);
        const svg = await readFile(new URL(`../assets/providers/${provider}.svg`, import.meta.url), "utf8");
        assert.match(svg, /<svg[^>]*viewBox=/);
        assert.doesNotMatch(svg, /<script|<foreignObject|(?:href|src)="https?:/i);
    }
});
