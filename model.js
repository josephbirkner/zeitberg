import { addIsoDays, cloneJson, isoWeekInfo, isoWeekStart, isoWeekdayIndex, jsonStringifySorted, utf8ByteLength } from "./utils.js";

/**
 * @typedef {Object} EntryRaw
 * @property {number} id
 * @property {string} start
 * @property {string | null} [end]
 * @property {string | null} project_key
 * @property {string | null} section_key
 * @property {number | null} [project_id]
 * @property {string | null} [description]
 * @property {string | null} [client]
 * @property {boolean | null} [billable]
 * @property {boolean | null} [is_running]
 * @property {number | null} [duration_seconds]
 * @property {string | null} [updated_at]
 */

/**
 * @typedef {Object} ExternalReferenceRaw
 * @description A stable identifier from an upstream service used only when importing data into the canonical local taxonomy.
 * @property {string} provider
 * @property {string} id
 */

/**
 * @typedef {Object} SectionRaw
 * @description A configurable subdivision of one project. Missing color or billable values inherit from the parent project.
 * @property {string} key
 * @property {string} name
 * @property {string | null} [color]
 * @property {boolean | null} [billable]
 * @property {boolean} archived
 * @property {ExternalReferenceRaw[]} [external_refs]
 */

/**
 * @typedef {Object} ProjectRaw
 * @description One canonical project together with its optional sections and upstream identity bindings.
 * @property {string} key
 * @property {string} name
 * @property {string} color
 * @property {boolean} billable
 * @property {boolean} archived
 * @property {SectionRaw[]} [sections]
 * @property {ExternalReferenceRaw[]} [external_refs]
 */

/**
 * @typedef {Object} ProjectsFileRaw
 * @property {string} [generated_at]
 * @property {number} [schema_version]
 * @property {ProjectRaw[]} [projects]
 */

/**
 * @typedef {Object} TodoDueRaw
 * @description The current occurrence date/time for a TODO, separate from its optional recurrence rule.
 * @property {string} date
 * @property {string | null} [timezone]
 * @property {boolean} [is_recurring] Legacy Todoist migration field.
 * @property {string} [string] Legacy Todoist migration field.
 * @property {string} [lang] Legacy Todoist migration field.
 */

/**
 * @typedef {"daily" | "weekly" | "monthly" | "yearly" | "custom"} RecurrenceFrequency
 */

/**
 * @typedef {"scheduled" | "after_completion"} RecurrenceBasis
 */

/**
 * @typedef {Object} RecurrenceRaw
 * @description A provider-neutral recurrence rule inspired by RFC 5545 recurrence parts.
 * @property {RecurrenceFrequency} frequency
 * @property {number} interval
 * @property {RecurrenceBasis} basis
 * @property {number[]} [weekdays] ISO weekdays (Monday=1 through Sunday=7).
 * @property {number | null} [month_day]
 * @property {number | null} [month]
 * @property {string} [source_text]
 */

/**
 * @typedef {Object} TodoCompletionRaw
 * @description One completed occurrence of a recurring TODO.
 * @property {string} completed_at
 * @property {string} scheduled_for
 */

/**
 * @typedef {Object} LegacyTodoistDueRaw
 * @description Legacy Todoist due payload accepted while migrating schema version 1.
 * @property {string} date
 * @property {boolean} [is_recurring]
 * @property {string} [string]
 * @property {string} [lang]
 * @property {string | null} [timezone]
 */

/**
 * @typedef {Object} TodoSourceRaw
 * @description Optional provenance retained for tasks imported from another service.
 * @property {string} provider
 * @property {string} id
 * @property {string | null} [project_id]
 * @property {string | null} [section_id]
 */

/**
 * @typedef {Object} TodoRaw
 * @description The stable JSON representation of one locally managed TODO.
 * @property {string} id
 * @property {string} content
 * @property {string} [description]
 * @property {string | null} project_key
 * @property {string | null} section_key
 * @property {string | null} [parent_id]
 * @property {string[]} [labels]
 * @property {number} [priority]
 * @property {TodoDueRaw | null} [due]
 * @property {RecurrenceRaw | null} [recurrence]
 * @property {TodoCompletionRaw[]} [completion_history]
 * @property {Object | null} [deadline]
 * @property {string | null} [completed_at]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 * @property {boolean} [archived]
 * @property {number} [order]
 * @property {TodoSourceRaw | null} [source]
 */

/**
 * @typedef {Object} TodosFileRaw
 * @description The complete data/todos.json document persisted by the application.
 * @property {string} [generated_at]
 * @property {number} [schema_version]
 * @property {TodoRaw[]} [todos]
 */

/**
 * @typedef {Object} WeekRequirementRaw
 * @property {string} week_start
 * @property {number} required_hours
 * @property {string} [comment]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} WeekRequirementsFileRaw
 * @property {string} [generated_at]
 * @property {number} [schema_version]
 * @property {number} [default_required_hours]
 * @property {WeekRequirementRaw[]} [weeks]
 */

/**
 * @typedef {Object} ManifestChunk
 * @property {number} year
 * @property {number} week
 * @property {string} path
 * @property {string} sha
 * @property {number | null} entries
 * @property {number | null} size
 */

/**
 * @typedef {Object} ManifestFileRaw
 * @property {ManifestChunk[]} [chunks]
 * @property {string} [timezone]
 * @property {string} [generated_at]
 * @property {number} [schema_version]
 */

/**
 * @typedef {Object} WorkspaceComponentRaw
 * @description One enabled planplural component and the repository-relative documents it owns.
 * @property {string} type
 * @property {Object.<string, string>} paths
 */

/**
 * @typedef {Object} WorkspaceRaw
 * @description The root planplural.json document that describes one independently shareable data repository.
 * @property {string} [$schema]
 * @property {number} schema_version
 * @property {string} workspace_id
 * @property {string} name
 * @property {string} timezone
 * @property {Object.<string, string>} resources
 * @property {Object.<string, WorkspaceComponentRaw>} components
 */

export const DEFAULT_WEEK_REQUIRED_HOURS = 40;

/**
 * Validates and normalizes a repository-relative workspace path.
 * Paths are deliberately POSIX-only because the same value is consumed by Git hosting APIs, browser URLs, and local filesystem adapters.
 * Absolute paths, traversal segments, query fragments, and platform-specific separators are rejected instead of silently rewritten.
 * @param {unknown} value Candidate path from configuration.
 * @param {string} label Human-readable field name used in validation errors.
 * @returns {string}
 */
export function normalizeRepositoryPath(value, label) {
    const path = String(value || "").trim();
    if (!path) throw new Error(`${label} must be a non-empty repository-relative path.`);
    if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) {
        throw new Error(`${label} must be a normalized repository-relative path.`);
    }
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
        throw new Error(`${label} must not contain empty or traversal segments.`);
    }
    return parts.join("/");
}

/**
 * Represents the versioned root configuration of one planplural data workspace.
 * The model keeps repository discovery independent from any hosting provider and centralizes every mutable document path used by the application.
 * Component keys are stable instance identifiers, while component types let future versions add finances or multiple sharing ledgers without changing the bootstrap format.
 */
export class Workspace {
    /**
     * Creates an already validated workspace model.
     * Callers should normally use fromRaw() so malformed or unsafe paths never enter a data source.
     * @param {string} workspaceId Stable identity used to detect links that resolve to the wrong repository.
     * @param {string} name Human-readable workspace name.
     * @param {string} timezone IANA timezone used by date-oriented components.
     * @param {Object.<string, string>} resources Shared repository resources such as the project taxonomy.
     * @param {Object.<string, WorkspaceComponentRaw>} components Enabled component instances keyed by stable identifier.
     * @param {string} schemaUrl Published JSON Schema URL retained during serialization.
     */
    constructor(workspaceId, name, timezone, resources, components, schemaUrl) {
        this.schemaUrl = schemaUrl;
        this.schema_version = 1;
        this.workspace_id = workspaceId;
        this.name = name;
        this.timezone = timezone;
        this.resources = cloneJson(resources);
        this.components = cloneJson(components);
    }

    /**
     * Parses and validates a planplural.json payload.
     * Besides schema-version checks, this validates timezone support, stable identifiers, component uniqueness, and every repository-relative path before network or filesystem access occurs.
     * @param {unknown} raw Untrusted JSON payload returned by a data source.
     * @returns {Workspace}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object") throw new Error("planplural.json must be a JSON object.");
        const rawObj = /** @type {WorkspaceRaw} */ (raw);
        if (Number(rawObj.schema_version) !== 1) throw new Error("planplural.json must use schema_version 1.");

