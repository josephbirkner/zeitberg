import { addIsoDays, isoWeekStart, isoWeekdayIndex, utcNowIso } from "./utils.js";
import { WeekRequirements } from "./model.js";
import { WorkTimeConfig, EmployerAccount } from "./work-time.js";

/**
 * Owns the employer setup, daily leave table inside the week dialog.
 * Edits remain detached until OK saves the complete requirements document through the existing provider pipeline.
 */
export class WorkTimeDialog {
    /**
     * Captures the host's shared services without creating another provider-specific save path.
     * @param {import("./week.view.js").WeekView} host Timeline controller owning this dialog.
     */
    constructor(host) {
        this.host = host;
        this.root = /** @type {HTMLElement} */ (host.weekReqForm.querySelector("#workTimeEditor"));
        /** @type {import("./work-time.js").WorkTimeRaw} */
        this.draft = { schema_version: 3, generated_at: "", employers: [] };
        this.selectedId = "";
        this.week = "";
        this.saving = false;
        this.settingsOpen = false;
        this.errorEl = document.createElement("p");
        this.errorEl.className = "work-time-error";
        this.errorEl.setAttribute("role", "alert");
    }

    /**
     * Resolves localized copy for the work-account editor.
     * @param {string} key Work-time message suffix.
     * @returns {string} Display text.
     */
    t(key) { return this.host.locale.t(`workTime.${key}`); }

    /**
     * Builds a text-only element; user names and notes are never interpreted as markup.
     * @param {string} tag HTML tag.
     * @param {string} [text] Text content.
     * @param {string} [className] CSS class.
     * @returns {HTMLElement} New element.
     */
    element(tag, text = "", className = "") {
        const element = document.createElement(tag);
        element.textContent = text;
        element.className = className;
        return element;
    }

    /**
     * Creates a non-submit action with contained error reporting.
     * @param {string} text Accessible button text.
     * @param {() => void} action Click handler.
     * @returns {HTMLButtonElement} Action button.
     */
    button(text, action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-secondary";
        button.textContent = text;
        button.addEventListener("click", () => {
            try { action(); } catch (error) { this.showError(error); }
        });
        return button;
    }

    /**
     * Places validation feedback inside the modal, above its sticky action bar.
     * @param {unknown} error Error or empty string to clear.
     * @returns {void}
     */
    showError(error) {
        this.errorEl.textContent = error instanceof Error ? error.message : String(error || "");
        this.errorEl.hidden = !this.errorEl.textContent;
    }

    /**
     * Creates a labeled native input with typed draft updates and live accounting feedback.
     * @param {string} label Field label.
     * @param {string} type Native input type.
     * @param {string | number} value Initial value.
     * @param {(value: string) => void} update Draft setter.
     * @returns {HTMLLabelElement} Label containing its input.
     */
    field(label, type, value, update) {
        const wrapper = document.createElement("label");
        wrapper.append(this.element("span", label));
        const input = document.createElement("input");
        input.type = type;
        input.value = String(value);
        input.required = type === "number" || (type === "date" && label !== this.t("activeUntil")) || label === this.t("name");
        if (type === "number") input.step = "any";
        input.addEventListener("change", () => {
            update(input.value);
            this.refreshSummary();
        });
        wrapper.append(input);
        return wrapper;
    }

    /**
     * Starts a fresh detached editing session, preserving the last employer selection when available.
     * Historical weekly documents stay read-only until converted directly in their data repository.
     * @param {string} weekStart Displayed Monday.
     * @returns {void}
     */
    open(weekStart) {
        this.week = weekStart;
        const legacy = this.host.store.getWeekRequirements();
        this.draft = legacy.accounting?.toObject() || { schema_version: 3, generated_at: "", employers: [] };
        const active = new WorkTimeConfig(this.draft).activeEmployers(this.week);
        if (!active.some((account) => account.id === this.selectedId)) this.selectedId = active[0]?.id || this.draft.employers[0]?.id || "";
        this.render();
        if (!legacy.accounting && legacy.listWeeks().length) this.showError(this.t("legacyReadOnly"));
    }

    /**
     * Validates the detached editor draft without modifying loaded requirements.
     * @returns {WorkTimeConfig} Validated candidate.
     */
    candidate() {
        const config = new WorkTimeConfig(this.draft);
        config.validateProjects(this.host.store.getProjects().map((project) => project.key));
        return config;
    }

