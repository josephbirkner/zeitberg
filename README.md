# planplural

Planplural is a static, keyboard-first personal-operations application. Its public HTML/JavaScript client loads private workspace data from a separate Git repository, currently through the GitHub API with a user-supplied token.

## How it works

- The static application has no backend and stores no private workspace data in its public repository.
- After login, it first loads the private repository's versioned `planplural.json` bootstrap document.
- `planplural.json` declares a stable workspace ID, timezone, shared resources, enabled component types, and every repository-relative document path. The same model is used by GitHub and local data sources.
- The configured entry manifest lists weekly chunks and immutable Git blob SHAs. Cache misses are fetched in size-bounded GitHub GraphQL batches, while missing or truncated GraphQL blobs fall back to individual Git blob requests.
- Raw week documents are cached by immutable blob SHA in IndexedDB; startup checks and updates that cache through batched transactions.
- Your token is stored in the browser (localStorage if “Remember” is enabled; otherwise sessionStorage).
- Edits are saved into the workspace repository as commits (GitHub mode) or written through `server.py` into a separately selectable local workspace checkout.
- Unsaved week and TODO edits are journaled in IndexedDB after every editor command, restored on reload, and removed only after a successful manual save. The journal is reload protection, not a repository save.
- TODOs and time entries share the workspace's schema-v2 project/section taxonomy. Assignments use stable `project_key`/`section_key` values, so names can change without rewriting diary or TODO history.
- Startup and explicit reloads use a dedicated progress screen; the application toolbar appears only after initialization succeeds.

Application files live at the repository root; private workspace documents are loaded exclusively from a separate repository.

## Views

- **Week**: graphical timeline with keyboard navigation (`←/→` day, `↑/↓` entry), daily billable totals, and pointer/touch editing. The responsive day window fits as many readable columns as the viewport allows; previous/next slides that window before crossing a week boundary. Zoom is available from the slider, `Ctrl+[ / ]`, `Ctrl+- / +`, `Ctrl+wheel`, or a two-finger pinch over the timeline.
- **TODOs**: keyboard-first task list (`↑/↓` select, `Enter` edit, `A` add, `Space` complete, `D` delete, `Ctrl+Z/Y` undo/redo, `Ctrl+S` save). The top bar mirrors the week editor with `Changed`, `Saving…`, and `Saved` states.
- **Search**: the query/table UI for filtering and browsing entries. Switch views from the top-left menu or with `Ctrl+K`, `Ctrl+T`, and `Ctrl+W`.
- The current week's balance deducts only the requirement due through today, distributed evenly across Monday–Friday; past weeks use their complete requirement.

## Recurring TODOs

The TODO document's schema version 3 stores stable project/section keys plus three independent pieces of recurrence state:

- `due` is the current occurrence's date and optional local time.
- `recurrence` is a structured daily, weekly, monthly, or yearly rule with an interval and either a scheduled (`every`) or completion-relative (`every!`) basis.
- `completion_history` records when each occurrence was completed and which due occurrence it represented.

The recurrence field in the editor accepts forms such as `every day`, `every Friday`, `every 2 weeks`, `every month`, and `every! 3 days`. Completing a scheduled recurring TODO advances it to the first occurrence after the completion time, skipping stale overdue occurrences. Completing an `every!` TODO calculates one interval from the completion date. Monthly and yearly rules retain their preferred calendar day across short months and leap years.

## Todoist import

The one-way importer reads the API token from `~/.todoist`, imports all active tasks plus completed history since 2007, and retains sections, labels, priorities, due dates, and shared active or archived projects. Todoist IDs bind to canonical projects/sections through `external_refs`, so a remote name such as the former `💼Work` continues to resolve to `KE` after consolidation. Supported Todoist recurrence text is normalized into the schema above:

```bash
npm run import:todoist
```

The command refuses to replace an earlier Todoist import unless `--replace-todoist` is explicitly supplied. Refresh an existing import with:

```bash
npm run import:todoist -- --replace-todoist
```

Use `--active-only` to skip completed history, or `--completed-since YYYY-MM-DD` to choose a later archive boundary. After the repository split, pass `--workspace ../planplural-data` or keep both repositories as siblings for automatic discovery. The importer preserves local-only TODOs and locally recorded recurrence history, and it never copies the API token into the repository.

The generic workspace validator checks configured paths, canonical data inventory, schemas, references, week metadata, manifest sizes, and Git blob hashes without modifying files:

```bash
npm run check:data -- --workspace ../planplural-data
```

TODO edits are saved manually. Each mutation updates the in-memory model and its IndexedDB recovery draft immediately; only `Ctrl+S` or **Save changes** writes the configured TODO document through the hosted/local save pipeline.

## Local testing

Local mode serves public application files from the code checkout and maps `/workspace-config`, `/workspace/*`, and `POST /save` to the selected private checkout:

```bash
python3 server.py --port 8000 --workspace ../planplural-data
```

With a sibling `planplural-data` checkout, `--workspace` may be omitted. Open `http://127.0.0.1:8000/?source=local`.

## Repository split

The split preparation command requires [`git-filter-repo`](https://github.com/newren/git-filter-repo) on `PATH`. It creates fresh, local-only filtered clones, relocates application history to the code-repository root, excludes all non-canonical private import artifacts, audits retained paths and common credential formats, and runs the application and workspace checks:

```bash
npm run split:prepare -- --output /path/to/empty/split-parent
```

It refuses an uncommitted source checkout or existing destination directories. It does not create GitHub repositories, configure remotes, or push anything.

## Token recommendation

Prefer a **fine-grained PAT**:
- Repository access: only the private workspace repository, such as `josephbirkner/planplural-data`
- Permissions: `Contents: Read-only` for browsing; `Contents: Read & write` to save edits/commits

Avoid classic PAT `repo` scope unless you really need it.

## Hosting

The intended deployment is:

1. Host the top-level static client from the public `planplural` repository at `planplural.io`.
2. Keep each workspace in a private repository; the client reads it through authenticated provider API calls.

Only code and published schemas belong to the public deployment. `planplural.json`, entries, TODOs, projects, requirements, and manifests remain private workspace data.
