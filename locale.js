/**
 * @typedef {"en" | "de"} SupportedLocale
 * @typedef {Record<string, string>} LocaleDictionary
 */

/** @type {Readonly<LocaleDictionary>} */
export const EN_MESSAGES = Object.freeze({
    "meta.description": "A static browser application for time, tasks, and expenses. Your data lives in a Git repository you control.",
    "document.title": "zeitberg — time, tasks, expenses → Git",

    "nav.application": "Application navigation",
    "nav.home": "zeitberg home",
    "nav.views": "Views",
    "nav.workspaces": "Workspaces",
    "nav.manageWorkspaces": "Manage workspaces",
    "nav.weekTitle": "Week (Ctrl+W)",
    "nav.week": "Week view",
    "nav.todosTitle": "Tasks (Ctrl+T)",
    "nav.todos": "Task view",
    "nav.expensesTitle": "Expenses (Ctrl+E)",
    "nav.expenses": "Expense view",
    "nav.searchTitle": "Search (Ctrl+K)",
    "nav.search": "Time-entry search",
    "nav.applicationZoom": "Application zoom",
    "nav.zoomOut": "Zoom app out",
    "nav.zoomReset": "Reset app zoom",
    "nav.zoomAutomatic": "Automatic app zoom ({percent}%)",
    "nav.zoomRestoreAutomatic": "Restore automatic app zoom (currently {percent}%)",
    "nav.zoomIn": "Zoom app in",
    "nav.useLightTheme": "Use light theme",
    "nav.useDarkTheme": "Use dark theme",
    "nav.light": "Light",
    "nav.dark": "Dark",
    "nav.projects": "Projects",
    "nav.manageProjects": "Manage projects",
    "nav.reload": "Reload data",
    "nav.logout": "Logout",

    "provider.selfHosted": "Self-hosted Git",
    "provider.local": "Local server",
    "provider.generic": "Git provider",

    "topbar.searchTimeTitle": "Search time entries (Ctrl+K)",
    "topbar.searchTime": "Search time entries",
    "topbar.searchTimePlaceholder": "Search time entries…",
    "topbar.searchTodosTitle": "Search tasks (Ctrl+K)",
    "topbar.searchTodos": "Search tasks",
    "topbar.searchTodosPlaceholder": "Search tasks…",
    "topbar.searchExpensesTitle": "Search expenses (Ctrl+K)",
    "topbar.searchExpenses": "Search expenses",
    "topbar.searchExpensesPlaceholder": "Search expenses…",
    "topbar.addTodoTitle": "Add task (A)",
    "topbar.addTodo": "Add task",
    "topbar.todoFilters": "Task view filters",
    "topbar.currentOnly": "Show current and overdue only",
    "topbar.openOnly": "Show open only",
    "topbar.previousTitle": "Previous days / week (PageUp)",
    "topbar.previous": "Previous days or week",
    "topbar.nextTitle": "Next days / week (PageDown)",
    "topbar.next": "Next days or week",
    "topbar.latest": "Latest",
    "topbar.requiredHours": "Edit required hours",
    "topbar.weekEditorActions": "Week editor actions",
    "topbar.normalModeTitle": "Normal mode (Escape)",
    "topbar.normalMode": "Normal mode",
    "topbar.addModeTitle": "Add mode (A)",
    "topbar.addMode": "Add mode",
    "topbar.splitModeTitle": "Split mode (S)",
    "topbar.splitMode": "Split selected entry",
    "topbar.history": "Undo and redo",
    "topbar.undoTitle": "Undo (Ctrl+Z)",
    "topbar.undo": "Undo",
    "topbar.redoTitle": "Redo (Ctrl+Y)",
    "topbar.redo": "Redo",
    "topbar.timelineZoom": "Timeline zoom",
    "topbar.zoomOutTitle": "Zoom out (Ctrl+[ or Ctrl+-)",
    "topbar.zoomOut": "Zoom out",
    "topbar.zoomInTitle": "Zoom in (Ctrl+] or Ctrl++)",
    "topbar.zoomIn": "Zoom in",
    "topbar.zoom": "Zoom",
    "topbar.saveTitle": "Save changes (Ctrl+S)",
    "topbar.save": "Save changes",

    "landing.navigation": "Landing page",
    "landing.architectureLink": "Architecture",
    "landing.setupLink": "Setup",
    "landing.similarLink": "Similar projects",
    "landing.sourceLink": "Source ↗",
    "landing.eyebrow": "STATIC BROWSER APP · GIT WORKSPACE",
    "landing.time": "Time",
    "landing.tasks": "Tasks",
    "landing.expenses": "Expenses",
    "landing.toGit": "> Git",
    "landing.lede": "zeitberg is a static application. It reads and writes versioned workspace files directly in a Git repository you choose; zeitberg.io has no data backend.",
    "landing.properties": "Project properties",
    "landing.staticHtml": "Static HTML5",
    "landing.directApi": "Direct provider API",
    "landing.versionedJson": "Versioned JSON",
    "landing.openWorkspaceTag": "OPEN WORKSPACE",
    "landing.provider": "Provider",
    "landing.selfHostedForgejo": "Forgejo (self-hosted)",
    "landing.autoDetect": "Auto-detect self-hosted",
    "landing.workspaceRepository": "Workspace repository",
    "landing.branch": "Branch / ref",
    "landing.accessToken": "Provider access token",
    "landing.rememberToken": "Remember this token on this device",
    "landing.openWorkspace": "Open workspace",
    "landing.useOAuth": "Use OAuth",
    "landing.createWorkspace": "Create workspace",
    "landing.clearConnection": "Clear saved connection",
    "landing.security": "The token stays in browser storage and is sent only to the selected repository provider.",
    "landing.architectureAlt": "Static hosting loads zeitberg in your browser. The browser talks directly to a Git provider API, which reads and writes your private workspace repository.",
    "landing.architectureCaption": "Credentials remain in browser storage. Requests go directly to the selected Git provider.",
    "landing.workspaceEyebrow": "01 · WORKSPACE",
    "landing.workspaceTitle": "Create a private data repository.",
    "landing.githubAvailable": "GITHUB · AVAILABLE",
    "landing.connectDirectly": "Connect directly",
    "landing.readOnlyPrefix": "Read-only tokens can browse. Saving requires",
    "landing.contentsPermission": "Contents: Read & write",
    "landing.createPrivateRepository": "Create a private repository.",
    "landing.copyTemplate": "Copy the workspace-template files into it.",
    "landing.enterConnection": "Enter its URL, branch, and PAT above.",
    "landing.detailedSetup": "Detailed setup ↗",
    "landing.otherProvidersAvailable": "GITLAB · CODEBERG · AVAILABLE",
    "landing.connectOrCreate": "Connect or create",
    "landing.connectExisting": "Connect an existing private repository with a provider token.",
    "landing.createOther": "Create and initialize a private GitLab.com or Codeberg workspace above.",
    "landing.pkce": "PKCE OAuth activates when this deployment has public client IDs.",
    "landing.cors": "CORS-enabled self-hosted GitLab and Forgejo servers are detected explicitly.",
    "landing.similarEyebrow": "02 · SIMILAR PROJECTS",
    "landing.similarTitle": "Related work.",
    "landing.similarIntro": "No direct equivalent surfaced in this review. These projects overlap with zeitberg in scope or storage model.",
    "landing.gitJournal": "Markdown notes in a Git repository of your choice.",
    "landing.gitBackedNotes": "Git-backed notes",
    "landing.taskRepo": "Tasks stored as Markdown files in Git repositories.",
    "landing.gitBackedTasks": "Git-backed tasks",
    "landing.activityWatch": "Automated time tracking with user-controlled local data.",
    "landing.timeLocalFirst": "Time · local-first",
    "landing.actualBudget": "Local-first personal finance with optional synchronization.",
    "landing.financeLocalFirst": "Finance · local-first",
    "landing.footerTag": "static application · Git workspace",
    "landing.aiDisclosure": "The code for this project was written using large language models with extensive human supervision.",
    "landing.landscapeAlt": "A clock sun setting behind layered mountain peaks beside a coin moon.",
    "landing.markAttribution": "The zeitberg mark and landscape are original hand-authored SVGs. No image model was used.",

    "loading.title": "Loading workspace",
    "loading.retry": "Retry",
    "loading.backToLogin": "Back to login",
    "loading.discoverLocal": "Discovering local workspaces…",
    "loading.prepareLocal": "Preparing local data…",
    "loading.prepareRepository": "Preparing repository data…",
    "loading.workspaceLocal": "Loading workspace (local)…",
    "loading.workspace": "Loading workspace…",
    "loading.manifestLocal": "Loading manifest (local)…",
    "loading.manifest": "Loading manifest…",
    "loading.projectsLocal": "Loading projects (local)…",
    "loading.projects": "Loading projects…",
    "loading.requirementsLocal": "Loading week requirements (local)…",
    "loading.requirements": "Loading week requirements…",
    "loading.todosLocal": "Loading tasks (local)…",
    "loading.todos": "Loading tasks…",
    "loading.expensesLocal": "Loading expenses (local)…",
    "loading.expenses": "Loading expenses…",
    "loading.progress": "Loading {loaded}/{total}…",
    "loading.checkCache": "Checking {count} cached week files…",
    "loading.download": "Downloading {count} week files in bulk…",
    "loading.prepare": "Preparing {loaded}/{total} • {week}",
    "loading.complete": "Loaded {loaded}/{total} week files • memory {memory} • cached {cached} • downloaded {downloaded}",
    "loading.connectProvider": "Connecting to {provider}…",
    "loading.completeAuthorization": "Completing provider authorization…",

    "search.filters": "Filters",
    "search.project": "Project",
    "search.from": "From ({timezone})",
    "search.to": "To ({timezone})",
    "search.maxRows": "Max rows",
    "search.sort": "Sort",
    "search.newest": "Newest first",
    "search.oldest": "Oldest first",
    "search.entries": "Entries",
    "search.date": "Date",
    "search.start": "Start",
    "search.end": "End",
    "search.duration": "Duration",
    "search.description": "Description",
    "search.billable": "Billable",
    "search.allProjects": "All projects",
    "search.allProject": "All {project}",
    "search.noProject": "No project",
    "search.archived": "archived",
    "search.stats": "{matches} matches • {duration} total • showing {shown}",
    "search.openWeek": "Open this entry in Week view",
    "common.yes": "Yes",
    "common.no": "No",
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.continue": "Continue",
    "common.ok": "OK",
    "common.save": "Save",
    "common.delete": "Delete",

    "workspace.title": "Workspaces",
    "workspace.meta": "Connections are stored in this browser. Credentials remain separate from workspace metadata.",
    "workspace.language": "Interface language",
    "workspace.languageEnglish": "English",
    "workspace.languageGerman": "Deutsch",
    "workspace.add": "Add workspace",
    "workspace.addMeta": "Connect another repository without disconnecting the current one.",
    "workspace.repositoryUrl": "Repository URL",
    "workspace.configPath": "Workspace config path",
    "workspace.shareActive": "Share active workspace",
    "workspace.createPrivate": "Create private workspace",
    "workspace.connect": "Connect",
    "workspace.createTitle": "Create private workspace",
    "workspace.createMeta": "Create and initialize a repository without a zeitberg backend.",
    "workspace.repositoryName": "Repository name",
    "workspace.workspaceName": "Workspace name",
    "workspace.timezone": "Timezone",
    "workspace.rememberResult": "Remember the resulting workspace credential on this device",
    "workspace.authorizeOAuth": "Authorize with OAuth",
    "workspace.createWithToken": "Create with token",
    "workspace.shareTitle": "Share workspace",
    "workspace.locatorTitle": "Locator link",
    "workspace.locatorHelp": "Contains the repository, branch, workspace identity, sub-app, and current view. The recipient authenticates independently.",
    "workspace.copyLocator": "Copy locator link",
    "workspace.capabilityTitle": "Capability link",
    "workspace.capabilityWarning": "Anyone holding this link receives the token's repository access. Treat it as a bearer credential.",
    "workspace.capabilityHelp": "Use a dedicated, expiring, least-privilege token for exactly this repository. zeitberg cannot mint or restrict a token for you.",
    "workspace.shareableToken": "Dedicated shareable token",
    "workspace.copyCapability": "Copy capability link",
    "workspace.importTitle": "Open capability link?",
    "workspace.importWarning": "This link contains a bearer credential. Opening it grants this browser the token's access to the workspace shown above.",
    "workspace.importScrubbed": "The secret fragment has already been removed from the address bar. It has not been sent to a Git provider or saved.",
    "workspace.trustHost": "I trust this custom provider host and permit sending the credential to it.",
    "workspace.trustNamedHost": "I trust {host} and permit sending the credential to this custom provider host.",
    "workspace.rememberSession": "Remember this token on this device (session-only by default)",
    "workspace.none": "No saved workspace connections.",
    "workspace.active": "Active",
    "workspace.localServer": "Local server",
    "workspace.authenticated": "Authenticated",
    "workspace.tokenRequired": "Token required",
    "workspace.open": "Open",
    "workspace.switch": "Switch",
    "workspace.authenticate": "Authenticate",
    "workspace.earlier": "Earlier",
    "workspace.later": "Later",
    "workspace.disconnect": "Disconnect",
    "workspace.enterTokenFor": "Enter a token to authenticate {workspace}.",
    "workspace.localLocatorOnly": "Local workspaces can only produce locator links for this server.",
    "workspace.linkCopied": "Workspace link copied.",
    "workspace.copyPrompt": "Copy this workspace link:",
    "workspace.capabilityCopied": "Capability link copied. Share it as securely as the token itself.",
    "workspace.notImported": "Capability not imported. Enter your own credential to open this workspace.",
    "workspace.confirmHost": "Confirm the custom provider host before opening this capability.",
    "workspace.oauthAvailable": "OAuth is available for GitLab.com and Codeberg.",
    "workspace.oauthAuthorize": "Authorize with {provider} using PKCE",
    "workspace.oauthUnavailable": "{provider} OAuth needs a public client id in this deployment; use a scoped token for now.",
    "workspace.codebergScope": "Forgejo OAuth grants are not fine-grained today. Prefer a repository-scoped Codeberg token when least privilege is important.",
    "workspace.gitlabScope": "GitLab OAuth requests API access so zeitberg can create, initialize, read, and write the private project.",
    "workspace.createdInitializationFailed": "The private repository was created at {repository}, but initialization failed: {error}",
    "workspace.couldNotOpen": "Could not open {workspace}: {error}",
    "workspace.tokenOrOAuth": "Enter a provider token or use OAuth.",
    "workspace.localUnavailable": "That workspace is not exposed by the local server.",
    "workspace.authenticateLink": "Authenticate to open the workspace named in this link.",
    "workspace.completeConnection": "Enter the repository URL, branch, and token.",

    "entry.dialogTitle": "Edit entry",
    "entry.description": "Description",
    "entry.assignment": "Project / section",
    "entry.noProject": "No project",
    "entry.dragStart": "Drag entry start",
    "entry.dragStartShort": "Drag start",
    "entry.dragEnd": "Drag entry end",
    "entry.dragEndShort": "Drag end",
    "entry.edit": "Edit entry",
    "entry.delete": "Delete entry",
    "entry.split": "Split entry",
    "entry.addHere": "Add {interval} entry on {date}",
    "entry.meta": "{date} {start}–{end} • {duration} • id {id}",
    "entry.archived": "archived",
    "entry.belongsToWeek": "This entry belongs to {week}; open that week to edit.",

    "todo.timeline": "Tasks",
    "todo.filterByProject": "Filter tasks by project",
    "todo.all": "All",
    "todo.empty": "No tasks match this view.",
    "todo.stats": "{shown} shown • {open} open • {completed} completed",
    "todo.addTo": "Add task to {assignment}",
    "todo.reopen": "Reopen {task}",
    "todo.complete": "Complete {task}",
    "todo.doneCount": "{count} done",
    "todo.occurrencesCompleted.one": "{count} recurring occurrence completed",
    "todo.occurrencesCompleted.other": "{count} recurring occurrences completed",
    "todo.openIssue": "Open GitHub issue #{number}",
    "todo.openLinkedIssue": "Open linked GitHub issue #{number}",
    "todo.addTitle": "Add task",
    "todo.editTitle": "Edit task",
    "todo.newTask": "New task",
    "todo.open": "Open",
    "todo.completed": "Completed",
    "todo.subtask": "subtask",
    "todo.importedFrom": "imported from {provider}",
    "todo.githubIssue": "GitHub issue #{number}",
    "todo.title": "Title",
    "todo.dueDate": "Due date",
    "todo.dueTime": "Due time",
    "todo.recurrence": "Recurrence",
    "todo.recurrencePlaceholder": "e.g. every Friday or every! 2 weeks",
    "todo.priority": "Priority",
    "todo.priorityNormal": "Normal",
    "todo.priorityMedium": "Medium",
    "todo.priorityHigh": "High",
    "todo.priorityUrgent": "Urgent",
    "todo.labels": "Labels (comma-separated)",
    "todo.conflictsTitle": "Resolve task conflicts",
    "todo.conflictsMeta": "Both this browser and GitHub changed these tasks. Choose one version for each task before saving.",
    "todo.conflictComparison": "Browser: {local} • GitHub: {remote}",
    "todo.deletedVersion": "deleted",
    "todo.keepLocal": "Keep browser version",
    "todo.useGitHub": "Use GitHub version",

    "expenses.timeline": "Expenses and settlements",
    "expenses.filterCategories": "Filter expenses by category",
    "expenses.all": "All",
    "expenses.empty": "No expenses match this view.",
    "expenses.stats": "{shown} shown • {expenses} expenses • {settlements} settlements",
    "expenses.addTitle": "Add expense (A)",
    "expenses.add": "Add expense",
    "expenses.newExpense": "New shared expense",
    "expenses.edit": "Edit expense",
    "expenses.editTitle": "Edit expense",
    "expenses.editSplit": "Edit split",
    "expenses.settleTitle": "Settle balances (S)",
    "expenses.settle": "Settle balances",
    "expenses.settlement": "Settlement",
    "expenses.settleMeta": "Suggested payments are calculated independently per currency.",
    "expenses.inventoryTitle": "Participants and categories",
    "expenses.inventory": "Participants and categories",
    "expenses.inventoryMeta": "Stable keys remain unchanged when names are edited.",
    "expenses.participants": "Participants",
    "expenses.categories": "Categories",
    "expenses.addParticipant": "Add participant",
    "expenses.addCategory": "Add category",
    "expenses.participantName": "Participant name",
    "expenses.categoryName": "Category name",
    "expenses.description": "Description",
    "expenses.date": "Date",
    "expenses.amount": "Amount",
    "expenses.currency": "Currency",
    "expenses.category": "Category",
    "expenses.noCategory": "No category",
    "expenses.notes": "Notes",
    "expenses.splitRule": "Split rule",
    "expenses.splitEqual": "Equal",
    "expenses.splitPercentage": "Percentage",
    "expenses.splitShares": "Shares",
    "expenses.splitExact": "Exact amounts",
    "expenses.participant": "Participant",
    "expenses.paid": "Paid",
    "expenses.owed": "Owed",
    "expenses.included": "Included (1)",
    "expenses.percentage": "Percentage",
    "expenses.shares": "Shares",
    "expenses.paidBy": "Paid by {participant}",
    "expenses.owedBy": "Owed by {participant}",
    "expenses.importedFrom": "Imported from {provider}",
    "expenses.localExpense": "Workspace expense",
    "expenses.balanced": "All balances settled",
    "expenses.balancedLong": "There are no outstanding balances.",
    "expenses.paymentSuggestion": "{from} pays {to} {amount}",
    "expenses.recordPayment": "Record payment",

    "projects.title": "Projects",
    "projects.meta": "Manage shared projects, sections, defaults, and archive state.",
    "projects.add": "Add project",
    "projects.name": "Name",
    "projects.color": "Color",
    "projects.colorOverride": "Color override",
    "projects.billable": "Billable",
    "projects.archived": "Archived",
    "projects.sections": "Sections",
    "projects.addSection": "Add section",
    "projects.inherit": "Inherit",
    "projects.notBillable": "Not billable",
    "projects.everyProjectName": "Every project needs a name.",
    "projects.duplicateProject": "Duplicate project name: {name}",
    "projects.invalidColor": "Invalid color for {name}.",
    "projects.everySectionName": "Every section in {project} needs a name.",
    "projects.duplicateSection": "Duplicate section in {project}: {section}",
    "projects.invalidSectionColor": "Invalid color for {project} / {section}.",
    "projects.githubRepository": "GitHub issue repository",
    "projects.githubCheck": "Check",
    "projects.githubLabel": "GitHub section label",
    "projects.githubLabelPlaceholder": "type/feature",
    "projects.githubInvalidRepository": "Use owner/repository.",
    "projects.githubInvalidForProject": "Invalid GitHub repository for {project}; use owner/repository.",
    "projects.githubUnavailable": "Repository checks require a GitHub workspace connection and PAT.",
    "projects.githubIssuesDisabled": "Repository is readable, but GitHub Issues are disabled.",
    "projects.githubIssuesDisabledFor": "GitHub Issues are disabled for {repository}.",
    "projects.githubPrivate": "Private",
    "projects.githubPublic": "Public",
    "projects.githubVerified": "{visibility} • read verified • issue write checked on first task save",
    "projects.githubCheckFailed": "Repository check failed: {error}",
    "projects.githubInvalidLabel": "Invalid GitHub label for {project} / {section}; labels must be one line and at most 50 characters.",
    "projects.githubDuplicateLabel": "GitHub label {label} is assigned to more than one section in {project}.",
    "projects.bindingPreviewTitle": "GitHub project migration",
    "projects.bindingPreviewMeta": "Review local task handling. Upstream issues are never deleted; new issues are created only by a later manual task save.",
    "projects.bindingConnectTitle": "Connect {project} to {repository}",
    "projects.bindingDetachTitle": "Detach {project} from {repository}",
    "projects.bindingConnectSummary": "{local} eligible local • {linked} already linked • {pending} pending",
    "projects.bindingDetachSummary": "{linked} linked issue tasks • {pending} unpublished local tasks",
    "projects.bindingLeaveLocal": "Leave existing local tasks local (recommended)",
    "projects.bindingPublish": "Publish eligible local tasks on next task save",
    "projects.bindingRetain": "Retain issue tasks as local copies (recommended)",
    "projects.bindingRemove": "Remove issue tasks from this workspace view",
    "projects.saveTodosFirst": "Save or discard the current task changes before changing a GitHub project binding.",
    "projects.saved": "Projects saved.",

    "requirements.title": "Week requirements",
    "requirements.requiredHours": "Required hours",
    "requirements.comment": "Comment (optional)",
    "requirements.commentPlaceholder": "Vacation, sick, holiday…",
    "requirements.billableCurrent": "Billable through current day",
    "requirements.requiredCurrent": "Required through current day",
    "requirements.weekDelta": "Week delta through current day",
    "requirements.accumulated": "Accumulated since {date}",
    "requirements.commentSummary": "Comment",
    "requirements.due": "Due {due}/{configured} h",
    "requirements.full": "Required {configured} h",

    "week.number": "W{week}",
    "week.trackedTitle": "{duration} tracked in week {week}",
    "week.trackedAria": "Week {week}, {duration} tracked",
    "week.billableTitle": "{duration} billable",
    "week.entryTitle": "{date} {start}–{end} • {project}{description}",
    "week.summaryAria": "{summary}. Edit required hours.",
    "week.summaryTitle": "{summary} • Edit required hours",
    "week.summaryBillable": "Billable {duration}",
    "week.summaryRequired": "Required {duration}",
    "week.summaryDelta": "Delta {duration}",
    "week.summaryAccumulated": "Accumulated {duration}",
    "week.saved": "Saved",
    "week.changed": "Changed",
    "week.saving": "Saving…",
    "week.noUnsaved": "No unsaved week changes",
    "week.saveChanged": "Save changed weeks",
    "week.changesSaved": "Week changes saved",

    "recurrence.daily.one": "every day",
    "recurrence.daily.other": "every {count} days",
    "recurrence.weekly.one": "every week",
    "recurrence.weekly.other": "every {count} weeks",
    "recurrence.monthly.one": "every month",
    "recurrence.monthly.other": "every {count} months",
    "recurrence.yearly.one": "every year",
    "recurrence.yearly.other": "every {count} years",
    "recurrence.weekday": "every {weekday}",
    "recurrence.afterCompletion": "{rule} after completion",
    "recurrence.custom": "custom recurrence",

    "status.localMode": "Local mode",
    "status.savedConnection": "Saved connection available",
    "status.notLoggedIn": "Not logged in",
    "status.cleared": "Cleared",
    "status.connecting": "Connecting…",
    "status.loggedInAs": "Logged in as {user}",
    "status.connectedTo": "Connected to {repository}",
    "status.saved": "Saved",
    "status.changed": "Changed",
    "status.saving": "Saving…",
    "status.todoNoUnsaved": "No unsaved task changes",
    "status.todoSaveChanged": "Save changed tasks",
    "status.todoChangesSaved": "Task changes saved",
    "status.expenseNoUnsaved": "No unsaved expense changes",
    "status.expenseSaveChanged": "Save changed expenses",
    "status.expenseChangesSaved": "Expense changes saved",

    "data.weekFiles": "{count} week files",
    "data.entries": "{count} entries",
    "data.todos": "{count} tasks",
    "data.expenses": "{count} expenses",
    "data.manifestAt": "manifest {date}",
    "data.local": "Local data",

    "toast.tapSplit": "Tap the desired split point inside the entry.",
    "toast.saving": "Saving in progress…",
    "toast.outsideWeek": "Cannot create entry outside the current week.",
    "toast.shortEntry": "Entry shorter than 15 minutes.",
    "toast.selectEntry": "Select an entry first.",
    "toast.splitThisWeek": "Split works only for entries in this week.",
    "toast.tooShortSplit": "Entry too short to split (minimum 30 minutes).",
    "toast.splitOutsideWeek": "Cannot split outside the current week.",
    "toast.nothingToSave": "Nothing to save.",
    "toast.saved": "Saved.",
    "toast.noWeek": "No week selected.",
    "toast.requirementRange": "Required hours must be between 0 and 168.",
    "toast.requirementsSaved": "Week requirements saved.",
    "toast.invalidAssignment": "Please select a project or section from the list, or clear the field for No project.",
    "toast.missingAssignment": "The selected project or section no longer exists.",
    "toast.invalidSplit": "Invalid split position.",
    "toast.todoTitle": "A task needs a title.",
    "toast.todoSaved": "Tasks saved.",
    "toast.expensesSaved": "Expenses saved.",
    "toast.expenseNeedsParticipant": "Add at least one participant before creating an expense.",
    "toast.expenseDescription": "An expense needs a description.",
    "toast.expensePayersTotal": "Paid amounts must equal the expense total.",
    "toast.expensePercentageTotal": "Percentage splits must add up to 100%.",
    "toast.expenseNeedsAllocation": "Select at least one participant for the split.",
    "toast.expenseAllocationsTotal": "Owed amounts must equal the expense total.",
    "toast.expenseMissing": "Expense or settlement not found.",
    "toast.expenseParticipantName": "Every participant needs a name.",
    "toast.expenseCategoryName": "Every category needs a name.",
    "toast.expenseDraftUnavailable": "Browser draft storage is unavailable; unsaved expense changes may not survive a reload.",
    "toast.expenseDraftCleanup": "The saved expense draft could not be removed from browser storage.",
    "toast.expenseDraftConflict": "The expense draft could not be merged safely: {error}",
    "toast.expenseRestored": "Unsaved expense changes restored.",
    "toast.expenseRestoredMerged": "Expense changes restored and merged with newer repository data.",
    "toast.todoRestored": "Restored unsaved task edits.",
    "toast.todoRestoredMerged": "Restored task edits and merged newer data.",
    "toast.todoRestoredConflicts": "Restored task edits with {count} conflict(s) requiring a choice.",
    "toast.todoResolveConflicts": "Resolve all task conflicts before saving.",
    "toast.githubIssuesCached": "GitHub is unavailable; showing the cached issue collection for {repository}.",
    "toast.githubIssueConflict": "GitHub issue #{number} changed after local editing began. Reload to compare before saving.",
    "toast.recurrenceDue": "A recurring task needs a due date.",
    "toast.unsupportedRecurrence": "Unsupported recurrence. Try “every day”, “every Friday”, “every 2 weeks”, or “every! month”.",
    "toast.waitSaveSwitch": "Wait for the active save to finish before switching workspaces.",
    "toast.waitSaveDisconnect": "Wait for the active save to finish before disconnecting a workspace.",
    "toast.enterToken": "Enter a token for this workspace.",
    "toast.restoredWeeks.one": "Restored unsaved edits for {count} week{merged}.",
    "toast.restoredWeeks.other": "Restored unsaved edits for {count} weeks{merged}.",
    "toast.mergedNewer": "; merged newer data in {count}",
    "toast.requirementsNotLoaded": "Week requirements not loaded: {error}",
    "toast.todoDraftUnavailable": "Browser draft storage is unavailable; unsaved task edits may not survive a reload.",
    "toast.todoDraftCleanup": "The saved task browser draft could not be cleaned up.",
    "toast.weekDraftUnavailable": "Browser draft storage is unavailable; unsaved time edits may not survive a reload.",
    "toast.weekDraftCleanup": "The saved time-entry browser draft could not be cleaned up.",
    "toast.invalidEditPayload": "Invalid edit payload.",

    "error.notLoggedIn": "Not logged in.",
    "error.nothingToSave": "Nothing to save.",
    "error.invalidRepository": "Enter a valid HTTPS repository URL.",
    "error.httpsRepository": "Repository URLs must use HTTPS.",
    "error.fullHttpsRepository": "Enter a full HTTPS repository URL.",
    "error.githubRepository": "Enter a valid GitHub repository URL.",
    "error.githubHttps": "The current connector accepts HTTPS github.com repository URLs.",
    "error.repositoryNoQuery": "The repository URL must not contain a query or fragment.",
    "error.repositoryExample": "Use a repository URL such as https://github.com/you/zeitberg-data.",
    "error.githubName": "The GitHub owner or repository name is invalid.",
    "error.workspacePathRelative": "The workspace bootstrap path must be repository-relative.",
    "error.workspacePathUnsafe": "The workspace bootstrap path contains an unsafe segment.",
    "error.workspaceIdentifier": "The expected workspace identifier is invalid.",
    "error.workspaceRepository": "The workspace repository URL is invalid.",
    "error.workspaceRepositorySafe": "Workspace repository URLs must use HTTPS and contain no credentials, query, or fragment.",
    "error.workspaceRef": "The workspace ref must not be empty.",
    "error.workspaceLocator": "A valid workspace locator is required.",
    "error.capabilityMalformed": "The capability payload is malformed.",
    "error.capabilityHosted": "Capability links require one hosted workspace route.",
    "error.shareableCredential": "Enter a valid shareable repository credential.",
    "error.capabilityMissing": "No capability payload was found.",
    "error.capabilityInvalid": "The capability payload is invalid.",
    "error.capabilityVersion": "The capability payload version is unsupported.",
    "error.capabilityCredential": "The capability credential is invalid.",
    "error.capabilityMismatch": "The capability route does not match its public workspace locator.",
    "error.capabilityAltered": "This capability link is invalid or has been altered. Its credential fragment was removed.",
    "error.hostedProvider": "Select a supported hosted Git provider.",
    "error.oauthIncomplete": "The OAuth credential is incomplete.",
    "error.oauthRefresh": "The OAuth credential could not be refreshed.",
    "error.authorizationIncomplete": "The provider authorization callback is incomplete.",
    "error.localNoWorkspaces": "The local server exposes no workspaces.",
    "error.localNoSelection": "The local server did not provide a selectable workspace.",
    "error.recurringDue": "A recurring task needs a due date.",
    "error.todoTitle": "A task needs a title.",
    "error.todoMissing": "Task not found.",
    "error.entryMissing": "Entry not found.",
    "error.entryMissingRaw": "The entry data is incomplete.",
    "error.entryOutsideWeek": "This entry belongs to another week; open its start week to edit.",
    "error.entryInvalidRange": "The entry has an invalid time range.",
    "error.entryEndBeforeStart": "The entry ends before it starts.",
    "error.entryTooShort": "An entry must be at least 15 minutes long.",
    "error.editAcrossWeek": "This edit would move an entry across a week boundary.",
    "error.collisionOutsideWeek": "Resolving this collision would modify an entry from another week.",
    "error.collisionFailed": "The time-entry collision could not be resolved.",
    "error.unknown": "Technical error: {message}",
});