    /**
     * Rebuilds editor sections after structural edits; ordinary typing keeps focus and scroll intact.
     * @returns {void}
     */
    render() {
        const card = this.host.weekReqForm;
        const scrollTop = card.scrollTop;
        this.root.replaceChildren();
        const config = new WorkTimeConfig(this.draft);
        const bar = this.element("div", "", "work-time-toolbar");
        const selector = document.createElement("select");
        selector.setAttribute("aria-label", this.t("employer"));
        const activeIds = new Set(config.activeEmployers(this.week).map((account) => account.id));
        for (const employer of this.draft.employers) {
            const option = new Option(`${employer.name}${activeIds.has(employer.id) ? "" : ` (${this.t("outsideWeek")})`}`, employer.id);
            selector.add(option);
        }
        selector.value = this.selectedId;
        selector.addEventListener("change", () => { this.selectedId = selector.value; this.render(); });
        bar.append(selector, this.button(this.t("addEmployer"), () => {
            const start = this.week;
            const employer = WorkTimeConfig.newEmployer(crypto.randomUUID(), this.t("newEmployer"), start);
            this.draft.employers.push(employer);
            this.selectedId = employer.id;
            this.settingsOpen = true;
            this.render();
        }));
        this.root.append(bar);
        const employer = this.draft.employers.find((account) => account.id === this.selectedId);
        if (employer) {
            this.root.append(this.dayTable(employer, this.week, employer.days));
            this.root.append(this.settings(employer));
        }
        this.root.append(this.errorEl);
        this.refreshSummary();
        card.scrollTop = scrollTop;
    }

