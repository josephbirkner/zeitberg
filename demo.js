import { DataSource } from "./datasource.js";
import { DEFAULT_CONFIG } from "./config.js";
import { EntryStore, ExpenseStore, TodoStore } from "./store.js";
import { ExpenseDocument, Manifest, ProjectList, Recurrence, allocateExpenseByWeights } from "./model.js";
import { WorkTimeConfig } from "./work-time.js";
import { TimeContext, addIsoDays, gitBlobSha1, isoWeekStart, isoWeekdayIndex } from "./utils.js";

/** Browser Storage contract backed only by a map; never reads or changes real credentials. */
export class MemoryStorage {
    /** Creates an empty, reload-disposable storage area. */
    constructor() { this.values = new Map(); }
    /** @returns {number} Number of stored keys. */
    get length() { return this.values.size; }
    /** @param {number} index Key position. @returns {string | null} Matching key. */
    key(index) { return [...this.values.keys()][index] ?? null; }
    /** @param {string} key Storage key. @returns {string | null} Stored text. */
    getItem(key) { return this.values.get(String(key)) ?? null; }
    /** @param {string} key Storage key. @param {string} value Text to retain in this tab. @returns {void} */
    setItem(key, value) { this.values.set(String(key), String(value)); }
    /** @param {string} key Storage key to discard. @returns {void} */
    removeItem(key) { this.values.delete(String(key)); }
    /** Discards all playground preferences. @returns {void} */
    clear() { this.values.clear(); }
}

/** Small reproducible PRNG for fictional data, not credentials or cryptographic use. */
export class DemoRandom {
    /** @param {string} seed Arbitrary text, including a parent seed and calendar date. */
    constructor(seed) {
        this.seed = seed;
        this.state = 2166136261;
        for (const character of seed) this.state = Math.imul(this.state ^ character.charCodeAt(0), 16777619) >>> 0;
    }
    /** @returns {number} Uniform sample in [0, 1), using the Mulberry32 mixing sequence. */
    next() {
        this.state = (this.state + 0x6D2B79F5) >>> 0;
        let value = this.state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    }
    /** @param {number} minimum Inclusive lower bound. @param {number} maximum Inclusive upper bound. @returns {number} Random integer. */
    integer(minimum, maximum) { return minimum + Math.floor(this.next() * (maximum - minimum + 1)); }
    /** @template T @param {T[]} values Nonempty options. @returns {T} One random option. */
    pick(values) { return values[this.integer(0, values.length - 1)]; }
    /** @param {string} key Stable domain/date label. @returns {DemoRandom} Independent stream, unaffected by draws from its parent. */
    fork(key) { return new DemoRandom(`${this.seed}:${key}`); }
}

/** @returns {string} A fresh, memory-only visit seed; never persisted into a normal demo URL. */
export function newDemoSeed() {
    return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("-");
}

/**
 * Builds a coherent fictional life across projects, time, tasks, leave and expenses.
 * Random streams are keyed by domain and date, so the same seed keeps past days stable
 * when the rolling 28-day window advances. Only today's entries are clipped to now.
 */
class DemoScenario {
    /** @param {Date} now Reference clock. @param {string} seed Visit seed or explicit screenshot seed. */
    constructor(now, seed) {
        this.now = now;
        this.clock = new TimeContext("Europe/Berlin");
        this.today = this.clock.formatDate(now);
        this.firstDay = addIsoDays(this.today, -27);
        this.stamp = now.toISOString();
        this.random = new DemoRandom(seed);
        this.files = new Map();
        this.entries = new EntryStore(this.clock);
        this.employer = WorkTimeConfig.newEmployer("studio", "Studio Linden", this.firstDay, ["studio"]);
    }