/** @type {Readonly<LocaleDictionary>} */
export const DE_MESSAGES = Object.freeze({
    "meta.description": "Eine statische Browser-Anwendung für Zeiterfassung, Aufgaben und Ausgaben. Deine Daten liegen in einem Git-Repository deiner Wahl.",
    "document.title": "zeitberg — Zeiterfassung, Aufgaben, Ausgaben → Git",

    "nav.application": "Anwendungsnavigation",
    "nav.home": "zeitberg Startseite",
    "nav.views": "Ansichten",
    "nav.workspaces": "Arbeitsbereiche",
    "nav.manageWorkspaces": "Arbeitsbereiche verwalten",
    "nav.weekTitle": "Woche (Strg+W)",
    "nav.week": "Wochenansicht",
    "nav.todosTitle": "Aufgaben (Strg+T)",
    "nav.todos": "Aufgabenansicht",
    "nav.expensesTitle": "Ausgaben (Strg+E)",
    "nav.expenses": "Ausgabenansicht",
    "nav.searchTitle": "Suche (Strg+K)",
    "nav.search": "Zeiteinträge durchsuchen",
    "nav.applicationZoom": "Anwendungszoom",
    "nav.zoomOut": "Anwendung verkleinern",
    "nav.zoomReset": "Anwendungszoom zurücksetzen",
    "nav.zoomAutomatic": "Automatischer Anwendungszoom ({percent} %)",
    "nav.zoomRestoreAutomatic": "Automatischen Anwendungszoom wiederherstellen (aktuell {percent} %)",
    "nav.zoomIn": "Anwendung vergrößern",
    "nav.useLightTheme": "Helles Design verwenden",
    "nav.useDarkTheme": "Dunkles Design verwenden",
    "nav.light": "Hell",
    "nav.dark": "Dunkel",
    "nav.projects": "Projekte",
    "nav.manageProjects": "Projekte verwalten",
    "nav.reload": "Daten neu laden",
    "nav.logout": "Abmelden",

    "provider.selfHosted": "Selbst gehostetes Git",
    "provider.local": "Lokaler Server",
    "provider.generic": "Git-Anbieter",

    "topbar.searchTimeTitle": "Zeiteinträge durchsuchen (Strg+K)",
    "topbar.searchTime": "Zeiteinträge durchsuchen",
    "topbar.searchTimePlaceholder": "Zeiteinträge durchsuchen…",
    "topbar.searchTodosTitle": "Aufgaben durchsuchen (Strg+K)",
    "topbar.searchTodos": "Aufgaben durchsuchen",
    "topbar.searchTodosPlaceholder": "Aufgaben durchsuchen…",
    "topbar.searchExpensesTitle": "Ausgaben durchsuchen (Strg+K)",
    "topbar.searchExpenses": "Ausgaben durchsuchen",
    "topbar.searchExpensesPlaceholder": "Ausgaben durchsuchen…",
    "topbar.addTodoTitle": "Aufgabe hinzufügen (A)",
    "topbar.addTodo": "Aufgabe hinzufügen",
    "topbar.todoFilters": "Aufgabenfilter",
    "topbar.currentOnly": "Nur aktuelle und überfällige anzeigen",
    "topbar.openOnly": "Nur offene anzeigen",
    "topbar.previousTitle": "Vorherige Tage / Woche (Bild↑)",
    "topbar.previous": "Vorherige Tage oder Woche",
    "topbar.nextTitle": "Nächste Tage / Woche (Bild↓)",
    "topbar.next": "Nächste Tage oder Woche",
    "topbar.latest": "Aktuell",
    "topbar.requiredHours": "Sollstunden bearbeiten",
    "topbar.weekEditorActions": "Wocheneditor-Aktionen",
    "topbar.normalModeTitle": "Normalmodus (Escape)",
    "topbar.normalMode": "Normalmodus",
    "topbar.addModeTitle": "Hinzufügen-Modus (A)",
    "topbar.addMode": "Hinzufügen-Modus",
    "topbar.splitModeTitle": "Teilen-Modus (S)",
    "topbar.splitMode": "Ausgewählten Eintrag teilen",
    "topbar.history": "Rückgängig und wiederholen",
    "topbar.undoTitle": "Rückgängig (Strg+Z)",
    "topbar.undo": "Rückgängig",
    "topbar.redoTitle": "Wiederholen (Strg+Y)",
    "topbar.redo": "Wiederholen",
    "topbar.timelineZoom": "Zeitskala zoomen",
    "topbar.zoomOutTitle": "Verkleinern (Strg+[ oder Strg+-)",
    "topbar.zoomOut": "Verkleinern",
    "topbar.zoomInTitle": "Vergrößern (Strg+] oder Strg++)",
    "topbar.zoomIn": "Vergrößern",
    "topbar.zoom": "Zoom",
    "topbar.saveTitle": "Änderungen speichern (Strg+S)",
    "topbar.save": "Änderungen speichern",

    "landing.navigation": "Startseitennavigation",
    "landing.architectureLink": "Architektur",
    "landing.setupLink": "Einrichtung",
    "landing.similarLink": "Ähnliche Projekte",
    "landing.sourceLink": "Quellcode ↗",
    "landing.eyebrow": "STATISCHE BROWSER-APP · GIT-ARBEITSBEREICH",
    "landing.time": "Zeiterfassung",
    "landing.tasks": "Aufgaben",
    "landing.expenses": "Ausgaben",
    "landing.toGit": "→ Git",
    "landing.lede": "zeitberg ist eine statische Anwendung. Sie liest und schreibt versionierte Arbeitsbereichsdateien direkt in ein Git-Repository deiner Wahl; zeitberg.io hat kein Daten-Backend.",
    "landing.properties": "Projekteigenschaften",
    "landing.staticHtml": "Statisches HTML5",
    "landing.directApi": "Direkte Anbieter-API",
    "landing.versionedJson": "Versioniertes JSON",
    "landing.openWorkspaceTag": "ARBEITSBEREICH ÖFFNEN",
    "landing.provider": "Anbieter",
    "landing.selfHostedForgejo": "Forgejo (selbst gehostet)",
    "landing.autoDetect": "Selbst gehosteten Anbieter erkennen",
    "landing.workspaceRepository": "Arbeitsbereichs-Repository",
    "landing.branch": "Branch / Ref",
    "landing.accessToken": "Anbieter-Zugriffstoken",
    "landing.rememberToken": "Token auf diesem Gerät speichern",
    "landing.openWorkspace": "Arbeitsbereich öffnen",
    "landing.useOAuth": "OAuth verwenden",
    "landing.createWorkspace": "Arbeitsbereich erstellen",
    "landing.clearConnection": "Gespeicherte Verbindung löschen",
    "landing.security": "Das Token bleibt im Browser-Speicher und wird nur an den ausgewählten Repository-Anbieter gesendet.",
    "landing.architectureAlt": "Statisches Hosting lädt zeitberg in deinen Browser. Der Browser spricht direkt mit der API eines Git-Anbieters, die dein privates Arbeitsbereichs-Repository liest und schreibt.",
    "landing.architectureCaption": "Zugangsdaten bleiben im Browser-Speicher. Anfragen gehen direkt an den ausgewählten Git-Anbieter.",
    "landing.workspaceEyebrow": "01 · ARBEITSBEREICH",
    "landing.workspaceTitle": "Erstelle ein privates Daten-Repository.",
    "landing.githubAvailable": "GITHUB · VERFÜGBAR",
    "landing.connectDirectly": "Direkt verbinden",
    "landing.readOnlyPrefix": "Mit schreibgeschützten Tokens kann man stöbern. Speichern benötigt",
    "landing.contentsPermission": "Contents: Read & write",
    "landing.createPrivateRepository": "Erstelle ein privates Repository.",
    "landing.copyTemplate": "Kopiere die Dateien aus workspace-template hinein.",
    "landing.enterConnection": "Trage oben URL, Branch und PAT ein.",
    "landing.detailedSetup": "Ausführliche Einrichtung ↗",
    "landing.otherProvidersAvailable": "GITLAB · CODEBERG · VERFÜGBAR",
    "landing.connectOrCreate": "Verbinden oder erstellen",
    "landing.connectExisting": "Verbinde ein bestehendes privates Repository mit einem Anbieter-Token.",
    "landing.createOther": "Erstelle und initialisiere oben einen privaten GitLab.com- oder Codeberg-Arbeitsbereich.",
    "landing.pkce": "PKCE-OAuth wird aktiv, sobald diese Bereitstellung öffentliche Client-IDs enthält.",
    "landing.cors": "CORS-fähige selbst gehostete GitLab- und Forgejo-Server werden ausdrücklich erkannt.",
    "landing.similarEyebrow": "02 · ÄHNLICHE PROJEKTE",
    "landing.similarTitle": "Verwandte Projekte.",
    "landing.similarIntro": "Bei dieser Recherche fand sich kein direktes Gegenstück. Diese Projekte überschneiden sich mit zeitberg beim Umfang oder Speichermodell.",
    "landing.gitJournal": "Markdown-Notizen in einem Git-Repository deiner Wahl.",
    "landing.gitBackedNotes": "Git-basierte Notizen",
    "landing.taskRepo": "Aufgaben als Markdown-Dateien in Git-Repositories.",
    "landing.gitBackedTasks": "Git-basierte Aufgaben",
    "landing.activityWatch": "Automatische Zeiterfassung mit lokal kontrollierten Daten.",
    "landing.timeLocalFirst": "Zeit · Local-first",
    "landing.actualBudget": "Local-first-Finanzverwaltung mit optionaler Synchronisierung.",
    "landing.financeLocalFirst": "Finanzen · Local-first",
    "landing.footerTag": "statische Anwendung · Git-Arbeitsbereich",
    "landing.aiDisclosure": "Der Code dieses Projekts wurde mit großen Sprachmodellen unter umfassender menschlicher Aufsicht geschrieben.",
    "landing.landscapeAlt": "Eine Uhrsonne geht hinter mehreren Bergketten unter, während daneben ein Münzmond aufgeht.",
    "landing.markAttribution": "Die zeitberg-Bildmarke und Landschaft sind eigenständig von Hand erstellte SVGs. Es wurde kein Bildmodell verwendet.",

    "loading.title": "Arbeitsbereich wird geladen",
    "loading.retry": "Erneut versuchen",
    "loading.backToLogin": "Zurück zur Anmeldung",
    "loading.discoverLocal": "Lokale Arbeitsbereiche werden gesucht…",
    "loading.prepareLocal": "Lokale Daten werden vorbereitet…",
    "loading.prepareRepository": "Repository-Daten werden vorbereitet…",
    "loading.workspaceLocal": "Lokaler Arbeitsbereich wird geladen…",
    "loading.workspace": "Arbeitsbereich wird geladen…",
    "loading.manifestLocal": "Lokales Manifest wird geladen…",
    "loading.manifest": "Manifest wird geladen…",
    "loading.projectsLocal": "Lokale Projekte werden geladen…",
    "loading.projects": "Projekte werden geladen…",
    "loading.requirementsLocal": "Lokale Sollstunden werden geladen…",
    "loading.requirements": "Sollstunden werden geladen…",
    "loading.todosLocal": "Lokale Aufgaben werden geladen…",
    "loading.todos": "Aufgaben werden geladen…",
    "loading.expensesLocal": "Lokale Ausgaben werden geladen…",
    "loading.expenses": "Ausgaben werden geladen…",
    "loading.progress": "{loaded}/{total} werden geladen…",
    "loading.checkCache": "{count} zwischengespeicherte Wochendateien werden geprüft…",
    "loading.download": "{count} Wochendateien werden gebündelt heruntergeladen…",
    "loading.prepare": "{loaded}/{total} werden vorbereitet • {week}",
    "loading.complete": "{loaded}/{total} Wochendateien geladen • Speicher {memory} • Cache {cached} • heruntergeladen {downloaded}",
    "loading.connectProvider": "Verbindung mit {provider} wird hergestellt…",
    "loading.completeAuthorization": "Anbieter-Autorisierung wird abgeschlossen…",

    "search.filters": "Filter",
    "search.project": "Projekt",
    "search.from": "Von ({timezone})",
    "search.to": "Bis ({timezone})",
    "search.maxRows": "Max. Zeilen",
    "search.sort": "Sortierung",
    "search.newest": "Neueste zuerst",
    "search.oldest": "Älteste zuerst",
    "search.entries": "Einträge",
    "search.date": "Datum",
    "search.start": "Beginn",
    "search.end": "Ende",
    "search.duration": "Dauer",
    "search.description": "Beschreibung",
    "search.billable": "Abrechenbar",
    "search.allProjects": "Alle Projekte",
    "search.allProject": "Ganzes Projekt {project}",
    "search.noProject": "Kein Projekt",
    "search.archived": "archiviert",
    "search.stats": "{matches} Treffer • {duration} gesamt • {shown} angezeigt",
    "search.openWeek": "Diesen Eintrag in der Wochenansicht öffnen",
    "common.yes": "Ja",
    "common.no": "Nein",
    "common.close": "Schließen",
    "common.cancel": "Abbrechen",
    "common.continue": "Weiter",
    "common.ok": "OK",
    "common.save": "Speichern",
    "common.delete": "Löschen",

    "workspace.title": "Arbeitsbereiche",
    "workspace.meta": "Verbindungen werden in diesem Browser gespeichert. Zugangsdaten bleiben von den Arbeitsbereichsmetadaten getrennt.",
    "workspace.language": "Oberflächensprache",
    "workspace.languageEnglish": "English",
    "workspace.languageGerman": "Deutsch",
    "workspace.add": "Arbeitsbereich hinzufügen",
    "workspace.addMeta": "Verbinde ein weiteres Repository, ohne das aktuelle zu trennen.",
    "workspace.repositoryUrl": "Repository-URL",
    "workspace.configPath": "Pfad zur Arbeitsbereichskonfiguration",
    "workspace.shareActive": "Aktiven Arbeitsbereich teilen",
    "workspace.createPrivate": "Privaten Arbeitsbereich erstellen",
    "workspace.connect": "Verbinden",
    "workspace.createTitle": "Privaten Arbeitsbereich erstellen",
    "workspace.createMeta": "Erstelle und initialisiere ein Repository ohne zeitberg-Backend.",
    "workspace.repositoryName": "Repository-Name",
    "workspace.workspaceName": "Name des Arbeitsbereichs",
    "workspace.timezone": "Zeitzone",
    "workspace.rememberResult": "Die resultierenden Zugangsdaten auf diesem Gerät speichern",
    "workspace.authorizeOAuth": "Mit OAuth autorisieren",
    "workspace.createWithToken": "Mit Token erstellen",
    "workspace.shareTitle": "Arbeitsbereich teilen",
    "workspace.locatorTitle": "Verweislink",
    "workspace.locatorHelp": "Enthält Repository, Branch, Arbeitsbereichsidentität, Teilanwendung und aktuelle Ansicht. Empfänger authentifizieren sich selbst.",
    "workspace.copyLocator": "Verweislink kopieren",
    "workspace.capabilityTitle": "Zugriffslink",
    "workspace.capabilityWarning": "Jeder mit diesem Link erhält die Repository-Rechte des Tokens. Behandle ihn wie Zugangsdaten.",
    "workspace.capabilityHelp": "Verwende ein eigenes, ablaufendes Token mit den geringstmöglichen Rechten nur für dieses Repository. zeitberg kann Tokens weder ausstellen noch einschränken.",
    "workspace.shareableToken": "Eigenes teilbares Token",
    "workspace.copyCapability": "Zugriffslink kopieren",
    "workspace.importTitle": "Zugriffslink öffnen?",
    "workspace.importWarning": "Dieser Link enthält Zugangsdaten. Beim Öffnen erhält dieser Browser die Token-Rechte für den oben gezeigten Arbeitsbereich.",
    "workspace.importScrubbed": "Das geheime Fragment wurde bereits aus der Adressleiste entfernt. Es wurde weder an einen Git-Anbieter gesendet noch gespeichert.",
    "workspace.trustHost": "Ich vertraue diesem eigenen Anbieter-Host und erlaube, die Zugangsdaten dorthin zu senden.",
    "workspace.trustNamedHost": "Ich vertraue {host} und erlaube, die Zugangsdaten an diesen eigenen Anbieter-Host zu senden.",
    "workspace.rememberSession": "Token auf diesem Gerät speichern (standardmäßig nur diese Sitzung)",
    "workspace.none": "Keine gespeicherten Arbeitsbereichsverbindungen.",
    "workspace.active": "Aktiv",
    "workspace.localServer": "Lokaler Server",
    "workspace.authenticated": "Authentifiziert",
    "workspace.tokenRequired": "Token erforderlich",
    "workspace.open": "Öffnen",
    "workspace.switch": "Wechseln",
    "workspace.authenticate": "Authentifizieren",
    "workspace.earlier": "Nach oben",
    "workspace.later": "Nach unten",
    "workspace.disconnect": "Trennen",
    "workspace.enterTokenFor": "Gib ein Token ein, um {workspace} zu authentifizieren.",
    "workspace.localLocatorOnly": "Lokale Arbeitsbereiche können nur Verweislinks für diesen Server erzeugen.",
    "workspace.linkCopied": "Arbeitsbereichslink kopiert.",
    "workspace.copyPrompt": "Diesen Arbeitsbereichslink kopieren:",
    "workspace.capabilityCopied": "Zugriffslink kopiert. Teile ihn so sicher wie das Token selbst.",
    "workspace.notImported": "Zugriffslink nicht importiert. Gib eigene Zugangsdaten ein, um diesen Arbeitsbereich zu öffnen.",
    "workspace.confirmHost": "Bestätige den eigenen Anbieter-Host, bevor du diesen Zugriffslink öffnest.",
    "workspace.oauthAvailable": "OAuth ist für GitLab.com und Codeberg verfügbar.",
    "workspace.oauthAuthorize": "Mit {provider} über PKCE autorisieren",
    "workspace.oauthUnavailable": "Für {provider}-OAuth fehlt dieser Bereitstellung eine öffentliche Client-ID; verwende vorerst ein eingeschränktes Token.",
    "workspace.codebergScope": "Forgejo-OAuth-Rechte sind derzeit nicht fein abgestuft. Wenn minimale Rechte wichtig sind, verwende ein Repository-bezogenes Codeberg-Token.",
    "workspace.gitlabScope": "GitLab-OAuth fordert API-Zugriff an, damit zeitberg das private Projekt erstellen, initialisieren, lesen und schreiben kann.",
    "workspace.createdInitializationFailed": "Das private Repository wurde unter {repository} erstellt, aber die Initialisierung ist fehlgeschlagen: {error}",
    "workspace.couldNotOpen": "{workspace} konnte nicht geöffnet werden: {error}",
    "workspace.tokenOrOAuth": "Gib ein Provider-Token ein oder verwende OAuth.",
    "workspace.localUnavailable": "Dieser Arbeitsbereich wird vom lokalen Server nicht bereitgestellt.",
    "workspace.authenticateLink": "Authentifiziere dich, um den im Link genannten Arbeitsbereich zu öffnen.",
    "workspace.completeConnection": "Gib Repository-URL, Branch und Token ein.",

    "entry.dialogTitle": "Eintrag bearbeiten",
    "entry.description": "Beschreibung",
    "entry.assignment": "Projekt / Abschnitt",
    "entry.noProject": "Kein Projekt",
    "entry.dragStart": "Beginn des Eintrags ziehen",
    "entry.dragStartShort": "Beginn ziehen",
    "entry.dragEnd": "Ende des Eintrags ziehen",
    "entry.dragEndShort": "Ende ziehen",
    "entry.edit": "Eintrag bearbeiten",
    "entry.delete": "Eintrag löschen",
    "entry.split": "Eintrag teilen",
    "entry.addHere": "Eintrag {interval} am {date} hinzufügen",
    "entry.meta": "{date} {start}–{end} • {duration} • ID {id}",
    "entry.archived": "archiviert",
    "entry.belongsToWeek": "Dieser Eintrag gehört zu {week}; öffne diese Woche zum Bearbeiten.",

    "todo.timeline": "Aufgaben",
    "todo.filterByProject": "Aufgaben nach Projekt filtern",
    "todo.all": "Alle",
    "todo.empty": "Keine Aufgaben entsprechen dieser Ansicht.",
    "todo.stats": "{shown} angezeigt • {open} offen • {completed} erledigt",
    "todo.addTo": "Aufgabe zu {assignment} hinzufügen",
    "todo.reopen": "{task} wieder öffnen",
    "todo.complete": "{task} erledigen",
    "todo.doneCount": "{count} erledigt",
    "todo.occurrencesCompleted.one": "{count} wiederkehrendes Vorkommen erledigt",
    "todo.occurrencesCompleted.other": "{count} wiederkehrende Vorkommen erledigt",
    "todo.openIssue": "GitHub-Issue #{number} öffnen",
    "todo.openLinkedIssue": "Verknüpftes GitHub-Issue #{number} öffnen",
    "todo.addTitle": "Aufgabe hinzufügen",
    "todo.editTitle": "Aufgabe bearbeiten",
    "todo.newTask": "Neue Aufgabe",
    "todo.open": "Offen",
    "todo.completed": "Erledigt",
    "todo.subtask": "Unteraufgabe",
    "todo.importedFrom": "aus {provider} importiert",
    "todo.githubIssue": "GitHub-Issue #{number}",
    "todo.title": "Titel",
    "todo.dueDate": "Fälligkeitsdatum",
    "todo.dueTime": "Fälligkeitszeit",
    "todo.recurrence": "Wiederholung",
    "todo.recurrencePlaceholder": "z. B. jeden Freitag oder alle 2 Wochen nach Abschluss",
    "todo.priority": "Priorität",
    "todo.priorityNormal": "Normal",
    "todo.priorityMedium": "Mittel",
    "todo.priorityHigh": "Hoch",
    "todo.priorityUrgent": "Dringend",
    "todo.labels": "Labels (kommagetrennt)",
    "todo.conflictsTitle": "Aufgabenkonflikte lösen",
    "todo.conflictsMeta": "Sowohl dieser Browser als auch GitHub haben diese Aufgaben geändert. Wähle vor dem Speichern für jede Aufgabe eine Version.",
    "todo.conflictComparison": "Browser: {local} • GitHub: {remote}",
    "todo.deletedVersion": "gelöscht",
    "todo.keepLocal": "Browser-Version behalten",
    "todo.useGitHub": "GitHub-Version verwenden",

    "expenses.timeline": "Ausgaben und Ausgleiche",
    "expenses.filterCategories": "Ausgaben nach Kategorie filtern",
    "expenses.all": "Alle",
    "expenses.empty": "Keine Ausgaben entsprechen dieser Ansicht.",
    "expenses.stats": "{shown} angezeigt • {expenses} Ausgaben • {settlements} Ausgleiche",
    "expenses.addTitle": "Ausgabe hinzufügen (A)",
    "expenses.add": "Ausgabe hinzufügen",
    "expenses.newExpense": "Neue gemeinsame Ausgabe",
    "expenses.edit": "Ausgabe bearbeiten",
    "expenses.editTitle": "Ausgabe bearbeiten",
    "expenses.editSplit": "Aufteilung bearbeiten",
    "expenses.settleTitle": "Salden ausgleichen (S)",
    "expenses.settle": "Salden ausgleichen",
    "expenses.settlement": "Ausgleich",
    "expenses.settleMeta": "Zahlungsvorschläge werden je Währung getrennt berechnet.",
    "expenses.inventoryTitle": "Personen und Kategorien",
    "expenses.inventory": "Personen und Kategorien",
    "expenses.inventoryMeta": "Stabile Schlüssel bleiben unverändert, wenn Namen bearbeitet werden.",
    "expenses.participants": "Personen",
    "expenses.categories": "Kategorien",
    "expenses.addParticipant": "Person hinzufügen",
    "expenses.addCategory": "Kategorie hinzufügen",
    "expenses.participantName": "Name der Person",
    "expenses.categoryName": "Name der Kategorie",
    "expenses.description": "Beschreibung",
    "expenses.date": "Datum",
    "expenses.amount": "Betrag",
    "expenses.currency": "Währung",
    "expenses.category": "Kategorie",
    "expenses.noCategory": "Keine Kategorie",
    "expenses.notes": "Notizen",
    "expenses.splitRule": "Aufteilung",
    "expenses.splitEqual": "Gleichmäßig",
    "expenses.splitPercentage": "Prozentual",
    "expenses.splitShares": "Anteile",
    "expenses.splitExact": "Exakte Beträge",
    "expenses.participant": "Person",
    "expenses.paid": "Bezahlt",
    "expenses.owed": "Anteil",
    "expenses.included": "Beteiligt (1)",
    "expenses.percentage": "Prozent",
    "expenses.shares": "Anteile",
    "expenses.paidBy": "Bezahlt von {participant}",
    "expenses.owedBy": "Anteil von {participant}",
    "expenses.importedFrom": "Aus {provider} importiert",
    "expenses.localExpense": "Ausgabe im Arbeitsbereich",
    "expenses.balanced": "Alle Salden ausgeglichen",
    "expenses.balancedLong": "Es gibt keine offenen Salden.",
    "expenses.paymentSuggestion": "{from} zahlt {to} {amount}",
    "expenses.recordPayment": "Zahlung eintragen",

    "projects.title": "Projekte",
    "projects.meta": "Gemeinsame Projekte, Abschnitte, Vorgaben und Archivstatus verwalten.",
    "projects.add": "Projekt hinzufügen",
    "projects.name": "Name",
    "projects.color": "Farbe",
    "projects.colorOverride": "Abweichende Farbe",
    "projects.billable": "Abrechenbar",
    "projects.archived": "Archiviert",
    "projects.sections": "Abschnitte",
    "projects.addSection": "Abschnitt hinzufügen",
    "projects.inherit": "Übernehmen",
    "projects.notBillable": "Nicht abrechenbar",
    "projects.everyProjectName": "Jedes Projekt benötigt einen Namen.",
    "projects.duplicateProject": "Doppelter Projektname: {name}",
    "projects.invalidColor": "Ungültige Farbe für {name}.",
    "projects.everySectionName": "Jeder Abschnitt in {project} benötigt einen Namen.",
    "projects.duplicateSection": "Doppelter Abschnitt in {project}: {section}",
    "projects.invalidSectionColor": "Ungültige Farbe für {project} / {section}.",
    "projects.githubRepository": "GitHub-Issue-Repository",
    "projects.githubCheck": "Prüfen",
    "projects.githubLabel": "GitHub-Label des Abschnitts",
    "projects.githubLabelPlaceholder": "type/feature",
    "projects.githubInvalidRepository": "Bitte owner/repository verwenden.",
    "projects.githubInvalidForProject": "Ungültiges GitHub-Repository für {project}; bitte owner/repository verwenden.",
    "projects.githubUnavailable": "Die Repository-Prüfung benötigt einen GitHub-Arbeitsbereich mit PAT.",
    "projects.githubIssuesDisabled": "Das Repository ist lesbar, aber GitHub Issues sind deaktiviert.",
    "projects.githubIssuesDisabledFor": "GitHub Issues sind für {repository} deaktiviert.",
    "projects.githubPrivate": "Privat",
    "projects.githubPublic": "Öffentlich",
    "projects.githubVerified": "{visibility} • Lesen bestätigt • Issue-Schreiben wird beim ersten Speichern geprüft",
    "projects.githubCheckFailed": "Repository-Prüfung fehlgeschlagen: {error}",
    "projects.githubInvalidLabel": "Ungültiges GitHub-Label für {project} / {section}; Labels dürfen nur eine Zeile und höchstens 50 Zeichen haben.",
    "projects.githubDuplicateLabel": "Das GitHub-Label {label} ist in {project} mehreren Abschnitten zugeordnet.",
    "projects.bindingPreviewTitle": "GitHub-Projektmigration",
    "projects.bindingPreviewMeta": "Lege den Umgang mit lokalen Aufgaben fest. Upstream-Issues werden nie gelöscht; neue Issues entstehen erst beim späteren manuellen Speichern der Aufgaben.",
    "projects.bindingConnectTitle": "{project} mit {repository} verbinden",
    "projects.bindingDetachTitle": "{project} von {repository} trennen",
    "projects.bindingConnectSummary": "{local} geeignete lokale • {linked} bereits verknüpft • {pending} ausstehend",
    "projects.bindingDetachSummary": "{linked} verknüpfte Issue-Aufgaben • {pending} unveröffentlichte lokale Aufgaben",
    "projects.bindingLeaveLocal": "Bestehende lokale Aufgaben lokal lassen (empfohlen)",
    "projects.bindingPublish": "Geeignete lokale Aufgaben beim nächsten Speichern veröffentlichen",
    "projects.bindingRetain": "Issue-Aufgaben als lokale Kopien behalten (empfohlen)",
    "projects.bindingRemove": "Issue-Aufgaben aus diesem Arbeitsbereich entfernen",
    "projects.saveTodosFirst": "Speichere oder verwirf die aktuellen Aufgabenänderungen, bevor du eine GitHub-Projektverknüpfung änderst.",
    "projects.saved": "Projekte gespeichert.",

    "requirements.title": "Wochen-Sollstunden",
    "requirements.requiredHours": "Sollstunden",
    "requirements.comment": "Kommentar (optional)",
    "requirements.commentPlaceholder": "Urlaub, krank, Feiertag…",
    "requirements.billableCurrent": "Abrechenbar bis heute",
    "requirements.requiredCurrent": "Soll bis heute",
    "requirements.weekDelta": "Wochendifferenz bis heute",
    "requirements.accumulated": "Summe seit {date}",
    "requirements.commentSummary": "Kommentar",
    "requirements.due": "Bis heute {due}/{configured} h",
    "requirements.full": "Soll {configured} h",

    "week.number": "KW {week}",
    "week.trackedTitle": "{duration} in Kalenderwoche {week} erfasst",
    "week.trackedAria": "Kalenderwoche {week}, {duration} erfasst",
    "week.billableTitle": "{duration} abrechenbar",
    "week.entryTitle": "{date} {start}–{end} • {project}{description}",
    "week.summaryAria": "{summary}. Sollstunden bearbeiten.",
    "week.summaryTitle": "{summary} • Sollstunden bearbeiten",
    "week.summaryBillable": "Abrechenbar {duration}",
    "week.summaryRequired": "Soll {duration}",
    "week.summaryDelta": "Differenz {duration}",
    "week.summaryAccumulated": "Summe {duration}",
    "week.saved": "Gespeichert",
    "week.changed": "Geändert",
    "week.saving": "Speichert…",
    "week.noUnsaved": "Keine ungespeicherten Wochenänderungen",
    "week.saveChanged": "Geänderte Wochen speichern",
    "week.changesSaved": "Wochenänderungen gespeichert",

    "recurrence.daily.one": "jeden Tag",
    "recurrence.daily.other": "alle {count} Tage",
    "recurrence.weekly.one": "jede Woche",
    "recurrence.weekly.other": "alle {count} Wochen",
    "recurrence.monthly.one": "jeden Monat",
    "recurrence.monthly.other": "alle {count} Monate",
    "recurrence.yearly.one": "jedes Jahr",
    "recurrence.yearly.other": "alle {count} Jahre",
    "recurrence.weekday": "jeden {weekday}",
    "recurrence.afterCompletion": "{rule} nach Abschluss",
    "recurrence.custom": "benutzerdefinierte Wiederholung",

    "status.localMode": "Lokaler Modus",
    "status.savedConnection": "Gespeicherte Verbindung verfügbar",
    "status.notLoggedIn": "Nicht angemeldet",
    "status.cleared": "Gelöscht",
    "status.connecting": "Verbindung wird hergestellt…",
    "status.loggedInAs": "Angemeldet als {user}",
    "status.connectedTo": "Verbunden mit {repository}",
    "status.saved": "Gespeichert",
    "status.changed": "Geändert",
    "status.saving": "Speichert…",
    "status.todoNoUnsaved": "Keine ungespeicherten Aufgabenänderungen",
    "status.todoSaveChanged": "Geänderte Aufgaben speichern",
    "status.todoChangesSaved": "Aufgabenänderungen gespeichert",
    "status.expenseNoUnsaved": "Keine ungespeicherten Ausgabenänderungen",
    "status.expenseSaveChanged": "Geänderte Ausgaben speichern",
    "status.expenseChangesSaved": "Ausgabenänderungen gespeichert",

    "data.weekFiles": "{count} Wochendateien",
    "data.entries": "{count} Einträge",
    "data.todos": "{count} Aufgaben",
    "data.expenses": "{count} Ausgaben",
    "data.manifestAt": "Manifest {date}",
    "data.local": "Lokale Daten",

    "toast.tapSplit": "Tippe auf die gewünschte Trennstelle im Eintrag.",
    "toast.saving": "Speichern läuft…",
    "toast.outsideWeek": "Außerhalb der aktuellen Woche kann kein Eintrag erstellt werden.",
    "toast.shortEntry": "Der Eintrag ist kürzer als 15 Minuten.",
    "toast.selectEntry": "Wähle zuerst einen Eintrag aus.",
    "toast.splitThisWeek": "Teilen funktioniert nur für Einträge dieser Woche.",
    "toast.tooShortSplit": "Der Eintrag ist zum Teilen zu kurz (mindestens 30 Minuten).",
    "toast.splitOutsideWeek": "Außerhalb der aktuellen Woche kann nicht geteilt werden.",
    "toast.nothingToSave": "Nichts zu speichern.",
    "toast.saved": "Gespeichert.",
    "toast.noWeek": "Keine Woche ausgewählt.",
    "toast.requirementRange": "Sollstunden müssen zwischen 0 und 168 liegen.",
    "toast.requirementsSaved": "Wochen-Sollstunden gespeichert.",
    "toast.invalidAssignment": "Wähle ein Projekt oder einen Abschnitt aus der Liste oder leere das Feld für „Kein Projekt“.",
    "toast.missingAssignment": "Das ausgewählte Projekt oder der Abschnitt existiert nicht mehr.",
    "toast.invalidSplit": "Ungültige Trennstelle.",
    "toast.todoTitle": "Eine Aufgabe benötigt einen Titel.",
    "toast.todoSaved": "Aufgaben gespeichert.",
    "toast.expensesSaved": "Ausgaben gespeichert.",
    "toast.expenseNeedsParticipant": "Füge mindestens eine Person hinzu, bevor du eine Ausgabe erstellst.",
    "toast.expenseDescription": "Eine Ausgabe benötigt eine Beschreibung.",
    "toast.expensePayersTotal": "Die bezahlten Beträge müssen der Gesamtausgabe entsprechen.",
    "toast.expensePercentageTotal": "Prozentuale Aufteilungen müssen zusammen 100 % ergeben.",
    "toast.expenseNeedsAllocation": "Wähle mindestens eine Person für die Aufteilung aus.",
    "toast.expenseAllocationsTotal": "Die Anteile müssen der Gesamtausgabe entsprechen.",
    "toast.expenseMissing": "Ausgabe oder Ausgleich nicht gefunden.",
    "toast.expenseParticipantName": "Jede Person benötigt einen Namen.",
    "toast.expenseCategoryName": "Jede Kategorie benötigt einen Namen.",
    "toast.expenseDraftUnavailable": "Der Browser-Entwurfsspeicher ist nicht verfügbar; ungespeicherte Ausgabenänderungen überstehen ein Neuladen möglicherweise nicht.",
    "toast.expenseDraftCleanup": "Der gespeicherte Ausgabenentwurf konnte nicht aus dem Browser-Speicher entfernt werden.",
    "toast.expenseDraftConflict": "Der Ausgabenentwurf konnte nicht sicher zusammengeführt werden: {error}",
    "toast.expenseRestored": "Ungespeicherte Ausgabenänderungen wiederhergestellt.",
    "toast.expenseRestoredMerged": "Ausgabenänderungen wiederhergestellt und mit neueren Repository-Daten zusammengeführt.",
    "toast.todoRestored": "Ungespeicherte Aufgabenänderungen wiederhergestellt.",
    "toast.todoRestoredMerged": "Aufgabenänderungen wiederhergestellt und mit neueren Daten zusammengeführt.",
    "toast.todoRestoredConflicts": "Aufgabenänderungen mit {count} Konflikt(en) wiederhergestellt, die eine Auswahl erfordern.",
    "toast.todoResolveConflicts": "Löse vor dem Speichern alle Aufgabenkonflikte.",
    "toast.githubIssuesCached": "GitHub ist nicht erreichbar; für {repository} wird der zwischengespeicherte Issue-Stand angezeigt.",
    "toast.githubIssueConflict": "GitHub-Issue #{number} wurde nach Beginn der lokalen Bearbeitung geändert. Lade neu, um vor dem Speichern zu vergleichen.",
    "toast.recurrenceDue": "Eine wiederkehrende Aufgabe benötigt ein Fälligkeitsdatum.",
    "toast.unsupportedRecurrence": "Nicht unterstützte Wiederholung. Versuche „jeden Tag“, „jeden Freitag“, „alle 2 Wochen“ oder „jeden Monat nach Abschluss“.",
    "toast.waitSaveSwitch": "Warte vor dem Wechseln des Arbeitsbereichs, bis das Speichern beendet ist.",
    "toast.waitSaveDisconnect": "Warte vor dem Trennen des Arbeitsbereichs, bis das Speichern beendet ist.",
    "toast.enterToken": "Gib ein Token für diesen Arbeitsbereich ein.",
    "toast.restoredWeeks.one": "Ungespeicherte Änderungen für {count} Woche wiederhergestellt{merged}.",
    "toast.restoredWeeks.other": "Ungespeicherte Änderungen für {count} Wochen wiederhergestellt{merged}.",
    "toast.mergedNewer": "; neuere Daten in {count} zusammengeführt",
    "toast.requirementsNotLoaded": "Wochen-Sollstunden nicht geladen: {error}",
    "toast.todoDraftUnavailable": "Der Browser-Entwurfsspeicher ist nicht verfügbar; ungespeicherte Aufgabenänderungen überstehen ein Neuladen möglicherweise nicht.",
    "toast.todoDraftCleanup": "Der gespeicherte Aufgabenentwurf konnte nicht aus dem Browser-Speicher entfernt werden.",
    "toast.weekDraftUnavailable": "Der Browser-Entwurfsspeicher ist nicht verfügbar; ungespeicherte Zeiteinträge überstehen ein Neuladen möglicherweise nicht.",
    "toast.weekDraftCleanup": "Der gespeicherte Zeiterfassungsentwurf konnte nicht aus dem Browser-Speicher entfernt werden.",
    "toast.invalidEditPayload": "Ungültige Bearbeitungsdaten.",

    "error.notLoggedIn": "Nicht angemeldet.",
    "error.nothingToSave": "Nichts zu speichern.",
    "error.invalidRepository": "Gib eine gültige HTTPS-Repository-URL ein.",
    "error.httpsRepository": "Repository-URLs müssen HTTPS verwenden.",
    "error.fullHttpsRepository": "Gib eine vollständige HTTPS-Repository-URL ein.",
    "error.githubRepository": "Gib eine gültige GitHub-Repository-URL ein.",
    "error.githubHttps": "Der aktuelle Konnektor akzeptiert HTTPS-Repository-URLs von github.com.",
    "error.repositoryNoQuery": "Die Repository-URL darf weder Abfrageparameter noch ein Fragment enthalten.",
    "error.repositoryExample": "Verwende eine Repository-URL wie https://github.com/du/zeitberg-data.",
    "error.githubName": "GitHub-Besitzer oder Repository-Name sind ungültig.",
    "error.workspacePathRelative": "Der Pfad zur Arbeitsbereichsdatei muss relativ zum Repository sein.",
    "error.workspacePathUnsafe": "Der Pfad zur Arbeitsbereichsdatei enthält ein unsicheres Segment.",
    "error.workspaceIdentifier": "Die erwartete Arbeitsbereichs-ID ist ungültig.",
    "error.workspaceRepository": "Die Arbeitsbereichs-Repository-URL ist ungültig.",
    "error.workspaceRepositorySafe": "Arbeitsbereichs-Repository-URLs müssen HTTPS verwenden und dürfen keine Zugangsdaten, Abfrageparameter oder Fragmente enthalten.",
    "error.workspaceRef": "Der Arbeitsbereichs-Ref darf nicht leer sein.",
    "error.workspaceLocator": "Eine gültige Arbeitsbereichsadresse ist erforderlich.",
    "error.capabilityMalformed": "Die Capability-Daten sind fehlerhaft.",
    "error.capabilityHosted": "Capability-Links benötigen genau einen gehosteten Arbeitsbereich.",
    "error.shareableCredential": "Gib gültige teilbare Repository-Zugangsdaten ein.",
    "error.capabilityMissing": "Es wurden keine Capability-Daten gefunden.",
    "error.capabilityInvalid": "Die Capability-Daten sind ungültig.",
    "error.capabilityVersion": "Die Version der Capability-Daten wird nicht unterstützt.",
    "error.capabilityCredential": "Die Capability-Zugangsdaten sind ungültig.",
    "error.capabilityMismatch": "Die Capability-Route stimmt nicht mit ihrer öffentlichen Arbeitsbereichsadresse überein.",
    "error.capabilityAltered": "Dieser Capability-Link ist ungültig oder wurde verändert. Sein Zugangsdaten-Fragment wurde entfernt.",
    "error.hostedProvider": "Wähle einen unterstützten gehosteten Git-Anbieter.",
    "error.oauthIncomplete": "Die OAuth-Zugangsdaten sind unvollständig.",
    "error.oauthRefresh": "Die OAuth-Zugangsdaten konnten nicht erneuert werden.",
    "error.authorizationIncomplete": "Der Rückruf der Anbieter-Autorisierung ist unvollständig.",
    "error.localNoWorkspaces": "Der lokale Server stellt keine Arbeitsbereiche bereit.",
    "error.localNoSelection": "Der lokale Server hat keinen auswählbaren Arbeitsbereich bereitgestellt.",
    "error.recurringDue": "Eine wiederkehrende Aufgabe benötigt ein Fälligkeitsdatum.",
    "error.todoTitle": "Eine Aufgabe benötigt einen Titel.",
    "error.todoMissing": "Aufgabe nicht gefunden.",
    "error.entryMissing": "Eintrag nicht gefunden.",
    "error.entryMissingRaw": "Die Eintragsdaten sind unvollständig.",
    "error.entryOutsideWeek": "Dieser Eintrag gehört zu einer anderen Woche; öffne seine Startwoche zum Bearbeiten.",
    "error.entryInvalidRange": "Der Eintrag hat einen ungültigen Zeitraum.",
    "error.entryEndBeforeStart": "Der Eintrag endet vor seinem Beginn.",
    "error.entryTooShort": "Ein Eintrag muss mindestens 15 Minuten lang sein.",
    "error.editAcrossWeek": "Diese Änderung würde einen Eintrag über eine Wochengrenze verschieben.",
    "error.collisionOutsideWeek": "Zum Auflösen dieser Überschneidung müsste ein Eintrag aus einer anderen Woche verändert werden.",
    "error.collisionFailed": "Die Überschneidung der Zeiteinträge konnte nicht aufgelöst werden.",
    "error.unknown": "Technischer Fehler: {message}",
});