    /**
     * Builds the seven-day table with keyboard-accessible statuses and row-scoped bulk actions.
     * Non-working dates may be annotated but never consume vacation.
     * @param {import("./work-time.js").EmployerRaw} employer Account draft.
     * @param {string} weekStart Monday date.
     * @param {import("./work-time.js").WorkDayRaw[]} days Mutable sparse daily annotations.
     * @returns {HTMLElement} Table and bulk toolbar.
     */
    dayTable(employer, weekStart, days) {
        const section = this.element("section", "", "work-time-days");
        const selected = new Set();
        const toolbar = this.element("div", "", "work-time-toolbar");
        /** @type {Map<string, HTMLInputElement>} */
        const checks = new Map();
        /** @type {Map<string, HTMLSelectElement[]>} */
        const controls = new Map();
        /** @type {Map<string, HTMLElement[]>} */
        const hourCells = new Map();
        const status = this.statusSelect("work", this.t("bulkStatus"), () => {});
        const half = document.createElement("select");
        half.setAttribute("aria-label", this.t("bulkHalf"));
        for (const [value, key] of [["both", "fullDay"], ["0", "firstHalf"], ["1", "secondHalf"]]) half.add(new Option(this.t(key), value));
        toolbar.append(this.button(this.t("selectWorkdays"), () => {
            const account = new EmployerAccount(employer);
            for (const [date, checkbox] of checks) {
                checkbox.checked = account.scheduledHours(date) > 0;
                if (checkbox.checked) selected.add(date); else selected.delete(date);
            }
        }), status, half, this.button(this.t("applySelected"), () => {
            for (const date of selected) {
                for (let index = 0; index < 2; index += 1) {
                    if (half.value !== "both" && Number(half.value) !== index) continue;
                    const select = controls.get(date)[index];
                    select.value = status.value;
                    select.dispatchEvent(new Event("change"));
                }
            }
        }));
        section.append(toolbar, this.element("p", this.t("flexHelp"), "muted"));
        const table = this.element("table", "", "work-time-table");
        const head = this.element("tr");
        for (const key of ["select", "day", "scheduled", "firstHalf", "secondHalf", "required", "comment"]) {
            const th = this.element("th", this.t(key));
            th.setAttribute("scope", "col");
            head.append(th);
        }
        const thead = this.element("thead");
        thead.append(head);
        const tbody = this.element("tbody");
        for (let index = 0; index < 7; index += 1) {
            const date = addIsoDays(weekStart, index);
            const tr = this.element("tr");
            tr.dataset.date = date;
            const checkCell = this.element("td");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.setAttribute("aria-label", `${this.t("select")} ${date}`);
            checkbox.addEventListener("change", () => checkbox.checked ? selected.add(date) : selected.delete(date));
            checks.set(date, checkbox);
            checkCell.append(checkbox);
            const dayCell = this.element("th", this.host.locale.formatDate(this.host.timeContext.dateFromLocalDayMinutes(date, 0), this.host.timeContext.timeZone, { weekday: "short", day: "numeric", month: "short" }));
            dayCell.setAttribute("scope", "row");
            const scheduled = this.element("td", "", "work-time-hours");
            const required = this.element("td", "", "work-time-hours");
            scheduled.dataset.label = this.t("scheduled");
            required.dataset.label = this.t("required");
            hourCells.set(date, [scheduled, required]);
            tr.append(checkCell, dayCell, scheduled);
            const existing = days.find((day) => day.date === date) || { date, halves: ["work", "work"], comment: "" };
            /** @type {HTMLSelectElement[]} */
            const selects = [];
            for (let part = 0; part < 2; part += 1) {
                const cell = this.element("td");
                cell.className = "work-time-half";
                cell.dataset.label = this.t(part ? "secondHalf" : "firstHalf");
                const select = this.statusSelect(existing.halves[part], `${date} ${this.t(part ? "secondHalf" : "firstHalf")}`, (value) => {
                    let row = days.find((day) => day.date === date);
                    if (!row) { row = { date, halves: ["work", "work"], comment: "" }; days.push(row); }
                    row.halves[part] = value;
                    this.refreshSummary();
                });
                selects.push(select);
                cell.append(select);
                tr.append(cell);
            }
            controls.set(date, selects);
            tr.append(required);
            const commentCell = this.element("td");
            const comment = document.createElement("input");
            comment.value = existing.comment;
            comment.placeholder = this.t("comment");
            comment.setAttribute("aria-label", `${date} ${this.t("comment")}`);
            comment.addEventListener("input", () => {
                let row = days.find((day) => day.date === date);
                if (!row) { row = { date, halves: ["work", "work"], comment: "" }; days.push(row); }
                row.comment = comment.value;
                // Update only the note: rebuilding the summary on blur would remove a clicked overview shortcut.
                const booking = this.host.weekReqSummaryEl.querySelector(`.work-time-vacation-booking[data-date="${date}"]`);
                if (booking) {
                    let note = booking.querySelector(".work-time-vacation-comment");
                    if (!comment.value) note?.remove();
                    else {
                        if (!note) { note = this.element("span", "", "work-time-vacation-comment"); booking.append(note); }
                        note.textContent = comment.value;
                    }
                }
            });
            commentCell.append(comment);
            tr.append(commentCell);
            tbody.append(tr);
        }
        table.append(thead, tbody);
        const scroll = this.element("div", "", "work-time-table-scroll");
        scroll.append(table);
        section.append(scroll);
        section.addEventListener("accountingrefresh", () => {
            const account = new EmployerAccount({ ...employer, days });
            for (const [date, [scheduled, required]] of hourCells) {
                scheduled.textContent = this.host.locale.formatNumber(account.scheduledHours(date));
                required.textContent = this.host.locale.formatNumber(account.requiredHours(date));
            }
        });
        return section;
    }

    /**
     * Creates a half-day status selector with one mutually exclusive value.
     * @param {string} value Current status.
     * @param {string} label Accessible field name.
     * @param {(status: import("./work-time.js").LeaveStatus) => void} update Draft setter.
     * @returns {HTMLSelectElement} Native keyboard-accessible selector.
     */
    statusSelect(value, label, update) {
        const select = document.createElement("select");
        select.setAttribute("aria-label", label);
        for (const status of ["work", "pto", "sick", "holiday", "flex"]) select.add(new Option(this.t(status), status));
        select.value = value;
        select.addEventListener("change", () => update(/** @type {import("./work-time.js").LeaveStatus} */ (select.value)));
        return select;
    }

