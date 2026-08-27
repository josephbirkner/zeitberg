import { parseGitHubRepositoryId } from "./datasource.js";
import { ProjectList } from "./model.js";
import { isTodoIssuePublishable } from "./todo.view.js";
import { utcNowIso } from "./utils.js";

/**
 * @typedef {Object} ProjectBindingPlan
 * @description One explicit connect or detach decision required before a project repository binding can be persisted.
 * @property {number} index Stable dialog-local decision index.
 * @property {"connect" | "detach"} kind
 * @property {string} projectKey
 * @property {string} projectName
 * @property {string} repository
 * @property {number} localCount Source-free local tasks currently assigned to the project.
 * @property {number} linkedCount Existing GitHub issue tasks associated with the repository.
 * @property {number} pendingCount Locally persisted tasks still awaiting first issue publication.
 */

/**
 * @typedef {Object} ProjectDialogOptions
 * @property {import("./store.js").EntryStore} store
 * @property {import("./store.js").TodoStore} todoStore
 * @property {import("./datasource.js").DataSource} dataSource
 * @property {import("./locale.js").LocaleService} locale
 * @property {Object} elements
 * @property {HTMLDialogElement} elements.dialog
 * @property {HTMLFormElement} elements.form
 * @property {HTMLButtonElement} elements.closeBtn
 * @property {HTMLButtonElement} elements.cancelBtn
 * @property {HTMLButtonElement} elements.addBtn
 * @property {HTMLElement} elements.list
 * @property {HTMLDialogElement} elements.bindingDialog
 * @property {HTMLFormElement} elements.bindingForm
 * @property {HTMLButtonElement} elements.bindingCloseBtn
 * @property {HTMLButtonElement} elements.bindingCancelBtn
 * @property {HTMLElement} elements.bindingList
 * @property {(message: string, timeout?: number, tone?: "error" | "success") => void} onToast
 * @property {(isBusy: boolean) => void} onBusy
 * @property {(projectList: import("./model.js").ProjectList) => void} onProjectsSaved
 * @property {(options: {reloadGitHub: boolean}) => Promise<void>} onTodosSaved
 * @property {() => boolean} hasUnsavedTodos
 */

/**
 * Manages the shared project/section taxonomy and persists it through the shared save pipeline.
 * Stable keys and hidden external-provider references survive display-name edits; new keys are generated only when new rows are saved.
 */
export class ProjectDialog {
    /**
     * Captures references to UI elements and callback hooks.
     * Keeps the main UI flow and data loading coordinated.
     * @param {ProjectDialogOptions} options
     */
    constructor(options) {
        this.store = options.store;
        this.todoStore = options.todoStore;
        this.dataSource = options.dataSource;
        this.locale = options.locale;
        this.dialog = options.elements.dialog;
        this.form = options.elements.form;
        this.closeBtn = options.elements.closeBtn;
        this.cancelBtn = options.elements.cancelBtn;
        this.addBtn = options.elements.addBtn;
        this.listEl = options.elements.list;
        this.bindingDialog = options.elements.bindingDialog;
        this.bindingForm = options.elements.bindingForm;
        this.bindingCloseBtn = options.elements.bindingCloseBtn;
        this.bindingCancelBtn = options.elements.bindingCancelBtn;
        this.bindingListEl = options.elements.bindingList;
        this.onToast = options.onToast;
        this.onBusy = options.onBusy;
        this.onProjectsSaved = options.onProjectsSaved;
        this.onTodosSaved = options.onTodosSaved;
        this.hasUnsavedTodos = options.hasUnsavedTodos;
        this.bindingDecisionResolve = null;

        this.bindEvents();
    }