export const LOCALE_DICTIONARIES = Object.freeze({ en: EN_MESSAGES, de: DE_MESSAGES });
export const SUPPORTED_LOCALES = Object.freeze(["en", "de"]);

const EXACT_ERROR_KEYS = new Map([
    ["Not logged in.", "error.notLoggedIn"],
    ["Nothing to save.", "error.nothingToSave"],
    ["Enter a valid HTTPS repository URL.", "error.invalidRepository"],
    ["Repository URLs must use HTTPS.", "error.httpsRepository"],
    ["Enter a full HTTPS repository URL.", "error.fullHttpsRepository"],
    ["Enter a GitHub workspace repository URL.", "error.githubRepository"],
    ["Enter a valid GitHub repository URL.", "error.githubRepository"],
    ["The current connector accepts HTTPS github.com repository URLs.", "error.githubHttps"],
    ["The repository URL must not contain a query or fragment.", "error.repositoryNoQuery"],
    ["Use a repository URL such as https://github.com/you/zeitberg-data.", "error.repositoryExample"],
    ["The GitHub owner or repository name is invalid.", "error.githubName"],
    ["The workspace bootstrap path must be repository-relative.", "error.workspacePathRelative"],
    ["The workspace bootstrap path contains an unsafe segment.", "error.workspacePathUnsafe"],
    ["The expected workspace identifier is invalid.", "error.workspaceIdentifier"],
    ["The workspace repository URL is invalid.", "error.workspaceRepository"],
    ["Workspace repository URLs must use HTTPS and contain no credentials, query, or fragment.", "error.workspaceRepositorySafe"],
    ["The workspace ref must not be empty.", "error.workspaceRef"],
    ["A valid workspace locator is required.", "error.workspaceLocator"],
    ["The capability payload is malformed.", "error.capabilityMalformed"],
    ["Capability links require one hosted workspace route.", "error.capabilityHosted"],
    ["Enter a valid shareable repository credential.", "error.shareableCredential"],
    ["No capability payload was found.", "error.capabilityMissing"],
    ["The capability payload is invalid.", "error.capabilityInvalid"],
    ["The capability payload version is unsupported.", "error.capabilityVersion"],
    ["The capability credential is invalid.", "error.capabilityCredential"],
    ["The capability route does not match its public workspace locator.", "error.capabilityMismatch"],
    ["This capability link is invalid or has been altered. Its credential fragment was removed.", "error.capabilityAltered"],
    ["Select a supported hosted Git provider.", "error.hostedProvider"],
    ["The OAuth credential is incomplete.", "error.oauthIncomplete"],
    ["The OAuth credential could not be refreshed.", "error.oauthRefresh"],
    ["The provider authorization callback is incomplete.", "error.authorizationIncomplete"],
    ["The local server exposes no workspaces.", "error.localNoWorkspaces"],
    ["The local server did not provide a selectable workspace.", "error.localNoSelection"],
    ["A recurring TODO needs a due date.", "error.recurringDue"],
    ["A TODO needs a title.", "error.todoTitle"],
    ["TODO not found.", "error.todoMissing"],
    ["Entry not found.", "error.entryMissing"],
    ["Entry not found in this week", "error.entryMissing"],
    ["Missing entry", "error.entryMissing"],
    ["Missing edited entry", "error.entryMissing"],
    ["Missing raw entry payload", "error.entryMissingRaw"],
    ["Entry is outside this week; open its start week to edit.", "error.entryOutsideWeek"],
    ["Entry has invalid time range.", "error.entryInvalidRange"],
    ["Entry has end before start.", "error.entryEndBeforeStart"],
    ["Entry shorter than 15 minutes.", "error.entryTooShort"],
    ["Edit would move an entry across week boundaries.", "error.editAcrossWeek"],
    ["Would need to modify an entry outside this week.", "error.collisionOutsideWeek"],
    ["Failed to resolve overlap (backward).", "error.collisionFailed"],
    ["Failed to resolve overlap (forward).", "error.collisionFailed"],
    ["Overlaps remain after resolve.", "error.collisionFailed"],
]);