    /**
     * Keeps less-frequent employer, schedule and vacation configuration behind a disclosure.
     * No daily numerical overrides are exposed.
     * @param {import("./work-time.js").EmployerRaw} employer Mutable account draft.
     * @returns {HTMLDetailsElement} Configuration disclosure.
     */
    settings(employer) {
        const details = document.createElement("details");
        details.className = "work-time-settings";
        details.open = this.settingsOpen;
        details.addEventListener("toggle", () => { this.settingsOpen = details.open; });
        details.append(this.element("summary", this.t("settings")));
        const fields = this.element("div", "", "work-time-fields");
        fields.append(
            this.field(this.t("name"), "text", employer.name, (value) => { employer.name = value; }),
            this.field(this.t("activeFrom"), "date", employer.active_from, (value) => { employer.active_from = value; }),
            this.field(this.t("activeUntil"), "date", employer.active_until || "", (value) => { employer.active_until = value || null; }),
            this.field(this.t("trackingStart"), "date", employer.tracking_start, (value) => { employer.tracking_start = value; }),
            this.field(this.t("openingOvertime"), "number", employer.opening_overtime_hours, (value) => { employer.opening_overtime_hours = Number(value); }),
            this.field(this.t("openingVacation"), "number", employer.opening_vacation_days, (value) => { employer.opening_vacation_days = Number(value); }),
        );
        details.append(fields, this.element("h3", this.t("projects")));
        const projects = this.element("div", "", "work-time-projects");
        const filter = document.createElement("input");
        filter.type = "search";
        filter.placeholder = this.t("filterProjects");
        filter.setAttribute("aria-label", this.t("filterProjects"));
        details.append(filter);
        for (const project of this.host.store.getProjects()) {
            const label = document.createElement("label");
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = employer.project_keys.includes(project.key);
            input.disabled = this.draft.employers.some((other) => other.id !== employer.id && other.project_keys.includes(project.key));
            input.addEventListener("change", () => {
                employer.project_keys = input.checked ? [...employer.project_keys, project.key] : employer.project_keys.filter((key) => key !== project.key);
                this.refreshSummary();
            });
            label.append(input, document.createTextNode(project.name));
            projects.append(label);
        }
        filter.addEventListener("input", () => {
            for (const label of projects.children) /** @type {HTMLElement} */ (label).hidden = !label.textContent.toLowerCase().includes(filter.value.toLowerCase());
        });
        details.append(projects, this.element("h3", this.t("schedules")));
        for (const schedule of employer.schedules) {
            const row = this.element("div", "", "work-time-schedule");
            row.append(this.field(this.t("effectiveFrom"), "date", schedule.effective_from, (value) => { schedule.effective_from = value; }));
            for (let index = 0; index < 7; index += 1) {
                const label = this.host.locale.formatDate(this.host.timeContext.dateFromLocalDayMinutes(addIsoDays("2026-09-14", index), 0), this.host.timeContext.timeZone, { weekday: "short" });
                row.append(this.field(label, "number", schedule.hours[index], (value) => { schedule.hours[index] = Number(value); }));
            }
            if (employer.schedules.length > 1) row.append(this.button(this.t("remove"), () => { employer.schedules.splice(employer.schedules.indexOf(schedule), 1); this.render(); }));
            details.append(row);
        }
        details.append(this.button(this.t("addSchedule"), () => {
            const last = employer.schedules[employer.schedules.length - 1];
            employer.schedules.push({ effective_from: addIsoDays(last.effective_from > this.week ? last.effective_from : this.week, 7), hours: last.hours.slice() });
            this.render();
        }), this.element("h3", this.t("allowances")), this.element("p", this.t("allowancesHelp"), "muted"));
        for (const year of Object.keys(employer.vacation_allowances).sort()) {
            const row = this.element("div", "", "work-time-toolbar");
            row.append(this.field(year, "number", employer.vacation_allowances[year], (value) => { employer.vacation_allowances[year] = Number(value); }),
                this.button(this.t("remove"), () => { delete employer.vacation_allowances[year]; this.render(); }));
            details.append(row);
        }
        const allowanceRow = this.element("div", "", "work-time-toolbar");
        let year = Number(this.week.slice(0, 4));
        allowanceRow.append(this.field(this.t("year"), "number", year, (value) => { year = Number(value); }),
            this.button(this.t("addAllowance"), () => {
                if (!Number.isInteger(year) || year < 1900 || year > 2199) throw new Error(this.t("invalidYear"));
                if (!(String(year) in employer.vacation_allowances)) employer.vacation_allowances[year] = 0;
                this.render();
            }));
        details.append(allowanceRow, this.element("h3", this.t("adjustments")));
        for (const adjustment of employer.vacation_adjustments) {
            const row = this.element("div", "", "work-time-fields");
            row.append(this.field(this.t("date"), "date", adjustment.date, (value) => { adjustment.date = value; }),
                this.field(this.t("days"), "number", adjustment.days, (value) => { adjustment.days = Number(value); }),
                this.field(this.t("comment"), "text", adjustment.comment, (value) => { adjustment.comment = value; }),
                this.button(this.t("remove"), () => { employer.vacation_adjustments.splice(employer.vacation_adjustments.indexOf(adjustment), 1); this.render(); }));
            details.append(row);
        }
        details.append(this.button(this.t("addAdjustment"), () => { employer.vacation_adjustments.push({ date: this.week, days: 0, comment: "" }); this.render(); }));
        return details;
    }

