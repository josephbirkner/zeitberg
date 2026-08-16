#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ExpenseDocument,
    ExpenseManifest,
    Manifest,
    ProjectList,
    TodoList,
    WeekRequirements,
} from "../model.js";
import { gitBlobSha1, utf8ByteLength } from "../utils.js";
import { loadWorkspace, resolveWorkspaceFile } from "./workspace.mjs";

/**
 * @typedef {Object} ValidateOptions
 * @property {string | null} workspaceRoot
 * @property {string} workspaceConfigPath
 */

/**
 * Parses workspace-location arguments for the non-mutating integrity check.
 * Unknown flags fail immediately so CI cannot accidentally validate a different repository than intended.
 * @param {string[]} argv Command-line arguments excluding node and script paths.
 * @returns {ValidateOptions}
 */
function parseArgs(argv) {
    const options = { workspaceRoot: null, workspaceConfigPath: "zeitplural.json" };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--workspace") {
            index += 1;
            if (!argv[index]) throw new Error("--workspace requires a path");
            options.workspaceRoot = resolve(argv[index]);
        } else if (arg === "--workspace-config") {
            index += 1;
            if (!argv[index]) throw new Error("--workspace-config requires a repository-relative path");
            options.workspaceConfigPath = argv[index];
        } else if (arg === "--help" || arg === "-h") {
            process.stdout.write("Usage: node scripts/validate-workspace.mjs [--workspace PATH] [--workspace-config PATH]\n");
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

/**
 * Reads and parses one required workspace JSON document.
 * @param {string} path Absolute filesystem path.
 * @returns {Promise<Object>}
 */
async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Recursively lists regular files beneath a directory in deterministic order.
 * @param {string} directory Absolute directory path.
 * @returns {Promise<string[]>}
 */
async function listFiles(directory) {
    const files = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, item.name);
        if (item.isDirectory()) files.push(...(await listFiles(path)));
        else if (item.isFile()) files.push(path);
        else throw new Error(`Workspace contains an unsupported filesystem entry: ${path}`);
    }
    return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Converts an absolute workspace file path back to the POSIX repository path stored in manifests.
 * @param {string} workspaceRoot Absolute workspace repository root.
 * @param {string} path Absolute file path inside that root.
 * @returns {string}
 */
function repositoryPath(workspaceRoot, path) {
    return relative(workspaceRoot, path).split(sep).join("/");
}

/**
 * Validates all project references used by time entries and TODOs against the shared project taxonomy.
 * @param {ProjectList} projectList Parsed project inventory.
 * @param {Object[]} entries Normalized time-entry records.
 * @param {import("../model.js").TodoRaw[]} todos Normalized TODO records.
 * @param {import("../model.js").ExpenseRaw[]} expenses Normalized expense records.
 * @returns {void}
 */
function validateAssignments(projectList, entries, todos, expenses = []) {
    for (const entry of entries) {
        if (!projectList.resolveAssignment(entry.project_key, entry.section_key)) {
            throw new Error(`Entry ${entry.id} has an unresolved configured assignment.`);
        }
    }
    for (const todo of todos) {
        if (!projectList.resolveAssignment(todo.project_key, todo.section_key)) {
            throw new Error(`TODO ${todo.id} has an unresolved configured assignment.`);
        }
    }
    for (const expense of expenses) {
        if (!projectList.resolveAssignment(expense.project_key, expense.section_key)) {
            throw new Error(`Expense ${expense.id} has an unresolved configured assignment.`);
        }
    }
}

/**
 * Performs a complete, read-only integrity pass over one zeitplural workspace.
 * It checks the workspace model, data inventory, schemas, project assignments, manifest metadata, blob hashes, and entry totals; undeclared files beneath data/ are rejected so obsolete import artifacts cannot silently enter the private repository.
 * @param {ValidateOptions} options Parsed command-line options.
 * @returns {Promise<void>}
 */