    /** Creates canonical workspace and shared taxonomy documents. @returns {void} */
    buildProjects() {
        this.files.set("zeitberg.json", JSON.stringify({
            schema_version: 1, workspace_id: "zeitberg-demo", name: "Alex’s playground", timezone: "Europe/Berlin",
            resources: { projects: "data/projects.json" },
            components: {
                time: { type: "time_tracking", paths: { entries: "data/entries", manifest: "data/index/entries-manifest.json", week_requirements: "data/week-requirements.json" } },
                tasks: { type: "todos", paths: { document: "data/todos.json" } },
                expenses: { type: "expenses", paths: { document: "data/expenses.json", manifest: "data/index/expenses-manifest.json" } },
            },
        }));
        const projects = ProjectList.fromRaw({ schema_version: 2, generated_at: this.stamp, projects: [
            { key: "studio", name: "Studio Linden", color: "#4385d0", billable: true, sections: ["Design", "Research", "Engineering"].map((name) => ({ key: name.toLowerCase(), name, archived: false })), archived: false, external_refs: [] },
            ...[
                ["personal", "Home & everyday life", "#b48ce0"], ["weekend", "Adventures & travel", "#45aa87"],
                ["health", "Movement & wellbeing", "#ee8a61"], ["learning", "Learning & making", "#d7b04e"],
                ["friends", "Friends & community", "#cf78aa"],
            ].map(([key, name, color]) => ({ key, name, color, billable: false, sections: [], archived: false, external_refs: [] })),
        ] });
        this.files.set("data/projects.json", projects.toJson());
        this.entries.setProjectList(projects);
        this.entries.setManifest(Manifest.fromRaw({ schema_version: 2, timezone: "Europe/Berlin", chunks: [], total_chunks: 0, total_entries: 0, generated_at: this.stamp }));
    }

    /**
     * Chooses consistent day annotations: occasional short trips, half-day PTO, sickness or TOIL.
     * Weekends retain the employer's zero-hour schedule and never spend PTO.
     * @param {string} day ISO calendar date.
     * @returns {import("./work-time.js").WorkDayRaw} Two half-day statuses and explanatory note.
     */
    leaveFor(day) {
        const weekday = isoWeekdayIndex(day);
        const random = this.random.fork(`leave:${day}`);
        const week = this.random.fork(`trip:${isoWeekStart(day)}`);
        const hasTrip = week.next() < 0.65;
        const tripStart = week.integer(0, 3);
        const tripLength = week.integer(1, 2);
        if (weekday < 5) {
            if (hasTrip && weekday >= tripStart && weekday < tripStart + tripLength) {
                return { date: day, halves: ["pto", "pto"], comment: "A short escape: walking, exploring and switching off." };
            }
            const roll = random.next();
            if (roll < 0.10) return { date: day, halves: random.next() < 0.5 ? ["pto", "work"] : ["work", "pto"], comment: "Half-day off for a little adventure." };
            if (roll < 0.14) return { date: day, halves: ["sick", "sick"], comment: "Rest and recover." };
            if (roll < 0.19) return { date: day, halves: ["work", "flex"], comment: "Taking the afternoon off with time in lieu." };
        }
        return { date: day, halves: ["work", "work"], comment: "" };
    }

    /**
     * Adds one completed, quarter-hour-aligned entry without crossing midnight or inventing future work.
     * Date/slot IDs stay stable as the window advances, independently of other days' entry counts.
     * @param {Object[]} rows Destination day entries.
     * @param {string} day ISO date.
     * @param {number} start Wall-clock minutes since midnight.
     * @param {number} duration Desired duration in minutes.
     * @param {string} description Fictional activity.
     * @param {string} project Shared project key.
     * @param {string | null} [section] Optional studio section.
     * @returns {void}
     */
    addEntry(rows, day, start, duration, description, project, section = null) {
        const beginning = this.clock.dateFromLocalDayMinutes(day, start).getTime();
        const requestedEnd = this.clock.dateFromLocalDayMinutes(day, Math.min(1440, start + duration)).getTime();
        const end = Math.min(requestedEnd, Math.floor(this.now.getTime() / 900000) * 900000);
        if (end - beginning < 900000) return;
        rows.push({
            id: Number(day.replace(/-/g, "")) * 100 + Math.floor(start / 15),
            start: new Date(beginning).toISOString(), end: new Date(end).toISOString(), duration_seconds: (end - beginning) / 1000,
            description, project_key: project, section_key: section, billable: project === "studio", is_running: false,
            updated_at: new Date(end).toISOString(),
        });
    }

