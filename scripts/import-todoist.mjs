#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectList, Recurrence, TodoList } from "../model.js";
import { loadWorkspace, resolveWorkspaceFile } from "./workspace.mjs";

const API_ROOT = "https://api.todoist.com/api/v1";
const DEFAULT_COMPLETED_SINCE = "2007-01-01";
const COMPLETED_WINDOW_DAYS = 89;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_ATTEMPTS = 5;
const TODOIST_COLORS = new Map([
    ["berry_red", "#b8256f"],
    ["red", "#db4035"],
    ["orange", "#ff9933"],
    ["yellow", "#fad000"],
    ["olive_green", "#afb83b"],
    ["lime_green", "#7ecc49"],
    ["green", "#299438"],
    ["mint_green", "#6accbc"],
    ["teal", "#158fad"],
    ["sky_blue", "#14aaf5"],
    ["light_blue", "#96c3eb"],
    ["blue", "#4073ff"],
    ["grape", "#884dff"],
    ["violet", "#af38eb"],
    ["lavender", "#eb96eb"],
    ["magenta", "#e05194"],
    ["salmon", "#ff8d85"],
    ["charcoal", "#808080"],
    ["grey", "#b8b8b8"],
    ["taupe", "#ccac93"],
]);

/**
 * @typedef {Object} ImportOptions
 * @property {string} tokenFile
 * @property {boolean} dryRun
 * @property {boolean} replaceTodoist
 * @property {boolean} includeCompleted
 * @property {string} completedSince
 * @property {string | null} workspaceRoot
 * @property {string} workspaceConfigPath
 */

/**
 * Parses the deliberately small command-line surface for this one-way importer.
 * Unknown arguments fail immediately so a typo cannot overwrite repository data unexpectedly.
 * @param {string[]} argv
 * @returns {ImportOptions}
 */
function parseArgs(argv) {
    const options = {
        tokenFile: join(homedir(), ".todoist"),
        dryRun: false,
        replaceTodoist: false,
        includeCompleted: true,
        completedSince: DEFAULT_COMPLETED_SINCE,
        workspaceRoot: null,
        workspaceConfigPath: "zeitberg.json",
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--replace-todoist") {
            options.replaceTodoist = true;
        } else if (arg === "--active-only") {
            options.includeCompleted = false;
        } else if (arg === "--completed-since") {
            index += 1;
            if (!argv[index] || !/^\d{4}-\d{2}-\d{2}$/.test(argv[index])) {
                throw new Error("--completed-since requires a YYYY-MM-DD date");
            }
            options.completedSince = argv[index];
        } else if (arg === "--token-file") {
            index += 1;
            if (!argv[index]) throw new Error("--token-file requires a path");
            options.tokenFile = resolve(argv[index]);
        } else if (arg === "--workspace") {
            index += 1;
            if (!argv[index]) throw new Error("--workspace requires a path");
            options.workspaceRoot = resolve(argv[index]);
        } else if (arg === "--workspace-config") {
            index += 1;
            if (!argv[index]) throw new Error("--workspace-config requires a repository-relative path");
            options.workspaceConfigPath = argv[index];
        } else if (arg === "--help" || arg === "-h") {
            process.stdout.write(
                "Usage: node scripts/import-todoist.mjs [--dry-run] [--replace-todoist] [--active-only] " +
                    "[--completed-since YYYY-MM-DD] [--token-file PATH] [--workspace PATH] " +
                    "[--workspace-config PATH]\n",
            );
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

/**
 * Reads a JSON file when present and returns a caller-provided default for a missing file.
 * Parse and permission failures remain fatal because continuing could discard existing data.
 * @param {string} path
 * @param {Object} fallback
 * @returns {Promise<Object>}
 */
async function readJsonOrDefault(path, fallback) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") return fallback;
        throw error;
    }
}