    /**
     * Updates the data source after login or mode changes.
     * Keeps the main UI flow and data loading coordinated.
     * @param {import("./datasource.js").DataSource} dataSource
     * @returns {void}
     */
    setDataSource(dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Rebuilds an open project editor with labels and sort order from the active locale.
     * The language setting lives in a separate modal, so no in-progress project form can be discarded by this refresh.
     * @returns {void}
     */
    refreshLocale() {
        if (this.dialog.open) this.renderList();
    }

    /**
     * Wires dialog controls to local row creation and repository persistence.
     * @returns {void}
     */
    bindEvents() {
        this.closeBtn.addEventListener("click", () => this.close());
        this.cancelBtn.addEventListener("click", () => this.close());
        this.dialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.close();
        });
        this.addBtn.addEventListener("click", () => this.addProjectRow());
        this.form.addEventListener("submit", (ev) => this.handleSubmit(ev));
        this.bindingCloseBtn.addEventListener("click", () => this.resolveBindingDecision(null));
        this.bindingCancelBtn.addEventListener("click", () => this.resolveBindingDecision(null));
        this.bindingDialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            this.resolveBindingDecision(null);
        });
        this.bindingForm.addEventListener("submit", (ev) => {
            ev.preventDefault();
            const decisions = new Map();
            for (const select of this.bindingListEl.querySelectorAll("select[data-binding-plan]")) {
                if (select instanceof HTMLSelectElement) {
                    decisions.set(Number(select.dataset.bindingPlan), select.value);
                }
            }
            this.resolveBindingDecision(decisions);
        });
    }

    /**
     * Populates the list and opens the modal dialog.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    open() {
        this.renderList();
        if (!this.dialog.open) this.dialog.showModal();
        queueMicrotask(() => {
            const input = this.listEl.querySelector(".project-name");
            if (input instanceof HTMLInputElement) input.focus();
        });
    }

    /**
     * Closes the dialog if it is currently open.
     * Keeps the main UI flow and data loading coordinated.
     * @returns {void}
     */
    close() {
        if (this.bindingDialog.open) this.resolveBindingDecision(null);
        if (this.dialog.open) this.dialog.close();
    }

    /**
     * Rebuilds nested project and section rows from the authoritative store model.
     * @returns {void}
     */
    renderList() {
        this.listEl.innerHTML = "";
        const projects = this.store.getProjects();
        const sorted = projects.slice().sort((a, b) => {
            if (a.archived !== b.archived) return a.archived ? 1 : -1;
            return this.locale.compare(a.name, b.name);
        });

        const frag = document.createDocumentFragment();
        for (const project of sorted) {
            frag.append(this.buildProjectRow(project));
        }
        this.listEl.append(frag);
    }

    /**
     * Adds a blank root project whose key will be reserved from its first saved name.
     * @returns {void}
     */
    addProjectRow() {
        const row = this.buildProjectRow({
            key: "",
            name: "",
            color: "#7c5cff",
            billable: false,
            archived: false,
            sections: [],
            externalRefs: [],
        });
        this.listEl.append(row);
        const input = row.querySelector(".project-name");
        if (input instanceof HTMLInputElement) input.focus();
    }

    /**
     * Builds one project card with default metadata, its optional GitHub issue repository, and a nested section editor.
     * The dataset retains an existing stable key while the explicit provider controls edit only GitHub-owned references and preserve unrelated importer metadata.
     * @param {{key: string, name: string, color: string, billable: boolean, archived: boolean, sections: Array<Object>, externalRefs?: import("./model.js").ExternalReferenceRaw[], getExternalReference?: (provider: string) => import("./model.js").ExternalReferenceRaw | null, listSections?: () => import("./model.js").Section[]}} project
     * @returns {HTMLElement}
     */
    buildProjectRow(project) {
        const row = document.createElement("div");
        row.className = "project-row";
        row.dataset.projectKey = project.key || "";

        const fields = document.createElement("div");
        fields.className = "project-fields";

        const nameWrap = document.createElement("label");
        nameWrap.className = "project-field";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = this.locale.t("projects.name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "project-name";
        nameInput.value = project.name || "";
        nameInput.spellcheck = false;
        nameWrap.append(nameSpan, nameInput);

        const colorWrap = document.createElement("label");
        colorWrap.className = "project-field";
        const colorSpan = document.createElement("span");
        colorSpan.textContent = this.locale.t("projects.color");
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "project-color";
        colorInput.value = /^#[0-9a-f]{6}$/i.test(project.color || "") ? project.color : "#7c5cff";
        colorWrap.append(colorSpan, colorInput);

        const billableWrap = document.createElement("label");
        billableWrap.className = "checkbox project-field";
        const billableInput = document.createElement("input");
        billableInput.type = "checkbox";
        billableInput.className = "project-billable";
        billableInput.checked = project.billable === true;
        const billableSpan = document.createElement("span");
        billableSpan.textContent = this.locale.t("projects.billable");
        billableWrap.append(billableInput, billableSpan);

        const archivedWrap = document.createElement("label");
        archivedWrap.className = "checkbox project-field";
        const archivedInput = document.createElement("input");
        archivedInput.type = "checkbox";
        archivedInput.className = "project-archived";
        archivedInput.checked = project.archived === true;
        const archivedSpan = document.createElement("span");
        archivedSpan.textContent = this.locale.t("projects.archived");
        archivedWrap.append(archivedInput, archivedSpan);

        fields.append(nameWrap, colorWrap, billableWrap, archivedWrap);

        const githubBinding = document.createElement("div");
        githubBinding.className = "project-github-binding";
        const githubWrap = document.createElement("label");
        githubWrap.className = "project-field project-github-field";
        const githubLabel = document.createElement("span");
        githubLabel.textContent = this.locale.t("projects.githubRepository");
        const githubInput = document.createElement("input");
        githubInput.type = "search";
        githubInput.className = "project-github-repository";
        githubInput.placeholder = "owner/repository";
        githubInput.spellcheck = false;
        githubInput.autocomplete = "off";
        githubInput.setAttribute("autocapitalize", "none");
        githubInput.value = project.getExternalReference
            ? project.getExternalReference("github")?.id || ""
            : (project.externalRefs || []).find((reference) => reference.provider === "github")?.id || "";
        githubWrap.append(githubLabel, githubInput);

        const githubCheckBtn = document.createElement("button");
        githubCheckBtn.type = "button";
        githubCheckBtn.className = "btn btn-secondary project-github-check";
        githubCheckBtn.textContent = this.locale.t("projects.githubCheck");
        const githubStatus = document.createElement("div");
        githubStatus.className = "project-github-status muted";
        githubStatus.setAttribute("role", "status");
        githubInput.addEventListener("input", () => {
            githubStatus.textContent = "";
            githubStatus.classList.remove("is-error", "is-success");
        });
        githubCheckBtn.addEventListener("click", () => {
            void this.checkGitHubRepository(githubInput, githubStatus);
        });
        githubBinding.append(githubWrap, githubCheckBtn, githubStatus);

        const sectionsHead = document.createElement("div");
        sectionsHead.className = "project-sections-head";
        const sectionsTitle = document.createElement("span");
        sectionsTitle.textContent = this.locale.t("projects.sections");
        const addSectionBtn = document.createElement("button");
        addSectionBtn.type = "button";
        addSectionBtn.className = "btn btn-secondary project-add-section";
        addSectionBtn.textContent = this.locale.t("projects.addSection");
        sectionsHead.append(sectionsTitle, addSectionBtn);

        const sectionsEl = document.createElement("div");
        sectionsEl.className = "project-sections";
        const sections = project.listSections ? project.listSections() : project.sections || [];
        for (const section of sections) {
            sectionsEl.append(this.buildSectionRow(section));
        }
        addSectionBtn.addEventListener("click", () => {
            const sectionRow = this.buildSectionRow({
                key: "",
                name: "",
                color: null,
                billable: null,
                archived: false,
            });
            sectionsEl.append(sectionRow);
            const input = sectionRow.querySelector(".section-name");
            if (input instanceof HTMLInputElement) input.focus();
        });

        row.append(fields, githubBinding, sectionsHead, sectionsEl);
        return row;
    }

    /**
     * Builds controls for one section and its optional color/billable overrides.
     * An unchecked custom-color switch and the “Inherit” billable choice explicitly serialize as null.
     * @param {{key: string, name: string, color: string | null, billable: boolean | null, archived: boolean, externalRefs?: import("./model.js").ExternalReferenceRaw[], getExternalReference?: (provider: string) => import("./model.js").ExternalReferenceRaw | null}} section
     * @returns {HTMLElement}
     */
    buildSectionRow(section) {
        const row = document.createElement("div");
        row.className = "section-row";
        row.dataset.sectionKey = section.key || "";

        const nameWrap = document.createElement("label");
        nameWrap.className = "project-field section-name-field";
        const nameLabel = document.createElement("span");
        nameLabel.textContent = this.locale.t("projects.name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "section-name";
        nameInput.value = section.name || "";
        nameInput.spellcheck = false;
        nameWrap.append(nameLabel, nameInput);

        const colorWrap = document.createElement("label");
        colorWrap.className = "project-field section-color-field";
        const colorLabel = document.createElement("span");
        colorLabel.textContent = this.locale.t("projects.colorOverride");
        const colorControls = document.createElement("span");
        colorControls.className = "section-color-controls";
        const useColor = document.createElement("input");
        useColor.type = "checkbox";
        useColor.className = "section-use-color";
        useColor.checked = typeof section.color === "string" && Boolean(section.color);
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "section-color";
        colorInput.value = /^#[0-9a-f]{6}$/i.test(section.color || "") ? String(section.color) : "#7c5cff";
        colorInput.disabled = !useColor.checked;
        useColor.addEventListener("change", () => {
            colorInput.disabled = !useColor.checked;
        });
        colorControls.append(useColor, colorInput);
        colorWrap.append(colorLabel, colorControls);

        const billableWrap = document.createElement("label");
        billableWrap.className = "project-field";
        const billableLabel = document.createElement("span");
        billableLabel.textContent = this.locale.t("projects.billable");
        const billableSelect = document.createElement("select");
        billableSelect.className = "section-billable";
        billableSelect.append(
            new Option(this.locale.t("projects.inherit"), "inherit"),
            new Option(this.locale.t("projects.billable"), "true"),
            new Option(this.locale.t("projects.notBillable"), "false"),
        );
        billableSelect.value = typeof section.billable === "boolean" ? String(section.billable) : "inherit";
        billableWrap.append(billableLabel, billableSelect);

        const archivedWrap = document.createElement("label");
        archivedWrap.className = "checkbox project-field";
        const archivedInput = document.createElement("input");
        archivedInput.type = "checkbox";
        archivedInput.className = "section-archived";
        archivedInput.checked = section.archived === true;
        const archivedLabel = document.createElement("span");
        archivedLabel.textContent = this.locale.t("projects.archived");
        archivedWrap.append(archivedInput, archivedLabel);

        const githubLabelWrap = document.createElement("label");
        githubLabelWrap.className = "project-field section-github-field";
        const githubLabelLabel = document.createElement("span");
        githubLabelLabel.textContent = this.locale.t("projects.githubLabel");
        const githubLabelInput = document.createElement("input");
        githubLabelInput.type = "text";
        githubLabelInput.className = "section-github-label";
        githubLabelInput.placeholder = this.locale.t("projects.githubLabelPlaceholder");
        githubLabelInput.spellcheck = false;
        githubLabelInput.autocomplete = "off";
        githubLabelInput.value = section.getExternalReference
            ? section.getExternalReference("github-label")?.id || ""
            : (section.externalRefs || []).find((reference) => reference.provider === "github-label")?.id || "";
        githubLabelWrap.append(githubLabelLabel, githubLabelInput);

        row.append(nameWrap, colorWrap, billableWrap, archivedWrap, githubLabelWrap);
        return row;
    }

    /**
     * Replaces one provider-specific reference while preserving every unrelated integration identifier.
     * An empty identifier removes that provider from the returned list, which gives repository and label controls explicit detach semantics.
     * @param {import("./model.js").ExternalReferenceRaw[]} references Existing normalized references.
     * @param {string} provider Provider name to replace.
     * @param {string} id New provider identifier, or an empty string to remove it.
     * @returns {import("./model.js").ExternalReferenceRaw[]}
     */
    replaceExternalReference(references, provider, id) {
        const normalizedProvider = String(provider || "").trim().toLowerCase();
        const normalizedId = String(id || "").trim();
        const retained = (Array.isArray(references) ? references : [])
            .filter((reference) => reference.provider !== normalizedProvider)
            .map((reference) => ({ ...reference }));
        if (normalizedId) retained.push({ provider: normalizedProvider, id: normalizedId });
        return retained;
    }

    /**
     * Verifies that the active GitHub credential can read a proposed issue repository and reports the limits of non-destructive permission probing.
     * GitHub does not expose fine-grained issue-write permission reliably through repository metadata, so write access is intentionally confirmed only by the first user-requested issue save.
     * @param {HTMLInputElement} input Repository input containing an owner/repository identifier.
     * @param {HTMLElement} statusEl Inline status destination belonging to the same project row.
     * @returns {Promise<boolean>} True when the repository is readable and Issues are enabled.
     */
    async checkGitHubRepository(input, statusEl) {
        statusEl.classList.remove("is-error", "is-success");
        let repository;
        try {
            const target = parseGitHubRepositoryId(input.value);
            repository = `${target.owner}/${target.repo}`;
            input.value = repository;
        } catch {
            statusEl.textContent = this.locale.t("projects.githubInvalidRepository");
            statusEl.classList.add("is-error");
            return false;
        }
        if (!this.dataSource.supportsGitHubIssueSync()) {
            statusEl.textContent = this.locale.t("projects.githubUnavailable");
            statusEl.classList.add("is-error");
            return false;
        }

        this.onBusy(true);
        try {
            const info = await this.dataSource.fetchGitHubRepositoryInfo(repository);
            if (info?.has_issues === false) {
                statusEl.textContent = this.locale.t("projects.githubIssuesDisabled");
                statusEl.classList.add("is-error");
                return false;
            }
            const visibility = info?.private === true
                ? this.locale.t("projects.githubPrivate")
                : this.locale.t("projects.githubPublic");
            statusEl.textContent = this.locale.t("projects.githubVerified", { visibility });
            statusEl.classList.add("is-success");
            return true;
        } catch (error) {
            statusEl.textContent = this.locale.t("projects.githubCheckFailed", {
                error: this.locale.localizeError(error),
            });
            statusEl.classList.add("is-error");
            return false;
        } finally {
            this.onBusy(false);
        }
    }

    /**
     * Reads nested controls, validates names/colors, reserves keys for new definitions, and preserves existing external references.
     * @returns {{projects: import("./model.js").ProjectRaw[], error: string | null}}
     */
    collectProjects() {
        const rows = Array.from(this.listEl.querySelectorAll(".project-row"));
        const projects = [];
        const seenNames = new Set();
        const usedProjectKeys = new Set(
            rows.map((row) => (row instanceof HTMLElement ? row.dataset.projectKey || "" : "")).filter(Boolean),
        );
        const currentByKey = new Map(this.store.getProjects().map((project) => [project.key, project]));

        for (const row of rows) {
            const nameInput = row.querySelector(".project-name");
            const colorInput = row.querySelector(".project-color");
            const billableInput = row.querySelector(".project-billable");
            const archivedInput = row.querySelector(".project-archived");
            const githubRepositoryInput = row.querySelector(".project-github-repository");
            if (!(nameInput instanceof HTMLInputElement)) continue;
            if (!(colorInput instanceof HTMLInputElement)) continue;
            if (!(billableInput instanceof HTMLInputElement)) continue;
            if (!(archivedInput instanceof HTMLInputElement)) continue;
            if (!(githubRepositoryInput instanceof HTMLInputElement)) continue;

            const name = nameInput.value.trim();
            if (!name) {
                return { projects: [], error: this.locale.t("projects.everyProjectName") };
            }
            const nameIdentity = name.toLowerCase();
            if (seenNames.has(nameIdentity)) {
                return { projects: [], error: this.locale.t("projects.duplicateProject", { name }) };
            }
            seenNames.add(nameIdentity);

            const color = colorInput.value.trim();
            if (!/^#[0-9a-f]{6}$/i.test(color)) {
                return { projects: [], error: this.locale.t("projects.invalidColor", { name }) };
            }

            const existingKey = row instanceof HTMLElement ? row.dataset.projectKey || "" : "";
            const projectKey = existingKey || ProjectList.reserveKey(name, usedProjectKeys);
            const currentProject = currentByKey.get(projectKey);
            let githubRepository = githubRepositoryInput.value.trim();
            if (githubRepository) {
                try {
                    const target = parseGitHubRepositoryId(githubRepository);
                    githubRepository = `${target.owner}/${target.repo}`;
                } catch {
                    return {
                        projects: [],
                        error: this.locale.t("projects.githubInvalidForProject", { project: name }),
                    };
                }
            }
            const currentSectionsByKey = new Map(
                (currentProject?.listSections() || []).map((section) => [section.key, section]),
            );
            const sectionRows = Array.from(row.querySelectorAll(".section-row"));
            const usedSectionKeys = new Set(
                sectionRows
                    .map((sectionRow) => (sectionRow instanceof HTMLElement ? sectionRow.dataset.sectionKey || "" : ""))
                    .filter(Boolean),
            );
            const seenSectionNames = new Set();
            const seenGitHubLabels = new Set();
            const sections = [];

            for (const sectionRow of sectionRows) {
                if (!(sectionRow instanceof HTMLElement)) continue;
                const sectionNameInput = sectionRow.querySelector(".section-name");
                const useColorInput = sectionRow.querySelector(".section-use-color");
                const sectionColorInput = sectionRow.querySelector(".section-color");
                const sectionBillableInput = sectionRow.querySelector(".section-billable");
                const sectionArchivedInput = sectionRow.querySelector(".section-archived");
                const sectionGitHubLabelInput = sectionRow.querySelector(".section-github-label");
                if (!(sectionNameInput instanceof HTMLInputElement)) continue;
                if (!(useColorInput instanceof HTMLInputElement)) continue;
                if (!(sectionColorInput instanceof HTMLInputElement)) continue;
                if (!(sectionBillableInput instanceof HTMLSelectElement)) continue;
                if (!(sectionArchivedInput instanceof HTMLInputElement)) continue;
                if (!(sectionGitHubLabelInput instanceof HTMLInputElement)) continue;

                const sectionName = sectionNameInput.value.trim();
                if (!sectionName) {
                    return { projects: [], error: this.locale.t("projects.everySectionName", { project: name }) };
                }
                const sectionNameIdentity = sectionName.toLowerCase();
                if (seenSectionNames.has(sectionNameIdentity)) {
                    return {
                        projects: [],
                        error: this.locale.t("projects.duplicateSection", { project: name, section: sectionName }),
                    };
                }
                seenSectionNames.add(sectionNameIdentity);
                const existingSectionKey = sectionRow.dataset.sectionKey || "";
                const sectionKey = existingSectionKey || ProjectList.reserveKey(sectionName, usedSectionKeys);
                const sectionColor = useColorInput.checked ? sectionColorInput.value.trim() : null;
                if (sectionColor !== null && !/^#[0-9a-f]{6}$/i.test(sectionColor)) {
                    return {
                        projects: [],
                        error: this.locale.t("projects.invalidSectionColor", { project: name, section: sectionName }),
                    };
                }
                const billableValue = sectionBillableInput.value;
                const sectionBillable = billableValue === "true" ? true : billableValue === "false" ? false : null;
                const githubLabel = githubRepository ? sectionGitHubLabelInput.value.trim() : "";
                if (githubLabel.length > 50 || /[\r\n]/.test(githubLabel)) {
                    return {
                        projects: [],
                        error: this.locale.t("projects.githubInvalidLabel", {
                            project: name,
                            section: sectionName,
                        }),
                    };
                }
                const githubLabelIdentity = githubLabel.toLowerCase();
                if (githubLabelIdentity && seenGitHubLabels.has(githubLabelIdentity)) {
                    return {
                        projects: [],
                        error: this.locale.t("projects.githubDuplicateLabel", {
                            label: githubLabel,
                            project: name,
                        }),
                    };
                }
                if (githubLabelIdentity) seenGitHubLabels.add(githubLabelIdentity);
                sections.push({
                    archived: sectionArchivedInput.checked,
                    billable: sectionBillable,
                    color: sectionColor,
                    external_refs: this.replaceExternalReference(
                        currentSectionsByKey.get(sectionKey)?.externalRefs || [],
                        "github-label",
                        githubLabel,
                    ),
                    key: sectionKey,
                    name: sectionName,
                });
            }

            projects.push({
                key: projectKey,
                name,
                color,
                billable: billableInput.checked,
                archived: archivedInput.checked,
                sections,
                external_refs: this.replaceExternalReference(
                    currentProject?.externalRefs || [],
                    "github",
                    githubRepository,
                ),
            });
        }

        return { projects, error: null };
    }

    /**
     * Returns a project's configured GitHub issue repository without exposing external-reference storage details to migration code.
     * @param {import("./model.js").Project | null | undefined} project Project model to inspect.
     * @returns {string}
     */
    githubRepositoryForProject(project) {
        return project?.getExternalReference("github")?.id || "";
    }

    /**
     * Builds a deterministic section-to-label signature used to notice integration edits that require a later issue synchronization.
     * @param {import("./model.js").Project | null | undefined} project Project model to inspect.
     * @returns {string}
     */
    githubSectionSignature(project) {
        if (!project) return "";
        return JSON.stringify(
            project
                .listSections()
                .map((section) => [section.key, section.getExternalReference("github-label")?.id || ""])
                .filter((entry) => entry[1])
                .sort((left, right) => left[0].localeCompare(right[0])),
        );
    }

    /**
     * Reports whether repository ownership or section-label mapping changed between two project inventories.
     * Ordinary project names, colors, billing defaults, and archive changes do not need GitHub migration handling.
     * @param {ProjectList} currentList Persisted project inventory.
     * @param {ProjectList} nextList Proposed project inventory.
     * @returns {boolean}
     */
    githubConfigurationChanged(currentList, nextList) {
        const keys = new Set([
            ...currentList.list().map((project) => project.key),
            ...nextList.list().map((project) => project.key),
        ]);
        for (const key of keys) {
            const current = currentList.getProjectByKey(key);
            const next = nextList.getProjectByKey(key);
            if (this.githubRepositoryForProject(current) !== this.githubRepositoryForProject(next)) return true;
            if (this.githubSectionSignature(current) !== this.githubSectionSignature(next)) return true;
        }
        return false;
    }

    /**
     * Describes every repository connect/detach operation and counts the task records affected by each possible decision.
     * Repository replacements deliberately become one detach and one connect plan so retaining old issues and publishing local copies remain independent choices.
     * @param {ProjectList} currentList Persisted project inventory.
     * @param {ProjectList} nextList Proposed project inventory.
     * @returns {ProjectBindingPlan[]}
     */
    buildBindingPlans(currentList, nextList) {
        /** @type {ProjectBindingPlan[]} */
        const plans = [];
        const keys = new Set([
            ...currentList.list().map((project) => project.key),
            ...nextList.list().map((project) => project.key),
        ]);
        for (const projectKey of keys) {
            const currentProject = currentList.getProjectByKey(projectKey);
            const nextProject = nextList.getProjectByKey(projectKey);
            const oldRepository = this.githubRepositoryForProject(currentProject);
            const newRepository = this.githubRepositoryForProject(nextProject);
            if (oldRepository === newRepository) continue;
            const todos = this.todoStore.getTodos().filter((todo) => todo.projectKey === projectKey);
            const localCount = todos.filter((todo) => !todo.source && isTodoIssuePublishable(todo)).length;
            const linkedTo = (repository) =>
                todos.filter(
                    (todo) =>
                        String(todo.source?.provider || "").toLowerCase() === "github" &&
                        todo.source?.project_id === repository,
                ).length;
            const pendingFor = (repository) =>
                todos.filter(
                    (todo) =>
                        String(todo.source?.provider || "").toLowerCase() === "github-pending" &&
                        todo.source?.project_id === repository,
                ).length;
            const projectName = nextProject?.name || currentProject?.name || projectKey;
            if (oldRepository) {
                plans.push({
                    index: plans.length,
                    kind: "detach",
                    projectKey,
                    projectName,
                    repository: oldRepository,
                    localCount,
                    linkedCount: linkedTo(oldRepository),
                    pendingCount: pendingFor(oldRepository),
                });
            }
            if (newRepository) {
                plans.push({
                    index: plans.length,
                    kind: "connect",
                    projectKey,
                    projectName,
                    repository: newRepository,
                    localCount,
                    linkedCount: linkedTo(newRepository),
                    pendingCount: pendingFor(newRepository),
                });
            }
        }
        return plans;
    }

    /**
     * Renders a compact migration choice for every changed repository binding and waits for explicit confirmation.
     * The recommended defaults retain data locally and never create issues, while the opt-in publish choice only marks eligible tasks for the next manual TODO save.
     * @param {ProjectBindingPlan[]} plans Connect and detach operations to preview.
     * @returns {Promise<Map<number, string> | null>} Selected choices keyed by plan index, or null when cancelled.
     */
    requestBindingDecisions(plans) {
        this.bindingListEl.innerHTML = "";
        const fragment = document.createDocumentFragment();
        for (const plan of plans) {
            const row = document.createElement("section");
            row.className = "project-binding-row";
            const heading = document.createElement("strong");
            heading.textContent = this.locale.t(
                plan.kind === "connect" ? "projects.bindingConnectTitle" : "projects.bindingDetachTitle",
                { project: plan.projectName, repository: plan.repository },
            );
            const summary = document.createElement("p");
            summary.className = "muted";
            summary.textContent = this.locale.t(
                plan.kind === "connect" ? "projects.bindingConnectSummary" : "projects.bindingDetachSummary",
                {
                    linked: this.locale.formatNumber(plan.linkedCount),
                    local: this.locale.formatNumber(plan.localCount),
                    pending: this.locale.formatNumber(plan.pendingCount),
                },
            );
            const choice = document.createElement("select");
            choice.dataset.bindingPlan = String(plan.index);
            if (plan.kind === "connect") {
                choice.append(
                    new Option(this.locale.t("projects.bindingLeaveLocal"), "leave"),
                    new Option(this.locale.t("projects.bindingPublish"), "publish"),
                );
            } else {
                choice.append(
                    new Option(this.locale.t("projects.bindingRetain"), "retain"),
                    new Option(this.locale.t("projects.bindingRemove"), "remove"),
                );
            }
            row.append(heading, summary, choice);
            fragment.append(row);
        }
        this.bindingListEl.append(fragment);
        if (!this.bindingDialog.open) this.bindingDialog.showModal();
        queueMicrotask(() => {
            const first = this.bindingListEl.querySelector("select");
            if (first instanceof HTMLSelectElement) first.focus();
        });
        return new Promise((resolve) => {
            this.bindingDecisionResolve = resolve;
        });
    }

    /**
     * Completes the active migration-preview promise exactly once and closes its modal.
     * @param {Map<number, string> | null} decision Confirmed choices or null for cancellation.
     * @returns {void}
     */
    resolveBindingDecision(decision) {
        const resolve = this.bindingDecisionResolve;
        this.bindingDecisionResolve = null;
        if (this.bindingDialog.open) this.bindingDialog.close();
        if (resolve) resolve(decision);
    }

    /**
     * Checks every newly connected repository before displaying migration choices.
     * A metadata read confirms repository visibility and that Issues are enabled without making a test issue or otherwise mutating upstream state.
     * @param {ProjectBindingPlan[]} plans Connect and detach operations to validate.
     * @returns {Promise<void>}
     */
    async validateNewRepositories(plans) {
        const repositories = [...new Set(plans.filter((plan) => plan.kind === "connect").map((plan) => plan.repository))];
        if (!repositories.length) return;
        if (!this.dataSource.supportsGitHubIssueSync()) {
            throw new Error(this.locale.t("projects.githubUnavailable"));
        }
        for (const repository of repositories) {
            const info = await this.dataSource.fetchGitHubRepositoryInfo(repository);
            if (info?.has_issues === false) {
                throw new Error(this.locale.t("projects.githubIssuesDisabledFor", { repository }));
            }
        }
    }

    /**
     * Applies confirmed connect/detach decisions after switching the shared store to the proposed project inventory.
     * Detaching never touches upstream issues; connecting only marks source-free, publishable tasks for the next explicit TODO save.
     * @param {ProjectBindingPlan[]} plans Confirmed migration operations.
     * @param {Map<number, string>} decisions Choice values returned by the preview dialog.
     * @returns {void}
     */
    applyBindingDecisions(plans, decisions) {
        for (const plan of plans.filter((item) => item.kind === "detach")) {
            if (decisions.get(plan.index) === "remove") {
                this.todoStore.removeGitHubProjectTodos(plan.projectKey, plan.repository);
            } else {
                this.todoStore.materializeGitHubProjectTodos(plan.projectKey, plan.repository);
            }
        }
        for (const plan of plans.filter((item) => item.kind === "connect")) {
            if (decisions.get(plan.index) === "publish") {
                this.todoStore.markProjectTodosForGitHub(
                    plan.projectKey,
                    plan.repository,
                    isTodoIssuePublishable,
                );
            }
        }
        this.todoStore.refreshPendingGitHubBindings();
        this.todoStore.refreshGitHubTaskOverlays();
    }

    /**
     * Validates project input, previews repository ownership changes, and atomically saves every affected workspace document.
     * A failed commit restores both in-memory models; after a successful commit, newly connected issue collections are refreshed and pending publications remain dirty for the next manual TODO save.
     * @param {Event} ev
     * @returns {Promise<void>}
     */
    async handleSubmit(ev) {
        ev.preventDefault();
        const { projects, error } = this.collectProjects();
        if (error) {
            this.onToast(error, 4000);
            return;
        }

        const currentProjectList = this.store.getProjectList() || ProjectList.createEmpty();
        let projectList;
        try {
            projectList = ProjectList.fromRaw({
                generated_at: utcNowIso(),
                projects,
                schema_version: 2,
            });
        } catch (validationError) {
            this.onToast(this.locale.localizeError(validationError), 5000);
            return;
        }
        const githubChanged = this.githubConfigurationChanged(currentProjectList, projectList);
        if (githubChanged && this.hasUnsavedTodos()) {
            this.onToast(this.locale.t("projects.saveTodosFirst"), 5000);
            return;
        }
        const plans = this.buildBindingPlans(currentProjectList, projectList);

        if (plans.some((plan) => plan.kind === "connect")) {
            this.onBusy(true);
            try {
                await this.validateNewRepositories(plans);
            } catch (validationError) {
                this.onToast(this.locale.localizeError(validationError), 5000);
                return;
            } finally {
                this.onBusy(false);
            }
        }

        const decisions = plans.length ? await this.requestBindingDecisions(plans) : new Map();
        if (!decisions) return;

        const priorTodoState = this.todoStore.snapshotDocumentState();
        const priorTodoJson = JSON.stringify(priorTodoState);
        let persisted = false;
        this.onBusy(true);
        try {
            this.store.setProjectList(projectList);
            this.applyBindingDecisions(plans, decisions);
            const todoChanged = JSON.stringify(this.todoStore.snapshotDocumentState()) !== priorTodoJson;
            const nowIso = utcNowIso();
            projectList.generated_at = nowIso;
            const files = [{ path: this.dataSource.getProjectsPath(), content: projectList.toJson() }];
            if (todoChanged) {
                files.push({ path: this.dataSource.getTodosPath(), content: this.todoStore.serialize(nowIso) });
            }
            await this.dataSource.saveFiles(files, "Update projects");
            persisted = true;
            this.onProjectsSaved(projectList);
            this.close();
            if (githubChanged || todoChanged) {
                await this.onTodosSaved({ reloadGitHub: plans.some((plan) => plan.kind === "connect") });
            }
            this.onToast(this.locale.t("projects.saved"), 2400, "success");
        } catch (err) {
            if (!persisted) {
                this.store.setProjectList(currentProjectList);
                this.todoStore.restoreDocumentState(priorTodoState);
            }
            this.onToast(this.locale.localizeError(err), 5000);
        } finally {
            this.onBusy(false);
        }
    }
}