/**
 * Chooses one supported language from a persisted value or, only when absent, the browser preference list.
 * Regional subtags such as de-DE reduce to their base language; every unsupported language falls back to English.
 * @param {unknown} persistedLocale Previously saved application preference.
 * @param {readonly string[]} [browserLanguages] Ordered navigator language values used for a first visit.
 * @returns {SupportedLocale}
 */
export function resolveLocale(persistedLocale, browserLanguages = []) {
    const persistedValue = String(persistedLocale || "").trim().toLowerCase();
    if (persistedValue) {
        const persisted = persistedValue.split("-")[0];
        return SUPPORTED_LOCALES.includes(persisted) ? /** @type {SupportedLocale} */ (persisted) : "en";
    }
    for (const candidate of browserLanguages) {
        const language = String(candidate || "").trim().toLowerCase().split("-")[0];
        if (SUPPORTED_LOCALES.includes(language)) return /** @type {SupportedLocale} */ (language);
    }
    return "en";
}

/**
 * Owns all localized copy and presentation formatting without changing repository data or timezone calculations.
 * The active locale is supplied by App from browser configuration, while ISO dates and Git payloads remain language-neutral.
 */
export class LocaleService {
    /**
     * Creates formatter caches for one supported locale.
     * @param {unknown} locale Persisted or browser-derived locale value.
     */
    constructor(locale) {
        this.locale = resolveLocale(locale);
        this.formatters = new Map();
        this.collators = new Map();
    }