/**
 * Waits for a retry delay without blocking the Node.js event loop.
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function wait(milliseconds) {
    return new Promise((resolveWait) => {
        setTimeout(resolveWait, Math.max(0, milliseconds));
    });
}

/**
 * Fetches one Todoist JSON response with bounded retries for throttling and transient server failures.
 * Credentials and response bodies are deliberately excluded from errors so task contents cannot leak into logs.
 * @param {URL} url
 * @param {string} token
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, token) {
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) return response.json();

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === MAX_REQUEST_ATTEMPTS) {
            throw new Error(`Todoist ${url.pathname} request failed (${response.status})`);
        }
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
        const fallbackDelay = Math.min(8000, 250 * 2 ** (attempt - 1));
        const delay =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
                ? retryAfterSeconds * 1000
                : fallbackDelay;
        await wait(delay);
    }
    throw new Error(`Todoist ${url.pathname} request failed`);
}

/**
 * Downloads every cursor page from a Todoist API collection without logging credentials or task contents.
 * The configurable result key supports ordinary collections (`results`) and completed history (`items`) through one path.
 * @param {string} resource
 * @param {string} token
 * @param {{resultKey?: string, params?: Record<string, string>, limit?: number}} [options]
 * @returns {Promise<Object[]>}
 */
async function fetchAll(resource, token, options = {}) {
    const results = [];
    let cursor = "";
    do {
        const url = new URL(`${API_ROOT}/${resource}`);
        url.searchParams.set("limit", String(options.limit || 200));
        for (const [name, value] of Object.entries(options.params || {})) {
            url.searchParams.set(name, value);
        }
        if (cursor) url.searchParams.set("cursor", cursor);
        const payload = await fetchJson(url, token);
        if (Array.isArray(payload)) {
            results.push(...payload);
            cursor = "";
        } else {
            const payloadObject = payload && typeof payload === "object" ? payload : {};
            const resultKey = options.resultKey || "results";
            const page = Array.isArray(payloadObject[resultKey]) ? payloadObject[resultKey] : [];
            results.push(...page);
            cursor = typeof payloadObject.next_cursor === "string" ? payloadObject.next_cursor : "";
        }
    } while (cursor);
    return results;
}

/**
 * Splits an inclusive history start and exclusive end into API-safe ranges shorter than Todoist's three-month maximum.
 * Adjacent windows share an exclusive boundary, so no completion can be skipped or requested twice.
 * @param {string} sinceDate
 * @param {Date} until
 * @returns {{since: string, until: string}[]}
 */