    /**
     * Reveals a booked date in the daily editor without reopening or discarding its detached draft.
     * The timeline and route follow the selected week; saving remains an explicit OK action.
     * @param {string} date Date of a booking generated by the annual accounting model.
     * @returns {void}
     */
    showVacationDate(date) {
        if (this.saving) return;
        this.week = isoWeekStart(date);
        this.host.setWeekStart(this.week, isoWeekdayIndex(date));
        this.host.updateWeekRequirementsMeta(this.week);
        this.render();
        const row = Array.from(this.root.querySelectorAll("tr[data-date]"))
            .find((element) => /** @type {HTMLElement} */ (element).dataset.date === date);
        row?.querySelector("select")?.focus();
    }

    /**
     * Builds an expandable, chronological PTO inventory from the same bookings used by the annual totals.
     * All dates, comments and translated labels are text-only; each row is a keyboard-accessible editor shortcut.
     * @param {import("./work-time.js").VacationBooking[]} bookings Charged PTO dates for the selected employer and current year.
     * @param {boolean} open Whether the disclosure was expanded before a draft refresh.
     * @returns {HTMLDetailsElement} Collapsed or expanded annual overview, including its empty state.
     */
    vacationOverview(bookings, open) {
        const details = document.createElement("details");
        details.className = "work-time-vacation-overview";
        details.open = open;
        details.append(this.element("summary", this.t("vacationOverview")));
        if (!bookings.length) {
            details.append(this.element("p", this.t("vacationEmpty"), "muted"));
            return details;
        }
        const list = this.element("ul", "", "work-time-vacation-list");
        for (const booking of bookings) {
            const item = this.element("li");
            const button = this.button("", () => this.showVacationDate(booking.date));
            button.className = "work-time-vacation-booking";
            button.dataset.date = booking.date;
            button.title = this.t("vacationShowDate");
            const date = this.element("time", this.host.locale.formatDate(
                this.host.timeContext.dateFromLocalDayMinutes(booking.date, 12 * 60), this.host.timeContext.timeZone,
                { weekday: "short", day: "numeric", month: "short", year: "numeric" },
            ));
            date.setAttribute("datetime", booking.date);
            const status = this.element("span", this.t(booking.status), "work-time-vacation-status");
            status.dataset.status = booking.status;
            const amount = this.host.locale.formatNumber(booking.days, { style: "unit", unit: "day", unitDisplay: "long" });
            button.append(date, status, this.element("span", `${amount} · ${this.t(booking.half)}`, "work-time-vacation-part"));
            if (booking.comment) button.append(this.element("span", booking.comment, "work-time-vacation-comment"));
            item.append(button);
            list.append(item);
        }
        details.append(list);
        return details;
    }