    /**
     * Fills one work half-day with varied focused tasks, small meetings and an occasional break.
     * @param {Object[]} rows Day entry records.
     * @param {string} day ISO date.
     * @param {number} start Wall-clock beginning.
     * @param {number} end Exclusive wall-clock end.
     * @param {DemoRandom} random This day's activity stream.
     * @returns {void}
     */
    workBlock(rows, day, start, end, random) {
        const activities = [
            ["Sketch the new onboarding flow", "design"], ["Prototype dashboard interactions", "design"],
            ["Refine typography & responsive layouts", "design"], ["Prepare usability interviews", "research"],
            ["Synthesize feedback from the latest interviews", "research"], ["Review accessibility findings", "research"],
            ["Build the shared component library", "engineering"], ["Pair on a stubborn layout bug", "engineering"],
            ["Write regression tests", "engineering"], ["Code review & small fixes", "engineering"],
        ];
        let cursor = start;
        while (cursor < end) {
            const duration = Math.min(end - cursor, random.pick([15, 30, 45, 60, 90, 120]));
            const [description, section] = random.pick(activities);
            this.addEntry(rows, day, cursor, duration, duration === 15 ? "Team check-in & quick questions" : description, "studio", section);
            cursor += duration;
            if (cursor + 30 < end && random.next() < 0.25) {
                this.addEntry(rows, day, cursor, 15, random.pick(["Coffee & a stretch", "Step outside for fresh air"]), "personal");
                cursor += 15;
            }
        }
    }

    /**
     * Populates workdays, free weekends and leave with different, non-overlapping activity patterns.
     * @param {string} day ISO date.
     * @returns {Object[]} Canonical entry records for this day only.
     */
    buildDay(day) {
        const random = this.random.fork(`entries:${day}`);
        const leave = this.leaveFor(day);
        const weekend = isoWeekdayIndex(day) >= 5;
        const sick = leave.halves.includes("sick");
        const rows = [];
        if (sick) {
            this.addEntry(rows, day, 10 * 60, random.integer(2, 5) * 15, "A quiet morning: tea, reading & recovery", "health");
            this.addEntry(rows, day, 16 * 60, random.integer(1, 3) * 15, "Gentle walk around the block", "health");
            return rows;
        }
        if (!weekend && random.next() < 0.6) this.addEntry(rows, day, 6 * 60 + random.integer(2, 4) * 15, 30, random.pick(["Morning run", "Yoga before breakfast", "Cycle along the river"]), "health");
        for (let half = 0; half < 2; half++) {
            if (!weekend && leave.halves[half] === "work") {
                const start = (half === 0 ? 8 : 13) * 60 + random.integer(0, 2) * 15;
                const fullWorkday = leave.halves.every((status) => status === "work");
                const quarters = half === 1 && fullWorkday ? random.integer(15, 18) : random.integer(13, 16);
                this.workBlock(rows, day, start, start + quarters * 15, random);
            } else {
                const activity = random.pick(weekend ? [
                    ["Browse the farmers’ market", "personal"], ["A long bike ride with Sam", "health"],
                    ["Explore a new hiking trail", "weekend"], ["Pottery workshop", "learning"],
                    ["Brunch with friends", "friends"], ["Volunteer at the community garden", "friends"],
                ] : [
                    ["Wander through the old town", "weekend"], ["Visit a museum & sketch a few ideas", "weekend"],
                    ["Read by the lake", "personal"], ["Train ride & a new podcast", "weekend"],
                    ["Picnic and a forest walk", "weekend"],
                ]);
                this.addEntry(rows, day, (half === 0 ? 9 : 14) * 60 + random.integer(0, 3) * 15, random.integer(3, 10) * 15, activity[0], activity[1]);
            }
        }
        this.addEntry(rows, day, 12 * 60 + 30, 30, random.pick(["Lunch & a walk", "Cook something new", "Lunch at the little café"]), "personal");
        const evening = random.pick([
            ["Cook dinner with Sam", "personal"], ["Board games with friends", "friends"], ["Learn a few guitar chords", "learning"],
            ["Climbing session", "health"], ["Read another chapter", "personal"], ["Work on a small side project", "learning"],
        ]);
        this.addEntry(rows, day, 18 * 60 + random.integer(0, 4) * 15, random.integer(2, 8) * 15, evening[0], evening[1]);
        if (random.next() < 0.35) this.addEntry(rows, day, 21 * 60 + 15, random.integer(1, 5) * 15, random.pick(["Plan tomorrow", "An episode before bed", "Catch up with family"]), "personal");
        return rows.sort((a, b) => a.start.localeCompare(b.start));
    }