        const workspaceId = String(rawObj.workspace_id || "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspaceId)) {
            throw new Error("planplural.json contains an invalid workspace_id.");
        }
        const name = String(rawObj.name || "").trim();
        if (!name) throw new Error("planplural.json must define a workspace name.");
        const timezone = String(rawObj.timezone || "").trim();
        try {
            new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
        } catch {
            throw new Error(`planplural.json contains an invalid timezone: ${timezone || "(empty)"}.`);
        }

        if (!rawObj.resources || typeof rawObj.resources !== "object" || Array.isArray(rawObj.resources)) {
            throw new Error("planplural.json resources must be an object.");
        }
        /** @type {Object.<string, string>} */
        const resources = {};
        for (const [key, value] of Object.entries(rawObj.resources)) {
            if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`planplural.json contains an invalid resource key: ${key}.`);
            resources[key] = normalizeRepositoryPath(value, `resources.${key}`);
        }

        if (!rawObj.components || typeof rawObj.components !== "object" || Array.isArray(rawObj.components)) {
            throw new Error("planplural.json components must be an object.");
        }
        /** @type {Object.<string, WorkspaceComponentRaw>} */
        const components = {};
        for (const [componentId, candidate] of Object.entries(rawObj.components)) {
            if (!/^[a-z][a-z0-9_-]*$/.test(componentId)) {
                throw new Error(`planplural.json contains an invalid component id: ${componentId}.`);
            }
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
                throw new Error(`planplural.json component ${componentId} must be an object.`);
            }
            const rawComponent = /** @type {WorkspaceComponentRaw} */ (candidate);
            const type = String(rawComponent.type || "").trim();
            if (!/^[a-z][a-z0-9_]*$/.test(type)) {
                throw new Error(`planplural.json component ${componentId} has an invalid type.`);
            }
            if (!rawComponent.paths || typeof rawComponent.paths !== "object" || Array.isArray(rawComponent.paths)) {
                throw new Error(`planplural.json component ${componentId} paths must be an object.`);
            }
            /** @type {Object.<string, string>} */
            const paths = {};
            for (const [pathKey, value] of Object.entries(rawComponent.paths)) {
                if (!/^[a-z][a-z0-9_]*$/.test(pathKey)) {
                    throw new Error(`planplural.json component ${componentId} contains an invalid path key: ${pathKey}.`);
                }
                paths[pathKey] = normalizeRepositoryPath(value, `components.${componentId}.paths.${pathKey}`);
            }
            components[componentId] = { paths, type };
        }

        const schemaUrl = typeof rawObj.$schema === "string" ? rawObj.$schema.trim() : "";
        return new Workspace(workspaceId, name, timezone, resources, components, schemaUrl);
    }

    /**
     * Returns the first configured component of the requested type in deterministic component-id order.
     * Current views consume one time-tracking and one TODO component, while retaining instance keys for future multi-component routing.
     * @param {string} type Provider-neutral component type.
     * @returns {WorkspaceComponentRaw}
     */
    getComponent(type) {
        const normalizedType = String(type || "").trim();
        const match = Object.entries(this.components)
            .sort(([left], [right]) => left.localeCompare(right))
            .find(([, component]) => component.type === normalizedType);
        if (!match) throw new Error(`Workspace does not enable the ${normalizedType} component.`);
        return cloneJson(match[1]);
    }

    /**
     * Resolves one shared resource path from the workspace manifest.
     * Keeping this lookup on the model prevents UI controllers from embedding repository layouts.
     * @param {string} key Resource key such as projects.
     * @returns {string}
     */
    getResourcePath(key) {
        const path = this.resources[String(key || "")];
        if (!path) throw new Error(`Workspace does not define the ${key} resource.`);
        return path;
    }

    /**
     * Resolves one document or directory path owned by a component type.
     * Missing paths fail early with a configuration-oriented error rather than a misleading network 404.
     * @param {string} componentType Component type such as time_tracking or todos.
     * @param {string} pathKey Path key inside the component definition.
     * @returns {string}
     */
    getComponentPath(componentType, pathKey) {
        const component = this.getComponent(componentType);
        const path = component.paths[String(pathKey || "")];
        if (!path) throw new Error(`Workspace component ${componentType} does not define the ${pathKey} path.`);
        return path;
    }

    /**
     * Returns a JSON-ready workspace representation with no runtime-only state.
     * Stable serialization makes workspace identity and path changes straightforward to review in Git.
     * @returns {WorkspaceRaw}
     */
    toObject() {
        return {
            ...(this.schemaUrl ? { $schema: this.schemaUrl } : {}),
            components: cloneJson(this.components),
            name: this.name,
            resources: cloneJson(this.resources),
            schema_version: this.schema_version,
            timezone: this.timezone,
            workspace_id: this.workspace_id,
        };
    }

    /**
     * Serializes the workspace using the deterministic JSON format shared by all repository documents.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}

/**
 * Normalizes required-hours values to a bounded two-decimal number.
 * Keeps persisted weekly requirement values deterministic.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeRequiredHours(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.max(0, Math.min(168, parsed));
    return Math.round(clamped * 100) / 100;
}

/**
 * Represents a time entry with derived metadata.
 * Wraps the raw entry payload with computed fields for fast access.
 */
export class Entry {
    /**
     * Creates an Entry from the raw payload and computes derived fields.
     * Defines the data shape used by the store.
     * @param {EntryRaw} raw
     */
    constructor(raw) {
        this.raw = cloneJson(raw || {});
        this.weekStart = null;
        this.searchHaystack = "";
        this.updateDerived();
    }

    /**
     * Recomputes cached fields such as duration and search text.
     * Defines the data shape used by the store.
     * @returns {void}
     */
    updateDerived() {
        const start = new Date(this.raw.start);
        const end = this.raw.end ? new Date(this.raw.end) : null;

        let durationSeconds = null;
        if (typeof this.raw.duration_seconds === "number" && Number.isFinite(this.raw.duration_seconds)) {
            durationSeconds = this.raw.duration_seconds;
        } else if (end instanceof Date && !Number.isNaN(end.getTime())) {
            durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);
        }

        this.id = Number(this.raw.id);
        this.startDate = start;
        this.endDate = end;
        this.durationSeconds = durationSeconds;
        this.projectKey = typeof this.raw.project_key === "string" && this.raw.project_key ? this.raw.project_key : null;
        this.sectionKey = typeof this.raw.section_key === "string" && this.raw.section_key ? this.raw.section_key : null;
        this.description = this.raw.description || "";
        this.billable = this.raw.billable === true ? true : this.raw.billable === false ? false : null;
        this.assignmentSearchText = this.assignmentSearchText || "";
        this.searchHaystack = [
            this.projectKey || "",
            this.sectionKey || "",
            this.assignmentSearchText,
            this.description,
            this.raw.client || "",
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
    }

    /**
     * Returns the ISO week start for the entry, caching the result.
     * Defines the data shape used by the store.
     * @param {import("./utils.js").TimeContext} timeContext
     * @returns {string | null}
     */
    getWeekStart(timeContext) {
        if (this.weekStart) {
            return this.weekStart;
        }
        if (!(this.startDate instanceof Date) || Number.isNaN(this.startDate.getTime())) {
            return null;
        }
        const dayStr = timeContext.formatDate(this.startDate);
        this.weekStart = isoWeekStart(dayStr);
        return this.weekStart;
    }

    /**
     * Sets a known week start on the entry to avoid recomputation.
     * Defines the data shape used by the store.
     * @param {string} weekStart
     * @returns {void}
     */
    setWeekStart(weekStart) {
        this.weekStart = weekStart;
    }

    /**
     * Returns a deep-cloned raw payload for safe editing.
     * Defines the data shape used by the store.
     * @returns {EntryRaw}
     */
    toRaw() {
        return cloneJson(this.raw);
    }

    /**
     * Applies edited metadata fields and refreshes derived fields.
     * Defines the data shape used by the store.
     * @param {{projectKey: string | null, sectionKey: string | null, description: string, billable: boolean | null, updatedAt: string}} details
     * @returns {void}
     */
    applyDetails(details) {
        this.raw.project_key = details.projectKey;
        this.raw.section_key = details.sectionKey;
        this.raw.description = details.description;
        this.raw.billable = details.billable;
        this.raw.updated_at = details.updatedAt;
        this.updateDerived();
    }

    /**
     * Injects the current human-readable project/section label into the cached search text.
     * Assignment names live in projects.json rather than entry rows, so EntryStore calls this whenever entries or project definitions change.
     * @param {string} value
     * @returns {void}
     */
    setAssignmentSearchText(value) {
        this.assignmentSearchText = String(value || "");
        this.updateDerived();
    }

