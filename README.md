# Timetracking Viewer / Editor (Static)

This is a static HTML5 viewer that stays “public” as code, but loads **private** time-entry data from GitHub via the API after you provide a token.

## How it works

- The site itself is static: `docs/index.html`, `docs/app.js`, `docs/style.css`.
- After login, it fetches `data/index/entries-manifest.json` in your private repo via GitHub’s API.
- The manifest lists weekly chunks in `data/entries/<iso-year>/<week>.json` (and their Git blob SHAs), which are then loaded via the Git blob API.
- Your token is stored in the browser (localStorage if “Remember” is enabled; otherwise sessionStorage).
- Edits are saved back into the repo as commits (GitHub mode) or written to disk via `server.py` (local mode).
- Unsaved week edits are journaled in IndexedDB after every editor command, restored on reload, and removed only after a successful manual save.

## Views

- **Week**: graphical week timeline (Mon–Sun) with keyboard navigation (`←/→` day, `↑/↓` entry, `PageUp/PageDown` week) and a zoom slider.
- **Search**: the query/table UI for filtering and browsing entries.

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
