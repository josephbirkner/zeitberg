/**
 * Read-only visual fixture using production markup/styles, without starting App,
 * accessing browser credentials, or contacting any provider. All data is fictional.
 * Serve the repository and open /tests/controls-preview.html for responsive review.
 */
import { OnboardingController } from "../onboarding.js";
import { LocaleService } from "../locale.js";
import { WorkspaceController } from "../workspace.js";
import { WorkspaceSessions } from "../workspace.sessions.js";
import { initializeContextHelp } from "../utils.js";

const source = new DOMParser().parseFromString(await (await fetch("/index.html")).text(), "text/html");
for (const link of source.querySelectorAll('link[rel="stylesheet"]')) {
    const copy = link.cloneNode(true);
    copy.href = new URL(link.getAttribute("href"), location.origin).href;
    document.head.append(copy);
}
const dialog = source.querySelector("#providerChooser");
for (const use of dialog.querySelectorAll("use")) use.setAttribute("href", use.getAttribute("href").replace("./icons/", "/icons/"));
document.body.append(dialog);
dialog.setAttribute("open", "");
document.querySelector("#providerChooserClose").hidden = true;
const locale = new LocaleService("en");
const workspaceDialog = source.querySelector("#workspaceDialog");
const welcomeCards = source.querySelector("#setupCards");
welcomeCards.hidden = true;
document.body.append(workspaceDialog, welcomeCards);
document.body.append(source.querySelector("#workspaceManualConnection"));
const loading = source.querySelector("#loadingSection");
document.body.append(loading);
const inventory = "28 week files · 860 entries · 32 tasks · 45 expenses";
const shareDialog = source.querySelector("#workspaceShareDialog");
document.body.append(shareDialog);
for (const element of document.querySelectorAll("use, img")) {
    const attribute = element.tagName.toLowerCase() === "img" ? "src" : "href";
    const value = element.getAttribute(attribute);
    if (value?.startsWith("./")) element.setAttribute(attribute, value.slice(1));
}
const connections = [
    { id: "personal", provider: "github", displayName: "Personal", repositoryUrl: "https://github.com/example/personal", ref: "main", workspacePath: "zeitberg.json" },
    { id: "trip", provider: "codeberg", displayName: "Summer trip", repositoryUrl: "https://codeberg.org/example/trip", ref: "main", workspacePath: "zeitberg.json" },
];
const workspaceController = Object.assign(Object.create(WorkspaceController.prototype), {
    locale, isLocalMode: false,
    configService: { loadWorkspaceCredential: () => "fictional-preview" },
    elements: {
        workspaceListEl: document.querySelector("#workspaceList"),
        workspaceAddSectionEl: document.querySelector("#workspaceAddSection"),
        workspaceShareBtn: document.querySelector("#workspaceShareBtn"),
    },
    runtime: {
        workspaceRegistry: { list: () => connections },
        sessions: { sessions: new Map([["personal", { ready: true, runtime: { workspace: { hasComponent: () => true } } }]]),
            unavailable: new Map([["trip", "Reconnect to load this workspace."]]), describeConnection: (id) => id === "personal" ? inventory : "" },
    },
});
workspaceController.renderWorkspaceRegistry();
const cardController = Object.assign(Object.create(OnboardingController.prototype), {
    app: { workspaceDialog, workspaceRepositoryInput: document.querySelector("#workspaceRepository") },
    open() {}, // The fixture never authorizes or contacts a provider.
});
cardController.mountConnectionCards();
document.querySelector("#workspaceManualConnection [data-connection-close]").addEventListener("click", () => document.querySelector("#workspaceManualConnection").close());
document.querySelector("#workspaceSetupCards").addEventListener("click", (event) => {
    // Only local custom-form disclosure is interactive in this visual fixture.
    const button = event.target.closest("button");
    if (button?.dataset.setupAction !== "custom") event.stopImmediatePropagation();
}, true);
const controller = Object.assign(Object.create(OnboardingController.prototype), {
    app: { locale, workspaceRegistry: { findByLocator: (locator) => locator.repositoryUrl.endsWith("/personal") ? connections[0] : null } }, busy: false,
    provider: "github", selectedRepositories: new Set(), addSelected: document.querySelector("#providerAddSelected"),
    search: document.querySelector("#providerRepositorySearch"),
    onlyWorkspaces: document.querySelector("#providerWorkspacesOnly"),
    list: document.querySelector("#providerRepositoryList"),
    status: document.querySelector("#providerScanStatus"),
    items: [
        { name: "Personal", ref: "main", detail: "Time · Tasks · Expenses", status: "ready" },
        { name: "Summer trip with friends", ref: "main", detail: "Expenses", status: "ready" },
        { name: "A workspace with a particularly long name", ref: "main", detail: "Configuration needs attention", status: "attention" },
    ].map((item, index) => ({ ...item, repositoryUrl: `https://github.com/example/${index === 0 ? "personal" : `workspace-${index}`}` })),
    connect() {},
});
controller.render();
initializeContextHelp(document);
locale.applyDocument(document);

