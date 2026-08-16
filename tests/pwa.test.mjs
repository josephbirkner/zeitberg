import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

/**
 * Reads the dimensions encoded in a PNG's required IHDR chunk without relying on image-decoding behavior.
 * @param {Buffer} bytes Complete PNG file contents.
 * @returns {{ width: number, height: number }} Physical image dimensions in pixels.
 */
function readPngDimensions(bytes) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(bytes.subarray(0, signature.length), signature);
    assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
    return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
    };
}

test("web app metadata provides regular, maskable, and iOS install icons", async () => {
    const [html, manifestText, rootAppleIcon, assetAppleIcon] = await Promise.all([
        readFile(new URL("index.html", repositoryRoot), "utf8"),
        readFile(new URL("site.webmanifest", repositoryRoot), "utf8"),
        readFile(new URL("apple-touch-icon.png", repositoryRoot)),
        readFile(new URL("assets/apple-touch-icon.png", repositoryRoot)),
    ]);
    const manifest = JSON.parse(manifestText);

    assert.equal(manifest.name, "zeitplural");
    assert.equal(manifest.short_name, "zeitplural");
    assert.equal(manifest.start_url, "./time");
    assert.equal(manifest.scope, "./");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.theme_color, "#17191f");
    assert.equal(manifest.background_color, "#17191f");
    assert.deepEqual(
        manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
        [
            { src: "./assets/zeitplural-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "./assets/zeitplural-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "./assets/zeitplural-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
    );
    assert.deepEqual(rootAppleIcon, assetAppleIcon);
    assert.deepEqual(readPngDimensions(rootAppleIcon), { width: 180, height: 180 });

    for (const icon of manifest.icons) {
        const iconBytes = await readFile(new URL(icon.src.replace(/^\.\//, ""), repositoryRoot));
        const [width, height] = icon.sizes.split("x").map(Number);
        assert.deepEqual(readPngDimensions(iconBytes), { width, height });
    }

    assert.match(html, /rel="icon"[^>]+zeitplural-mark\.svg/);
    assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\.\/apple-touch-icon\.png"/);
    assert.match(html, /rel="manifest" href="\.\/site\.webmanifest"/);
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /name="apple-mobile-web-app-title" content="zeitplural"/);
});

test("relative install metadata resolves from root and project-page component routes", () => {
    const deployments = [
        "https://zeitplural.io/time",
        "https://example.github.io/zeitplural/todos",
        "https://example.test/nested/zeitplural/expenses",
    ];

    for (const componentRoute of deployments) {
        const manifestUrl = new URL("./site.webmanifest", componentRoute);
        const expectedBase = componentRoute.replace(/\/(?:time|todos|expenses)$/, "/");
        assert.equal(manifestUrl.href, `${expectedBase}site.webmanifest`);
        assert.equal(new URL("./time", manifestUrl).href, `${expectedBase}time`);
        assert.equal(new URL("./assets/zeitplural-maskable-512.png", manifestUrl).href, `${expectedBase}assets/zeitplural-maskable-512.png`);
    }
});