    /**
     * Updates the entry start/end times and duration using timezone-aware formatting.
     * Defines the data shape used by the store.
     * @param {number} startMs
     * @param {number} endMs
     * @param {import("./utils.js").TimeContext} timeContext
     * @returns {void}
     */
    applyTimes(startMs, endMs, timeContext) {
        const start = new Date(startMs);
        const end = new Date(endMs);
        this.raw.start = timeContext.formatIsoWithOffset(start);
        this.raw.end = timeContext.formatIsoWithOffset(end);
        this.raw.is_running = false;
        this.raw.duration_seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
        this.raw.updated_at = this.raw.updated_at || timeContext.formatIsoWithOffset(new Date());
        this.weekStart = null;
        this.updateDerived();
    }
}

/**
 * Represents a week containing entries.
 * Stores entries in the ISO week that begins on the provided Monday.
 */
export class Week {
    /**
     * Initializes the week metadata based on a week start date.
     * Defines the data shape used by the store.
     * @param {string} weekStart
     */
    constructor(weekStart) {
        this.weekStart = weekStart;
        const info = isoWeekInfo(weekStart);
        this.isoYear = info.isoYear;
        this.isoWeek = info.week;
        this.entries = [];
    }

    /**
     * Adds an Entry to the week without sorting.
     * Defines the data shape used by the store.
     * @param {Entry} entry
     * @returns {void}
     */
    addEntry(entry) {
        this.entries.push(entry);
    }

    /**
     * Finds an Entry by id within the week.
     * Defines the data shape used by the store.
     * @param {number} entryId
     * @returns {Entry | null}
     */
    getEntryById(entryId) {
        for (const entry of this.entries) {
            if (entry.id === entryId) {
                return entry;
            }
        }
        return null;
    }

    /**
     * Removes an Entry by id and returns true when removed.
     * Defines the data shape used by the store.
     * @param {number} entryId
     * @returns {boolean}
     */
    removeEntryById(entryId) {
        const idx = this.entries.findIndex((entry) => entry.id === entryId);
        if (idx < 0) return false;
        this.entries.splice(idx, 1);
        return true;
    }

    /**
     * Sorts entries by start time, then id for stability.
     * Defines the data shape used by the store.
     * @returns {void}
     */
    sortEntries() {
        this.entries.sort((a, b) => {
            const startA = a.startDate instanceof Date ? a.startDate.getTime() : 0;
            const startB = b.startDate instanceof Date ? b.startDate.getTime() : 0;
            if (startA !== startB) return startA - startB;
            return (a.id || 0) - (b.id || 0);
        });
    }

    /**
     * Returns sorted raw payloads for serialization.
     * Defines the data shape used by the store.
     * @returns {EntryRaw[]}
     */
    snapshotRawEntries() {
        const raws = this.entries.map((entry) => entry.toRaw());
        raws.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")) || (a.id || 0) - (b.id || 0));
        return raws;
    }

    /**
     * Serializes the week into its JSON file payload.
     * Defines the data shape used by the store.
     * @param {string} nowIso
     * @param {string} timezone
     * @returns {{payload: Object, content: string, size: number, entries: number}}
     */
    serialize(nowIso, timezone) {
        const payload = {
            entries: this.snapshotRawEntries(),
            generated_at: nowIso,
            schema_version: 2,
            timezone,
            week: this.isoWeek,
            year: this.isoYear,
        };
        const content = jsonStringifySorted(payload);
        return { payload, content, size: utf8ByteLength(content), entries: payload.entries.length };
    }
}

const PROJECT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Normalizes provider identifiers attached to projects and sections.
 * Duplicate references inside one definition are collapsed; ProjectList later rejects references reused by different assignments.
 * @param {unknown} raw
 * @returns {ExternalReferenceRaw[]}
 */
function normalizeExternalReferences(raw) {
    if (!Array.isArray(raw)) return [];
    const result = [];
    const seen = new Set();
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const candidate = /** @type {Partial<ExternalReferenceRaw>} */ (item);
        const provider = typeof candidate.provider === "string" ? candidate.provider.trim().toLowerCase() : "";
        const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
        const identity = `${provider}\u0000${id}`;
        if (!provider || !id || seen.has(identity)) continue;
        seen.add(identity);
        result.push({ provider, id });
    }
    result.sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
    return result;
}

/**
 * Represents one optional subdivision of a project.
 * Sections inherit color and billable state from their parent unless an explicit override is stored.
 */
export class Section {
    /**
     * Creates a normalized immutable-identity section model from projects.json.
     * The key is the persisted identity; renaming the human-readable name never changes existing entry or TODO references.
     * @param {SectionRaw} raw
     */
    constructor(raw) {
        this.key = typeof raw?.key === "string" ? raw.key.trim() : "";
        this.name = typeof raw?.name === "string" ? raw.name.trim() : "";
        const color = typeof raw?.color === "string" ? raw.color.trim() : "";
        this.color = PROJECT_COLOR_PATTERN.test(color) ? color : null;
        this.billable = typeof raw?.billable === "boolean" ? raw.billable : null;
        this.archived = raw?.archived === true;
        this.externalRefs = normalizeExternalReferences(raw?.external_refs);
    }

    /**
     * Returns the first external binding for a provider, or null when this section is not integrated with it.
     * Provider names are normalized to lowercase in the constructor, so callers may use human-entered casing safely.
     * @param {string} provider External system identifier such as `github-label` or `todoist`.
     * @returns {ExternalReferenceRaw | null}
     */
    getExternalReference(provider) {
        const normalized = String(provider || "").trim().toLowerCase();
        return this.externalRefs.find((reference) => reference.provider === normalized) || null;
    }

    /**
     * Returns the stable JSON representation persisted beneath its parent project.
     * Explicit null overrides mean inherit and keep project-dialog serialization deterministic.
     * @returns {SectionRaw}
     */
    toRaw() {
        return {
            archived: this.archived,
            billable: this.billable,
            color: this.color,
            external_refs: this.externalRefs.map((reference) => ({ ...reference })),
            key: this.key,
            name: this.name,
        };
    }
}

/**
 * Represents one canonical project and all of its configured sections.
 * Project-level color and billable values provide defaults shared by time entries and TODOs.
 */
export class Project {
    /**
     * Creates a project model whose stable key is independent from its editable display name.
     * @param {ProjectRaw} raw
     */
    constructor(raw) {
        this.key = typeof raw?.key === "string" ? raw.key.trim() : "";
        this.name = typeof raw?.name === "string" ? raw.name.trim() : "";
        const color = typeof raw?.color === "string" ? raw.color.trim() : "";
        this.color = PROJECT_COLOR_PATTERN.test(color) ? color : "";
        this.billable = raw?.billable === true;
        this.archived = raw?.archived === true;
        this.sections = (Array.isArray(raw?.sections) ? raw.sections : []).map((section) => new Section(section));
        this.externalRefs = normalizeExternalReferences(raw?.external_refs);
        this.sectionsByKey = new Map(this.sections.map((section) => [section.key, section]));
    }

    /**
     * Returns the first external binding for a provider, or null when the project has no such integration.
     * This is used both by importers and optional live integrations without coupling the canonical project model to a particular service.
     * @param {string} provider External system identifier such as `github` or `todoist`.
     * @returns {ExternalReferenceRaw | null}
     */
    getExternalReference(provider) {
        const normalized = String(provider || "").trim().toLowerCase();
        return this.externalRefs.find((reference) => reference.provider === normalized) || null;
    }

    /**
     * Looks up one section by its stable key within this project.
     * @param {string | null | undefined} key
     * @returns {Section | null}
     */
    getSectionByKey(key) {
        const normalized = String(key || "").trim();
        return normalized ? this.sectionsByKey.get(normalized) || null : null;
    }

    /**
     * Finds a section by display name for project-management and import matching only.
     * Persisted assignments always use keys.
     * @param {string} name
     * @returns {Section | null}
     */
    findSectionByName(name) {
        const normalized = String(name || "").trim().toLowerCase();
        if (!normalized) return null;
        return this.sections.find((section) => section.name.toLowerCase() === normalized) || null;
    }

    /**
     * Returns a shallow copy so views cannot reorder the project model accidentally.
     * @returns {Section[]}
     */
    listSections() {
        return this.sections.slice();
    }

    /**
     * Returns the complete JSON-ready project object including hidden upstream bindings.
     * @returns {ProjectRaw}
     */
    toRaw() {
        return {
            archived: this.archived,
            billable: this.billable,
            color: this.color,
            external_refs: this.externalRefs.map((reference) => ({ ...reference })),
            key: this.key,
            name: this.name,
            sections: this.sections.map((section) => section.toRaw()),
        };
    }
}

/**
 * @typedef {Object} ResolvedAssignment
 * @description Fully resolved project metadata used by editors, rendering, search, and billable defaults.
 * @property {Project | null} project
 * @property {Section | null} section
 * @property {string} label
 * @property {string} color
 * @property {boolean | null} billable
 * @property {boolean} archived
 */

