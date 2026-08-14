#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = resolve(SCRIPT_DIR, "..");

const CODE_PATHS = [
    ".gitignore",
    "ROADMAP.md",
    "TODO.md",
    "app/",
    "docs/",
    "package-lock.json",
    "package.json",
    "schema/",
    "data/schema/entries-v2.schema.json",
    "data/schema/projects-v2.schema.json",
    "data/schema/todos-v3.schema.json",
    "scripts/import-todoist.mjs",
    "scripts/split-repositories.mjs",
    "scripts/validate-workspace.mjs",
    "scripts/workspace.mjs",
    "server.py",
    "tests/",
    "tsconfig.json",
];

const DATA_PATHS = [
    "planplural.json",
    "data/index/entries-manifest.json",
    "data/projects.json",
    "data/todos.json",
    "data/week-requirements.json",
];

/**
 * @typedef {Object} SplitOptions
 * @property {string} source
 * @property {string} output
 * @property {string} branch
 * @property {boolean} verify
 */

/**
 * Parses the deliberately non-destructive split command line.
 * An explicit output directory is mandatory, and the script never creates remotes or pushes rewritten history.
 * @param {string[]} argv Command-line arguments excluding node and script paths.
 * @returns {SplitOptions}
 */
function parseArgs(argv) {
    const options = { source: CODE_ROOT, output: "", branch: "main", verify: true };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--source") {
            index += 1;
            if (!argv[index]) throw new Error("--source requires a local path or Git URL");
            options.source = argv[index];
        } else if (arg === "--output") {
            index += 1;
            if (!argv[index]) throw new Error("--output requires a directory");
            options.output = resolve(argv[index]);
        } else if (arg === "--branch") {
            index += 1;
            if (!argv[index]) throw new Error("--branch requires a branch name");
            options.branch = argv[index];
        } else if (arg === "--skip-verify") {
            options.verify = false;
        } else if (arg === "--help" || arg === "-h") {
            process.stdout.write(
                "Usage: node scripts/split-repositories.mjs --output PATH [--source PATH_OR_URL] " +
                    "[--branch NAME] [--skip-verify]\n\n" +
                    "Creates PATH/planplural and PATH/planplural-data from fresh clones. It never pushes or modifies the source.\n",
            );
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!options.output) throw new Error("--output is required");
    return options;
}

/**
 * Runs one subprocess with inherited output and throws a concise command-oriented error on failure.
 * Array arguments avoid shell expansion, keeping repository paths and regex filters literal.
 * @param {string} command Executable name.
 * @param {string[]} args Argument vector.
 * @param {string} cwd Working directory.
 * @param {boolean} [capture] Return stdout instead of inheriting it.
 * @returns {string}
 */
function run(command, args, cwd, capture = false) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = capture ? String(result.stderr || result.stdout || "").trim() : "";
        throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
    }
    return capture ? String(result.stdout || "") : "";
}

/**
 * Resolves an existing local source path while leaving remote Git URLs untouched.
 * @param {string} source User-provided source path or URL.
 * @returns {string}
 */
function normalizeSource(source) {
    const local = resolve(source);
    return existsSync(local) ? local : source;
}

/**
 * Refuses to mix rewritten history into pre-existing directories.
 * This guard makes retries explicit and keeps every run recoverable by deleting only the dedicated output parent chosen by the user.
 * @param {string} outputParent Parent directory selected with --output.
 * @returns {{code: string, data: string}}
 */
function prepareDestinations(outputParent) {
    const code = join(outputParent, "planplural");
    const data = join(outputParent, "planplural-data");
    if (existsSync(code) || existsSync(data)) {
        throw new Error(`Refusing to overwrite existing split destination under ${outputParent}.`);
    }
    mkdirSync(outputParent, { recursive: true });
    return { code, data };
}

/**
 * Ensures a local source checkout is committed before fresh clones are made.
 * Remote URLs are immutable from this process and therefore skip the working-tree check.
 * @param {string} source Normalized source path or URL.
 * @returns {void}
 */
function assertCleanLocalSource(source) {
    if (!existsSync(source)) return;
    const status = run("git", ["status", "--porcelain"], source, true);
    if (status.trim()) throw new Error("The source checkout has uncommitted changes; commit the compatibility checkpoint first.");
}

/**
 * Prevents generated clones from being nested inside a local source checkout.
 * Keeping outputs outside the source avoids an untracked recursive tree and makes the source-cleanliness guarantee remain true for the entire run.
 * @param {string} source Normalized source path or URL.
 * @param {string} outputParent Requested split parent directory.
 * @returns {void}
 */
