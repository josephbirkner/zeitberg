import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const destination = path.resolve(process.argv[2] || path.join(root, "dist"));
// Never overwrite a directory supplied by the user. CI starts from a clean checkout.
await mkdir(destination);
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
const directories = new Set(["assets", "icons", "styles", "vendor", "schema", "workspace-template"]);
const files = new Set([".nojekyll", "CNAME", "site.webmanifest", "apple-touch-icon.png", "LICENSE"]);
for (const item of await readdir(root, { withFileTypes: true })) {
    if ((item.isDirectory() && directories.has(item.name)) || (item.isFile() && (/\.(?:js|html)$/.test(item.name) || files.has(item.name)))) {
        await cp(path.join(root, item.name), path.join(destination, item.name), { recursive: true });
    }
}
await writeFile(path.join(destination, "build-info.js"), `export const BUILD_INFO = ${JSON.stringify({ version: packageJson.version, commit, dirty })};\n`);
// Cache keys bind every runtime dependency to this artifact, including its build label.
const indexPath = path.join(destination, "index.html");
let html = (await readFile(indexPath, "utf8")).replace(/\?v=[^"\s]+/g, `?v=${commit}`);
const importMap = html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/)[1];
const hash = createHash("sha256").update(importMap).digest("base64");
html = html.replace(/'sha256-[^']+'/, `'sha256-${hash}'`);
await writeFile(indexPath, html);
console.log(`Built ${packageJson.version} (${commit.slice(0, 8)}${dirty ? ", local changes" : ""}) in ${destination}`);
