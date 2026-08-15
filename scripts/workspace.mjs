import { access, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRepositoryPath, Workspace } from "../model.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = resolve(SCRIPT_DIR, "..");

/**
 * Returns whether a path can be accessed without exposing filesystem errors during workspace discovery.
 * Explicitly selected workspaces still surface full read/parse failures later through loadWorkspace().
 * @param {string} path Absolute filesystem path.
 * @returns {Promise<boolean>}
 */
async function pathExists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolves the active data-workspace root for command-line tooling.
 * The mixed pre-split repository remains the first default; after splitting, the sibling zeitplural-data checkout is discovered automatically.
 * @param {string | null | undefined} requestedRoot Explicit --workspace argument, when supplied.
 * @param {string} [configPath] Repository-relative workspace bootstrap path.
 * @returns {Promise<string>}
 */
export async function resolveWorkspaceRoot(requestedRoot, configPath = "zeitplural.json") {
    const normalizedConfigPath = normalizeRepositoryPath(configPath, "workspace config path");
    if (requestedRoot) return resolve(requestedRoot);

    const candidates = [CODE_ROOT, resolve(CODE_ROOT, "..", "zeitplural-data")];
    for (const candidate of candidates) {
        if (await pathExists(resolveWorkspaceFile(candidate, normalizedConfigPath))) return candidate;
    }
    throw new Error(
        `Could not find ${normalizedConfigPath}; pass --workspace PATH or clone zeitplural-data next to the code repository.`,
    );
}

/**
 * Converts a validated repository-relative path into a filesystem path confined to one workspace root.
 * This is the Node.js equivalent of the browser/local-server path boundary and rejects escape attempts even when symbolic path segments are supplied.
 * @param {string} workspaceRoot Absolute or relative workspace repository root.
 * @param {string} repositoryPath Path declared by zeitplural.json.
 * @returns {string}
 */
export function resolveWorkspaceFile(workspaceRoot, repositoryPath) {
    const root = resolve(workspaceRoot);
    const normalizedPath = normalizeRepositoryPath(repositoryPath, "workspace document path");
    const target = resolve(root, ...normalizedPath.split("/"));
    const relation = relative(root, target);
    if (!relation || relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error(`Workspace path escapes its repository root: ${normalizedPath}`);
    }
    return target;
}

/**
 * Loads and validates the root workspace model used by command-line import and integrity tools.
 * Returning the resolved root together with the model keeps every caller on the same path-discovery behavior.
 * @param {string | null | undefined} requestedRoot Explicit workspace root, or null for automatic discovery.
 * @param {string} [configPath] Repository-relative workspace bootstrap path.
 * @returns {Promise<{root: string, configPath: string, workspace: Workspace}>}
 */
export async function loadWorkspace(requestedRoot, configPath = "zeitplural.json") {
    const normalizedConfigPath = normalizeRepositoryPath(configPath, "workspace config path");
    const root = await resolveWorkspaceRoot(requestedRoot, normalizedConfigPath);
    const raw = JSON.parse(await readFile(resolveWorkspaceFile(root, normalizedConfigPath), "utf8"));
    return { root, configPath: normalizedConfigPath, workspace: Workspace.fromRaw(raw) };
}