export function buildCompletedWindows(sinceDate, until) {
    const since = new Date(`${sinceDate}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate) ||
        Number.isNaN(since.getTime()) ||
        since.toISOString().slice(0, 10) !== sinceDate
    ) {
        throw new Error(`Invalid completed-history start date: ${sinceDate}`);
    }
    if (!(until instanceof Date) || Number.isNaN(until.getTime()) || until <= since) {
        throw new Error("Completed-history end must be after its start.");
    }

    const windows = [];
    let windowStart = since.getTime();
    while (windowStart < until.getTime()) {
        const windowEnd = Math.min(until.getTime(), windowStart + COMPLETED_WINDOW_DAYS * DAY_MS);
        windows.push({
            since: new Date(windowStart).toISOString(),
            until: new Date(windowEnd).toISOString(),
        });
        windowStart = windowEnd;
    }
    return windows;
}

/**
 * Downloads completed Todoist tasks across the account's history using consecutive bounded date windows.
 * Progress contains only dates and counts, keeping task content and credentials out of terminal output.
 * @param {string} token
 * @param {string} completedSince
 * @param {Date} until
 * @returns {Promise<Object[]>}
 */
async function fetchCompletedTasks(token, completedSince, until) {
    const windows = buildCompletedWindows(completedSince, until);
    const completed = [];
    for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index];
        completed.push(
            ...(await fetchAll("tasks/completed/by_completion_date", token, {
                resultKey: "items",
                params: window,
            })),
        );
        if ((index + 1) % 12 === 0 || index + 1 === windows.length) {
            process.stderr.write(
                `Completed history through ${window.until.slice(0, 10)}: ${completed.length} task(s)\n`,
            );
        }
    }
    return completed;
}

/**
 * Converts Todoist's named palette into the shared hexadecimal project color format.
 * @param {unknown} color
 * @returns {string}
 */
function mapProjectColor(color) {
    return TODOIST_COLORS.get(String(color || "")) || "#7c5cff";
}

/**
 * Retains the current Todoist due occurrence while keeping provider-specific recurrence text out of the due model.
 * @param {unknown} due
 * @returns {Object | null}
 */
function mapDue(due) {
    if (!due || typeof due !== "object" || typeof due.date !== "string" || !due.date) return null;
    return {
        date: due.date,
        timezone: typeof due.timezone === "string" && due.timezone ? due.timezone : null,
    };
}

/**
 * Maps an active task or one completed-history record into the repository's provider-neutral TODO schema.
 * Historical records receive occurrence-specific local IDs, preventing collisions with reopened or recurring active tasks.
 * Project references use stable workspace keys; Inbox deliberately maps to no project.
 * @param {Object} task
 * @param {Map<string, {projectKey: string | null, sectionKey: string | null}>} projectAssignmentById
 * @param {Map<string, {projectKey: string | null, sectionKey: string | null}>} sectionAssignmentById
 * @param {{historical?: boolean}} [options]
 * @returns {Object | null}
 */
export function mapTask(task, projectAssignmentById, sectionAssignmentById, options = {}) {
    const sourceId = String(task?.id || "").trim();
    const content = typeof task?.content === "string" ? task.content.trim() : "";
    if (!sourceId || !content || task?.is_deleted === true) return null;
    const completedAt = typeof task?.completed_at === "string" && task.completed_at ? task.completed_at : null;
    if (options.historical && !completedAt) return null;
    const projectId = task?.project_id == null ? null : String(task.project_id);
    const sectionId = task?.section_id == null ? null : String(task.section_id);
    const parentId = task?.parent_id == null ? null : String(task.parent_id);
    const priority = Number(task?.priority);
    const order = Number(task?.child_order);
    if (projectId && !projectAssignmentById.has(projectId)) {
        throw new Error(`Todoist task ${sourceId} references unknown project ${projectId}.`);
    }
    if (sectionId && !sectionAssignmentById.has(sectionId)) {
        throw new Error(`Todoist task ${sourceId} references unknown section ${sectionId}.`);
    }
    const assignment = sectionId
        ? sectionAssignmentById.get(sectionId)
        : projectId
          ? projectAssignmentById.get(projectId)
          : null;
    const localId = options.historical ? `todoist-completed:${sourceId}:${completedAt}` : `todoist:${sourceId}`;
    let localParentId = null;
    if (parentId) {
        localParentId = options.historical
            ? `todoist-completed:${parentId}:${completedAt}`
            : `todoist:${parentId}`;
    }
    return {
        id: localId,
        content,
        description: typeof task?.description === "string" ? task.description : "",
        project_key: assignment?.projectKey || null,
        section_key: assignment?.sectionKey || null,
        parent_id: localParentId,
        labels: Array.isArray(task?.labels) ? task.labels.filter((label) => typeof label === "string") : [],
        priority: Number.isInteger(priority) ? Math.max(1, Math.min(4, priority)) : 1,
        due: mapDue(task?.due),
        recurrence: Recurrence.fromTodoistDue(task?.due)?.toRaw() || null,
        completion_history: [],
        deadline: task?.deadline && typeof task.deadline === "object" ? task.deadline : null,
        completed_at: completedAt,
        created_at: typeof task?.added_at === "string" ? task.added_at : "",
        updated_at: typeof task?.updated_at === "string" ? task.updated_at : "",
        archived: false,
        order: Number.isFinite(order) ? order : 0,
        source: {
            provider: "todoist",
            id: sourceId,
            project_id: projectId,
            section_id: sectionId,
        },
    };
}

/**
 * Deduplicates API objects by stable Todoist id while allowing later collections to provide the freshest representation.
 * Objects without an id are ignored because they cannot be joined to tasks safely.
 * @param {Object[]} items
 * @returns {Object[]}
 */
function uniqueById(items) {
    const byId = new Map();
    for (const item of items) {
        const id = String(item?.id || "").trim();
        if (id) byId.set(id, item);
    }
    return Array.from(byId.values());
}

/**
 * Carries locally recorded recurring-completion history into freshly downloaded active Todoist tasks.
 * Todoist remains authoritative for ordinary task fields, while this application-specific audit trail is not discarded.
 * @param {Object[]} importedActive
 * @param {import("../model.js").TodoRaw[]} priorImported
 * @returns {Object[]}
 */
export function preserveLocalCompletionHistory(importedActive, priorImported) {
    const priorById = new Map(priorImported.map((todo) => [todo.id, todo]));
    return importedActive.map((todo) => {
        const prior = priorById.get(String(todo?.id || ""));
        const completionHistory = Array.isArray(prior?.completion_history) ? prior.completion_history : [];
        return {
            ...todo,
            completion_history: completionHistory.map((record) => ({ ...record })),
        };
    });
}

/**
 * Sorts imported TODOs deterministically while keeping open work before historical completions.
 * Within completed history, newest completions come first for readable repository diffs.
 * @param {Object} left
 * @param {Object} right
 * @returns {number}
 */
function compareImportedTodos(left, right) {
    const leftCompleted = Boolean(left?.completed_at);
    const rightCompleted = Boolean(right?.completed_at);
    if (leftCompleted !== rightCompleted) return leftCompleted ? 1 : -1;
    if (leftCompleted) {
        const completedOrder = String(right.completed_at || "").localeCompare(String(left.completed_at || ""));
        if (completedOrder !== 0) return completedOrder;
    }
    const projectOrder = String(left?.project_key || "").localeCompare(String(right?.project_key || ""));
    if (projectOrder !== 0) return projectOrder;
    const sectionOrder = String(left?.section_key || "").localeCompare(String(right?.section_key || ""));
    if (sectionOrder !== 0) return sectionOrder;
    return (
        Number(left?.order || 0) - Number(right?.order || 0) ||
        String(left?.content || "").localeCompare(String(right?.content || ""))
    );
}

/**
 * Adds one provider identity to a mutable project or section payload without duplicating it.
 * @param {{external_refs?: import("../model.js").ExternalReferenceRaw[]}} target
 * @param {string} provider
 * @param {string} id
 * @returns {void}
 */
function addExternalReference(target, provider, id) {
    const references = Array.isArray(target.external_refs) ? target.external_refs : [];
    if (!references.some((reference) => reference.provider === provider && String(reference.id) === id)) {
        references.push({ provider, id });
    }
    target.external_refs = references;
}

/**
 * Reconciles Todoist's project/section inventory with the shared workspace taxonomy.
 * Existing external-reference bindings win, exact display-name matches acquire a binding, and only genuinely unknown definitions create new keys.
 * @param {ProjectList} currentProjectList
 * @param {Object[]} todoistProjects
 * @param {Object[]} todoistSections
 * @returns {{projectList: ProjectList, projectAssignmentById: Map<string, {projectKey: string | null, sectionKey: string | null}>, sectionAssignmentById: Map<string, {projectKey: string | null, sectionKey: string | null}>, addedProjects: number, addedSections: number}}
 */
export function mergeTodoistTaxonomy(currentProjectList, todoistProjects, todoistSections) {
    const raw = currentProjectList.toObject();
    const projects = Array.isArray(raw.projects) ? raw.projects : [];
    const projectsByKey = new Map(projects.map((project) => [project.key, project]));
    const projectsByName = new Map(projects.map((project) => [project.name.toLowerCase(), project]));
    const usedProjectKeys = new Set(projects.map((project) => project.key));
    const externalAssignments = new Map();
    const projectAssignmentById = new Map();
    const sectionAssignmentById = new Map();
    for (const project of projects) {
        for (const reference of project.external_refs || []) {
            const assignment = {
                projectKey: project.key,
                sectionKey: null,
            };
            externalAssignments.set(`${reference.provider}\u0000${reference.id}`, assignment);
            if (reference.provider === "todoist") projectAssignmentById.set(String(reference.id), assignment);
        }
        for (const candidate of project.sections || []) {
            for (const reference of candidate.external_refs || []) {
                const assignment = {
                    projectKey: project.key,
                    sectionKey: candidate.key,
                };
                externalAssignments.set(`${reference.provider}\u0000${reference.id}`, assignment);
                if (reference.provider === "todoist") sectionAssignmentById.set(String(reference.id), assignment);
            }
        }
    }

    let addedProjects = 0;
    for (const remoteProject of todoistProjects) {
        const id = String(remoteProject?.id || "").trim();
        const name = typeof remoteProject?.name === "string" ? remoteProject.name.trim() : "";
        if (!id || !name) continue;
        if (remoteProject?.inbox_project === true) {
            projectAssignmentById.set(id, { projectKey: null, sectionKey: null });
            continue;
        }

        const bound = externalAssignments.get(`todoist\u0000${id}`);
        if (bound) {
            if (bound.sectionKey) throw new Error(`Todoist project ${id} is bound to a section instead of a project.`);
            projectAssignmentById.set(id, { ...bound });
            continue;
        }

        let project = projectsByName.get(name.toLowerCase());
        if (!project) {
            const key = ProjectList.reserveKey(name, usedProjectKeys);
            project = {
                archived: remoteProject?.is_archived === true,
                billable: false,
                color: mapProjectColor(remoteProject?.color),
                external_refs: [],
                key,
                name,
                sections: [],
            };
            projects.push(project);
            projectsByKey.set(key, project);
            projectsByName.set(name.toLowerCase(), project);
            addedProjects += 1;
        }
        addExternalReference(project, "todoist", id);
        const assignment = { projectKey: project.key, sectionKey: null };
        externalAssignments.set(`todoist\u0000${id}`, assignment);
        projectAssignmentById.set(id, assignment);
    }

    let addedSections = 0;
    for (const remoteSection of todoistSections) {
        const id = String(remoteSection?.id || "").trim();
        const name = typeof remoteSection?.name === "string" ? remoteSection.name.trim() : "";
        const remoteProjectId = String(remoteSection?.project_id || "").trim();
        if (!id || !name || !remoteProjectId) continue;
        const parentAssignment = projectAssignmentById.get(remoteProjectId);
        if (!parentAssignment) throw new Error(`Todoist section ${id} references unknown project ${remoteProjectId}.`);
        if (!parentAssignment.projectKey) {
            sectionAssignmentById.set(id, { projectKey: null, sectionKey: null });
            continue;
        }

        const bound = externalAssignments.get(`todoist\u0000${id}`);
        if (bound) {
            if (bound.projectKey !== parentAssignment.projectKey || !bound.sectionKey) {
                throw new Error(`Todoist section ${id} is bound outside its configured parent project.`);
            }
            sectionAssignmentById.set(id, { ...bound });
            continue;
        }

        const project = projectsByKey.get(parentAssignment.projectKey);
        if (!project) throw new Error(`Project ${parentAssignment.projectKey} is missing.`);
        project.sections = Array.isArray(project.sections) ? project.sections : [];
        let localSection = project.sections.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        if (!localSection) {
            const usedSectionKeys = new Set(project.sections.map((candidate) => candidate.key));
            localSection = {
                archived: remoteSection?.is_archived === true,
                billable: null,
                color: null,
                external_refs: [],
                key: ProjectList.reserveKey(name, usedSectionKeys),
                name,
            };
            project.sections.push(localSection);
            addedSections += 1;
        }
        addExternalReference(localSection, "todoist", id);
        const assignment = { projectKey: project.key, sectionKey: localSection.key };
        externalAssignments.set(`todoist\u0000${id}`, assignment);
        sectionAssignmentById.set(id, assignment);
    }

    const projectList = ProjectList.fromRaw({
        ...raw,
        projects,
        schema_version: 2,
    });
    return { projectList, projectAssignmentById, sectionAssignmentById, addedProjects, addedSections };
}

/**
 * Performs the one-way import, reconciling Todoist projects/sections with the existing shared taxonomy.
 * Existing locally authored TODOs and local recurring-completion history are retained; replacing an earlier import requires an explicit flag.
 * @param {ImportOptions} options
 * @returns {Promise<void>}
 */
async function run(options) {
    const token = (await readFile(options.tokenFile, "utf8")).trim();
    if (!token) throw new Error(`Todoist token file is empty: ${options.tokenFile}`);
    const { root: workspaceRoot, workspace } = await loadWorkspace(options.workspaceRoot, options.workspaceConfigPath);

    const historyUntil = new Date(Date.now() + 60 * 1000);
    const [activeProjects, archivedProjects, sections, labels, activeTasks, completedTasks] = await Promise.all([
        fetchAll("projects", token),
        fetchAll("projects/archived", token),
        fetchAll("sections", token),
        fetchAll("labels", token),
        fetchAll("tasks", token),
        options.includeCompleted
            ? fetchCompletedTasks(token, options.completedSince, historyUntil)
            : Promise.resolve([]),
    ]);
    const todoistProjects = uniqueById([
        ...archivedProjects.map((project) => ({ ...project, is_archived: true })),
        ...activeProjects,
    ]);

    const projectsPath = resolveWorkspaceFile(workspaceRoot, workspace.getResourcePath("projects"));
    const todosPath = resolveWorkspaceFile(workspaceRoot, workspace.getComponentPath("todos", "document"));
    const projectsFile = await readJsonOrDefault(projectsPath, { generated_at: "", projects: [], schema_version: 2 });
    const existingTodosFile = await readJsonOrDefault(todosPath, {
        generated_at: "",
        github_overlays: [],
        schema_version: 4,
        todos: [],
    });
    const currentProjectList = ProjectList.fromRaw(projectsFile);
    const existingTodoList = TodoList.fromRaw(existingTodosFile);
    const existingTodos = existingTodoList.snapshotRaw();
    const priorImported = existingTodos.filter((todo) => todo?.source?.provider === "todoist");
    if (priorImported.length && !options.replaceTodoist) {
        throw new Error(
            `${workspace.getComponentPath("todos", "document")} already contains ${priorImported.length} Todoist task(s); ` +
                "pass --replace-todoist to refresh them",
        );
    }

    const taxonomy = mergeTodoistTaxonomy(currentProjectList, todoistProjects, sections);

    const importedActive = preserveLocalCompletionHistory(
        activeTasks
            .map((task) => mapTask(task, taxonomy.projectAssignmentById, taxonomy.sectionAssignmentById))
            .filter(Boolean),
        priorImported,
    );
    const historicalById = new Map();
    for (const task of completedTasks) {
        const mapped = mapTask(task, taxonomy.projectAssignmentById, taxonomy.sectionAssignmentById, { historical: true });
        if (mapped) historicalById.set(mapped.id, mapped);
    }
    const importedCompleted = Array.from(historicalById.values());
    const importedTodos = [...importedActive, ...importedCompleted].sort(compareImportedTodos);
    const localTodos = existingTodos.filter((todo) => todo?.source?.provider !== "todoist");
    const generatedAt = new Date().toISOString();
    const nextProjectsFile = ProjectList.fromRaw({
        ...taxonomy.projectList.toObject(),
        generated_at: generatedAt,
        schema_version: 2,
    });
    const nextTodosFile = {
        generated_at: generatedAt,
        github_overlays: existingTodoList.github_overlays,
        schema_version: 4,
        todos: [...localTodos, ...importedTodos],
    };
    const normalizedTodos = TodoList.fromRaw(nextTodosFile);
    if (normalizedTodos.list().length !== nextTodosFile.todos.length) {
        throw new Error("Todoist import produced duplicate or invalid TODO identifiers.");
    }

    if (!options.dryRun) {
        await writeFile(projectsPath, nextProjectsFile.toJson(), "utf8");
        await writeFile(todosPath, normalizedTodos.toJson(), "utf8");
    }

    const mode = options.dryRun ? "Would import" : "Imported";
    process.stdout.write(
        `${mode} into ${workspace.name}: ${importedActive.length} active and ${importedCompleted.length} completed task(s), ` +
            `${activeProjects.length} active and ${archivedProjects.length} archived Todoist project(s), ` +
            `${sections.length} section(s), and ${labels.length} label(s); added ${taxonomy.addedProjects} shared project(s) ` +
            `and ${taxonomy.addedSections} shared section(s).\n`,
    );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        await run(parseArgs(process.argv.slice(2)));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Todoist import failed: ${message}\n`);
        process.exitCode = 1;
    }
}