/**
 * @typedef {Object} AssignmentOption
 * @description One searchable project/section choice exposed by the canonical taxonomy.
 * Root projects use a null section key, while section choices use the full “Project / Section” display label.
 * @property {string} projectKey
 * @property {string | null} sectionKey
 * @property {string} label
 * @property {boolean} archived
 */

/**
 * Represents the authoritative projects.json taxonomy.
 * It validates stable identities once, exposes shared assignment resolution, and prevents either frontend from inventing project names.
 */
export class ProjectList {
    /**
     * Creates lookup indexes for canonical keys and external provider identities.
     * Duplicate provider references are rejected because an import must never resolve one source id to two local assignments.
     * @param {Project[]} projects
     * @param {string} generatedAt
     */
    constructor(projects, generatedAt) {
        this.projects = projects;
        this.generated_at = generatedAt;
        this.schema_version = 2;
        this.projectsByKey = new Map(projects.map((project) => [project.key, project]));
        /** @type {Map<string, {projectKey: string, sectionKey: string | null}>} */
        this.assignmentsByExternalRef = new Map();

        for (const project of projects) {
            for (const reference of project.externalRefs) {
                this.addExternalReference(reference, project.key, null);
            }
            for (const section of project.sections) {
                for (const reference of section.externalRefs) {
                    this.addExternalReference(reference, project.key, section.key);
                }
            }
        }
    }

    /**
     * Registers one upstream identifier and rejects ambiguous configuration immediately.
     * @param {ExternalReferenceRaw} reference
     * @param {string} projectKey
     * @param {string | null} sectionKey
     * @returns {void}
     */
    addExternalReference(reference, projectKey, sectionKey) {
        const key = `${reference.provider}\u0000${reference.id}`;
        const prior = this.assignmentsByExternalRef.get(key);
        if (prior && (prior.projectKey !== projectKey || prior.sectionKey !== sectionKey)) {
            throw new Error(`External reference ${reference.provider}:${reference.id} is assigned more than once.`);
        }
        this.assignmentsByExternalRef.set(key, { projectKey, sectionKey });
    }

    /**
     * Parses and strictly validates the schema-version-2 project document.
     * The application intentionally has no legacy name-based fallback after the one-shot migration.
     * @param {ProjectsFileRaw} raw
     * @returns {ProjectList}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object" || Number(raw.schema_version) !== 2) {
            throw new Error("projects.json must use schema_version 2.");
        }
        const projects = Array.isArray(raw.projects) ? raw.projects : [];
        const result = [];
        const projectKeys = new Set();
        const projectNames = new Set();

        for (const item of projects) {
            if (!item || typeof item !== "object") throw new Error("projects.json contains an invalid project.");
            const project = new Project(item);
            if (!PROJECT_KEY_PATTERN.test(project.key)) throw new Error(`Invalid project key: ${project.key || "(empty)"}`);
            if (!project.name) throw new Error(`Project ${project.key} needs a name.`);
            if (!project.color) throw new Error(`Project ${project.name} needs a valid color.`);
            const nameKey = project.name.toLowerCase();
            if (projectKeys.has(project.key)) throw new Error(`Duplicate project key: ${project.key}`);
            if (projectNames.has(nameKey)) throw new Error(`Duplicate project name: ${project.name}`);
            projectKeys.add(project.key);
            projectNames.add(nameKey);

            const sectionKeys = new Set();
            const sectionNames = new Set();
            for (const section of project.sections) {
                if (!PROJECT_KEY_PATTERN.test(section.key)) {
                    throw new Error(`Invalid section key in ${project.name}: ${section.key || "(empty)"}`);
                }
                if (!section.name) throw new Error(`Section ${project.key}/${section.key} needs a name.`);
                const sectionNameKey = section.name.toLowerCase();
                if (sectionKeys.has(section.key)) throw new Error(`Duplicate section key in ${project.name}: ${section.key}`);
                if (sectionNames.has(sectionNameKey)) throw new Error(`Duplicate section name in ${project.name}: ${section.name}`);
                sectionKeys.add(section.key);
                sectionNames.add(sectionNameKey);
            }
            project.sections.sort((left, right) => left.name.localeCompare(right.name));
            project.sectionsByKey = new Map(project.sections.map((section) => [section.key, section]));
            result.push(project);
        }

        result.sort((left, right) => left.name.localeCompare(right.name));
        const generatedAt = typeof raw.generated_at === "string" ? raw.generated_at : "";
        return new ProjectList(result, generatedAt);
    }

    /**
     * Creates an empty but schema-valid taxonomy for error recovery and new repositories.
     * @param {string} [generatedAt]
     * @returns {ProjectList}
     */
    static createEmpty(generatedAt = "") {
        return new ProjectList([], generatedAt);
    }

    /**
     * Converts a display name into a deterministic key candidate for newly created definitions.
     * Callers must still reserve uniqueness within the relevant project scope.
     * @param {string} name
     * @returns {string}
     */
    static keyFromName(name) {
        const normalized = String(name || "")
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return normalized || "item";
    }

    /**
     * Reserves a readable unique key by adding a numeric suffix when necessary.
     * @param {string} name
     * @param {Set<string>} used
     * @returns {string}
     */
    static reserveKey(name, used) {
        const base = ProjectList.keyFromName(name);
        let candidate = base;
        let suffix = 2;
        while (used.has(candidate)) {
            candidate = `${base}-${suffix}`;
            suffix += 1;
        }
        used.add(candidate);
        return candidate;
    }

    /**
     * Returns a project by stable key.
     * @param {string | null | undefined} key
     * @returns {Project | null}
     */
    getProjectByKey(key) {
        const normalized = String(key || "").trim();
        return normalized ? this.projectsByKey.get(normalized) || null : null;
    }

    /**
     * Finds a project by display name for combobox input and import diagnostics only.
     * Persisted records never use this mutable name as identity.
     * @param {string} name
     * @returns {Project | null}
     */
    findProjectByName(name) {
        const normalized = String(name || "").trim().toLowerCase();
        if (!normalized) return null;
        return this.projects.find((project) => project.name.toLowerCase() === normalized) || null;
    }

    /**
     * Resolves a project and optional section into effective display and accounting metadata.
     * Invalid key pairs return null, while the intentional no-project pair resolves to neutral metadata.
     * @param {string | null | undefined} projectKey
     * @param {string | null | undefined} sectionKey
     * @returns {ResolvedAssignment | null}
     */
    resolveAssignment(projectKey, sectionKey) {
        const normalizedProject = String(projectKey || "").trim();
        const normalizedSection = String(sectionKey || "").trim();
        if (!normalizedProject) {
            if (normalizedSection) return null;
            return { project: null, section: null, label: "", color: "", billable: null, archived: false };
        }
        const project = this.getProjectByKey(normalizedProject);
        if (!project) return null;
        const section = normalizedSection ? project.getSectionByKey(normalizedSection) : null;
        if (normalizedSection && !section) return null;
        return {
            project,
            section,
            label: section ? `${project.name} / ${section.name}` : project.name,
            color: section?.color || project.color,
            billable: typeof section?.billable === "boolean" ? section.billable : project.billable,
            archived: project.archived || section?.archived === true,
        };
    }

    /**
     * Returns every assignable root project and section as a flat searchable list.
     * Keeping this projection in the model gives time entries and TODOs exactly the same labels and archive semantics.
     * The intentional no-project assignment is represented by an empty editor value and is therefore not included.
     * @returns {AssignmentOption[]}
     */
    listAssignmentOptions() {
        const options = [];
        for (const project of this.projects) {
            options.push({
                projectKey: project.key,
                sectionKey: null,
                label: project.name,
                archived: project.archived,
            });
            for (const section of project.sections) {
                options.push({
                    projectKey: project.key,
                    sectionKey: section.key,
                    label: `${project.name} / ${section.name}`,
                    archived: project.archived || section.archived,
                });
            }
        }
        return options;
    }

    /**
     * Resolves the exact human-readable value entered in a project/section combobox back to stable keys.
     * Matching is case-insensitive and surrounding whitespace is ignored; an empty value means “No project”.
     * Unknown or ambiguous labels return null so callers can reject arbitrary text instead of persisting mutable names.
     * @param {string | null | undefined} label
     * @returns {{projectKey: string | null, sectionKey: string | null} | null}
     */
    findAssignmentByLabel(label) {
        const normalized = String(label || "").trim().toLowerCase();
        if (!normalized) return { projectKey: null, sectionKey: null };

        let match = null;
        for (const option of this.listAssignmentOptions()) {
            if (option.label.toLowerCase() !== normalized) continue;
            if (match) return null;
            match = { projectKey: option.projectKey, sectionKey: option.sectionKey };
        }
        return match;
    }