    /** Serializes exactly 28 calendar days and matching leave, plus two weeks of planned annotations. @returns {void} */
    buildTime() {
        const byWeek = new Map();
        for (let offset = -27; offset <= 0; offset++) {
            const day = addIsoDays(this.today, offset);
            const week = isoWeekStart(day);
            if (!byWeek.has(week)) byWeek.set(week, []);
            byWeek.get(week).push(...this.buildDay(day));
        }
        for (const [week, rows] of byWeek) this.entries.applyWeekSnapshot(week, rows);
        const weeks = this.entries.serializeWeeks([...byWeek.keys()], this.stamp);
        for (const week of weeks) this.files.set(week.path, week.content);
        this.files.set("data/index/entries-manifest.json", this.entries.buildManifest(weeks, this.stamp).toJson());
        for (let offset = -27; offset <= 14; offset++) {
            const day = addIsoDays(this.today, offset);
            const leave = this.leaveFor(day);
            // Future PTO/TOIL is a plan; sickness is only a historical annotation.
            if (leave.halves.some((half) => half !== "work") && !(offset > 0 && leave.halves.includes("sick"))) this.employer.days.push(leave);
            this.employer.vacation_allowances[day.slice(0, 4)] = 30;
        }
        this.files.set("data/week-requirements.json", new WorkTimeConfig({ schema_version: 3, generated_at: this.stamp, employers: [this.employer] }).toJson());
    }

    /** Creates a larger mix of open/completed, overdue, upcoming, undated and recurring tasks. @returns {void} */
    buildTodos() {
        const store = new TodoStore(this.entries);
        const random = this.random.fork("todos");
        let id = 0;
        store.reserveTodoId = () => `demo:task:${++id}`;
        const groups = [
            ["studio", "Review the dashboard", "Prepare the next research session", "Polish the mobile navigation", "Document the design tokens", "Share the prototype", "Triage accessibility findings", "Review the release checklist", "Schedule a team retrospective"],
            ["personal", "Organize the balcony plants", "Repair the wobbly shelf", "Back up family photos", "Pick up a library book", "Donate unused clothes", "Plan meals for next week"],
            ["weekend", "Book train tickets", "Find a quiet campsite", "Pack a picnic", "Research rainy-day activities", "Download an offline trail map", "Check the bikes before the trip"],
            ["health", "Book a climbing session", "Try a new walking route", "Prepare a healthy lunch", "Stretch after the run", "Replace worn running shoes"],
            ["learning", "Practice guitar", "Finish the pottery mug", "Read about accessible interfaces", "Try a new recipe", "Build a tiny weather display"],
            ["friends", "Invite friends for board games", "Help at the community garden", "Call Robin", "Choose a birthday present", "Organize a shared dinner"],
        ];
        for (const [projectKey, ...titles] of groups) {
            for (const [index, content] of titles.entries()) {
                const offset = index === 0 ? 0 : random.pick([-7, -3, -1, 0, 1, 3, 7, 14, null]);
                const dueDate = offset === null ? (index === 3 ? this.today : null) : addIsoDays(this.today, offset);
                const recurrence = index === 3 ? Recurrence.fromText("every week", dueDate || this.today)?.toRaw() : null;
                const task = store.createTodo({
                    content, description: random.pick(["", "Keep it simple — one small step is enough.", "Discuss the options with Sam before deciding.", "A fictional task: try changing its project, due date or priority."]),
                    projectKey, sectionKey: projectKey === "studio" ? random.pick(["design", "research", "engineering"]) : null,
                    labels: [], priority: random.integer(1, 4), due: dueDate ? { date: dueDate, string: dueDate, is_recurring: Boolean(recurrence) } : null, recurrence,
                }, `${this.firstDay}T06:00:00Z`);
                if (index > 0 && !recurrence && (offset === null || offset <= 0) && random.next() < 0.4) store.toggleTodoCompleted(task.id, this.stamp);
            }
        }
        this.files.set("data/todos.json", store.serialize(this.stamp));
    }

