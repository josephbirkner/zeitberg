# Changelog

## 1.4.0

### Provider onboarding and connections

- Connect GitHub, GitLab, and Codeberg accounts, discover existing workspaces, or create a private repository with the selected apps already configured.
- Scan repository pages automatically, select several workspaces to add, and recognize connections already present. Reuse valid account authorization and coordinate token refresh across connections.
- Use a restricted Scaleway relay for GitHub device authorization and refresh; GitLab and Codeberg use browser-based OAuth with PKCE. Workspace data still travels directly between the browser and Git provider.
- Show one startup progress screen with per-workspace status. Connection failures remain visible without blocking healthy workspaces.
- Manage independent connections through compact workspace cards with app icons, data summaries, status, and edit/share/open/reconnect/disconnect actions. Custom connection details and QR scanning have separate dialogs.

### Sharing

- Create short, browser-encrypted invitations with a 30-day lifetime and revocation. The service stores ciphertext; the decryption key stays in the URL fragment.
- Keep locator links and existing capability links compatible. Account-wide OAuth grants cannot be shared as invitations; use a dedicated repository token.
- Invitation revocation stops new imports, not access already imported. Revoke the underlying token at its provider to remove that access.

### Interface and documentation

- Save expense templates from the editor and reuse them through the Add expense split button. Templates belong to their workspace, use today's date when applied, and support normal saves, draft recovery, and undo/redo.
- Refine typography, spacing, toolbar sizing, editor actions, workspace cards, and the front page. Move secondary explanations into contextual help.
- Fix full-screen task and expense dialogs at non-default app zoom, and restore a compatible workspace when entering an app from the front page.
- Edit time-entry start and end times in the details dialog using the existing collision and week-boundary rules. Keep description focus and put Save before Cancel and Delete in keyboard order.
- Add English and German user guides with fictional playground screenshots, plus CI-generated documentation examples.
- Document the authentication and invitation services, deployment limits, and credential handling.

### Compatibility and deployment

- No workspace data migration is required. Existing personal-token connections remain supported.
- GitHub Pages continues to publish the static app from main through Actions. The two Scaleway services are deployed separately; neither stores workspace documents.

## 1.3.1

- Keep the workspace title picker visible and tappable on phones, including when another configured repository is still loading or needs reconnection.
- Normalize Safari's expense date field so Date and Category remain aligned without overlapping, while retaining the native date picker.
- Move workspace configuration into a separate Edit workspace dialog, accessible from each workspace row. Cancel leaves saved configuration unchanged; missing configurations open the editor directly.
- Give the playground button white text in light mode, shorten its label, and remove the two implementation/artwork disclosure paragraphs from the welcome page.
- Add mobile WebKit regression checks for expense-only workspace switching, reconnection, workspace editing, and expense-field geometry.

## 1.3.0

### Multiple workspaces

- Keep several workspaces open with independent data, editing history, and pending changes.
- Switch workspaces from the document title; browse combined tasks and search across workspaces by default, with optional workspace filtering.
- Save pending changes across workspaces without losing newer edits made during a save.
- Closing workspace settings no longer unexpectedly leaves the app. Closing a dirty workspace offers Save and close or Cancel.

### Work time and leave

- Configure employers, dated work schedules, billable project assignments, and annual vacation allowances.
- Record full or half days of vacation, sickness, time off in lieu, and public holidays; apply annotations to several days at once.
- Track overtime per employer and carry vacation balances across years. See this year's taken, planned, and unplanned vacation, with an expandable date overview.
- See work/leave annotations in weekday headers and jump to a week by date.

### Saving and everyday usability

- Autosave runs 60 seconds after the latest applied edit. Every edit, undo, or redo restarts the countdown; manual saving remains available.
- A more prominent Save Changes control shows the countdown and softly pulses while changes are pending, respecting reduced-motion preferences.
- When a selected task project has no current or overdue matches, show its matching future and undated tasks automatically.
- Dialogs now have centered touch-friendly close buttons, consistent actions, and improved scrolling on narrow screens.
- Expense payer/split controls adapt to phone widths. Optional task fields are expandable, and validation errors remain visible inside the editor.

### Playground and build identity

- Explore all three modules without a repository in a disposable playground. Reloading generates a varied fictional scenario with four weeks of time entries, leave, tasks, and shared expenses.
- Playground edits and settings remain in memory, without touching real credentials, IndexedDB, or workspace files. An optional seed supports reproducible documentation screenshots.
- The front page identifies the served version and commit. The new static build embeds revision-specific cache keys and publishes through a GitHub Pages Actions workflow.

### Compatibility and rollout

- Existing weekly work-requirement documents remain readable. Conversion to daily employer/leave records is a deliberate data migration, not an automatic rewrite on loading.
- New workspaces start without assumed employer or vacation entitlements; configure these before interpreting leave balances.
- When deploying 1.3, change GitHub Pages publishing from the branch source to **GitHub Actions** so the versioned build artifact is served.
- GitHub App/device-flow onboarding is deferred to 1.4. Existing token and capability-link connections remain supported.

Earlier release notes are available in the [GitHub releases](https://github.com/josephbirkner/zeitberg/releases).