    /**
     * Refreshes candidate totals without replacing focused controls or changing dialog scroll position.
     * @returns {void}
     */
    refreshSummary() {
        try {
            const config = this.candidate();
            const selector = /** @type {HTMLSelectElement | null} */ (this.root.querySelector(":scope > .work-time-toolbar select"));
            if (selector) {
                const activeIds = new Set(config.activeEmployers(this.week).map((account) => account.id));
                for (const option of selector.options) {
                    const employer = config.getEmployer(option.value);
                    if (employer) option.textContent = `${employer.name}${activeIds.has(employer.id) ? "" : ` (${this.t("outsideWeek")})`}`;
                }
            }
            const today = this.host.timeContext.formatDate(new Date());
            const end = addIsoDays(this.week, 6) < today ? addIsoDays(this.week, 6) : today;
            const account = config.getEmployer(this.selectedId);
            const summary = this.host.weekReqSummaryEl;
            const calculationOpen = summary.querySelector("details.work-time-vacation-calculation")?.open || false;
            const overviewOpen = summary.querySelector("details.work-time-vacation-overview")?.open || false;
            summary.replaceChildren();
            if (account) {
                const billable = this.host.store.getAccountBillableSeconds(this.week, end, account.id, config);
                const overtime = this.host.store.getEmployerBalance(account.id, end, config);
                // Vacation is an annual planning budget, not an overtime-style balance clipped to the displayed week.
                const vacation = account.vacationYearSummary(Number(today.slice(0, 4)), today);
                const due = config.requiredHours(this.week, end, account.id);
                const rows = [
                    [this.t("billable"), this.host.locale.formatDuration(billable)],
                    [this.t("required"), `${this.host.locale.formatNumber(due)} h / ${this.host.locale.formatNumber(config.requiredHours(this.week, addIsoDays(this.week, 6), account.id))} h`],
                    [this.t("weekDelta"), this.host.formatSignedDuration(billable - due * 3600)],
                    [this.t("overtime"), this.host.formatSignedDuration(overtime)],
                ];
                for (const [label, value] of rows) {
                    const row = this.element("div", "", "week-requirements-row");
                    row.append(this.element("span", label), this.element("strong", value));
                    summary.append(row);
                }
                const vacationSection = this.element("section", "", "work-time-vacation");
                vacationSection.setAttribute("aria-label", `${this.t("vacationBalance")} · ${vacation.year}`);
                vacationSection.append(this.element("h3", `${this.t("vacationBalance")} · ${vacation.year}`));
                const columns = this.element("dl", "", "work-time-vacation-columns");
                for (const key of /** @type {const} */ (["taken", "planned", "unplanned"])) {
                    const column = this.element("div");
                    column.dataset.vacation = key;
                    column.classList.toggle("is-negative", vacation[key] < 0);
                    column.append(this.element("dt", this.t(key)), this.element("dd", this.host.locale.formatNumber(vacation[key], {
                        style: "unit", unit: "day", unitDisplay: "long", maximumFractionDigits: 2,
                    })));
                    columns.append(column);
                }
                const calculation = document.createElement("details");
                calculation.className = "work-time-vacation-calculation";
                calculation.open = calculationOpen;
                calculation.append(this.element("summary", this.t("vacationCalculation")), this.element("p", this.host.locale.t("workTime.vacationBudget", {
                    carryover: this.host.locale.formatNumber(vacation.carryover),
                    allowance: this.host.locale.formatNumber(vacation.allowance),
                    adjustments: this.host.locale.formatNumber(vacation.adjustments),
                }), "muted"), this.element("p", this.t("vacationPlanningHelp"), "muted"));
                vacationSection.append(columns, this.vacationOverview(vacation.bookings, overviewOpen), calculation);
                summary.append(vacationSection);
                if (vacation.missingYears.length) summary.append(this.element("p", `${this.t("missingAllowances")} ${vacation.missingYears.join(", ")}`, "muted"));
                if (!account.project_keys.length) summary.append(this.element("p", this.t("noProjects"), "muted"));
            }
            for (const section of this.root.querySelectorAll(".work-time-days")) section.dispatchEvent(new Event("accountingrefresh"));
            this.showError("");
        } catch (error) { this.showError(error); }
    }

    /**
     * Saves one validated snapshot on OK. Failures retain the draft and show an in-modal error.
     * The same DataSource operation writes local disk or commits all configuration atomically on a Git provider.
     * @returns {Promise<void>}
     */
    async save() {
        if (this.saving || this.host.saveInFlight) { this.showError(this.t("saving")); return; }
        try {
            const legacy = this.host.store.getWeekRequirements();
            if (!legacy.accounting && legacy.listWeeks().length) throw new Error(this.t("legacyReadOnly"));
            const candidate = this.candidate();
            candidate.generated_at = utcNowIso();
            const requirements = WeekRequirements.fromRaw(candidate.toObject());
            this.saving = true;
            this.host.onBusy(true);
            this.root.inert = true;
            await this.host.dataSource.saveFiles([{ path: this.host.dataSource.getWeekRequirementsPath(), content: requirements.toJson() }], "Update employer schedules and daily leave");
            this.host.store.setWeekRequirements(requirements);
            this.saving = false;
            this.host.closeWeekRequirementsDialog();
            this.host.updateWeekSummary(this.week);
            this.host.updateDayWorkStatuses();
            this.host.onToast(this.host.locale.t("toast.requirementsSaved"), 2400, "success");
        } catch (error) { this.showError(error); }
        finally { this.saving = false; this.root.inert = false; this.host.onBusy(false); }
    }
}