    /** Generates varied shared purchases with exact cent allocation, changing payers and split weights. @returns {void} */
    buildExpenses() {
        const store = new ExpenseStore(this.entries);
        let id = 0;
        store.reserveId = () => `demo:expense:${++id}`;
        const people = ["alex", "sam", "robin", "mia"];
        store.setDocument(ExpenseDocument.fromRaw({ schema_version: 1, generated_at: this.stamp, expenses: [], transfers: [],
            participants: people.map((key) => ({ key, name: key[0].toUpperCase() + key.slice(1), archived: false, source_refs: [] })),
            categories: [["food", "Food & drink", "#f97316"], ["travel", "Travel", "#4385d0"], ["activities", "Activities", "#b48ce0"], ["home", "Household", "#45aa87"]].map(([key, name, color]) => ({ key, name, color, archived: false, source_refs: [] })),
        }));
        for (let offset = -27; offset <= 0; offset++) {
            const day = addIsoDays(this.today, offset);
            const random = this.random.fork(`expenses:${day}`);
            const outing = isoWeekdayIndex(day) >= 5 || this.leaveFor(day).halves.includes("pto");
            const count = outing ? random.integer(1, 3) : random.integer(0, 2);
            for (let index = 0; index < count; index++) {
                const [description, category, low, high] = random.pick(outing ? [
                    ["Dinner by the river", "food", 4500, 14000], ["Train tickets", "travel", 2800, 12000],
                    ["Museum tickets", "activities", 1800, 6400], ["Coffee & pastries", "food", 900, 2800],
                    ["Bike rental", "activities", 2400, 9600], ["Picnic supplies", "food", 1600, 4800],
                ] : [
                    ["Weekly groceries", "home", 2800, 9500], ["Shared lunch", "food", 1400, 4500],
                    ["Household supplies", "home", 800, 3600], ["Bus tickets", "travel", 600, 1800],
                ]);
                const amount = random.integer(Number(low), Number(high));
                const members = people.slice(0, random.integer(2, 4));
                const weighted = random.next() < 0.3;
                const units = members.map((participant_key) => ({ participant_key, value: weighted ? random.integer(1, 3) : 1 }));
                const payer = random.pick(members);
                const payers = random.next() < 0.2
                    ? allocateExpenseByWeights(amount, members.slice(0, 2).map((participant_key) => ({ participant_key, value: 1 })))
                    : [{ participant_key: payer, amount_minor: amount }];
                store.createExpense({
                    description: String(description), date: day, currency: "EUR", amount_minor: amount, payers,
                    allocations: allocateExpenseByWeights(amount, units), allocation_rule: { type: weighted ? "shares" : "equal", units },
                    category_key: String(category), project_key: outing ? "weekend" : "personal", section_key: null,
                    notes: random.next() < 0.25 ? "Fictional receipt — amounts and participants are generated for this visit." : "",
                }, `${day}T06:00:00Z`);
            }
        }
        for (const file of store.buildPersistenceFiles("data/expenses.json", "data/index/expenses-manifest.json", this.stamp).files) this.files.set(file.path, file.content);
    }

