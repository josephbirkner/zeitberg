# Diary and TODO Editor (Static)

This is a static HTML5 application that stays “public” as code, but loads **private** time-entry and TODO data from GitHub via the API after you provide a token.

## How it works

- The site itself is static: `docs/index.html`, `docs/app.js`, `docs/style.css`.
- After login, it fetches `data/index/entries-manifest.json` in your private repo via GitHub’s API.
- The manifest lists weekly chunks in `data/entries/<iso-year>/<week>.json` and their Git blob SHAs. Cache misses are fetched in size-bounded GitHub GraphQL batches, while missing or truncated GraphQL blobs fall back to the individual Git blob API.
- Raw week documents are cached by immutable blob SHA in IndexedDB; startup checks and updates that cache through batched transactions.
- Your token is stored in the browser (localStorage if “Remember” is enabled; otherwise sessionStorage).
- Edits are saved back into the repo as commits (GitHub mode) or written to disk via `server.py` (local mode).
- Unsaved week and TODO edits are journaled in IndexedDB after every editor command, restored on reload, and removed only after a successful manual save. The journal is reload protection, not a repository save.
- TODOs and time entries share the schema-v2 project/section taxonomy in `data/projects.json`. Assignments use stable `project_key`/`section_key` values, so names can change without rewriting diary or TODO history.
- Startup and explicit reloads use a dedicated progress screen; the application toolbar appears only after initialization succeeds.

## Views

- **Week**: graphical timeline with keyboard navigation (`←/→` day, `↑/↓` entry), daily billable totals, and pointer/touch editing. The responsive day window fits as many readable columns as the viewport allows; previous/next slides that window before crossing a week boundary. Zoom is available from the slider, `Ctrl+[ / ]`, `Ctrl+- / +`, `Ctrl+wheel`, or a two-finger pinch over the timeline.
- **TODOs**: keyboard-first task list (`↑/↓` select, `Enter` edit, `A` add, `Space` complete, `D` delete, `Ctrl+Z/Y` undo/redo, `Ctrl+S` save). The top bar mirrors the week editor with `Changed`, `Saving…`, and `Saved` states.
- **Search**: the query/table UI for filtering and browsing entries. Switch views from the top-left menu or with `Ctrl+K`, `Ctrl+T`, and `Ctrl+W`.
- The current week's balance deducts only the requirement due through today, distributed evenly across Monday–Friday; past weeks use their complete requirement.

## Recurring TODOs

`data/todos.json` schema version 3 stores stable project/section keys plus three independent pieces of recurrence state:

- `due` is the current occurrence's date and optional local time.
- `recurrence` is a structured daily, weekly, monthly, or yearly rule with an interval and either a scheduled (`every`) or completion-relative (`every!`) basis.
- `completion_history` records when each occurrence was completed and which due occurrence it represented.

The recurrence field in the editor accepts forms such as `every day`, `every Friday`, `every 2 weeks`, `every month`, and `every! 3 days`. Completing a scheduled recurring TODO advances it to the first occurrence after the completion time, skipping stale overdue occurrences. Completing an `every!` TODO calculates one interval from the completion date. Monthly and yearly rules retain their preferred calendar day across short months and leap years.

## Todoist migration

The one-way importer reads the API token from `~/.todoist`, imports all active tasks plus completed history since 2007, and retains sections, labels, priorities, due dates, and shared active or archived projects. Todoist IDs bind to canonical projects/sections through `external_refs`, so a remote name such as the former `💼Work` continues to resolve to `KE` after consolidation. Supported Todoist recurrence text is normalized into the schema above:

```bash
npm run import:todoist
```

The command refuses to replace an earlier Todoist import unless `--replace-todoist` is explicitly supplied. Refresh an existing import with:

```bash
npm run import:todoist -- --replace-todoist
```

Use `--active-only` to skip completed history, or `--completed-since YYYY-MM-DD` to choose a later archive boundary. The importer preserves local-only TODOs and locally recorded recurrence history, and it never copies the API token into the repository.

The historical flat-project migration remains available as a guarded integrity utility. On this migrated repository it performs read-only count, reference, and manifest-hash checks:

```bash
node scripts/migrate-project-taxonomy.mjs --check
```

TODO edits are saved manually. Each mutation updates the in-memory model and its IndexedDB recovery draft immediately; only `Ctrl+S` or **Save changes** writes `data/todos.json` through the GitHub/local save pipeline.

## Local testing

Local mode requires `server.py` (serves the repo root and exposes `POST /save`):

```bash
python3 server.py --port 8000
```

Then open:
- `http://127.0.0.1:8000/docs/?source=local`

## Token recommendation

Prefer a **fine-grained PAT**:
- Repository access: only `josephbirkner/timetracking` (or whichever repo you use)
- Permissions: `Contents: Read-only` for browsing; `Contents: Read & write` to save edits/commits

Avoid classic PAT `repo` scope unless you really need it.

## Hosting

GitHub Pages for personal accounts is public, so the common approach is:

1. Host the viewer as a **public** GitHub Pages site (e.g. this repo’s `docs/` folder, or a separate pages repo).
2. Keep the actual diary data in a **private** repo; the viewer reads it via authenticated GitHub API calls.

The private data stays in the private `timetracking` repo; only authenticated GitHub API calls can read it.
