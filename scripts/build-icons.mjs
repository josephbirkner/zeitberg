import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = fileURLToPath(new URL("../assets/zeitberg-mark.svg", import.meta.url));
const assetsDirectory = fileURLToPath(new URL("../assets/", import.meta.url));
const background = { r: 39, g: 42, b: 59, alpha: 1 };

/**
 * Renders one deterministic PNG from the hand-authored zeitberg mark SVG.
 * Opaque outputs fill the SVG's rounded transparent corners with the brand background, as required for the iOS Web Clip fallback.
 * @param {Buffer} sourceSvg Original vector asset bytes.
 * @param {number} size Square output dimensions in physical pixels.
 * @param {string} filename Repository-relative output filename beneath assets/.
 * @param {boolean} opaque Whether to flatten transparent rounded corners onto the brand background.
 * @returns {Promise<void>}
 */
async function renderIcon(sourceSvg, size, filename, opaque) {
    let pipeline = sharp(sourceSvg, { density: 384 }).resize(size, size, {
        fit: "contain",
        background: opaque ? background : { r: 0, g: 0, b: 0, alpha: 0 },
    });
    if (opaque) pipeline = pipeline.flatten({ background });
    await pipeline
        .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
        .toFile(`${assetsDirectory}${filename}`);
}

/**
 * Renders an opaque install icon whose mark remains inside the maskable safe area.
 * A platform may crop a maskable icon to a circle, squircle, or another system shape, so the source mark is centered at 80% size over a full-bleed brand background.
 * @param {Buffer} sourceSvg Original vector asset bytes.
 * @param {number} size Square output dimensions in physical pixels.
 * @param {string} filename Repository-relative output filename beneath assets/.
 * @returns {Promise<void>}
 */
async function renderMaskableIcon(sourceSvg, size, filename) {
    const contentSize = Math.round(size * 0.8);
    const content = await sharp(sourceSvg, { density: 384 })
        .resize(contentSize, contentSize, { fit: "contain" })
        .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
        .toBuffer();
    await sharp({
        create: {
            width: size,
            height: size,
            channels: 4,
            background,
        },
    })
        .composite([{ input: content, gravity: "center" }])
        .flatten({ background })
        .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
        .toFile(`${assetsDirectory}${filename}`);
}

/**
 * Builds all browser-install assets and copies the iOS icon to Safari's root fallback filename.
 * @returns {Promise<void>}
 */
async function main() {
    await mkdir(assetsDirectory, { recursive: true });
    const sourceSvg = await readFile(sourcePath);
    await renderIcon(sourceSvg, 180, "apple-touch-icon.png", true);
    await renderIcon(sourceSvg, 192, "zeitberg-icon-192.png", false);
    await renderIcon(sourceSvg, 512, "zeitberg-icon-512.png", false);
    await renderMaskableIcon(sourceSvg, 512, "zeitberg-maskable-512.png");
    await copyFile(`${assetsDirectory}apple-touch-icon.png`, `${repositoryRoot}apple-touch-icon.png`);
}

await main();