function assertOutputOutsideSource(source, outputParent) {
    if (!existsSync(source)) return;
    const relation = relative(resolve(source), resolve(outputParent));
    if (!relation || (relation !== ".." && !relation.startsWith(`..${sep}`))) {
        throw new Error("--output must be outside the local source checkout.");
    }
}

/**
 * Creates one fresh single-branch clone suitable for git-filter-repo's safety model.
 * @param {string} source Local source path or Git URL.
 * @param {string} destination New clone destination.
 * @param {string} branch Source branch to preserve.
 * @returns {void}
 */
function cloneSource(source, destination, branch) {
    run("git", ["clone", "--no-local", "--single-branch", "--branch", branch, source, destination], CODE_ROOT);
}

/**
 * Filters and relocates the public application history.
 * Historical app/ and current docs/ are merged into repository root; exact script/schema selection deliberately excludes obsolete personal migration and Toggl artifacts.
 * @param {string} repository Fresh code clone.
 * @returns {void}
 */
function filterCodeRepository(repository) {
    const args = ["filter-repo", "--force"];
    for (const path of CODE_PATHS) args.push("--path", path);
    args.push("--path-rename", "app/:", "--path-rename", "docs/:", "--path-rename", "data/schema/:schema/");
    run("git", args, repository);
}

/**
 * Filters the private history to canonical workspace documents only.
 * The strict week-path regex omits root CSV/PNG exports, yearly aggregate JSON, raw provider dumps, schema copies, and placeholder files.
 * @param {string} repository Fresh data clone.
 * @returns {void}
 */
function filterDataRepository(repository) {
    const args = ["filter-repo", "--force"];
    for (const path of DATA_PATHS) args.push("--path", path);
    args.push("--path-regex", "^data/entries/[0-9]{4}/[0-9]{2}\\.json$");
    run("git", args, repository);
}

/**
 * Recursively returns text files whose imports or documentation may refer to the pre-split docs/ source directory.
 * @param {string} directory Directory to scan.
 * @returns {string[]}
 */
function listRewriteFiles(directory) {
    const result = [];
    for (const name of readdirSync(directory)) {
        if (name === ".git" || name === "node_modules") continue;
        const path = join(directory, name);
        const stat = statSync(path);
        if (stat.isDirectory()) result.push(...listRewriteFiles(path));
        else if ([".js", ".json", ".md", ".mjs"].includes(extname(name))) result.push(path);
    }
    return result;
}

/**
 * Updates references that cannot be transformed by filename filtering itself.
 * Relative imports from tests/scripts and documentation paths are rewritten after docs/ becomes repository root, then recorded as one explicit post-rewrite compatibility commit.
 * @param {string} repository Filtered code repository.
 * @returns {void}
 */
function finalizeCodeLayout(repository) {
    for (const path of listRewriteFiles(repository)) {
        const before = readFileSync(path, "utf8");
        const after = before
            .replaceAll("../docs/", "../")
            .replaceAll("docs/index.html", "index.html")
            .replaceAll("docs/app.js", "app.js")
            .replaceAll("docs/style.css", "style.css")
            .replaceAll("/docs/?source=local", "/?source=local")
            .replaceAll('"include": ["docs/**/*.js"]', '"include": ["*.js"]')
            .replaceAll('repo: "timetracking"', 'repo: "planplural-data"')
            .replaceAll(
                "During the compatibility checkpoint, the deployable application remains under `docs/` so the existing Pages site cannot expose mixed-repository root data. `npm run split:prepare` rewrites historical `app/` and `docs/` paths to the root of the resulting public `planplural` repository.",
                "Application files live at the repository root; private workspace documents are loaded exclusively from a separate repository.",
            )
            .replaceAll(
                "In the compatibility checkout, omit `--workspace` to use its embedded `planplural.json` and open `http://127.0.0.1:8000/?source=local`. In the final top-level code repository, the server opens `http://127.0.0.1:8000/?source=local`.",
                "With a sibling `planplural-data` checkout, `--workspace` may be omitted. Open `http://127.0.0.1:8000/?source=local`.",
            );
        if (after !== before) writeFileSync(path, after, "utf8");
    }
    const status = run("git", ["status", "--porcelain"], repository, true);
    if (!status.trim()) return;
    run("git", ["add", "-A"], repository);
    run("git", ["commit", "-m", "Finalize top-level planplural layout."], repository);
}