    /**
     * Resolves an upstream service identifier to one canonical assignment.
     * This is the only supported bridge for Todoist/Toggl imports after migration.
     * @param {string} provider
     * @param {string | number | null | undefined} id
     * @returns {{projectKey: string, sectionKey: string | null} | null}
     */
    findAssignmentByExternalRef(provider, id) {
        const normalizedProvider = String(provider || "").trim().toLowerCase();
        const normalizedId = String(id ?? "").trim();
        if (!normalizedProvider || !normalizedId) return null;
        const assignment = this.assignmentsByExternalRef.get(`${normalizedProvider}\u0000${normalizedId}`);
        return assignment ? { ...assignment } : null;
    }

    /**
     * Returns a shallow copy of canonical projects for rendering and management.
     * @returns {Project[]}
     */
    list() {
        return this.projects.slice();
    }

    /**
     * Returns a JSON-serializable payload object with stable schema metadata.
     * @returns {ProjectsFileRaw}
     */
    toObject() {
        return {
            generated_at: this.generated_at,
            projects: this.projects.map((project) => project.toRaw()),
            schema_version: this.schema_version,
        };
    }

    /**
     * Returns deterministic projects.json content shared by local and GitHub save paths.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}

const RECURRENCE_FREQUENCIES = new Set(["daily", "weekly", "monthly", "yearly", "custom"]);
const WEEKDAY_BY_NAME = new Map([
    ["monday", 1],
    ["mon", 1],
    ["tuesday", 2],
    ["tue", 2],
    ["tues", 2],
    ["wednesday", 3],
    ["wed", 3],
    ["thursday", 4],
    ["thu", 4],
    ["thur", 4],
    ["thurs", 4],
    ["friday", 5],
    ["fri", 5],
    ["saturday", 6],
    ["sat", 6],
    ["sunday", 7],
    ["sun", 7],
]);
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Parses the date prefix from a date-only or local date-time TODO value.
 * Calendar arithmetic intentionally uses UTC as a neutral representation so browser timezone and daylight-saving changes cannot shift dates.
 * @param {string} value
 * @returns {{year: number, month: number, day: number} | null}
 */
function parseTodoCalendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day
    ) {
        return null;
    }
    return { year, month, day };
}

/**
 * Formats validated calendar parts as YYYY-MM-DD.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string}
 */
function formatTodoCalendarDate(year, month, day) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Returns the number of days in a calendar month.
 * @param {number} year
 * @param {number} month
 * @returns {number}
 */
function daysInTodoMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Adds whole months while retaining a preferred day-of-month and clamping only when that day does not exist.
 * Keeping the preferred day in Recurrence prevents a January-31 series from drifting permanently after February.
 * @param {string} date
 * @param {number} deltaMonths
 * @param {number} preferredDay
 * @returns {string | null}
 */
function addTodoMonths(date, deltaMonths, preferredDay) {
    const parts = parseTodoCalendarDate(date);
    if (!parts) return null;
    const absoluteMonth = parts.year * 12 + (parts.month - 1) + deltaMonths;
    const year = Math.floor(absoluteMonth / 12);
    const month = ((absoluteMonth % 12) + 12) % 12 + 1;
    const day = Math.min(Math.max(1, preferredDay), daysInTodoMonth(year, month));
    return formatTodoCalendarDate(year, month, day);
}

/**
 * Adds whole years while preserving a preferred month and day, clamping leap-day occurrences in non-leap years.
 * @param {string} date
 * @param {number} deltaYears
 * @param {number} preferredMonth
 * @param {number} preferredDay
 * @returns {string | null}
 */
function addTodoYears(date, deltaYears, preferredMonth, preferredDay) {
    const parts = parseTodoCalendarDate(date);
    if (!parts) return null;
    const year = parts.year + deltaYears;
    const month = Math.max(1, Math.min(12, preferredMonth));
    const day = Math.min(Math.max(1, preferredDay), daysInTodoMonth(year, month));
    return formatTodoCalendarDate(year, month, day);
}

/**
 * Replaces only the calendar-date prefix of a due value, preserving its local time and offset suffix.
 * @param {TodoDueRaw} due
 * @param {string} date
 * @returns {TodoDueRaw}
 */
function replaceTodoDueDate(due, date) {
    const suffix = String(due.date || "").slice(10);
    return {
        date: `${date}${suffix}`,
        timezone: typeof due.timezone === "string" && due.timezone ? due.timezone : null,
    };
}

/**
 * Represents a structured recurrence rule independently from the current due occurrence.
 * Frequencies and interval/weekday/month parts follow the same conceptual model as iCalendar RRULE, with one local extension for completion-relative schedules.
 */
export class Recurrence {
    /**
     * Normalizes recurrence fields into a bounded, deterministic model.
     * @param {RecurrenceRaw} raw
     */
    constructor(raw) {
        const frequency = String(raw?.frequency || "").toLowerCase();
        this.frequency = /** @type {RecurrenceFrequency} */ (
            RECURRENCE_FREQUENCIES.has(frequency) ? frequency : "custom"
        );
        const interval = Number(raw?.interval);
        this.interval = Number.isInteger(interval) ? Math.max(1, Math.min(999, interval)) : 1;
        this.basis = raw?.basis === "after_completion" ? "after_completion" : "scheduled";
        this.weekdays = Array.isArray(raw?.weekdays)
            ? Array.from(
                  new Set(
                      raw.weekdays
                          .map((weekday) => Number(weekday))
                          .filter((weekday) => Number.isInteger(weekday) && weekday >= 1 && weekday <= 7),
                  ),
              ).sort((left, right) => left - right)
            : [];
        const monthDay = Number(raw?.month_day);
        this.month_day = Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31 ? monthDay : null;
        const month = Number(raw?.month);
        this.month = Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
        this.source_text = typeof raw?.source_text === "string" ? raw.source_text.trim() : "";
    }