    /**
     * Switches language and clears cached Intl instances when the effective locale changes.
     * @param {unknown} locale Requested locale code.
     * @returns {boolean} Whether the active locale changed.
     */
    setLocale(locale) {
        const next = resolveLocale(locale);
        if (next === this.locale) return false;
        this.locale = next;
        this.formatters.clear();
        this.collators.clear();
        return true;
    }

    /**
     * Looks up one message with English fallback and replaces named interpolation markers.
     * Unknown keys are returned visibly so tests and development builds expose incomplete call sites rather than rendering blank controls.
     * @param {string} key Stable dictionary key.
     * @param {Record<string, unknown>} [values] Named values substituted into `{name}` markers.
     * @returns {string}
     */
    t(key, values = {}) {
        const dictionary = LOCALE_DICTIONARIES[this.locale] || EN_MESSAGES;
        const template = dictionary[key] ?? EN_MESSAGES[key] ?? `[${key}]`;
        return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
        );
    }

    /**
     * Applies declarative text and accessibility bindings and updates the document language.
     * Supported attributes are explicit so localized content cannot choose arbitrary DOM properties.
     * @param {Document | Element} root Document or subtree containing `data-i18n*` bindings.
     * @returns {void}
     */
    applyDocument(root) {
        const documentElement = root instanceof Document ? root.documentElement : root.ownerDocument?.documentElement;
        if (documentElement) documentElement.lang = this.locale;
        for (const element of root.querySelectorAll("[data-i18n]")) {
            const key = element.getAttribute("data-i18n");
            if (key) element.textContent = this.t(key);
        }
        const attributeBindings = [
            ["data-i18n-title", "title"],
            ["data-i18n-aria-label", "aria-label"],
            ["data-i18n-placeholder", "placeholder"],
            ["data-i18n-alt", "alt"],
            ["data-i18n-content", "content"],
        ];
        for (const [sourceAttribute, targetAttribute] of attributeBindings) {
            for (const element of root.querySelectorAll(`[${sourceAttribute}]`)) {
                const key = element.getAttribute(sourceAttribute);
                if (key) element.setAttribute(targetAttribute, this.t(key));
            }
        }
    }

    /**
     * Returns a cached Intl formatter, keyed by kind and stable options JSON.
     * @param {"number" | "date" | "plural"} kind Formatter family.
     * @param {Intl.NumberFormatOptions | Intl.DateTimeFormatOptions | Intl.PluralRulesOptions} options Intl constructor options.
     * @returns {Intl.NumberFormat | Intl.DateTimeFormat | Intl.PluralRules}
     */
    getFormatter(kind, options) {
        const key = `${kind}:${JSON.stringify(options)}`;
        const cached = this.formatters.get(key);
        if (cached) return cached;
        let formatter;
        if (kind === "date") formatter = new Intl.DateTimeFormat(this.locale, options);
        else if (kind === "plural") formatter = new Intl.PluralRules(this.locale, options);
        else formatter = new Intl.NumberFormat(this.locale, options);
        this.formatters.set(key, formatter);
        return formatter;
    }

    /**
     * Formats a finite number using active-locale digits, separators, and sign conventions.
     * @param {number} value Numeric value.
     * @param {Intl.NumberFormatOptions} [options] Optional Intl formatting controls.
     * @returns {string}
     */
    formatNumber(value, options = {}) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return "—";
        return /** @type {Intl.NumberFormat} */ (this.getFormatter("number", options)).format(numeric);
    }

    /**
     * Formats a Date in the active locale while preserving the active workspace's IANA timezone.
     * @param {Date | number | string} value Date-compatible input.
     * @param {string} timeZone Workspace IANA timezone.
     * @param {Intl.DateTimeFormatOptions} [options] Display shape, defaulting to a medium calendar date.
     * @returns {string}
     */
    formatDate(value, timeZone, options = { dateStyle: "medium" }) {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) return "—";
        return /** @type {Intl.DateTimeFormat} */ (this.getFormatter("date", { ...options, timeZone })).format(date);
    }

    /**
     * Formats a wall-clock time in the active locale and workspace timezone using a stable 24-hour cycle.
     * @param {Date | number | string} value Date-compatible input.
     * @param {string} timeZone Workspace IANA timezone.
     * @returns {string}
     */
    formatTime(value, timeZone) {
        return this.formatDate(value, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    }

    /**
     * Formats one localized weekday label for the workspace-local calendar day.
     * @param {Date | number | string} value Date-compatible input.
     * @param {string} timeZone Workspace IANA timezone.
     * @param {"long" | "short" | "narrow"} [width] Requested weekday width.
     * @returns {string}
     */
    formatWeekday(value, timeZone, width = "short") {
        return this.formatDate(value, timeZone, { weekday: width });
    }

    /**
     * Formats elapsed seconds as localized hours and two-digit minutes while retaining the compact H:MM layout used throughout time views.
     * @param {number} seconds Elapsed or signed delta seconds.
     * @param {{signDisplay?: "auto" | "always"}} [options] Whether positive values receive an explicit plus sign.
     * @returns {string}
     */
    formatDuration(seconds, options = {}) {
        const numeric = Number(seconds);
        if (!Number.isFinite(numeric)) return "—";
        const absolute = Math.abs(Math.round(numeric));
        const hours = Math.floor(absolute / 3600);
        const minutes = Math.floor((absolute % 3600) / 60);
        const sign = numeric < 0 ? "−" : options.signDisplay === "always" ? "+" : "";
        return `${sign}${this.formatNumber(hours, { useGrouping: false })}:${this.formatNumber(minutes, {
            minimumIntegerDigits: 2,
            useGrouping: false,
        })}`;
    }

    /**
     * Formats a monetary amount with active-locale separators and currency placement.
     * @param {number} amount Decimal currency amount.
     * @param {string} [currency] ISO 4217 currency code.
     * @returns {string}
     */
    formatCurrency(amount, currency = "EUR") {
        return this.formatNumber(amount, { style: "currency", currency });
    }

    /**
     * Returns the standard minor-unit precision reported by Intl for one currency in the active locale.
     * This affects input and display only; repository amounts remain explicit integers and never depend on locale parsing.
     * @param {string} currency ISO 4217 currency code.
     * @returns {number}
     */
    currencyMinorDigits(currency) {
        const code = String(currency || "").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) throw new Error("Currency must be a three-letter currency code.");
        return new Intl.NumberFormat(this.locale, { style: "currency", currency: code }).resolvedOptions()
            .maximumFractionDigits;
    }

    /**
     * Formats a safe integer minor-unit amount using the currency's Intl-defined decimal precision.
     * Floating-point conversion is confined to presentation; persisted and calculated balances remain integers.
     * @param {number} amountMinor Integer minor-unit amount.
     * @param {string} [currency] ISO 4217 currency code.
     * @param {Intl.NumberFormatOptions} [options] Additional display controls such as signDisplay.
     * @returns {string}
     */
    formatMinorCurrency(amountMinor, currency = "EUR", options = {}) {
        const amount = Number(amountMinor);
        if (!Number.isSafeInteger(amount)) return "—";
        const code = String(currency || "").trim().toUpperCase();
        const digits = this.currencyMinorDigits(code);
        return this.formatNumber(amount / 10 ** digits, { ...options, style: "currency", currency: code });
    }

    /**
     * Compares two user-facing labels according to the active locale while treating numeric runs naturally.
     * @param {string} left First display label.
     * @param {string} right Second display label.
     * @returns {number}
     */
    compare(left, right) {
        let collator = this.collators.get("default");
        if (!collator) {
            collator = new Intl.Collator(this.locale, { numeric: true, sensitivity: "base" });
            this.collators.set("default", collator);
        }
        return collator.compare(String(left), String(right));
    }

    /**
     * Selects a locale plural category and translates the matching `.one` or `.other` message.
     * @param {string} baseKey Dictionary key prefix.
     * @param {number} count Quantity controlling plural selection.
     * @param {Record<string, unknown>} [values] Additional interpolation values.
     * @returns {string}
     */
    plural(baseKey, count, values = {}) {
        const category = /** @type {Intl.PluralRules} */ (this.getFormatter("plural", {})).select(Number(count));
        const key = Object.prototype.hasOwnProperty.call(EN_MESSAGES, `${baseKey}.${category}`)
            ? `${baseKey}.${category}`
            : `${baseKey}.other`;
        return this.t(key, { ...values, count: this.formatNumber(count) });
    }

    /**
     * Produces localized presentation text from a structured recurrence without modifying its persisted representation.
     * Supported rules render from neutral fields in the active language; unsupported custom rules retain their original user/provider text because no safe translation is possible.
     * @param {import("./model.js").Recurrence | null | undefined} recurrence Structured recurrence model.
     * @param {string} timeZone Workspace timezone used to derive localized weekday names.
     * @returns {string}
     */
    describeRecurrence(recurrence, timeZone) {
        if (!recurrence) return "";
        if (!recurrence.isSupported()) return recurrence.source_text || this.t("recurrence.custom");
        let rule = "";
        if (recurrence.frequency === "weekly" && recurrence.interval === 1 && recurrence.weekdays.length === 1) {
            const monday = new Date(Date.UTC(2024, 0, 1 + recurrence.weekdays[0] - 1, 12));
            rule = this.t("recurrence.weekday", { weekday: this.formatWeekday(monday, timeZone, "long") });
        } else if (["daily", "weekly", "monthly", "yearly"].includes(recurrence.frequency)) {
            rule = this.plural(`recurrence.${recurrence.frequency}`, recurrence.interval);
        }
        return recurrence.basis === "after_completion" ? this.t("recurrence.afterCompletion", { rule }) : rule;
    }

    /**
     * Localizes known validation failures while retaining unknown provider diagnostics verbatim for troubleshooting.
     * @param {unknown} error Error object or user-facing message.
     * @returns {string}
     */
    localizeError(error) {
        const raw = error instanceof Error ? error.message : String(error || "");
        const message = raw.replace(/^Error:\s*/, "");
        if (!message || this.locale === "en") return message;
        const key = EXACT_ERROR_KEYS.get(message);
        return key ? this.t(key) : message;
    }
}