/**
 * Audits rewritten path history and common credential formats before either candidate can be considered publishable.
 * The scan reports filenames only and never prints matching secret text; author identities remain visible for the separate manual public-history decision.
 * @param {string} codeRepository Filtered public repository.
 * @param {string} dataRepository Filtered private repository.
 * @returns {void}
 */
function auditFilteredHistory(codeRepository, dataRepository) {
    const publicPaths = run("git", ["log", "--all", "--name-only", "--pretty=format:"], codeRepository, true)
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean);
    const leakedPublicPath = publicPaths.find(
        (path) =>
            path === "planplural.json" ||
            path.startsWith("data/") ||
            /^\d{4}\.csv$/i.test(path) ||
            /^\d{4}\/\d+\.png$/i.test(path),
    );
    if (leakedPublicPath) throw new Error(`Private path survived in public history: ${leakedPublicPath}`);

    const dataPaths = run("git", ["log", "--all", "--name-only", "--pretty=format:"], dataRepository, true)
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean);
    const invalidDataPath = dataPaths.find(
        (path) =>
            path !== "planplural.json" &&
            path !== "data/index/entries-manifest.json" &&
            path !== "data/projects.json" &&
            path !== "data/todos.json" &&
            path !== "data/week-requirements.json" &&
            !/^data\/entries\/[0-9]{4}\/[0-9]{2}\.json$/.test(path),
    );
    if (invalidDataPath) throw new Error(`Non-canonical path survived in private history: ${invalidDataPath}`);

    const revisions = run("git", ["rev-list", "--all"], codeRepository, true)
        .split(/\r?\n/)
        .map((revision) => revision.trim())
        .filter(Boolean);
    const secretPattern =
        "gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer [A-Za-z0-9_=-]{20,}";
    const grep = spawnSync("git", ["grep", "-l", "-I", "-E", secretPattern, ...revisions], {
        cwd: codeRepository,
        encoding: "utf8",
    });
    if (grep.error) throw grep.error;
    if (grep.status === 0) {
        const files = String(grep.stdout || "")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => line.replace(/^[0-9a-f]{40}:/, ""));
        throw new Error(`Potential credential found in public history: ${[...new Set(files)].join(", ")}`);
    }
    if (grep.status !== 1) throw new Error("Public-history credential scan failed.");

    const authors = run("git", ["log", "--all", "--format=%an <%ae>"], codeRepository, true)
        .split(/\r?\n/)
        .map((author) => author.trim())
        .filter(Boolean);
    process.stdout.write(`Public-history authors for manual review:\n  ${[...new Set(authors)].sort().join("\n  ")}\n`);
}

/**
 * Runs application checks against the code repository and then validates its sibling private workspace.
 * Verification is intentionally performed before any remote repository is created or updated.
 * @param {string} codeRepository Filtered public repository.
 * @param {string} dataRepository Filtered private repository.
 * @returns {void}
 */
function verifySplit(codeRepository, dataRepository) {
    auditFilteredHistory(codeRepository, dataRepository);
    run("npm", ["ci"], codeRepository);
    run("npm", ["test"], codeRepository);
    run("npm", ["run", "typecheck"], codeRepository);
    run("npm", ["run", "check:data", "--", "--workspace", dataRepository], codeRepository);
}

/**
 * Produces two local, reviewed split candidates without modifying the source checkout or GitHub state.
 * @param {SplitOptions} options Parsed command-line options.
 * @returns {void}
 */
function splitRepositories(options) {
    run("git", ["filter-repo", "--version"], CODE_ROOT, true);
    const source = normalizeSource(options.source);
    assertCleanLocalSource(source);
    assertOutputOutsideSource(source, options.output);
    const destinations = prepareDestinations(options.output);
    cloneSource(source, destinations.code, options.branch);
    cloneSource(source, destinations.data, options.branch);
    filterCodeRepository(destinations.code);
    filterDataRepository(destinations.data);
    finalizeCodeLayout(destinations.code);
    if (options.verify) verifySplit(destinations.code, destinations.data);
    process.stdout.write(
        `Prepared local split candidates:\n  code: ${destinations.code}\n  data: ${destinations.data}\n` +
            "No remotes were created and nothing was pushed.\n",
    );
}

try {
    splitRepositories(parseArgs(process.argv.slice(2)));
} catch (error) {
    process.stderr.write(`Repository split preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