async function validateWorkspace(options) {
    const { root, configPath, workspace } = await loadWorkspace(options.workspaceRoot, options.workspaceConfigPath);
    const expectedDataPaths = new Set();
    const projectsPath = workspace.resources.projects || "";
    const projectList = projectsPath
        ? ProjectList.fromRaw(await readJson(resolveWorkspaceFile(root, projectsPath)))
        : ProjectList.createEmpty();
    if (projectsPath) expectedDataPaths.add(projectsPath);
    const entries = [];
    let weekCount = 0;
    if (workspace.hasComponent("time_tracking")) {
        const entriesDirectory = workspace.getComponentPath("time_tracking", "entries");
        const manifestPath = workspace.getComponentPath("time_tracking", "manifest");
        const weekRequirementsPath = workspace.getComponentPath("time_tracking", "week_requirements");
        const [requirementsRaw, manifestRaw] = await Promise.all([
            readJson(resolveWorkspaceFile(root, weekRequirementsPath)),
            readJson(resolveWorkspaceFile(root, manifestPath)),
        ]);
        WeekRequirements.fromRaw(requirementsRaw);
        const manifest = Manifest.fromRaw(manifestRaw, entriesDirectory);
        if (manifest.timezone !== workspace.timezone) {
            throw new Error(`Manifest timezone ${manifest.timezone} does not match workspace timezone ${workspace.timezone}.`);
        }

        const entriesPath = resolveWorkspaceFile(root, entriesDirectory);
        let weekFiles = [];
        try {
            const entriesStat = await stat(entriesPath);
            if (!entriesStat.isDirectory()) throw new Error("The configured entries path is not a directory.");
            weekFiles = await listFiles(entriesPath);
        } catch (error) {
            const errorCode = error && typeof error === "object" && "code" in error ? error.code : "";
            if (errorCode !== "ENOENT" || manifest.chunks.length) throw error;
        }
        const actualWeekPaths = weekFiles.map((path) => repositoryPath(root, path));
        if (actualWeekPaths.some((path) => !path.endsWith(".json"))) {
            throw new Error("The entries directory contains a non-JSON import artifact.");
        }
        const manifestPaths = manifest.chunks.map((chunk) => chunk.path);
        if (JSON.stringify(actualWeekPaths) !== JSON.stringify(manifestPaths)) {
            throw new Error("Manifest chunk paths do not exactly match the expected week files on disk.");
        }
        for (const chunk of manifest.chunks) {
            const path = resolveWorkspaceFile(root, chunk.path);
            const rawText = await readFile(path, "utf8");
            const week = JSON.parse(rawText);
            if (Number(week.schema_version) !== 2) throw new Error(`${chunk.path} is not entry schema version 2.`);
            if (Number(week.year) !== chunk.year || Number(week.week) !== chunk.week) {
                throw new Error(`${chunk.path} year/week metadata does not match its manifest chunk.`);
            }
            if (String(week.timezone || "") !== workspace.timezone) {
                throw new Error(`${chunk.path} timezone does not match zeitplural.json.`);
            }
            const weekEntries = Array.isArray(week.entries) ? week.entries : [];
            entries.push(...weekEntries);
            if (chunk.sha !== gitBlobSha1(rawText)) throw new Error(`Manifest SHA mismatch for ${chunk.path}.`);
            if (chunk.size !== utf8ByteLength(rawText)) throw new Error(`Manifest size mismatch for ${chunk.path}.`);
            if (chunk.entries !== weekEntries.length) throw new Error(`Manifest entry count mismatch for ${chunk.path}.`);
        }
        if (entries.length !== manifest.total_entries) throw new Error("Manifest total_entries does not match week data.");
        weekCount = manifest.chunks.length;
        expectedDataPaths.add(manifestPath);
        expectedDataPaths.add(weekRequirementsPath);
        for (const path of manifestPaths) expectedDataPaths.add(path);
    }

    let todoList = TodoList.createEmpty();
    if (workspace.hasComponent("todos")) {
        const todosPath = workspace.getComponentPath("todos", "document");
        todoList = TodoList.fromRaw(await readJson(resolveWorkspaceFile(root, todosPath)));
        expectedDataPaths.add(todosPath);
    }

    let expenseDocument = ExpenseDocument.createEmpty();
    if (workspace.hasComponent("expenses")) {
        const expensesPath = workspace.getComponentPath("expenses", "document");
        const expenseManifestPath = workspace.getComponentPath("expenses", "manifest");
        const [expenseText, expenseManifestRaw] = await Promise.all([
            readFile(resolveWorkspaceFile(root, expensesPath), "utf8"),
            readJson(resolveWorkspaceFile(root, expenseManifestPath)),
        ]);
        expenseDocument = ExpenseDocument.fromRaw(JSON.parse(expenseText));
        const expenseManifest = ExpenseManifest.fromRaw(expenseManifestRaw, expensesPath);
        expenseManifest.verifyContent(expenseText);
        if (
            expenseManifest.participants !== expenseDocument.participants.length ||
            expenseManifest.categories !== expenseDocument.categories.length ||
            expenseManifest.expenses !== expenseDocument.expenses.length ||
            expenseManifest.transfers !== expenseDocument.transfers.length
        ) {
            throw new Error("Expense manifest counts do not match expenses.json.");
        }
        expectedDataPaths.add(expensesPath);
        expectedDataPaths.add(expenseManifestPath);
    }

    validateAssignments(projectList, entries, todoList.snapshotRaw(), expenseDocument.expenses.map((expense) => expense.toRaw()));

    const managedRoots = new Set([...expectedDataPaths].map((path) => path.split("/")[0]));
    const managedFiles = [];
    for (const managedRoot of managedRoots) {
        const managedPath = resolveWorkspaceFile(root, managedRoot);
        const managedStat = await stat(managedPath);
        managedFiles.push(...(managedStat.isDirectory() ? await listFiles(managedPath) : [managedPath]));
    }
    const actualDataPaths = managedFiles.map((path) => repositoryPath(root, path)).sort((left, right) => left.localeCompare(right));
    const undeclared = actualDataPaths.filter((path) => !expectedDataPaths.has(path));
    const missing = [...expectedDataPaths].filter((path) => !actualDataPaths.includes(path));
    if (undeclared.length) throw new Error(`Workspace contains undeclared data artifacts: ${undeclared.join(", ")}`);
    if (missing.length) throw new Error(`Workspace is missing configured data documents: ${missing.join(", ")}`);

    process.stdout.write(
        `Validated workspace ${workspace.name} (${workspace.workspace_id}) via ${configPath}: ` +
            `${entries.length} entries, ${todoList.list().length} TODOs, ${expenseDocument.expenses.length} expenses, ` +
            `${expenseDocument.transfers.length} transfers, ${weekCount} weeks, and all manifest hashes.\n`,
    );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        await validateWorkspace(parseArgs(process.argv.slice(2)));
    } catch (error) {
        process.stderr.write(`Workspace validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