    /**
     * Parses a persisted structured recurrence object.
     * @param {unknown} raw
     * @returns {Recurrence | null}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object") return null;
        return new Recurrence(/** @type {RecurrenceRaw} */ (raw));
    }

    /**
     * Converts the supported natural-language subset used by the editor and Todoist import into structured fields.
     * Unsupported phrases return null rather than creating a task that cannot advance safely.
     * @param {string} text
     * @param {string} anchorDate
     * @returns {Recurrence | null}
     */
    static fromText(text, anchorDate) {
        const sourceText = String(text || "").trim();
        const anchor = parseTodoCalendarDate(anchorDate);
        if (!sourceText || !anchor) return null;

        let normalized = sourceText.toLowerCase().replace(/\s+/g, " ").trim();
        let basis = /** @type {RecurrenceBasis} */ ("scheduled");
        if (normalized.startsWith("every!")) {
            basis = "after_completion";
            normalized = normalized.slice("every!".length).trim();
        } else if (normalized.startsWith("every ")) {
            normalized = normalized.slice("every ".length).trim();
        }
        normalized = normalized.replace(/\s+at\s+.+$/, "").trim();

        const anchorDateText = formatTodoCalendarDate(anchor.year, anchor.month, anchor.day);
        const anchorWeekday = isoWeekdayIndex(anchorDateText) + 1;
        const common = { basis, source_text: sourceText };

        if (normalized === "daily" || normalized === "day") {
            return new Recurrence({ ...common, frequency: "daily", interval: 1 });
        }
        if (normalized === "weekly" || normalized === "week") {
            return new Recurrence({ ...common, frequency: "weekly", interval: 1, weekdays: [anchorWeekday] });
        }
        if (normalized === "monthly" || normalized === "month") {
            return new Recurrence({
                ...common,
                frequency: "monthly",
                interval: 1,
                month_day: anchor.day,
            });
        }
        if (normalized === "yearly" || normalized === "annually" || normalized === "year") {
            return new Recurrence({
                ...common,
                frequency: "yearly",
                interval: 1,
                month: anchor.month,
                month_day: anchor.day,
            });
        }

        const weekday = WEEKDAY_BY_NAME.get(normalized);
        if (weekday) {
            return new Recurrence({ ...common, frequency: "weekly", interval: 1, weekdays: [weekday] });
        }

        const intervalMatch = /^(\d+)\s+(days?|weeks?|months?|years?)$/.exec(normalized);
        if (!intervalMatch) return null;
        const interval = Number(intervalMatch[1]);
        const unit = intervalMatch[2];
        if (unit.startsWith("day")) {
            return new Recurrence({ ...common, frequency: "daily", interval });
        }
        if (unit.startsWith("week")) {
            return new Recurrence({ ...common, frequency: "weekly", interval, weekdays: [anchorWeekday] });
        }
        if (unit.startsWith("month")) {
            return new Recurrence({ ...common, frequency: "monthly", interval, month_day: anchor.day });
        }
        return new Recurrence({
            ...common,
            frequency: "yearly",
            interval,
            month: anchor.month,
            month_day: anchor.day,
        });
    }

    /**
     * Converts a legacy Todoist due object into the provider-neutral recurrence model.
     * Unknown natural-language rules remain as custom records for lossless migration, but are not advanced automatically.
     * @param {LegacyTodoistDueRaw | null | undefined} due
     * @returns {Recurrence | null}
     */
    static fromTodoistDue(due) {
        if (!due?.is_recurring) return null;
        const sourceText = typeof due.string === "string" ? due.string.trim() : "";
        const parsed = Recurrence.fromText(sourceText, due.date);
        if (parsed) return parsed;
        return new Recurrence({
            frequency: "custom",
            interval: 1,
            basis: sourceText.toLowerCase().startsWith("every!") ? "after_completion" : "scheduled",
            source_text: sourceText,
        });
    }

    /**
     * Reports whether the application can calculate future occurrences for this rule.
     * @returns {boolean}
     */
    isSupported() {
        return this.frequency !== "custom";
    }

    /**
     * Returns a human-readable recurrence phrase, preferring the original imported/editor text.
     * @returns {string}
     */
    describe() {
        if (this.source_text) return this.source_text;
        const prefix = this.basis === "after_completion" ? "every!" : "every";
        if (this.frequency === "daily") {
            return this.interval === 1 ? `${prefix} day` : `${prefix} ${this.interval} days`;
        }
        if (this.frequency === "weekly") {
            if (this.interval === 1 && this.weekdays.length === 1) {
                return `${prefix} ${WEEKDAY_NAMES[this.weekdays[0] - 1]}`;
            }
            return this.interval === 1 ? `${prefix} week` : `${prefix} ${this.interval} weeks`;
        }
        if (this.frequency === "monthly") {
            return this.interval === 1 ? `${prefix} month` : `${prefix} ${this.interval} months`;
        }
        if (this.frequency === "yearly") {
            return this.interval === 1 ? `${prefix} year` : `${prefix} ${this.interval} years`;
        }
        return this.source_text || "custom recurrence";
    }

    /**
     * Advances one scheduled occurrence according to frequency-specific calendar rules.
     * @param {string} currentDate
     * @returns {string | null}
     */
    advanceScheduledDate(currentDate) {
        const current = parseTodoCalendarDate(currentDate);
        if (!current || !this.isSupported()) return null;
        if (this.frequency === "daily") return addIsoDays(currentDate, this.interval);
        if (this.frequency === "weekly") {
            const currentWeekday = isoWeekdayIndex(currentDate) + 1;
            const weekdays = this.weekdays.length ? this.weekdays : [currentWeekday];
            const nextInWeek = weekdays.find((weekday) => weekday > currentWeekday);
            if (nextInWeek) return addIsoDays(currentDate, nextInWeek - currentWeekday);
            const first = weekdays[0];
            return addIsoDays(currentDate, this.interval * 7 - currentWeekday + first);
        }
        if (this.frequency === "monthly") {
            return addTodoMonths(currentDate, this.interval, this.month_day || current.day);
        }
        return addTodoYears(
            currentDate,
            this.interval,
            this.month || current.month,
            this.month_day || current.day,
        );
    }

    /**
     * Calculates the first occurrence strictly after a completion timestamp.
     * Scheduled rules skip overdue occurrences; completion-relative rules apply their interval once from the completion date.
     * @param {TodoDueRaw} due
     * @param {string} completedAt
     * @param {import("./utils.js").TimeContext} timeContext
     * @returns {TodoDueRaw | null}
     */
    nextDue(due, completedAt, timeContext) {
        if (!this.isSupported() || !due || !parseTodoCalendarDate(due.date)) return null;
        const completedDate = new Date(completedAt);
        if (Number.isNaN(completedDate.getTime())) return null;
        const completedLocalDate = timeContext.formatDate(completedDate);
        const completedLocalTime = timeContext.formatTime(completedDate);
        const hasTime = /T\d{2}:\d{2}/.test(due.date);

        if (this.basis === "after_completion") {
            const completedParts = parseTodoCalendarDate(completedLocalDate);
            if (!completedParts) return null;
            let nextDate = null;
            if (this.frequency === "daily") {
                nextDate = addIsoDays(completedLocalDate, this.interval);
            } else if (this.frequency === "weekly") {
                nextDate = addIsoDays(completedLocalDate, this.interval * 7);
            } else if (this.frequency === "monthly") {
                nextDate = addTodoMonths(completedLocalDate, this.interval, completedParts.day);
            } else if (this.frequency === "yearly") {
                nextDate = addTodoYears(
                    completedLocalDate,
                    this.interval,
                    completedParts.month,
                    completedParts.day,
                );
            }
            return nextDate ? replaceTodoDueDate(due, nextDate) : null;
        }

        let candidateDate = this.advanceScheduledDate(due.date.slice(0, 10));
        for (let attempts = 0; candidateDate && attempts < 10000; attempts += 1) {
            const candidate = replaceTodoDueDate(due, candidateDate);
            const candidateKey = hasTime ? candidate.date.slice(0, 16) : candidate.date.slice(0, 10);
            const completedKey = hasTime ? `${completedLocalDate}T${completedLocalTime}` : completedLocalDate;
            if (candidateKey > completedKey) return candidate;
            candidateDate = this.advanceScheduledDate(candidateDate);
        }
        return null;
    }

    /**
     * Returns the stable JSON representation persisted in data/todos.json.
     * @returns {RecurrenceRaw}
     */
    toRaw() {
        return {
            frequency: this.frequency,
            interval: this.interval,
            basis: this.basis,
            weekdays: this.weekdays.slice(),
            month_day: this.month_day,
            month: this.month,
            source_text: this.source_text,
        };
    }
}

/**
 * Represents one actionable TODO independent of its visual presentation.
 * Project and section associations use stable keys so display-name edits cannot break historical TODO references.
 */
