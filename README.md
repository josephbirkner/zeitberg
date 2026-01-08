# Timetracking Viewer (Static)

This is a static HTML5 viewer that stays “public” as code, but loads **private** time-entry data from GitHub via the API after you provide a token.

## How it works

- The site itself is static: `docs/index.html`, `docs/app.js`, `docs/style.css`.
- After login, it fetches `data/index/entries-manifest.json` in your private repo via GitHub’s API.
- The manifest lists weekly chunks in `data/entries/<iso-year>/<week>.json` (and their Git blob SHAs), which are then loaded via the Git blob API.
- Your token is stored in the browser (localStorage if “Remember” is enabled; otherwise sessionStorage).

## Local testing

You can test the viewer against local files (no GitHub token) by serving the **repo root** so `/data/` is reachable:

```bash
python3 -m http.server 8000
```

Then open:
- `http://127.0.0.1:8000/docs/?source=local`

## Token recommendation

Prefer a **fine-grained PAT**:
- Repository access: only `josephbirkner/timetracking` (or whichever repo you use)
- Permissions: `Contents: Read-only`

Avoid classic PAT `repo` scope unless you really need it.

## Hosting

GitHub Pages for personal accounts is public, so the common approach is:

1. Host the viewer as a **public** GitHub Pages site (e.g. this repo’s `docs/` folder, or a separate pages repo).
2. Keep the actual diary data in a **private** repo; the viewer reads it via authenticated GitHub API calls.

The private data stays in the private `timetracking` repo; only authenticated GitHub API calls can read it.