/** Selects a static production dialog stage; no authorization or writes occur. @returns {void} */
function render() {
    const state = document.querySelector("#previewState").value;
    const sharing = state.startsWith("share");
    dialog.hidden = state === "workspaces" || sharing || state === "loading";
    loading.hidden = state !== "loading";
    if (state === "loading") {
        const sample = Object.assign(Object.create(WorkspaceSessions.prototype), {
            app: { locale, workspaceRegistry: { list: () => [...connections, { id: "family", displayName: "Family" }] } },
            sessions: new Map([["personal", { ready: true, name: "Personal" }]]),
            unavailable: new Map([["trip", "Reconnect to load this workspace."]]),
            loadLabels: new Map([["family", "Loading expenses…"]]), describeConnection: () => inventory,
        });
        document.querySelector("#loadProgress").value = .7;
        sample.renderLoadingConnections();
    }
    workspaceDialog.hidden = state !== "workspaces";
    shareDialog.hidden = !sharing;
    shareDialog.setAttribute("open", "");
    locale.setLocale(document.querySelector("#previewLanguage").value);
    locale.applyDocument(document);
    document.querySelector("#workspaceShareDetails").textContent = "Summer trip";
    document.querySelector("#workspaceCopyCapabilityBtn").disabled = state === "share-oauth";
    document.querySelector("#workspaceShareAccessNote").hidden = state !== "share-oauth";
    document.querySelector("#workspaceShareAccessReason").textContent = locale.t("workspace.oauthNotShareable");
    workspaceDialog.setAttribute("open", "");
    document.body.classList.add("app-mode");
    document.documentElement.classList.add("app-mode");
    document.documentElement.dataset.theme = document.querySelector("#previewTheme").value;
    document.documentElement.classList.toggle("ui-narrow", innerWidth < 700);
    document.querySelector("#providerChooserTitle").textContent = state === "create" ? "Create private workspace" : "Connect with GitHub";
    document.querySelector("#providerChooserNote").textContent = locale.t(state === "create" ? "onboarding.createNote" : "onboarding.chooserNote");
    document.querySelector("#providerAuthorizeForm").hidden = true;
    document.querySelector("#providerCreateForm").hidden = state !== "create";
    document.querySelector("#providerRepositories").hidden = state !== "repositories";
    document.querySelector("#githubDevicePanel").hidden = state !== "device";
    document.querySelector("#githubDeviceControls").hidden = false;
    document.querySelector("#githubDeviceCode").value = "DEMO-CODE";
    document.querySelector("#githubDeviceStatus").textContent = "Waiting for GitHub authorization…";
    document.querySelector("#providerWorkspaceName").value = "My workspace";
    document.querySelector("#providerGitHubAccess").hidden = false;
    document.querySelector("#providerGitHubAccessNote").textContent = "Choose which repositories Zeitberg can access. Newly granted repositories appear when you return.";
}
document.querySelector("#previewState").addEventListener("change", render);
document.querySelector("#previewTheme").addEventListener("change", render);
document.querySelector("#previewLanguage").addEventListener("change", render);
window.addEventListener("resize", render);
document.querySelector("#providerRepositorySearch").addEventListener("input", () => controller.render());
document.addEventListener("submit", (event) => event.preventDefault());
// Links/buttons are visually real but inert: this fixture cannot authorize or create repositories.
dialog.addEventListener("click", (event) => {
    if (event.target.closest("a, button:not([popovertarget])")) event.preventDefault();
});
render();