export class Todo {
    /**
     * Normalizes a raw TODO payload into the provider-neutral schema used by the editor.
     * Schema-version-1 Todoist recurrence fields are migrated from `due` into a structured Recurrence automatically.
     * Invalid optional values are reduced to safe defaults so one malformed row cannot prevent the rest of the list from loading.
     * @param {TodoRaw} raw
     */
    constructor(raw) {
        this.id = typeof raw?.id === "string" ? raw.id.trim() : "";
        this.content = typeof raw?.content === "string" ? raw.content.trim() : "";
        this.description = typeof raw?.description === "string" ? raw.description : "";
        this.projectKey = typeof raw?.project_key === "string" && raw.project_key.trim() ? raw.project_key.trim() : null;
        this.sectionKey = typeof raw?.section_key === "string" && raw.section_key.trim() ? raw.section_key.trim() : null;
        this.parent_id = typeof raw?.parent_id === "string" && raw.parent_id.trim() ? raw.parent_id.trim() : null;
        this.labels = Array.isArray(raw?.labels)
            ? raw.labels.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim())
            : [];
        const priority = Number(raw?.priority);
        this.priority = Number.isInteger(priority) ? Math.max(1, Math.min(4, priority)) : 1;
        this.due = Todo.normalizeDue(raw?.due);
        this.recurrence = Recurrence.fromRaw(raw?.recurrence) || Recurrence.fromTodoistDue(raw?.due);
        this.completion_history = Todo.normalizeCompletionHistory(raw?.completion_history);
        this.deadline = raw?.deadline && typeof raw.deadline === "object" ? cloneJson(raw.deadline) : null;
        this.completed_at = typeof raw?.completed_at === "string" && raw.completed_at ? raw.completed_at : null;
        this.created_at = typeof raw?.created_at === "string" ? raw.created_at : "";
        this.updated_at = typeof raw?.updated_at === "string" ? raw.updated_at : "";
        this.archived = raw?.archived === true;
        const order = Number(raw?.order);
        this.order = Number.isFinite(order) ? order : 0;
        this.source = Todo.normalizeSource(raw?.source);
        this.searchHaystack = [
            this.content,
            this.description,
            this.projectKey || "",
            this.sectionKey || "",
            this.recurrence?.describe() || "",
            ...this.labels,
        ]
            .join(" ")
            .toLowerCase();
    }

    /**
     * Clones and validates the current due occurrence independently from recurrence.
     * Legacy Todoist recurrence fields are deliberately omitted here because the constructor migrates them into Recurrence.
     * @param {TodoDueRaw | null | undefined} due
     * @returns {TodoDueRaw | null}
     */
    static normalizeDue(due) {
        if (!due || typeof due !== "object") return null;
        const date = typeof due.date === "string" ? due.date.trim() : "";
        if (!date) return null;
        return {
            date,
            timezone: typeof due.timezone === "string" && due.timezone ? due.timezone : null,
        };
    }

    /**
     * Normalizes the immutable occurrence log kept for a recurring TODO.
     * Invalid records are ignored while the original order is retained for auditability and deterministic undo snapshots.
     * @param {unknown} history
     * @returns {TodoCompletionRaw[]}
     */
    static normalizeCompletionHistory(history) {
        if (!Array.isArray(history)) return [];
        const normalized = [];
        for (const item of history) {
            if (!item || typeof item !== "object") continue;
            const record = /** @type {Partial<TodoCompletionRaw>} */ (item);
            const completedAt = typeof record.completed_at === "string" ? record.completed_at.trim() : "";
            const scheduledFor = typeof record.scheduled_for === "string" ? record.scheduled_for.trim() : "";
            if (!completedAt || !scheduledFor) continue;
            normalized.push({
                completed_at: completedAt,
                scheduled_for: scheduledFor,
            });
        }
        return normalized;
    }

    /**
     * Clones supported import provenance without making it part of the task identity rules.
     * Locally created TODOs omit this object, while imported TODOs keep their original service identifiers for auditing.
     * @param {TodoSourceRaw | null | undefined} source
     * @returns {TodoSourceRaw | null}
     */
    static normalizeSource(source) {
        if (!source || typeof source !== "object") return null;
        const provider = typeof source.provider === "string" ? source.provider.trim() : "";
        const id = typeof source.id === "string" ? source.id.trim() : "";
        if (!provider || !id) return null;
        return {
            provider,
            id,
            project_id: typeof source.project_id === "string" && source.project_id ? source.project_id : null,
            section_id: typeof source.section_id === "string" && source.section_id ? source.section_id : null,
        };
    }

    /**
     * Reports whether the TODO has a completion timestamp.
     * Keeping this derived state out of JSON avoids contradictory completed flags.
     * @returns {boolean}
     */
    isCompleted() {
        return Boolean(this.completed_at);
    }

    /**
     * Reports whether this TODO represents an active recurrence series.
     * This remains true even when an imported custom rule cannot yet be calculated by the application.
     * @returns {boolean}
     */
    isRecurring() {
        return this.recurrence instanceof Recurrence;
    }

    /**
     * Returns a detached JSON-ready representation of this TODO.
     * Callers may edit the returned object without mutating the model held by TodoStore.
     * @returns {TodoRaw}
     */
    toRaw() {
        return {
            id: this.id,
            content: this.content,
            description: this.description,
            project_key: this.projectKey,
            section_key: this.sectionKey,
            parent_id: this.parent_id,
            labels: this.labels.slice(),
            priority: this.priority,
            due: this.due ? cloneJson(this.due) : null,
            recurrence: this.recurrence ? this.recurrence.toRaw() : null,
            completion_history: cloneJson(this.completion_history),
            deadline: this.deadline ? cloneJson(this.deadline) : null,
            completed_at: this.completed_at,
            created_at: this.created_at,
            updated_at: this.updated_at,
            archived: this.archived,
            order: this.order,
            source: this.source ? cloneJson(this.source) : null,
        };
    }
}

/**
 * Represents the complete todos.json document and its serialization metadata.
 * The collection owns Todo models while project definitions remain in the shared ProjectList managed by EntryStore.
 */
export class TodoList {
    /**
     * Creates a TODO collection from already normalized models.
     * The input order is retained because imported child ordering is meaningful when due dates are equal.
     * @param {Todo[]} todos
     * @param {string} generatedAt
     */
    constructor(todos, generatedAt) {
        this.todos = todos;
        this.generated_at = generatedAt;
        this.schema_version = 3;
        this.todosById = new Map();
        for (const todo of todos) {
            this.todosById.set(todo.id, todo);
        }
    }

    /**
     * Parses data/todos.json and discards rows without a stable id or content.
     * Duplicate identifiers keep the last valid row, which mirrors update semantics and makes recovery from hand edits deterministic.
     * @param {unknown} raw
     * @returns {TodoList}
     */
    static fromRaw(raw) {
        const rawObj = raw && typeof raw === "object" ? /** @type {TodosFileRaw} */ (raw) : null;
        if (!rawObj || Number(rawObj.schema_version) !== 3) {
            throw new Error("todos.json must use schema_version 3.");
        }
        const rawTodos = Array.isArray(rawObj.todos) ? rawObj.todos : [];
        const byId = new Map();
        for (const item of rawTodos) {
            if (!item || typeof item !== "object") continue;
            if (!("project_key" in item) || !("section_key" in item)) {
                throw new Error("todos.json contains a TODO without canonical project_key/section_key fields.");
            }
            const todo = new Todo(item);
            if (!todo.id || !todo.content) continue;
            byId.set(todo.id, todo);
        }
        const generatedAt = typeof rawObj.generated_at === "string" ? rawObj.generated_at : "";
        return new TodoList(Array.from(byId.values()), generatedAt);
    }

    /**
     * Creates an empty TODO document for new repositories or a missing optional file.
     * @param {string} [generatedAt]
     * @returns {TodoList}
     */
    static createEmpty(generatedAt = "") {
        return new TodoList([], generatedAt);
    }

    /**
     * Returns the TODO matching an exact stable id.
     * @param {string} id
     * @returns {Todo | null}
     */
    getTodoById(id) {
        return this.todosById.get(String(id || "")) || null;
    }

    /**
     * Returns a shallow copy of the model array for read-only iteration by views.
     * @returns {Todo[]}
     */
    list() {
        return this.todos.slice();
    }

    /**
     * Returns detached raw TODO rows suitable for snapshots, undo history, and draft persistence.
     * @returns {TodoRaw[]}
     */
    snapshotRaw() {
        return this.todos.map((todo) => todo.toRaw());
    }

    /**
     * Returns the complete JSON-ready document while preserving current collection order.
     * @returns {TodosFileRaw}
     */
    toObject() {
        return {
            generated_at: this.generated_at,
            schema_version: this.schema_version,
            todos: this.snapshotRaw(),
        };
    }

    /**
     * Produces deterministic JSON for data/todos.json in both GitHub and local modes.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}

/**
 * Represents a single week-specific required-hours override.
 * Associates one ISO week start (Monday) with hours and an optional note.
 */
export class WeekRequirement {
    /**
     * Normalizes a raw week override payload into a strict object.
     * Ensures week keys are Monday-based and hours are bounded.
     * @param {WeekRequirementRaw} raw
     * @param {number} defaultRequiredHours
     */
    constructor(raw, defaultRequiredHours) {
        const weekStartRaw = typeof raw?.week_start === "string" ? raw.week_start.trim() : "";
        const weekStartNormalized = weekStartRaw && /^\d{4}-\d{2}-\d{2}$/.test(weekStartRaw) ? isoWeekStart(weekStartRaw) : "";
        this.week_start = weekStartNormalized || "";
        this.required_hours = normalizeRequiredHours(raw?.required_hours, defaultRequiredHours);
        this.comment = typeof raw?.comment === "string" ? raw.comment.trim() : "";
        this.updated_at = typeof raw?.updated_at === "string" ? raw.updated_at : "";
    }

    /**
     * Returns true when the requirement has a valid Monday week key.
     * Used while parsing persisted configuration files.
     * @returns {boolean}
     */
    isValid() {
        return Boolean(this.week_start);
    }

    /**
     * Returns a JSON-ready override payload.
     * Used while serializing week-requirements.json.
     * @returns {WeekRequirementRaw}
     */
    toRaw() {
        return {
            week_start: this.week_start,
            required_hours: this.required_hours,
            comment: this.comment,
            ...(this.updated_at ? { updated_at: this.updated_at } : {}),
        };
    }
}

/**
 * Represents the week-requirements.json payload.
 * Stores default hours plus per-week required-hours/comment overrides.
 */
export class WeekRequirements {
    /**
     * Initializes week requirements with sorted overrides.
     * Provides lookup and immutable update helpers for the store.
     * @param {number} defaultRequiredHours
     * @param {WeekRequirement[]} weeks
     * @param {string} generatedAt
     */
    constructor(defaultRequiredHours, weeks, generatedAt) {
        this.default_required_hours = normalizeRequiredHours(defaultRequiredHours, DEFAULT_WEEK_REQUIRED_HOURS);
        this.generated_at = generatedAt;
        this.schema_version = 2;
        this.weeks = weeks
            .filter((week) => week instanceof WeekRequirement && week.isValid())
            .slice()
            .sort((a, b) => a.week_start.localeCompare(b.week_start));
        this.weeksByStart = new Map();
        for (const week of this.weeks) {
            this.weeksByStart.set(week.week_start, week);
        }
    }

