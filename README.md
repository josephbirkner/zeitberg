# Timetracking Viewer (Static)

This is a static HTML5 viewer that stays “public” as code, but loads **private** time-entry data from GitHub via the API after you provide a token.

## How it works

- The site itself is static: `app/index.html`, `app/app.js`, `app/style.css`.
- After login, it fetches `data/entries/<year>.json` from your private repo via GitHub’s API (it uses the Git blob API to handle >1MB files).
- Your token is stored in the browser (localStorage if “Remember” is enabled; otherwise sessionStorage).

## Token recommendation

Prefer a **fine-grained PAT**:
- Repository access: only `josephbirkner/timetracking` (or whichever repo you use)
- Permissions: `Contents: Read-only`

Avoid classic PAT `repo` scope unless you really need it.

## Hosting

GitHub Pages for personal accounts is public, so the common approach is:

1. Create a **public** Pages repo (e.g. `josephbirkner.github.io` or `timetracking-viewer`)
2. Copy the contents of `app/` to the Pages root (or your configured Pages folder)
3. Enable GitHub Pages for that repo

The private data stays in the private `timetracking` repo; only authenticated GitHub API calls can read it.