    /** @returns {Map<string, string>} Complete fictional repository serialized through normal application models. */
    build() {
        this.buildProjects();
        this.buildTime();
        this.buildTodos();
        this.buildExpenses();
        return this.files;
    }
}

/**
 * Generates a new disposable scenario, or reproduces one with an explicit seed and clock.
 * No private workspace, credential, file or network endpoint is consulted.
 * @param {Date} [now] Reference date/time for the rolling four-week history.
 * @param {string} [seed] Fixed seed for tests/screenshots; omitted means a fresh visit.
 * @returns {Map<string, string>} Canonical workspace documents.
 */
export function createDemoFiles(now = new Date(), seed = newDemoSeed()) {
    return new DemoScenario(now, seed).build();
}

/** Repository adapter whose reads and saves stay entirely inside this page's memory. */
export class DemoDataSource extends DataSource {
    /** @param {import("./config.js").AppConfig} [config] Shared configuration. @param {Date} [now] Fixture clock. @param {string} [seed] Optional reproducible scenario seed. */
    constructor(config = DEFAULT_CONFIG, now = new Date(), seed = newDemoSeed()) {
        super(config);
        this.files = createDemoFiles(now, seed);
    }
    /** @param {string} path Normalized document path. @returns {any} A fresh parsed document. */
    read(path) {
        if (!this.files.has(path)) throw new Error(`Missing demo document: ${path}`);
        return JSON.parse(this.files.get(path));
    }
    /** @returns {Promise<Object>} Fictional workspace configuration. */
    async fetchWorkspace() { return this.read(this.getWorkspaceConfigPath()); }
    /** @param {string} path Repository-relative path. @returns {Promise<boolean>} Whether the disposable file exists. */
    async repositoryFileExists(path) { return this.files.has(path); }
    /** @returns {Promise<Object>} Current time manifest. */
    async fetchManifest() { return this.read(this.getEntriesManifestPath()); }
    /** @param {import("./model.js").ManifestChunk} chunk Manifest descriptor. @returns {Promise<string>} Serialized week. */
    async fetchChunkText(chunk) { this.read(chunk.path); return this.files.get(chunk.path); }
    /** @returns {Promise<Object>} Shared project inventory. */
    async fetchProjects() { return this.read(this.getProjectsPath()); }
    /** @returns {Promise<Object>} Employer schedules and leave. */
    async fetchWeekRequirements() { return this.read(this.getWeekRequirementsPath()); }
    /** @returns {Promise<Object>} Disposable task document. */
    async fetchTodos() { return this.read(this.getTodosPath()); }
    /** @returns {Promise<string>} Expense document, preserving integrity hashes. */
    async fetchExpensesText() { return this.files.get(this.getExpensesPath()); }
    /** @returns {Promise<Object>} Expense integrity manifest. */
    async fetchExpensesManifest() { return this.read(this.getExpensesManifestPath()); }
    /**
     * Acknowledges a normal save snapshot without HTTP, Git, or durable storage.
     * @param {import("./datasource.js").SaveFile[]} files Serialized edits.
     * @param {string} message Unused repository commit message.
     * @returns {Promise<import("./datasource.js").SaveResult>} Same acknowledgement shape as real providers.
     */
    async saveFiles(files, message) {
        void message;
        const saved = files.map((file) => {
            if (!file.path.startsWith("data/") && file.path !== "zeitberg.json") throw new Error("Invalid demo path.");
            JSON.parse(file.content);
            return { ...file, sha: gitBlobSha1(file.content) };
        });
        for (const file of saved) this.files.set(file.path, file.content);
        return { files: saved };
    }
}