    /**
     * Creates a default configuration with no overrides.
     * Used when week-requirements.json does not exist yet.
     * @param {string} [generatedAt]
     * @returns {WeekRequirements}
     */
    static createDefault(generatedAt = "") {
        return new WeekRequirements(DEFAULT_WEEK_REQUIRED_HOURS, [], generatedAt);
    }

    /**
     * Parses week-requirements.json into a validated model.
     * Drops invalid rows and keeps only one override per week.
     * @param {unknown} raw
     * @returns {WeekRequirements}
     */
    static fromRaw(raw) {
        if (!raw || typeof raw !== "object") {
            return WeekRequirements.createDefault();
        }

        const rawObj = /** @type {WeekRequirementsFileRaw} */ (raw);
        const defaultRequiredHours = normalizeRequiredHours(rawObj.default_required_hours, DEFAULT_WEEK_REQUIRED_HOURS);
        const weeksRaw = Array.isArray(rawObj.weeks) ? rawObj.weeks : [];
        const byWeek = new Map();
        for (const item of weeksRaw) {
            if (!item || typeof item !== "object") continue;
            const normalized = new WeekRequirement(item, defaultRequiredHours);
            if (!normalized.isValid()) continue;
            byWeek.set(normalized.week_start, normalized);
        }

        const generatedAt = typeof rawObj.generated_at === "string" ? rawObj.generated_at : "";
        const weeks = Array.from(byWeek.values()).sort((a, b) => a.week_start.localeCompare(b.week_start));
        return new WeekRequirements(defaultRequiredHours, weeks, generatedAt);
    }

    /**
     * Returns the override object for a week when present.
     * Used by the week UI to display required-hours metadata.
     * @param {string} weekStart
     * @returns {WeekRequirement | null}
     */
    getWeek(weekStart) {
        const key = String(weekStart || "");
        return this.weeksByStart.get(key) || null;
    }

    /**
     * Returns required hours for a week, falling back to default.
     * Used for week-level under/over-time calculations.
     * @param {string} weekStart
     * @returns {number}
     */
    getRequiredHours(weekStart) {
        const week = this.getWeek(weekStart);
        return week ? week.required_hours : this.default_required_hours;
    }

    /**
     * Returns the optional week comment for a week.
     * Used for labels such as vacation/sick annotations.
     * @param {string} weekStart
     * @returns {string}
     */
    getComment(weekStart) {
        const week = this.getWeek(weekStart);
        return week ? week.comment : "";
    }

    /**
     * Applies one week override and returns a new immutable model.
     * Removes the override when it matches defaults and has no comment.
     * @param {string} weekStart
     * @param {number} requiredHours
     * @param {string} comment
     * @param {string} updatedAt
     * @returns {WeekRequirements}
     */
    withUpdatedWeek(weekStart, requiredHours, comment, updatedAt) {
        const key = String(weekStart || "").trim();
        if (!key) return this;

        const normalizedWeekStart = /^\d{4}-\d{2}-\d{2}$/.test(key) ? isoWeekStart(key) : "";
        if (!normalizedWeekStart) return this;

        const normalizedHours = normalizeRequiredHours(requiredHours, this.default_required_hours);
        const normalizedComment = String(comment || "").trim();
        const byWeek = new Map(this.weeksByStart);

        const shouldRemove = normalizedHours === this.default_required_hours && !normalizedComment;
        if (shouldRemove) {
            byWeek.delete(normalizedWeekStart);
        } else {
            const next = new WeekRequirement(
                {
                    week_start: normalizedWeekStart,
                    required_hours: normalizedHours,
                    comment: normalizedComment,
                    updated_at: String(updatedAt || ""),
                },
                this.default_required_hours,
            );
            byWeek.set(normalizedWeekStart, next);
        }

        const weeks = Array.from(byWeek.values()).sort((a, b) => a.week_start.localeCompare(b.week_start));
        return new WeekRequirements(this.default_required_hours, weeks, String(updatedAt || this.generated_at || ""));
    }

    /**
     * Returns sorted week overrides for iteration or rendering.
     * Used by the store when computing accumulated balances.
     * @returns {WeekRequirement[]}
     */
    listWeeks() {
        return this.weeks.slice();
    }

    /**
     * Returns a JSON-ready object for serialization.
     * Used to persist week requirements through the save pipeline.
     * @returns {WeekRequirementsFileRaw}
     */
    toObject() {
        return {
            generated_at: this.generated_at,
            schema_version: this.schema_version,
            default_required_hours: this.default_required_hours,
            weeks: this.weeks.map((week) => week.toRaw()),
        };
    }

    /**
     * Returns stable JSON output for week-requirements.json.
     * Used by both GitHub and local save modes.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}

/**
 * Represents the entries manifest.
 * Stores week file metadata for loading and validation.
 */
export class Manifest {
    /**
     * Initializes a manifest with chunk metadata and totals.
     * Defines the data shape used by the store.
     * @param {ManifestChunk[]} chunks
     * @param {string} timezone
     * @param {string} generatedAt
     * @param {number} totalEntries
     */
    constructor(chunks, timezone, generatedAt, totalEntries) {
        this.chunks = chunks;
        this.timezone = timezone;
        this.generated_at = generatedAt;
        this.schema_version = 2;
        this.total_chunks = chunks.length;
        this.total_entries = totalEntries;
    }

    /**
     * Parses a raw manifest JSON object and validates its entries.
     * Defines the data shape used by the store.
     * @param {unknown} raw
     * @param {string} [entriesDirectory] Workspace-relative directory that is allowed to contain manifest chunks.
     * @returns {Manifest}
     */
    static fromRaw(raw, entriesDirectory = "data/entries") {
        if (!raw || typeof raw !== "object") {
            throw new Error("entries-manifest.json must be a JSON object");
        }

        const rawObj = /** @type {ManifestFileRaw} */ (raw);
        if (Number(rawObj.schema_version) !== 2) {
            throw new Error("entries-manifest.json must use schema_version 2.");
        }
        const chunksRaw = Array.isArray(rawObj.chunks) ? rawObj.chunks : [];
        const normalizedEntriesDirectory = normalizeRepositoryPath(entriesDirectory, "entries directory");
        const pathPrefix = `${normalizedEntriesDirectory}/`;
        const chunks = [];
        for (const c of chunksRaw) {
            if (!c || typeof c !== "object") continue;
            const year = Number(c.year);
            const week = Number(c.week);
            const sha = typeof c.sha === "string" ? c.sha : "";
            const size = Number(c.size);
            const path = typeof c.path === "string" ? c.path : "";
            const entries = typeof c.entries === "number" && Number.isFinite(c.entries) && c.entries >= 0 ? c.entries : null;

            if (!Number.isFinite(year) || year < 1970 || year > 9999) continue;
            if (!Number.isFinite(week) || week < 1 || week > 53) continue;
            if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
            if (!path.startsWith(pathPrefix)) continue;

            chunks.push({
                entries,
                path,
                sha,
                size: Number.isFinite(size) && size >= 0 ? size : null,
                week,
                year,
            });
        }

        chunks.sort((a, b) => a.year - b.year || a.week - b.week);

        let totalEntries = 0;
        for (const c of chunks) {
            if (typeof c.entries === "number" && Number.isFinite(c.entries)) {
                totalEntries += c.entries;
            }
        }

        const timezone = typeof rawObj.timezone === "string" ? rawObj.timezone : "Europe/Berlin";
        const generatedAt = typeof rawObj.generated_at === "string" ? rawObj.generated_at : "";
        return new Manifest(chunks, timezone, generatedAt, totalEntries);
    }

    /**
     * Builds a manifest from the provided chunk list.
     * Defines the data shape used by the store.
     * @param {ManifestChunk[]} chunks
     * @param {string} timezone
     * @param {string} generatedAt
     * @returns {Manifest}
     */
    static fromChunks(chunks, timezone, generatedAt) {
        const list = chunks.slice().sort((a, b) => a.year - b.year || a.week - b.week);
        let totalEntries = 0;
        for (const chunk of list) {
            if (typeof chunk.entries === "number" && Number.isFinite(chunk.entries)) {
                totalEntries += chunk.entries;
            }
        }
        return new Manifest(list, timezone, generatedAt, totalEntries);
    }

    /**
     * Returns a JSON-ready object for serialization.
     * Defines the data shape used by the store.
     * @returns {Object}
     */
    toObject() {
        return {
            chunks: this.chunks,
            generated_at: this.generated_at,
            schema_version: this.schema_version,
            timezone: this.timezone,
            total_chunks: this.total_chunks,
            total_entries: this.total_entries,
        };
    }

    /**
     * Returns stable JSON output for entries-manifest.json.
     * Defines the data shape used by the store.
     * @returns {string}
     */
    toJson() {
        return jsonStringifySorted(this.toObject());
    }
}
