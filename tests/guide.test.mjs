import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";

for (const [language, filename] of [["en", "guide.html"], ["de", "guide.de.html"]]) {
    test(`${language} guide has complete chapter links, local screenshots, and no application bootstrap`, async () => {
        const guide = await readFile(new URL(`../${filename}`, import.meta.url), "utf8");
        assert.ok(guide.includes(`<html lang="${language}"`));
        const ids = new Set([...guide.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
        for (const [, id] of guide.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(id), `Broken chapter #${id}`);
        for (const [, file] of guide.matchAll(/(?:src|href)="\.\/([^"?#]+\.(?:png|svg|css|js|html))(?:#[^"]*)?"/g)) {
            await access(new URL(`../${file}`, import.meta.url));
        }
        assert.equal((guide.match(/<h1>/g) || []).length, 1);
        assert.ok(guide.includes(`href="./${filename}" lang="${language}" hreflang="${language}" aria-current="page"`));
        assert.doesNotMatch(guide, /src="\.\/(?:app|oauth|onboarding)\.js/);
        for (const [, attributes] of guide.matchAll(/<img\s+([^>]+)>/g)) assert.match(attributes, /\balt="[^"]*"/);
        const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
        assert.match(index, /href="\.\/guide\.html"/);
    });

    test(`${language} guide screenshots are covered by the existing playground publication scenario`, async () => {
        const guide = await readFile(new URL(`../${filename}`, import.meta.url), "utf8");
        const scenario = await readFile(new URL("./demo.browser.mjs", import.meta.url), "utf8");
        const published = JSON.parse(scenario.match(/const publishedImages = (\[[^;]+\]);/)[1]);
        const images = [...guide.matchAll(/<img\s+([^>]*src="\.\/assets\/guide\/([^"/]+)"[^>]*)>/g)];
        assert.equal(images.length, 6);
        for (const [, attributes, file] of images) {
            assert.ok(published.includes(file), `${file} missing from screenshot refresh`);
            assert.match(attributes, /alt="[^"]{30,}"/);
            assert.match(attributes, /width="\d+" height="\d+"/);
            const png = await readFile(new URL(`../assets/guide/${file}`, import.meta.url));
            assert.equal(png.subarray(1, 4).toString(), "PNG", `${file} must be a real PNG`);
            const [, width, height] = attributes.match(/width="(\d+)" height="(\d+)"/);
            assert.equal(png.readUInt32BE(16), Number(width), `${file}: declared width`);
            assert.equal(png.readUInt32BE(20), Number(height), `${file}: declared height`);
        }
        for (const route of ["time", "todos", "expenses"]) assert.ok(guide.includes(`./${route}?demo=1`));
    });
}

test("guide translations retain matching chapters and explicit language links", async () => {
    const en = await readFile(new URL("../guide.html", import.meta.url), "utf8");
    const de = await readFile(new URL("../guide.de.html", import.meta.url), "utf8");
    const chapters = (html) => [...html.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(chapters(en), chapters(de));
    assert.match(en, /href="\.\/guide\.de\.html" lang="de" hreflang="de"/);
    assert.match(de, /href="\.\/guide\.html" lang="en" hreflang="en"/);
    assert.doesNotMatch(en, /Your everyday life|Get tasks out of your head|without a spreadsheet|Field guide/i);
});
