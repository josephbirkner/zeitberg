const DEFAULT_CONFIG = {
  owner: "josephbirkner",
  repo: "timetracking",
  ref: "main",
  timezone: "Europe/Berlin",
};

const STORAGE_KEYS = {
  config: "tt_viewer:config:v1",
  token: "tt_viewer:token:v1",
  tokenRemembered: "tt_viewer:token_remembered:v1",
};

const CHUNK_CACHE = {
  dbName: "tt_viewer:chunk_cache:v1",
  dbVersion: 1,
  storeName: "chunks",
};

let chunkCacheDbPromise = null;
let chunkCacheDb = null;
let chunkCacheWritesDisabled = false;

function isQuotaError(err) {
  const name = err && typeof err === "object" ? String(err.name || "") : "";
  if (name === "QuotaExceededError") return true;
  if (name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  return false;
}

function idbReqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

async function getChunkCacheDb() {
  if (chunkCacheDb) return chunkCacheDb;
  if (chunkCacheDbPromise) return await chunkCacheDbPromise;

  if (typeof indexedDB === "undefined") return null;

  chunkCacheDbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(CHUNK_CACHE.dbName, CHUNK_CACHE.dbVersion);
    } catch {
      resolve(null);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNK_CACHE.storeName)) {
        db.createObjectStore(CHUNK_CACHE.storeName, { keyPath: "sha" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });

  chunkCacheDb = await chunkCacheDbPromise;
  return chunkCacheDb;
}

async function chunkCacheGetRaw(sha) {
  const key = String(sha || "").trim();
  if (!key) return null;

  const db = await getChunkCacheDb();
  if (!db) return null;

  try {
    const tx = db.transaction(CHUNK_CACHE.storeName, "readonly");
    const store = tx.objectStore(CHUNK_CACHE.storeName);
    const rec = await idbReqToPromise(store.get(key));
    await idbTxDone(tx);
    if (rec && typeof rec.raw === "string") return rec.raw;
  } catch {
    // ignore
  }

  return null;
}

async function chunkCachePutRaw(sha, raw) {
  if (chunkCacheWritesDisabled) return;
  const key = String(sha || "").trim();
  if (!key) return;
  if (typeof raw !== "string" || !raw) return;

  const db = await getChunkCacheDb();
  if (!db) return;

  try {
    const tx = db.transaction(CHUNK_CACHE.storeName, "readwrite");
    const store = tx.objectStore(CHUNK_CACHE.storeName);
    store.put({ sha: key, raw, saved_at: Date.now() });
    await idbTxDone(tx);
  } catch (e) {
    if (isQuotaError(e)) chunkCacheWritesDisabled = true;
  }
}

async function chunkCacheDeleteRaw(sha) {
  const key = String(sha || "").trim();
  if (!key) return;

  const db = await getChunkCacheDb();
  if (!db) return;

  try {
    const tx = db.transaction(CHUNK_CACHE.storeName, "readwrite");
    const store = tx.objectStore(CHUNK_CACHE.storeName);
    store.delete(key);
    await idbTxDone(tx);
  } catch {
    // ignore
  }
}

function clearChunkCache() {
  try {
    chunkCacheDb?.close();
  } catch {
    // ignore
  }
  chunkCacheDb = null;
  chunkCacheDbPromise = null;
  chunkCacheWritesDisabled = false;

  try {
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(CHUNK_CACHE.dbName);
  } catch {
    // ignore
  }
}

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.config);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(config));
}

function loadToken() {
  const remembered = localStorage.getItem(STORAGE_KEYS.tokenRemembered) === "1";
  if (remembered) return localStorage.getItem(STORAGE_KEYS.token) || "";
  return sessionStorage.getItem(STORAGE_KEYS.token) || "";
}

function saveToken(token, remember) {
  localStorage.setItem(STORAGE_KEYS.tokenRemembered, remember ? "1" : "0");
  if (remember) {
    localStorage.setItem(STORAGE_KEYS.token, token);
    sessionStorage.removeItem(STORAGE_KEYS.token);
  } else {
    sessionStorage.setItem(STORAGE_KEYS.token, token);
    localStorage.removeItem(STORAGE_KEYS.token);
  }
}

function clearSaved() {
  localStorage.removeItem(STORAGE_KEYS.config);
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.tokenRemembered);
  sessionStorage.removeItem(STORAGE_KEYS.token);
  clearChunkCache();
}

function setVisible(el, isVisible) {
  el.hidden = !isVisible;
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const sign = seconds < 0 ? "-" : "";
  seconds = Math.abs(Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${sign}${h}:${String(m).padStart(2, "0")}`;
}

function apiHeaders(token, accept) {
  const headers = {
    Accept: accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson(url, token) {
  const resp = await fetch(url, { headers: apiHeaders(token) });
  if (!resp.ok) throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
  return await resp.json();
}

async function ghJsonRequest(url, token, { method = "GET", body = null, accept = null } = {}) {
  const headers = apiHeaders(token, accept || undefined);
  const init = { method, headers };
  if (body !== null && body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...headers, "Content-Type": "application/json" };
  }
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
  return await resp.json();
}

async function ghRawText(url, token) {
  const resp = await fetch(url, { headers: apiHeaders(token, "application/vnd.github.raw") });
  if (!resp.ok) throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
  return await resp.text();
}

function getSourceMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("source") || "").trim().toLowerCase();
    if (raw === "local") return "local";
  } catch {
    // ignore
  }
  return "github";
}

function makeTzFormatters(timeZone) {
  const dateFmt = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit" });
  return { dateFmt, timeFmt };
}

function safeText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeEntry(entry) {
  const start = new Date(entry.start);
  const end = entry.end ? new Date(entry.end) : null;

  let durationSeconds = null;
  if (typeof entry.duration_seconds === "number" && Number.isFinite(entry.duration_seconds)) {
    durationSeconds = entry.duration_seconds;
  } else if (end) {
    durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);
  } else {
    durationSeconds = null;
  }

  return {
    ...entry,
    startDate: start,
    endDate: end,
    durationSeconds,
    project: entry.project || "",
    description: entry.description || "",
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    billable: entry.billable === true ? true : entry.billable === false ? false : null,
  };
}

function entrySearchHaystack(entry) {
  const parts = [entry.project, entry.description, entry.client || "", (entry.tags || []).join(" ")].filter(Boolean);
  return parts.join(" ").toLowerCase();
}

function sumDurationSeconds(entries) {
  let sum = 0;
  for (const e of entries) {
    if (typeof e.durationSeconds === "number" && Number.isFinite(e.durationSeconds) && e.durationSeconds >= 0) {
      sum += e.durationSeconds;
    }
  }
  return sum;
}

function parseIsoDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`Invalid ISO date: ${dateStr}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function formatIsoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addIsoDays(dateStr, deltaDays) {
  const { year, month, day } = parseIsoDate(dateStr);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return formatIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function isoWeekdayIndex(dateStr) {
  const { year, month, day } = parseIsoDate(dateStr);
  const dt = new Date(Date.UTC(year, month - 1, day));
  // 0..6 with Monday=0
  return (dt.getUTCDay() + 6) % 7;
}

function isoWeekStart(dateStr) {
  return addIsoDays(dateStr, -isoWeekdayIndex(dateStr));
}

function isoWeekInfo(weekStartStr) {
  const { year, month, day } = parseIsoDate(weekStartStr);
  const monday = new Date(Date.UTC(year, month - 1, day));
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();

  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Weekday);

  const diffDays = Math.round((thursday.getTime() - week1Monday.getTime()) / (24 * 3600 * 1000));
  const week = 1 + Math.floor(diffDays / 7);
  return { isoYear, week };
}

function hhmmToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesToHHMM(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  minutes = Math.max(0, Math.min(1440, Math.round(minutes)));
  if (minutes === 1440) return "24:00";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

async function main() {
  const authStatusEl = $("authStatus");
  const logoutBtn = $("logoutBtn");
  const loginSection = $("loginSection");
  const loginForm = $("loginForm");
  const loginErrorEl = $("loginError");
  const clearSavedBtn = $("clearSavedBtn");

  const viewTabsEl = $("viewTabs");
  const tabWeekBtn = $("tabWeek");
  const tabSearchBtn = $("tabSearch");
  const weekControlsEl = $("weekControls");

  const appSection = $("appSection");
  const repoLabelEl = $("repoLabel");
  const reloadDataBtn = $("reloadDataBtn");
  const loadProgressEl = $("loadProgress");
  const loadProgressLabelEl = $("loadProgressLabel");
  const dataErrorEl = $("dataError");

  const weekViewSection = $("weekViewSection");
  const weekLabelEl = $("weekLabel");
  const weekScrollEl = $("weekScroll");
  const prevWeekBtn = $("prevWeekBtn");
  const nextWeekBtn = $("nextWeekBtn");
  const latestWeekBtn = $("latestWeekBtn");
  const zoomInput = $("zoomInput");
  const editorBadgeEl = $("editorBadge");

  const entryDialog = $("entryDialog");
  const entryForm = $("entryForm");
  const entryCloseBtn = $("entryCloseBtn");
  const entryCancelBtn = $("entryCancelBtn");
  const entryMetaEl = $("entryMeta");
  const entryProjectInput = $("entryProject");
  const entryTagsInput = $("entryTags");
  const entryDescInput = $("entryDesc");
  const entryBillableInput = $("entryBillable");
  const projectDatalistEl = $("projectDatalist");

  const searchViewEl = $("searchView");
  const searchInput = $("searchInput");
  const projectSelect = $("projectSelect");
  const fromDateInput = $("fromDate");
  const toDateInput = $("toDate");
  const maxRowsInput = $("maxRows");
  const sortSelect = $("sortSelect");
  const statsEl = $("stats");
  const entriesTbody = $("entriesTbody");

  const sourceMode = getSourceMode();
  const isLocalMode = sourceMode === "local";

  let config = loadConfig();
  $("ownerInput").value = config.owner;
  $("repoInput").value = config.repo;
  $("refInput").value = config.ref;
  $("rememberInput").checked = localStorage.getItem(STORAGE_KEYS.tokenRemembered) === "1";

  let activeTab = "week";

  let token = loadToken();
  let ghUser = null;
  let chunkFiles = [];
  let entriesById = new Map();
  let allEntries = [];

  const { dateFmt, timeFmt } = makeTzFormatters(config.timezone);
  const tzPartsFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  function zonedParts(date) {
    const parts = tzPartsFmt.formatToParts(date);
    const out = {};
    for (const p of parts) {
      if (p.type === "year") out.year = Number(p.value);
      if (p.type === "month") out.month = Number(p.value);
      if (p.type === "day") out.day = Number(p.value);
      if (p.type === "hour") out.hour = Number(p.value);
      if (p.type === "minute") out.minute = Number(p.value);
      if (p.type === "second") out.second = Number(p.value);
    }
    return {
      year: out.year || 0,
      month: out.month || 0,
      day: out.day || 0,
      hour: out.hour || 0,
      minute: out.minute || 0,
      second: out.second || 0,
    };
  }

  function tzOffsetMinutesAt(date) {
    const p = zonedParts(date);
    const asUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtcMs - date.getTime()) / 60000);
  }

  function dateFromZonedParts({ year, month, day, hour, minute, second }) {
    const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second || 0);
    let guess = new Date(localUtcMs);
    let offsetMin = tzOffsetMinutesAt(guess);
    let dt = new Date(localUtcMs - offsetMin * 60000);
    for (let i = 0; i < 2; i++) {
      const nextOffsetMin = tzOffsetMinutesAt(dt);
      if (nextOffsetMin === offsetMin) break;
      offsetMin = nextOffsetMin;
      dt = new Date(localUtcMs - offsetMin * 60000);
    }
    return dt;
  }

  function dateFromLocalDayMinutes(dayStr, minutes) {
    const { year, month, day } = parseIsoDate(dayStr);
    const m = Math.max(0, Math.min(1440, Math.round(minutes)));
    const hour = Math.floor(m / 60);
    const minute = m % 60;
    return dateFromZonedParts({ year, month, day, hour, minute, second: 0 });
  }

  function formatIsoWithOffset(date) {
    const p = zonedParts(date);
    const offsetMin = tzOffsetMinutesAt(date);
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const offH = Math.floor(abs / 60);
    const offM = abs % 60;
    return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(
      2,
      "0",
    )}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(
      2,
      "0",
    )}${sign}${String(offH).padStart(2, "0")}:${String(offM).padStart(2, "0")}`;
  }

  let weekEntryIds = new Map(); // weekStart -> Set<entryId>
  let weekSegmentsCache = new Map(); // weekStart -> Map<dateStr, segment[]>
  let longEntryIds = new Set(); // entryId that spans > 7 days
  let segmentsIndex = new Map(); // dateStr -> segment[] for the current week
  let latestWeekStartStr = null;
  let weekStartStr = null;
  let focusedDayIndex = 0; // 0..6 (Mon..Sun)
  const focusedEntryIndexByDay = Array(7).fill(0);
  let weekDom = null;
  let zoom = Number.parseFloat(zoomInput.value || "1");
  if (!Number.isFinite(zoom) || zoom < 1) zoom = 1;

  const MIN_ENTRY_MINUTES = 15;
  const MIN_ENTRY_MS = MIN_ENTRY_MINUTES * 60 * 1000;
  const LONG_ENTRY_MS = 7 * 24 * 60 * 60 * 1000;

  let selectedSegKey = null;
  let selectedEntryId = null;

  let editMode = "normal"; // normal | add | split
  let cursor = null; // { kind: "add"|"split", ms: number }
  let cursorEl = null;

  let dialogEntryId = null;

  const dirtyWeekStarts = new Set();
  let lastEditAt = 0;
  let autosaveTimer = 0;
  let saveInFlight = false;
  let toastTimer = 0;

  const undoStack = [];
  const redoStack = [];
  let nextEntryId = 1;
  let searchDirty = false;

  function setAuthStatus(text) {
    authStatusEl.textContent = text;
  }

  function setError(el, message) {
    if (!message) {
      el.textContent = "";
      setVisible(el, false);
      return;
    }
    el.textContent = message;
    setVisible(el, true);
  }

  function toast(message, timeoutMs = 2400) {
    window.clearTimeout(toastTimer);
    setError(dataErrorEl, message ? String(message) : "");
    if (!message) return;
    toastTimer = window.setTimeout(() => {
      setError(dataErrorEl, "");
    }, Math.max(400, timeoutMs));
  }

  function setBusy(isBusy) {
    logoutBtn.disabled = isBusy;
    reloadDataBtn.disabled = isBusy;
    tabWeekBtn.disabled = isBusy;
    tabSearchBtn.disabled = isBusy;
    prevWeekBtn.disabled = isBusy;
    nextWeekBtn.disabled = isBusy;
    latestWeekBtn.disabled = isBusy;
    zoomInput.disabled = isBusy;
    searchInput.disabled = isBusy;
    projectSelect.disabled = isBusy;
    fromDateInput.disabled = isBusy;
    toDateInput.disabled = isBusy;
    maxRowsInput.disabled = isBusy;
    sortSelect.disabled = isBusy;
  }

  function setProgress(loaded, total, label) {
    const max = Math.max(1, total || 0);
    loadProgressEl.max = max;
    loadProgressEl.value = Math.min(Math.max(0, loaded), max);
    loadProgressLabelEl.textContent = label || "";
  }

  function updateEditorBadge() {
    const dirty = dirtyWeekStarts.size > 0;
    const mode = String(editMode || "normal").toUpperCase();
    const save = saveInFlight ? "Saving…" : dirty ? "Unsaved" : "Saved";

    editorBadgeEl.classList.toggle("is-dirty", dirty);
    editorBadgeEl.innerHTML = `<span class="dot"></span><span class="mode">${mode}</span><span class="save">${save}</span>`;
  }

  function clearCursor() {
    cursor = null;
    if (cursorEl) cursorEl.remove();
    cursorEl = null;
  }

  function updateCursorLine() {
    if (!weekDom || !cursor || !weekDom.metrics) {
      clearCursor();
      return;
    }

    const dt = new Date(cursor.ms);
    if (Number.isNaN(dt.getTime())) return clearCursor();
    const dayStr = dateFmt.format(dt);
    const dayIdx = weekDom.days.indexOf(dayStr);
    if (dayIdx < 0) return clearCursor();

    const minutes = hhmmToMinutes(timeFmt.format(dt));
    if (minutes === null) return clearCursor();

    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.className = "cursor-line";
    }

    cursorEl.classList.toggle("is-split", cursor.kind === "split");
    cursorEl.style.top = `${minutes * weekDom.metrics.pxPerMinute}px`;

    const parent = weekDom.dayColEls[dayIdx];
    if (cursorEl.parentElement !== parent) parent.append(cursorEl);
  }

  function setEditMode(nextMode) {
    const next = nextMode === "add" ? "add" : nextMode === "split" ? "split" : "normal";
    editMode = next;
    if (next === "normal") clearCursor();
    updateCursorLine();
    updateEditorBadge();
  }

  function setTab(tab) {
    const next = tab === "search" ? "search" : "week";
    activeTab = next;
    tabWeekBtn.setAttribute("aria-selected", next === "week" ? "true" : "false");
    tabSearchBtn.setAttribute("aria-selected", next === "search" ? "true" : "false");
    setVisible(weekViewSection, next === "week");
    setVisible(searchViewEl, next === "search");
    setVisible(weekControlsEl, next === "week" && !viewTabsEl.hidden);
    if (next === "week") {
      queueMicrotask(() => {
        try {
          weekScrollEl.focus();
        } catch {
          // ignore
        }
        updateWeekScaleAndReposition();
      });
    } else {
      queueMicrotask(() => applyFiltersAndRender());
    }
  }

  function setAppMode(isEnabled) {
    const enabled = Boolean(isEnabled);
    document.body.classList.toggle("app-mode", enabled);
    document.documentElement.classList.toggle("app-mode", enabled);
  }

  function renderProjects(entries) {
    const projects = new Set();
    for (const e of entries) {
      if (e.project) projects.add(e.project);
    }
    const sorted = Array.from(projects).sort((a, b) => a.localeCompare(b));

    projectSelect.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All projects";
    projectSelect.append(allOpt);

    for (const p of sorted) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      projectSelect.append(opt);
    }

    projectDatalistEl.innerHTML = "";
    for (const p of sorted) {
      const opt = document.createElement("option");
      opt.value = p;
      projectDatalistEl.append(opt);
    }
  }

  function applyFiltersAndRender() {
    if (searchDirty) {
      const currentProject = projectSelect.value;
      allEntries = Array.from(entriesById.values());
      renderProjects(allEntries);
      if (currentProject) projectSelect.value = currentProject;
      searchDirty = false;
    }
    const query = searchInput.value.trim().toLowerCase();
    const project = projectSelect.value;
    const from = fromDateInput.value ? fromDateInput.value : null;
    const to = toDateInput.value ? toDateInput.value : null;
    const maxRows = Math.max(50, Number.parseInt(maxRowsInput.value || "500", 10) || 500);
    const sortDir = sortSelect.value === "asc" ? "asc" : "desc";

    const qTokens = query ? query.split(/\s+/).filter(Boolean) : [];

    let entries = allEntries;
    if (project) entries = entries.filter((e) => e.project === project);
    if (from) {
      entries = entries.filter((e) => dateFmt.format(e.startDate) >= from);
    }
    if (to) {
      entries = entries.filter((e) => dateFmt.format(e.startDate) <= to);
    }
    if (qTokens.length) {
      entries = entries.filter((e) => {
        const hay = entrySearchHaystack(e);
        return qTokens.every((t) => hay.includes(t));
      });
    }

    entries = entries.slice().sort((a, b) => {
      const diff = a.startDate.getTime() - b.startDate.getTime();
      if (diff !== 0) return sortDir === "asc" ? diff : -diff;
      return sortDir === "asc" ? a.id - b.id : b.id - a.id;
    });

    const total = entries.length;
    const shown = entries.slice(0, maxRows);
    const dur = sumDurationSeconds(entries);
    statsEl.textContent = `${total} match • ${formatDuration(dur)} total • showing ${shown.length}`;

	    entriesTbody.innerHTML = "";
	    const frag = document.createDocumentFragment();
	    for (const e of shown) {
	      const tr = document.createElement("tr");
	      tr.classList.add("row-link");
	      tr.title = "Open this entry in Week view";
	      tr.addEventListener("click", () => jumpToEntryInWeek(e));

	      const tdDate = document.createElement("td");
	      tdDate.textContent = dateFmt.format(e.startDate);
	      const tdStart = document.createElement("td");
	      tdStart.textContent = timeFmt.format(e.startDate);
      const tdEnd = document.createElement("td");
      tdEnd.textContent = e.endDate ? timeFmt.format(e.endDate) : "—";
      const tdDur = document.createElement("td");
      tdDur.textContent = formatDuration(e.durationSeconds);

      const tdProject = document.createElement("td");
      tdProject.textContent = safeText(e.project);
      const tdDesc = document.createElement("td");
      tdDesc.textContent = safeText(e.description);
      const tdTags = document.createElement("td");
      tdTags.textContent = Array.isArray(e.tags) ? e.tags.join(", ") : "";
	      const tdBillable = document.createElement("td");
	      tdBillable.textContent = e.billable === true ? "Yes" : e.billable === false ? "No" : "—";

	      tr.append(tdDate, tdStart, tdEnd, tdDur, tdProject, tdDesc, tdTags, tdBillable);
	      frag.append(tr);
	    }
	    entriesTbody.append(frag);
	  }

  function jumpToEntryInWeek(entry) {
    if (!entry || !(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
    if (viewTabsEl.hidden) return;

    const startDay = dateFmt.format(entry.startDate);
    const startWeek = isoWeekStart(startDay);
    const startDayIdx = isoWeekdayIndex(startDay);

    setTab("week");
    setWeekStart(startWeek, startDayIdx);

    if (!weekDom) return;
    const entryId = entry.id;
    const preferredKey = `${entryId}@${startDay}`;

    let dayIdx = startDayIdx;
    let idx = weekDom.keyToIndexByDay?.[dayIdx]?.get(preferredKey);
    if (typeof idx !== "number") {
      const prefix = `${entryId}@`;
      for (let i = 0; i < 7; i++) {
        const keys = weekDom.dayKeys[i] || [];
        const found = keys.findIndex((k) => typeof k === "string" && k.startsWith(prefix));
        if (found >= 0) {
          dayIdx = i;
          idx = found;
          break;
        }
      }
    }

    if (typeof idx === "number") {
      focusedDayIndex = dayIdx;
      focusedEntryIndexByDay[dayIdx] = idx;
      applyWeekFocusAndSelection();
      scrollWeekFocusIntoView();
    }

    try {
      weekScrollEl.focus();
    } catch {
      // ignore
    }
  }

  function tagsToText(tags) {
    if (!Array.isArray(tags)) return "";
    return tags.filter((t) => typeof t === "string" && t.trim()).join(", ");
  }

  function textToTags(text) {
    return String(text || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  function closeEntryDialog() {
    dialogEntryId = null;
    if (entryDialog.open) entryDialog.close();
    queueMicrotask(() => {
      try {
        weekScrollEl.focus();
      } catch {
        // ignore
      }
    });
  }

  function openEntryDialog(entryId) {
    const id = Number(entryId);
    if (!Number.isFinite(id)) return;
    const entry = entriesById.get(id);
    if (!entry) return;
    if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
    if (!(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) return;
    if (weekStartStr && weekStartForEntry(entry) !== weekStartStr) {
      toast(`This entry belongs to ${isoWeekInfo(weekStartForEntry(entry)).isoYear}-W${String(isoWeekInfo(weekStartForEntry(entry)).week).padStart(2,"0")}; open that week to edit.`);
      return;
    }

    dialogEntryId = id;
    entryProjectInput.value = safeText(entry.project);
    entryDescInput.value = safeText(entry.description);
    entryTagsInput.value = tagsToText(entry.tags);
    entryBillableInput.checked = entry.billable === true;

    const day = dateFmt.format(entry.startDate);
    const start = timeFmt.format(entry.startDate);
    const end = timeFmt.format(entry.endDate);
    const dur = formatDuration(entry.durationSeconds);
    entryMetaEl.textContent = `${day} ${start}–${end} • ${dur} • id ${id}`;

    if (!entryDialog.open) entryDialog.showModal();
    queueMicrotask(() => {
      try {
        entryProjectInput.focus();
        entryProjectInput.select();
      } catch {
        // ignore
      }
    });
  }

  const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const projectColorCache = new Map(); // project -> { bg, border }

  function projectColors(project) {
    const key = String(project || "");
    const cached = projectColorCache.get(key);
    if (cached) return cached;

    if (!key) {
      const neutral = { bg: "rgba(255, 255, 255, 0.06)", border: "rgba(255, 255, 255, 0.16)" };
      projectColorCache.set(key, neutral);
      return neutral;
    }

    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const hue = Math.abs(hash) % 360;
    const colors = {
      bg: `hsla(${hue}, 82%, 55%, 0.26)`,
      border: `hsla(${hue}, 82%, 65%, 0.55)`,
    };
    projectColorCache.set(key, colors);
    return colors;
  }

  function buildSegmentsIndexForWeek(entries, weekStart) {
    const index = new Map();
    if (!weekStart) return index;
    const weekEnd = addIsoDays(weekStart, 7);
    const now = new Date();

    for (const entry of entries) {
      if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) continue;
      const start = entry.startDate;
      const end = entry.endDate instanceof Date && !Number.isNaN(entry.endDate.getTime()) ? entry.endDate : entry.is_running ? now : null;
      if (!end) continue;
      if (end.getTime() < start.getTime()) continue;

      const startDay = dateFmt.format(start);
      const endDay = dateFmt.format(end);
      if (endDay < weekStart || startDay >= weekEnd) continue;

      const startMin = hhmmToMinutes(timeFmt.format(start));
      const endMin = hhmmToMinutes(timeFmt.format(end));
      if (startMin === null || endMin === null) continue;

      let day = startDay;
      // Safety: cap at 14 days to avoid pathological entries.
      for (let iter = 0; iter < 14; iter++) {
        if (day >= weekEnd) break;
        const segStart = day === startDay ? startMin : 0;
        const segEnd = day === endDay ? endMin : 1440;
        if (day >= weekStart && segEnd > segStart) {
          const key = `${entry.id}@${day}`;
          const seg = { key, day, entry, startMinutes: segStart, endMinutes: segEnd };
          const bucket = index.get(day);
          if (bucket) bucket.push(seg);
          else index.set(day, [seg]);
        }

        if (day === endDay) break;
        day = addIsoDays(day, 1);
      }
    }

    return index;
  }

  function invalidateWeekSegmentsCache(weekStart) {
    if (!weekStart) return;
    weekSegmentsCache.delete(weekStart);
    weekSegmentsCache.delete(addIsoDays(weekStart, 7));
  }

  function clampWeekFocus() {
    focusedDayIndex = Math.max(0, Math.min(6, focusedDayIndex));
    if (!weekDom) return;
    const keys = weekDom.dayKeys[focusedDayIndex] || [];
    if (!keys.length) {
      focusedEntryIndexByDay[focusedDayIndex] = 0;
      return;
    }
    const current = Number(focusedEntryIndexByDay[focusedDayIndex] || 0);
    focusedEntryIndexByDay[focusedDayIndex] = Math.max(0, Math.min(keys.length - 1, current));
  }

  function applyWeekFocusAndSelection() {
    if (!weekDom) return;
    clampWeekFocus();

    for (let i = 0; i < weekDom.dayColEls.length; i++) {
      weekDom.dayColEls[i].classList.toggle("is-focused", i === focusedDayIndex);
    }

    const dayKeys = weekDom.dayKeys[focusedDayIndex] || [];
    const selectedKey = dayKeys.length ? dayKeys[focusedEntryIndexByDay[focusedDayIndex] || 0] : null;
    selectedSegKey = selectedKey || null;
    selectedEntryId = null;
    if (selectedKey && typeof selectedKey === "string") {
      const at = selectedKey.indexOf("@");
      const idText = at >= 0 ? selectedKey.slice(0, at) : selectedKey;
      const idNum = Number.parseInt(idText, 10);
      if (Number.isFinite(idNum)) selectedEntryId = idNum;
    }
    for (const [key, el] of weekDom.entryElsByKey.entries()) {
      el.classList.toggle("is-selected", Boolean(selectedKey && key === selectedKey));
    }
  }

  function scrollWeekFocusIntoView() {
    if (!weekDom) return;
    const dayKeys = weekDom.dayKeys[focusedDayIndex] || [];
    const selectedKey = dayKeys.length ? dayKeys[focusedEntryIndexByDay[focusedDayIndex] || 0] : null;

    const target = selectedKey ? weekDom.entryElsByKey.get(selectedKey) : weekDom.dayColEls[focusedDayIndex];
    if (!target) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function computeWeekMetrics() {
    if (!weekDom) return null;
    const headerEl = weekDom.gridEl.querySelector(".wg-header");
    const headerHeight = headerEl ? headerEl.offsetHeight : 48;
    const baseHeight = Math.max(240, weekScrollEl.clientHeight - headerHeight);
    const timelineHeight = Math.max(240, Math.round(baseHeight * zoom));
    return { baseHeight, headerHeight, timelineHeight, pxPerMinute: timelineHeight / 1440 };
  }

  function renderTimeAxis(metrics) {
    if (!weekDom) return;
    const { timelineHeight, pxPerMinute } = metrics;
    weekDom.timeAxisEl.innerHTML = "";

    for (let hour = 0; hour <= 24; hour++) {
      if (hour === 24 && timelineHeight < 420) continue; // avoid crowding at small heights
      const top = hour * 60 * pxPerMinute;
      const label = document.createElement("div");
      label.className = "wg-time-label";
      label.textContent = `${String(hour).padStart(2, "0")}:00`;
      label.style.top = `${top}px`;
      label.style.transform = hour === 0 ? "translateY(0)" : "translateY(-50%)";
      weekDom.timeAxisEl.append(label);
    }
  }

  function updateWeekScaleAndReposition() {
    if (!weekDom) return;
    const metrics = computeWeekMetrics();
    if (!metrics) return;
    weekDom.metrics = metrics;
    weekDom.gridEl.style.setProperty("--timeline-height", `${metrics.timelineHeight}px`);
    renderTimeAxis(metrics);

    for (const el of weekDom.entryElsByKey.values()) {
      const start = Number.parseFloat(el.dataset.start || "0");
      const end = Number.parseFloat(el.dataset.end || "0");
      const topPx = start * metrics.pxPerMinute;
      const heightPx = Math.max(1, (end - start) * metrics.pxPerMinute);
      el.style.top = `${topPx}px`;
      el.style.height = `${heightPx}px`;
    }

    updateCursorLine();
    scrollWeekFocusIntoView();
  }

  function rebuildWeekView() {
    weekScrollEl.innerHTML = "";
    weekDom = null;

    if (!weekStartStr) {
      weekLabelEl.textContent = "";
      return;
    }

    segmentsIndex = getWeekSegmentsIndex(weekStartStr);

    const days = Array.from({ length: 7 }, (_, i) => addIsoDays(weekStartStr, i));
    const weekEnd = days[6];
    const { isoYear, week } = isoWeekInfo(weekStartStr);
    weekLabelEl.textContent = `${isoYear}-W${String(week).padStart(2, "0")} • ${weekStartStr} → ${weekEnd}`;

    const gridEl = document.createElement("div");
    gridEl.className = "week-grid";

    const timeHeader = document.createElement("div");
    timeHeader.className = "wg-header";
    gridEl.append(timeHeader);

    for (let i = 0; i < 7; i++) {
      const header = document.createElement("div");
      header.className = "wg-header";
      header.dataset.dayIdx = String(i);

      const dowEl = document.createElement("div");
      dowEl.className = "wg-dow";
      dowEl.textContent = DOW_LABELS[i];
      const dateEl = document.createElement("div");
      dateEl.className = "wg-date";
      dateEl.textContent = days[i];

      header.append(dowEl, dateEl);
      header.addEventListener("click", () => {
        focusedDayIndex = i;
        applyWeekFocusAndSelection();
        scrollWeekFocusIntoView();
        weekScrollEl.focus();
      });
      gridEl.append(header);
    }

    const timeAxisEl = document.createElement("div");
    timeAxisEl.className = "wg-timeaxis";
    gridEl.append(timeAxisEl);

    const dayColEls = [];
    const entryElsByKey = new Map();
    const keyToIndexByDay = Array.from({ length: 7 }, () => new Map());
    const dayKeys = Array.from({ length: 7 }, () => []);

    for (let i = 0; i < 7; i++) {
      const col = document.createElement("div");
      col.className = "wg-daycol";
      col.dataset.dayIdx = String(i);
      col.addEventListener("click", () => {
        focusedDayIndex = i;
        applyWeekFocusAndSelection();
        scrollWeekFocusIntoView();
        weekScrollEl.focus();
      });
      dayColEls.push(col);
      gridEl.append(col);
    }

    weekScrollEl.append(gridEl);
    weekDom = { days, dayColEls, dayKeys, entryElsByKey, gridEl, keyToIndexByDay, metrics: null, timeAxisEl };

    const metrics = computeWeekMetrics();
    if (metrics) {
      weekDom.metrics = metrics;
      gridEl.style.setProperty("--timeline-height", `${metrics.timelineHeight}px`);
      renderTimeAxis(metrics);
    }

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const dateStr = days[dayIdx];
      const segs = (segmentsIndex.get(dateStr) || []).slice();
      segs.sort(
        (a, b) =>
          a.startMinutes - b.startMinutes ||
          a.endMinutes - b.endMinutes ||
          (a.entry?.project || "").localeCompare(b.entry?.project || "") ||
          (a.entry?.id || 0) - (b.entry?.id || 0),
      );

      const laneEnds = [];
      const assigned = [];
      for (const seg of segs) {
        let lane = -1;
        let bestEnd = Infinity;
        for (let i = 0; i < laneEnds.length; i++) {
          const end = laneEnds[i];
          if (end <= seg.startMinutes && end < bestEnd) {
            lane = i;
            bestEnd = end;
          }
        }
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(seg.endMinutes);
        } else {
          laneEnds[lane] = seg.endMinutes;
        }
        assigned.push({ lane, seg });
      }

      const laneCount = Math.max(1, laneEnds.length);
      const pxPerMinute = weekDom.metrics ? weekDom.metrics.pxPerMinute : 1;

      for (let idx = 0; idx < assigned.length; idx++) {
        const { lane, seg } = assigned[idx];
        const entry = seg.entry || {};
        const project = entry.project || "—";
        const description = entry.description || "";

        dayKeys[dayIdx].push(seg.key);
        keyToIndexByDay[dayIdx].set(seg.key, idx);

        const el = document.createElement("div");
        el.className = "entry-block";
        el.dataset.key = seg.key;
        el.dataset.dayIdx = String(dayIdx);
        el.dataset.start = String(seg.startMinutes);
        el.dataset.end = String(seg.endMinutes);

        const colors = projectColors(project);
        el.style.setProperty("--entry-bg", colors.bg);
        el.style.setProperty("--entry-border", colors.border);

        const widthPct = 100 / laneCount;
        el.style.left = `${lane * widthPct}%`;
        el.style.width = `${widthPct}%`;

        const topPx = seg.startMinutes * pxPerMinute;
        const heightPx = Math.max(1, (seg.endMinutes - seg.startMinutes) * pxPerMinute);
        el.style.top = `${topPx}px`;
        el.style.height = `${heightPx}px`;

        const projectEl = document.createElement("div");
        projectEl.className = "entry-project";
        projectEl.textContent = project;
        const descEl = document.createElement("div");
        descEl.className = "entry-desc";
        descEl.textContent = description;
        el.append(projectEl, descEl);

        el.title = `${dateStr} ${minutesToHHMM(seg.startMinutes)}–${minutesToHHMM(seg.endMinutes)} • ${project}${
          description ? ` • ${description}` : ""
        }`;

        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          focusedDayIndex = dayIdx;
          const idxInDay = keyToIndexByDay[dayIdx].get(seg.key);
          if (typeof idxInDay === "number") focusedEntryIndexByDay[dayIdx] = idxInDay;
          applyWeekFocusAndSelection();
          scrollWeekFocusIntoView();
          weekScrollEl.focus();
        });

        dayColEls[dayIdx].append(el);
        entryElsByKey.set(seg.key, el);
      }
    }

    applyWeekFocusAndSelection();
    updateCursorLine();
    scrollWeekFocusIntoView();
    updateEditorBadge();

    latestWeekBtn.disabled = Boolean(latestWeekStartStr && latestWeekStartStr === weekStartStr);
  }

  function setWeekStart(nextWeekStartStr, nextFocusedDayIndex = focusedDayIndex) {
    if (!nextWeekStartStr) return;
    weekStartStr = isoWeekStart(nextWeekStartStr);
    focusedDayIndex = Math.max(0, Math.min(6, nextFocusedDayIndex));
    rebuildWeekView();
  }

  function moveFocusDay(deltaDays) {
    if (!weekDom || !weekStartStr) return;
    const next = focusedDayIndex + deltaDays;
    if (next < 0) return setWeekStart(addIsoDays(weekStartStr, -7), 6);
    if (next > 6) return setWeekStart(addIsoDays(weekStartStr, 7), 0);
    focusedDayIndex = next;
    applyWeekFocusAndSelection();
    scrollWeekFocusIntoView();
  }

  function moveFocusEntry(deltaEntries) {
    if (!weekDom) return;
    const dayKeys = weekDom.dayKeys[focusedDayIndex] || [];
    if (!dayKeys.length) return moveFocusDay(deltaEntries > 0 ? 1 : -1);

    const current = Number(focusedEntryIndexByDay[focusedDayIndex] || 0);
    const next = current + deltaEntries;
    if (next < 0) {
      moveFocusDay(-1);
      if (!weekDom) return;
      const keys = weekDom.dayKeys[focusedDayIndex] || [];
      focusedEntryIndexByDay[focusedDayIndex] = keys.length ? keys.length - 1 : 0;
      applyWeekFocusAndSelection();
      scrollWeekFocusIntoView();
      return;
    }
    if (next >= dayKeys.length) {
      moveFocusDay(1);
      if (!weekDom) return;
      focusedEntryIndexByDay[focusedDayIndex] = 0;
      applyWeekFocusAndSelection();
      scrollWeekFocusIntoView();
      return;
    }

    focusedEntryIndexByDay[focusedDayIndex] = next;
    applyWeekFocusAndSelection();
    scrollWeekFocusIntoView();
  }

  function weekBoundsMs(weekStart) {
    if (!weekStart) return null;
    const startMs = dateFromLocalDayMinutes(weekStart, 0).getTime();
    const endMs = dateFromLocalDayMinutes(addIsoDays(weekStart, 7), 0).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    return { startMs, endMs };
  }

  function snapAddCursorMs(ms, direction) {
    if (!Number.isFinite(ms)) return ms;
    const bounds = weekBoundsMs(weekStartStr);
    if (!bounds) return ms;

    const dt = new Date(ms);
    if (Number.isNaN(dt.getTime())) return ms;
    const dayStr = dateFmt.format(dt);
    const minutes = hhmmToMinutes(timeFmt.format(dt));
    if (minutes === null) return ms;

    const segs = segmentsIndex.get(dayStr) || [];
    for (const seg of segs) {
      if (minutes >= seg.startMinutes && minutes < seg.endMinutes) {
        const entry = seg.entry;
        const startMs = entry?.startDate instanceof Date ? entry.startDate.getTime() : null;
        const endMs = entry?.endDate instanceof Date ? entry.endDate.getTime() : null;
        const jumpMs = direction < 0 ? startMs : endMs;
        if (Number.isFinite(jumpMs) && jumpMs >= bounds.startMs && jumpMs <= bounds.endMs) return jumpMs;
        // If we cannot jump beyond (e.g., would exit the week), keep the original ms.
        return ms;
      }
    }

    return ms;
  }

  function enterAddMode() {
    if (!weekStartStr) return;
    const bounds = weekBoundsMs(weekStartStr);
    if (!bounds) return;

    let ms = null;
    if (selectedEntryId) {
      const e = entriesById.get(selectedEntryId);
      if (e?.endDate instanceof Date && !Number.isNaN(e.endDate.getTime())) ms = e.endDate.getTime();
    }

    if (!Number.isFinite(ms)) {
      const dayStr = weekDom?.days?.[focusedDayIndex] || weekStartStr;
      ms = dateFromLocalDayMinutes(dayStr, 8 * 60).getTime();
    }

    ms = Math.max(bounds.startMs, Math.min(bounds.endMs, ms));
    ms = snapAddCursorMs(ms, 1);
    cursor = { kind: "add", ms };
    setEditMode("add");

    const dayStr = dateFmt.format(new Date(ms));
    const dayIdx = weekDom?.days?.indexOf(dayStr) ?? -1;
    if (dayIdx >= 0) {
      focusedDayIndex = dayIdx;
      applyWeekFocusAndSelection();
    }
    updateCursorLine();
  }

  function nudgeAddCursor(deltaSteps) {
    if (!cursor || cursor.kind !== "add") return;
    const bounds = weekBoundsMs(weekStartStr);
    if (!bounds) return;

    const direction = deltaSteps < 0 ? -1 : 1;
    let nextMs = cursor.ms + deltaSteps * MIN_ENTRY_MS;
    if (nextMs < bounds.startMs || nextMs > bounds.endMs) return;

    nextMs = snapAddCursorMs(nextMs, direction);
    cursor.ms = nextMs;

    const dayStr = dateFmt.format(new Date(nextMs));
    const dayIdx = weekDom?.days?.indexOf(dayStr) ?? -1;
    if (dayIdx >= 0) focusedDayIndex = dayIdx;
    updateCursorLine();
    applyWeekFocusAndSelection();
    scrollWeekFocusIntoView();
  }

  function shiftAddCursorDay(deltaDays) {
    if (!cursor || cursor.kind !== "add") return;
    const bounds = weekBoundsMs(weekStartStr);
    if (!bounds) return;

    const dt = new Date(cursor.ms);
    if (Number.isNaN(dt.getTime())) return;
    const dayStr = dateFmt.format(dt);
    const minutes = hhmmToMinutes(timeFmt.format(dt));
    if (minutes === null) return;

    const nextDayStr = addIsoDays(dayStr, deltaDays);
    if (weekDom && !weekDom.days.includes(nextDayStr)) return;

    let nextMs = dateFromLocalDayMinutes(nextDayStr, minutes).getTime();
    nextMs = Math.max(bounds.startMs, Math.min(bounds.endMs, nextMs));
    nextMs = snapAddCursorMs(nextMs, deltaDays < 0 ? -1 : 1);
    cursor.ms = nextMs;

    const idx = weekDom?.days?.indexOf(dateFmt.format(new Date(nextMs))) ?? -1;
    if (idx >= 0) focusedDayIndex = idx;
    updateCursorLine();
    applyWeekFocusAndSelection();
    scrollWeekFocusIntoView();
  }

	  function enterSplitMode() {
	    if (!selectedEntryId) return toast("Select an entry first.");
	    const entry = entriesById.get(selectedEntryId);
	    if (!entry) return;
	    if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
	    if (!(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) return;
	    if (weekStartStr && weekStartForEntry(entry) !== weekStartStr) return toast("Split works only for entries in this week.");

	    const startMs = entry.startDate.getTime();
	    const endMs = entry.endDate.getTime();
    if (endMs - startMs < 2 * MIN_ENTRY_MS) return toast("Entry too short to split (min 30 min).");

    const bounds = weekBoundsMs(weekStartStr);
    if (!bounds) return;
    const minMs = Math.max(bounds.startMs, startMs + MIN_ENTRY_MS);
    const maxMs = Math.min(bounds.endMs, endMs - MIN_ENTRY_MS);
    if (maxMs < minMs) return toast("Cannot split outside the current week.");

    let ms = cursor && cursor.kind === "split" ? cursor.ms : startMs + MIN_ENTRY_MS;
    ms = Math.max(minMs, Math.min(maxMs, ms));
    cursor = { kind: "split", ms };
    setEditMode("split");

    const dayStr = dateFmt.format(new Date(ms));
    const dayIdx = weekDom?.days?.indexOf(dayStr) ?? -1;
    if (dayIdx >= 0) focusedDayIndex = dayIdx;
    updateCursorLine();
    applyWeekFocusAndSelection();
    scrollWeekFocusIntoView();
  }

  function nudgeSplitCursor(deltaSteps) {
    if (!cursor || cursor.kind !== "split") return;
    const entry = selectedEntryId ? entriesById.get(selectedEntryId) : null;
    if (!entry) return;
    if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return;
    if (!(entry.endDate instanceof Date) || Number.isNaN(entry.endDate.getTime())) return;

    const bounds = weekBoundsMs(weekStartStr);
    if (!bounds) return;

    const startMs = entry.startDate.getTime();
    const endMs = entry.endDate.getTime();
    const minMs = Math.max(bounds.startMs, startMs + MIN_ENTRY_MS);
    const maxMs = Math.min(bounds.endMs, endMs - MIN_ENTRY_MS);
    if (maxMs < minMs) return toast("Entry too short to split (min 30 min).");

    let nextMs = cursor.ms + deltaSteps * MIN_ENTRY_MS;
    nextMs = Math.max(minMs, Math.min(maxMs, nextMs));
    cursor.ms = nextMs;

    const dayStr = dateFmt.format(new Date(nextMs));
    const dayIdx = weekDom?.days?.indexOf(dayStr) ?? -1;
    if (dayIdx >= 0) focusedDayIndex = dayIdx;
    updateCursorLine();
    applyWeekFocusAndSelection();
    scrollWeekFocusIntoView();
  }

  function deepClone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function ensureEntryWeekStart(entry) {
    if (!entry || !(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) return null;
    if (entry.weekStart) return entry.weekStart;
    const weekStart = isoWeekStart(dateFmt.format(entry.startDate));
    entry.weekStart = weekStart;
    return weekStart;
  }

  function addEntryToWeekIndex(entry) {
    if (!entry) return;
    const weekStart = ensureEntryWeekStart(entry);
    if (!weekStart) return;
    let bucket = weekEntryIds.get(weekStart);
    if (!bucket) {
      bucket = new Set();
      weekEntryIds.set(weekStart, bucket);
    }
    bucket.add(entry.id);

    if (entry.endDate instanceof Date && !Number.isNaN(entry.endDate.getTime())) {
      const span = entry.endDate.getTime() - entry.startDate.getTime();
      if (span > LONG_ENTRY_MS) longEntryIds.add(entry.id);
      else longEntryIds.delete(entry.id);
    } else {
      longEntryIds.delete(entry.id);
    }
  }

  function removeEntryFromWeekIndex(entry) {
    if (!entry) return;
    const weekStart = entry.weekStart;
    if (weekStart && weekEntryIds.has(weekStart)) {
      const bucket = weekEntryIds.get(weekStart);
      bucket?.delete(entry.id);
      if (bucket && bucket.size === 0) weekEntryIds.delete(weekStart);
    }
    longEntryIds.delete(entry.id);
  }

  function rebuildWeekIndexes() {
    weekEntryIds = new Map();
    longEntryIds = new Set();
    for (const entry of entriesById.values()) addEntryToWeekIndex(entry);
  }

  function recomputeLatestWeekStart() {
    let latest = null;
    for (const weekStart of weekEntryIds.keys()) {
      if (!latest || weekStart > latest) latest = weekStart;
    }
    latestWeekStartStr = latest;
  }

  function utcNowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function sortJsonValue(value) {
    if (Array.isArray(value)) return value.map(sortJsonValue);
    if (value && typeof value === "object" && value.constructor === Object) {
      const out = {};
      const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
      for (const k of keys) out[k] = sortJsonValue(value[k]);
      return out;
    }
    return value;
  }

  function jsonStringifySorted(value) {
    return JSON.stringify(sortJsonValue(value), null, 2) + "\n";
  }

  function utf8ByteLength(text) {
    return new TextEncoder().encode(String(text || "")).length;
  }

  function weekFileInfoForStart(weekStart) {
    const { isoYear, week } = isoWeekInfo(weekStart);
    const path = `data/entries/${isoYear}/${String(week).padStart(2, "0")}.json`;
    return { year: isoYear, week, path };
  }

  function buildWeekFileForSave(weekStart, nowIso = utcNowIso()) {
    const info = weekFileInfoForStart(weekStart);
    const entries = snapshotWeekRaw(weekStart);
    const timezone = entriesManifest?.timezone || config.timezone;

    const payload = {
      entries,
      generated_at: nowIso,
      schema_version: 1,
      timezone,
      week: info.week,
      year: info.year,
    };
    const content = jsonStringifySorted(payload);
    return {
      ...info,
      weekStart,
      entries: entries.length,
      payload,
      content,
      size: utf8ByteLength(content),
    };
  }

  function buildManifestForSave(updates, nowIso = utcNowIso()) {
    const timezone = entriesManifest?.timezone || config.timezone;
    const byKey = new Map();
    const baseChunks = Array.isArray(entriesManifest?.chunks) ? entriesManifest.chunks : [];
    for (const c of baseChunks) {
      byKey.set(chunkKey(c.year, c.week), { ...c });
    }

    const list = Array.isArray(updates) ? updates : [];
    for (const u of list) {
      if (!u) continue;
      const year = Number(u.year);
      const week = Number(u.week);
      const sha = typeof u.sha === "string" ? u.sha : "";
      const path = typeof u.path === "string" ? u.path : "";
      const size = typeof u.size === "number" && Number.isFinite(u.size) && u.size >= 0 ? u.size : null;
      const entries = typeof u.entries === "number" && Number.isFinite(u.entries) && u.entries >= 0 ? u.entries : null;
      if (!Number.isFinite(year) || year < 1970 || year > 9999) continue;
      if (!Number.isFinite(week) || week < 1 || week > 53) continue;
      if (!/^[0-9a-f]{40}$/i.test(sha)) continue;

      byKey.set(chunkKey(year, week), {
        entries,
        path: path || `data/entries/${year}/${String(week).padStart(2, "0")}.json`,
        sha,
        size,
        week,
        year,
      });
    }

    const chunks = Array.from(byKey.values());
    chunks.sort((a, b) => a.year - b.year || a.week - b.week);

    let totalEntries = 0;
    for (const c of chunks) {
      if (typeof c.entries === "number" && Number.isFinite(c.entries) && c.entries >= 0) totalEntries += c.entries;
    }

    const manifest = {
      chunks,
      generated_at: nowIso,
      schema_version: 1,
      timezone,
      total_chunks: chunks.length,
      total_entries: totalEntries,
    };
    const content = jsonStringifySorted(manifest);
    return { manifest, content };
  }

  function weekStartForEntry(entry) {
    if (!entry) return null;
    return ensureEntryWeekStart(entry);
  }

  function denormalizeEntry(entry) {
    const { startDate, endDate, durationSeconds, weekStart, ...raw } = entry || {};
    return deepClone(raw);
  }

  function snapshotWeekRaw(weekStart) {
    const out = [];
    const ids = weekEntryIds.get(weekStart);
    if (ids) {
      for (const id of ids) {
        const entry = entriesById.get(id);
        if (!entry) continue;
        out.push(denormalizeEntry(entry));
      }
    }
    out.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")) || (a.id || 0) - (b.id || 0));
    return out;
  }

  function applyWeekSnapshot(weekStart, rawEntries) {
    const existingIds = Array.from(weekEntryIds.get(weekStart) || []);
    for (const id of existingIds) {
      const entry = entriesById.get(id);
      if (entry) removeEntryFromWeekIndex(entry);
      entriesById.delete(id);
    }

    const nextEntries = Array.isArray(rawEntries) ? rawEntries : [];
    for (const raw of nextEntries) {
      if (!raw || typeof raw !== "object") continue;
      const id = Number(raw.id);
      if (!Number.isFinite(id)) continue;
      const entry = normalizeEntry(raw);
      entriesById.set(id, entry);
      addEntryToWeekIndex(entry);
    }
    invalidateWeekSegmentsCache(weekStart);
    recomputeLatestWeekStart();
    if (!weekStartStr && latestWeekStartStr) weekStartStr = latestWeekStartStr;

    searchDirty = true;
    if (activeTab === "search" && !searchViewEl.hidden) applyFiltersAndRender();
    if (weekStartStr === weekStart) rebuildWeekView();
  }

  function recomputeNextEntryId() {
    let maxId = 0;
    for (const entry of entriesById.values()) {
      const id = Number(entry?.id);
      if (Number.isFinite(id) && id > maxId) maxId = id;
    }
    nextEntryId = maxId + 1;
  }

  function entryIntersectsRange(entry, startMs, endMs) {
    if (!entry || !(entry.startDate instanceof Date) || !(entry.endDate instanceof Date)) return false;
    const s = entry.startDate.getTime();
    const e = entry.endDate.getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    return e > startMs && s < endMs;
  }

  function collectEntriesForWeekWindow(weekStart, bounds) {
    if (!bounds) throw new Error("Invalid week bounds");
    const windowStartMs = bounds.startMs - 7 * 24 * 60 * 60 * 1000;
    const windowEndMs = bounds.endMs + 7 * 24 * 60 * 60 * 1000;

    const prevWeek = addIsoDays(weekStart, -7);
    const nextWeek = addIsoDays(weekStart, 7);
    const candidates = new Set();
    for (const ws of [prevWeek, weekStart, nextWeek]) {
      const bucket = weekEntryIds.get(ws);
      if (!bucket) continue;
      for (const id of bucket) candidates.add(id);
    }
    for (const id of longEntryIds) candidates.add(id);

    const entries = [];
    for (const id of candidates) {
      const entry = entriesById.get(id);
      if (!entry) continue;
      if (entryIntersectsRange(entry, windowStartMs, windowEndMs)) entries.push(entry);
    }

    return { windowStartMs, windowEndMs, entries };
  }

  function getWeekSegmentsIndex(weekStart) {
    if (!weekStart) return new Map();
    const cached = weekSegmentsCache.get(weekStart);
    if (cached) return cached;
    const bounds = weekBoundsMs(weekStart);
    if (!bounds) return new Map();
    const { entries } = collectEntriesForWeekWindow(weekStart, bounds);
    const index = buildSegmentsIndexForWeek(entries, weekStart);
    weekSegmentsCache.set(weekStart, index);
    return index;
  }

  function buildWeekSchedule(weekStart) {
    const bounds = weekBoundsMs(weekStart);
    if (!bounds) throw new Error("Invalid week bounds");

    const { entries } = collectEntriesForWeekWindow(weekStart, bounds);
    const nodes = [];
    for (const entry of entries) {
      const startMs = entry.startDate.getTime();
      const endMs = entry.endDate.getTime();
      const editable = weekStartForEntry(entry) === weekStart;
      nodes.push({
        id: entry.id,
        startMs,
        endMs,
        editable,
        raw: editable ? denormalizeEntry(entry) : null,
      });
    }

    nodes.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
    return { bounds, nodes };
  }

  function ensureEditableNode(node) {
    if (!node) throw new Error("Missing entry");
    if (!node.editable) throw new Error("Entry is outside this week; open its start week to edit.");
    if (!Number.isFinite(node.startMs) || !Number.isFinite(node.endMs)) throw new Error("Entry has invalid time range.");
    if (node.endMs <= node.startMs) throw new Error("Entry has end before start.");
  }

  function enforceEditableBounds(node, bounds) {
    if (!node.editable) return;
    if (node.startMs < bounds.startMs || node.startMs >= bounds.endMs) {
      throw new Error("Edit would move an entry across week boundaries.");
    }
  }

  function resolveNonOverlapping(nodes, targetId, bounds) {
    nodes.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
    const idx = nodes.findIndex((n) => n.id === targetId);
    if (idx < 0) throw new Error("Missing edited entry");

    // Validate editable entries.
    for (const n of nodes) {
      if (n.editable) {
        ensureEditableNode(n);
        if (n.endMs - n.startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
        enforceEditableBounds(n, bounds);
      }
    }

    // Backward pass: compress/move earlier entries.
    for (let i = idx - 1; i >= 0; i--) {
      const prev = nodes[i];
      const next = nodes[i + 1];
      if (prev.endMs <= next.startMs) continue;
      if (!prev.editable) throw new Error("Would need to modify an entry outside this week.");

      const overlap = prev.endMs - next.startMs;
      const minEnd = prev.startMs + MIN_ENTRY_MS;
      prev.endMs = Math.max(minEnd, prev.endMs - overlap);

      if (prev.endMs > next.startMs) {
        const remaining = prev.endMs - next.startMs;
        prev.startMs -= remaining;
        prev.endMs -= remaining;
      }

      if (prev.endMs > next.startMs) throw new Error("Failed to resolve overlap (backward).");
      if (prev.endMs - prev.startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
      enforceEditableBounds(prev, bounds);
    }

    // Forward pass: move later entries only.
    for (let i = idx + 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const next = nodes[i];
      if (next.startMs >= prev.endMs) continue;
      if (!next.editable) throw new Error("Would need to modify an entry outside this week.");

      const shift = prev.endMs - next.startMs;
      next.startMs += shift;
      next.endMs += shift;

      if (next.startMs < prev.endMs) throw new Error("Failed to resolve overlap (forward).");
      if (next.endMs - next.startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
      enforceEditableBounds(next, bounds);
    }

    // Final sanity: verify adjacent non-overlap.
    nodes.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
    for (let i = 1; i < nodes.length; i++) {
      if (nodes[i - 1].endMs > nodes[i].startMs) throw new Error("Overlaps remain after resolve.");
    }
  }

  function applyTimesToRaw(raw, startMs, endMs) {
    const start = new Date(startMs);
    const end = new Date(endMs);
    raw.start = formatIsoWithOffset(start);
    raw.end = formatIsoWithOffset(end);
    raw.is_running = false;
    raw.duration_seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
    if (!Array.isArray(raw.tags)) raw.tags = [];
    raw.updated_at = raw.updated_at || formatIsoWithOffset(new Date());
  }

  function makeNewRawEntry({ id, startMs, endMs }) {
    const raw = {
      billable: false,
      client: null,
      client_id: null,
      created_at: null,
      description: "",
      duration_seconds: null,
      end: null,
      id,
      is_running: false,
      project: "",
      project_id: null,
      start: null,
      tags: [],
      updated_at: null,
      user_id: null,
    };
    applyTimesToRaw(raw, startMs, endMs);
    return raw;
  }

  function weekRawFromNodes(nodes) {
    const out = [];
    for (const n of nodes) {
      if (!n.editable) continue;
      if (!n.raw) throw new Error("Missing raw entry payload");
      applyTimesToRaw(n.raw, n.startMs, n.endMs);
      out.push(n.raw);
    }
    out.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")) || (a.id || 0) - (b.id || 0));
    return out;
  }

  function focusEntryByIdInWeek(entryId, preferredDayStr = null) {
    if (!weekDom || !entryId) return;
    const id = Number(entryId);
    if (!Number.isFinite(id)) return;

    if (preferredDayStr && typeof preferredDayStr === "string") {
      const dayIdx = weekDom.days.indexOf(preferredDayStr);
      if (dayIdx >= 0) {
        const key = `${id}@${preferredDayStr}`;
        const idx = weekDom.keyToIndexByDay?.[dayIdx]?.get(key);
        if (typeof idx === "number") {
          focusedDayIndex = dayIdx;
          focusedEntryIndexByDay[dayIdx] = idx;
          applyWeekFocusAndSelection();
          scrollWeekFocusIntoView();
          return;
        }
      }
    }

    const prefix = `${id}@`;
    for (let i = 0; i < 7; i++) {
      const keys = weekDom.dayKeys[i] || [];
      const found = keys.findIndex((k) => typeof k === "string" && k.startsWith(prefix));
      if (found >= 0) {
        focusedDayIndex = i;
        focusedEntryIndexByDay[i] = found;
        applyWeekFocusAndSelection();
        scrollWeekFocusIntoView();
        return;
      }
    }
  }

  function scheduleAutosave() {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    if (!dirtyWeekStarts.size) return;

    const sinceLastEdit = Date.now() - lastEditAt;
    const dueIn = Math.max(500, 30_000 - (Number.isFinite(sinceLastEdit) ? sinceLastEdit : 0));
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = 0;
      if (!dirtyWeekStarts.size) return;
      if (saveInFlight) return scheduleAutosave();
      if (Date.now() - lastEditAt < 30_000) return scheduleAutosave();
      saveDirtyWeeksNow("autosave");
    }, dueIn);
  }

  function markDirty(weekStart) {
    if (!weekStart) return;
    dirtyWeekStarts.add(weekStart);
    lastEditAt = Date.now();
    updateEditorBadge();
    scheduleAutosave();
  }

  function pushUndoAction(action) {
    undoStack.push(action);
    redoStack.length = 0;
  }

  function applyEditorActionSnapshot(weekStart, rawEntries, focusEntryId = null) {
    if (!weekStart) return;
    if (weekStartStr !== weekStart) setWeekStart(weekStart);
    applyWeekSnapshot(weekStart, rawEntries);
    setEditMode("normal");
    if (focusEntryId) {
      const entry = entriesById.get(focusEntryId);
      const day = entry?.startDate instanceof Date ? dateFmt.format(entry.startDate) : null;
      focusEntryByIdInWeek(focusEntryId, day);
    }
    updateEditorBadge();
  }

  function undo() {
    const action = undoStack.pop();
    if (!action) return;
    applyEditorActionSnapshot(action.weekStart, action.before, action.focusBefore || null);
    redoStack.push(action);
    markDirty(action.weekStart);
  }

  function redo() {
    const action = redoStack.pop();
    if (!action) return;
    applyEditorActionSnapshot(action.weekStart, action.after, action.focusAfter || null);
    undoStack.push(action);
    markDirty(action.weekStart);
  }

  async function applyPostSaveUpdates({ manifest, weekUpdates }) {
    if (manifest && typeof manifest === "object") {
      entriesManifest = normalizeManifest(manifest);
      chunkFiles = entriesManifest.chunks;
      refreshRepoLabel();
    }

    const updates = Array.isArray(weekUpdates) ? weekUpdates : [];
    for (const u of updates) {
      if (!u) continue;
      const year = Number(u.year);
      const week = Number(u.week);
      const sha = typeof u.sha === "string" ? u.sha : "";
      const payload = u.payload && typeof u.payload === "object" ? u.payload : null;
      if (!Number.isFinite(year) || !Number.isFinite(week) || !/^[0-9a-f]{40}$/i.test(sha) || !payload) continue;

      const key = chunkKey(year, week);
      const entries = Array.isArray(payload.entries) ? payload.entries.map(normalizeEntry) : [];
      chunkCache.set(key, { sha, entries });
      await chunkCachePutRaw(sha, JSON.stringify(payload));

      const oldSha = typeof u.oldSha === "string" ? u.oldSha : "";
      if (oldSha && oldSha !== sha) {
        await chunkCacheDeleteRaw(oldSha);
      }
    }
  }

  async function saveWeeksToGitHub(weekStarts, reason) {
    if (!token) throw new Error("Not logged in.");
    if (!entriesManifest) await fetchManifest();

    const baseUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
    const branch = String(config.ref || "").trim();
    if (!branch) throw new Error("Missing branch ref.");

    const refInfo = await ghJsonRequest(`${baseUrl}/git/ref/heads/${encodeURIComponent(branch)}`, token);
    const baseCommitSha = refInfo?.object?.sha;
    if (!/^[0-9a-f]{40}$/i.test(baseCommitSha || "")) throw new Error("Failed to resolve branch ref.");

    const baseCommit = await ghJsonRequest(`${baseUrl}/git/commits/${encodeURIComponent(baseCommitSha)}`, token);
    const baseTreeSha = baseCommit?.tree?.sha;
    if (!/^[0-9a-f]{40}$/i.test(baseTreeSha || "")) throw new Error("Failed to resolve base tree.");

    const nowIso = utcNowIso();
    const weekList = Array.isArray(weekStarts) ? weekStarts : [];
    const weekFiles = weekList.map((ws) => buildWeekFileForSave(ws, nowIso));

    const existingByKey = new Map();
    for (const c of chunkFiles) existingByKey.set(chunkKey(c.year, c.week), c);

    const weekUpdates = [];
    for (const wf of weekFiles) {
      const blob = await ghJsonRequest(`${baseUrl}/git/blobs`, token, {
        method: "POST",
        body: { content: wf.content, encoding: "utf-8" },
      });
      const sha = blob?.sha;
      if (!/^[0-9a-f]{40}$/i.test(sha || "")) throw new Error(`Failed to create blob for ${wf.path}`);

      const existing = existingByKey.get(chunkKey(wf.year, wf.week));
      weekUpdates.push({
        ...wf,
        sha,
        oldSha: existing?.sha || "",
      });
    }

    const { manifest, content: manifestContent } = buildManifestForSave(weekUpdates, nowIso);
    const manifestBlob = await ghJsonRequest(`${baseUrl}/git/blobs`, token, {
      method: "POST",
      body: { content: manifestContent, encoding: "utf-8" },
    });
    const manifestSha = manifestBlob?.sha;
    if (!/^[0-9a-f]{40}$/i.test(manifestSha || "")) throw new Error("Failed to create manifest blob.");

    const tree = [];
    for (const u of weekUpdates) tree.push({ path: u.path, mode: "100644", type: "blob", sha: u.sha });
    tree.push({ path: "data/index/entries-manifest.json", mode: "100644", type: "blob", sha: manifestSha });

    const treeRes = await ghJsonRequest(`${baseUrl}/git/trees`, token, {
      method: "POST",
      body: { base_tree: baseTreeSha, tree },
    });
    const newTreeSha = treeRes?.sha;
    if (!/^[0-9a-f]{40}$/i.test(newTreeSha || "")) throw new Error("Failed to create tree.");

    const labels = weekUpdates
      .map((u) => `${u.year}-W${String(u.week).padStart(2, "0")}`)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    const message = reason === "autosave" ? `Autosave time entries (${labels})` : `Edit time entries (${labels})`;

    const commitRes = await ghJsonRequest(`${baseUrl}/git/commits`, token, {
      method: "POST",
      body: { message, tree: newTreeSha, parents: [baseCommitSha] },
    });
    const newCommitSha = commitRes?.sha;
    if (!/^[0-9a-f]{40}$/i.test(newCommitSha || "")) throw new Error("Failed to create commit.");

    await ghJsonRequest(`${baseUrl}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
      method: "PATCH",
      body: { sha: newCommitSha, force: false },
    });

    await applyPostSaveUpdates({ manifest, weekUpdates });
  }

  async function saveWeeksToLocalServer(weekStarts, _reason) {
    if (!entriesManifest) await fetchManifest();

    const nowIso = utcNowIso();
    const weekList = Array.isArray(weekStarts) ? weekStarts : [];
    const weekFiles = weekList.map((ws) => buildWeekFileForSave(ws, nowIso));

    const existingByKey = new Map();
    for (const c of chunkFiles) existingByKey.set(chunkKey(c.year, c.week), c);

    const reqWeeks = weekFiles.map((wf) => ({
      year: wf.year,
      week: wf.week,
      entries: Array.isArray(wf.payload?.entries) ? wf.payload.entries : [],
    }));

    const timezone = entriesManifest?.timezone || config.timezone;
    let resp;
    try {
      resp = await fetch(localRepoUrl("save"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weeks: reqWeeks, timezone }),
      });
    } catch {
      throw new Error("Local save failed. Run the app via: python3 server.py");
    }

    if (!resp.ok) throw new Error(`Local save failed (${resp.status}): ${await resp.text()}`);

    const result = await resp.json();
    if (!result || result.ok !== true) throw new Error(typeof result?.error === "string" ? result.error : "Local save failed.");

    const saved = Array.isArray(result.saved) ? result.saved : [];
    const savedByKey = new Map();
    for (const s of saved) {
      const year = Number(s?.year);
      const week = Number(s?.week);
      const sha = typeof s?.sha === "string" ? s.sha : "";
      if (!Number.isFinite(year) || !Number.isFinite(week) || !/^[0-9a-f]{40}$/i.test(sha)) continue;
      savedByKey.set(chunkKey(year, week), sha);
    }

    const weekUpdates = [];
    for (const wf of weekFiles) {
      const sha = savedByKey.get(chunkKey(wf.year, wf.week));
      if (!sha) throw new Error(`Local save did not return a sha for ${wf.year}-W${String(wf.week).padStart(2, "0")}.`);
      const existing = existingByKey.get(chunkKey(wf.year, wf.week));
      weekUpdates.push({ ...wf, sha, oldSha: existing?.sha || "" });
    }

    await applyPostSaveUpdates({ manifest: result.manifest, weekUpdates });
  }

  async function saveDirtyWeeksNow(reason) {
    if (saveInFlight) return;
    const weekStarts = Array.from(dirtyWeekStarts).filter(Boolean);
    if (!weekStarts.length) {
      if (reason === "manual") toast("Nothing to save.");
      return;
    }

    window.clearTimeout(autosaveTimer);
    autosaveTimer = 0;

    saveInFlight = true;
    setBusy(true);
    updateEditorBadge();

    const sortedWeeks = weekStarts.slice().sort((a, b) => a.localeCompare(b));
    try {
      if (isLocalMode) {
        await saveWeeksToLocalServer(sortedWeeks, reason);
      } else {
        await saveWeeksToGitHub(sortedWeeks, reason);
      }

      for (const ws of sortedWeeks) dirtyWeekStarts.delete(ws);
      if (reason === "manual") toast("Saved.");
    } catch (e) {
      toast(safeText(e), 5000);
    } finally {
      saveInFlight = false;
      setBusy(false);
      updateEditorBadge();
    }
  }

  function applyWeekEdit({ weekStart, label, getAfterRaw, focusAfter }) {
    if (saveInFlight) return toast("Saving in progress…");
    const before = snapshotWeekRaw(weekStart);
    const focusBefore = selectedEntryId;
    let after;
    try {
      after = getAfterRaw();
    } catch (e) {
      toast(safeText(e));
      return;
    }

    applyWeekSnapshot(weekStart, after);
    pushUndoAction({ weekStart, label, before, after, focusBefore, focusAfter });
    markDirty(weekStart);
    setEditMode("normal");
    if (focusAfter) {
      const entry = entriesById.get(focusAfter);
      const day = entry?.startDate instanceof Date ? dateFmt.format(entry.startDate) : null;
      focusEntryByIdInWeek(focusAfter, day);
    }
  }

  function extendSelectedEntry(deltaStartMs, deltaEndMs) {
    if (!weekStartStr) return;
    if (!selectedEntryId) return;

    applyWeekEdit({
      weekStart: weekStartStr,
      label: "extend",
      focusAfter: selectedEntryId,
      getAfterRaw: () => {
        const { bounds, nodes } = buildWeekSchedule(weekStartStr);
        const node = nodes.find((n) => n.id === selectedEntryId);
        ensureEditableNode(node);

        node.startMs += deltaStartMs;
        node.endMs += deltaEndMs;
        if (node.endMs - node.startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
        enforceEditableBounds(node, bounds);

        resolveNonOverlapping(nodes, selectedEntryId, bounds);
        return weekRawFromNodes(nodes);
      },
    });
  }

  function moveSelectedEntry(deltaMs) {
    extendSelectedEntry(deltaMs, deltaMs);
  }

  function deleteSelectedEntry() {
    if (!weekStartStr) return;
    if (!selectedEntryId) return;

    const deletedId = selectedEntryId;
    applyWeekEdit({
      weekStart: weekStartStr,
      label: "delete",
      focusAfter: null,
      getAfterRaw: () => {
        const { nodes } = buildWeekSchedule(weekStartStr);
        const node = nodes.find((n) => n.id === deletedId);
        ensureEditableNode(node);
        const remaining = nodes.filter((n) => !(n.editable && n.id === deletedId));
        return weekRawFromNodes(remaining);
      },
    });
  }

  function addEntryFromCursor() {
    if (!weekStartStr) return;
    if (!cursor || cursor.kind !== "add") return;

    const startMs = cursor.ms;
    const endMs = startMs + MIN_ENTRY_MS;
    const newId = nextEntryId;

    applyWeekEdit({
      weekStart: weekStartStr,
      label: "add",
      focusAfter: newId,
      getAfterRaw: () => {
        const { bounds, nodes } = buildWeekSchedule(weekStartStr);
        const newNode = { id: newId, startMs, endMs, editable: true, raw: makeNewRawEntry({ id: newId, startMs, endMs }) };
        enforceEditableBounds(newNode, bounds);
        if (endMs - startMs < MIN_ENTRY_MS) throw new Error("Entry shorter than 15 minutes.");
        nodes.push(newNode);
        resolveNonOverlapping(nodes, newId, bounds);
        return weekRawFromNodes(nodes);
      },
    });

    const created = entriesById.get(newId);
    if (created) {
      openEntryDialog(newId);
      nextEntryId = Math.max(nextEntryId, newId + 1);
    }
  }

  function splitSelectedEntryAtCursor() {
    if (!weekStartStr) return;
    if (!selectedEntryId) return;
    if (!cursor || cursor.kind !== "split") return;

    const splitMs = cursor.ms;
    const firstId = selectedEntryId;
    const secondId = nextEntryId;

    applyWeekEdit({
      weekStart: weekStartStr,
      label: "split",
      focusAfter: secondId,
      getAfterRaw: () => {
        const { bounds, nodes } = buildWeekSchedule(weekStartStr);
        const node = nodes.find((n) => n.id === firstId);
        ensureEditableNode(node);
        if (node.endMs - node.startMs < 2 * MIN_ENTRY_MS) throw new Error("Entry too short to split.");

        const minMs = node.startMs + MIN_ENTRY_MS;
        const maxMs = node.endMs - MIN_ENTRY_MS;
        if (splitMs < minMs || splitMs > maxMs) throw new Error("Invalid split point.");

        const secondRaw = deepClone(node.raw);
        secondRaw.id = secondId;

        const secondNode = { id: secondId, startMs: splitMs, endMs: node.endMs, editable: true, raw: secondRaw };
        node.endMs = splitMs;

        enforceEditableBounds(node, bounds);
        enforceEditableBounds(secondNode, bounds);

        nodes.push(secondNode);
        resolveNonOverlapping(nodes, secondId, bounds);
        return weekRawFromNodes(nodes);
      },
    });

    const created = entriesById.get(secondId);
    if (created) {
      openEntryDialog(secondId);
      nextEntryId = Math.max(nextEntryId, secondId + 1);
    }
  }

  const chunkCache = new Map(); // key -> { sha, entries[] }

  function chunkKey(year, week) {
    return `${year}-W${String(week).padStart(2, "0")}`;
  }

  let entriesManifest = null;

  function ghContentsUrl(repoPath) {
    return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
      config.repo,
    )}/contents/${repoPath}?ref=${encodeURIComponent(config.ref)}`;
  }

  function localRepoUrl(repoPath) {
    const clean = String(repoPath || "").replace(/^\/+/, "");
    return new URL(`../${clean}`, window.location.href).toString();
  }

  function normalizeManifest(raw) {
    if (!raw || typeof raw !== "object") throw new Error("entries-manifest.json must be a JSON object");
    const chunksRaw = Array.isArray(raw.chunks) ? raw.chunks : [];

    const chunks = [];
    for (const c of chunksRaw) {
      if (!c || typeof c !== "object") continue;
      const year = Number(c.year);
      const week = Number(c.week);
      const sha = typeof c.sha === "string" ? c.sha : "";
      const size = Number(c.size);
      const path = typeof c.path === "string" ? c.path : "";
      const entries = typeof c.entries === "number" && Number.isFinite(c.entries) && c.entries >= 0 ? c.entries : null;

      if (!Number.isFinite(year) || year < 1970 || year > 9999) continue;
      if (!Number.isFinite(week) || week < 1 || week > 53) continue;
      if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
      if (!path.startsWith("data/entries/")) continue;

      chunks.push({
        entries,
        path,
        sha,
        size: Number.isFinite(size) && size >= 0 ? size : null,
        week,
        year,
      });
    }

    chunks.sort((a, b) => a.year - b.year || a.week - b.week);

    return {
      chunks,
      generated_at: typeof raw.generated_at === "string" ? raw.generated_at : null,
      schema_version: typeof raw.schema_version === "number" ? raw.schema_version : null,
      timezone: typeof raw.timezone === "string" ? raw.timezone : null,
      total_chunks: typeof raw.total_chunks === "number" ? raw.total_chunks : chunks.length,
      total_entries: typeof raw.total_entries === "number" ? raw.total_entries : null,
    };
  }

  function refreshRepoLabel() {
    if (!entriesManifest) {
      repoLabelEl.textContent = "";
      return;
    }

    const totals = [];
    totals.push(`${chunkFiles.length} week file(s)`);
    if (typeof entriesManifest.total_entries === "number" && Number.isFinite(entriesManifest.total_entries)) {
      totals.push(`${entriesManifest.total_entries} entries`);
    }
    if (entriesManifest.generated_at) totals.push(`manifest @ ${entriesManifest.generated_at}`);

    if (isLocalMode) {
      repoLabelEl.textContent = `Local data • ${totals.join(" • ")}`;
    } else {
      repoLabelEl.textContent = `${config.owner}/${config.repo}@${config.ref} • ${totals.join(" • ")}`;
    }
  }

  async function fetchManifest() {
    setProgress(0, 1, isLocalMode ? "Loading manifest (local)…" : "Loading manifest…");

    let raw;
    if (isLocalMode) {
      const resp = await fetch(localRepoUrl("data/index/entries-manifest.json"), { cache: "no-store" });
      if (!resp.ok) {
        throw new Error(
          `Local manifest not found (${resp.status}). Run the local server from repo root: python3 server.py`,
        );
      }
      raw = await resp.text();
    } else {
      raw = await ghRawText(ghContentsUrl("data/index/entries-manifest.json"), token);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Failed to parse entries-manifest.json");
    }

    entriesManifest = normalizeManifest(parsed);
    chunkFiles = entriesManifest.chunks;
    refreshRepoLabel();
  }

  async function fetchChunkRawText(chunk) {
    if (isLocalMode) {
      const resp = await fetch(localRepoUrl(chunk.path), { cache: "no-store" });
      if (!resp.ok) throw new Error(`Local fetch failed (${resp.status}): ${chunk.path}`);
      return await resp.text();
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
      config.repo,
    )}/git/blobs/${encodeURIComponent(chunk.sha)}`;
    return await ghRawText(url, token);
  }

  async function loadAllChunks() {
    if (!entriesManifest) await fetchManifest();
    if (!chunkFiles.length) {
      entriesById = new Map();
      rebuildWeekIndexes();
      weekSegmentsCache = new Map();
      segmentsIndex = new Map();
      allEntries = [];
      searchDirty = false;
      latestWeekStartStr = null;
      weekStartStr = null;
      projectColorCache.clear();
      renderProjects(allEntries);
      applyFiltersAndRender();
      rebuildWeekView();
      return;
    }

    setProgress(0, chunkFiles.length, `Loading 0/${chunkFiles.length}…`);

    const byId = new Map();
    let cacheHits = 0;
    let downloads = 0;
    for (let i = 0; i < chunkFiles.length; i++) {
      const chunk = chunkFiles[i];
      const key = chunkKey(chunk.year, chunk.week);
      setProgress(i, chunkFiles.length, `Loading ${i}/${chunkFiles.length} • ${key}`);

      const cached = chunkCache.get(key);
      if (cached && cached.sha === chunk.sha) {
        for (const e of cached.entries) byId.set(e.id, e);
        continue;
      }

      let payload = null;
      const cachedRaw = await chunkCacheGetRaw(chunk.sha);
      if (typeof cachedRaw === "string" && cachedRaw) {
        try {
          payload = JSON.parse(cachedRaw);
          cacheHits++;
        } catch {
          await chunkCacheDeleteRaw(chunk.sha);
          payload = null;
        }
      }

      if (!payload) {
        const raw = await fetchChunkRawText(chunk);
        payload = JSON.parse(raw);
        downloads++;
        // Store a minified representation to reduce on-disk size.
        await chunkCachePutRaw(chunk.sha, JSON.stringify(payload));
      }

      const entries = Array.isArray(payload.entries) ? payload.entries.map(normalizeEntry) : [];
      chunkCache.set(key, { sha: chunk.sha, entries });
      for (const e of entries) byId.set(e.id, e);
    }

    const cacheSummary = ` • cached ${cacheHits} • downloaded ${downloads}`;
    setProgress(chunkFiles.length, chunkFiles.length, `Loaded ${chunkFiles.length}/${chunkFiles.length} week files${cacheSummary}`);

    entriesById = byId;
    rebuildWeekIndexes();
    weekSegmentsCache = new Map();
    projectColorCache.clear();
    recomputeLatestWeekStart();
    if (!weekStartStr && latestWeekStartStr) weekStartStr = latestWeekStartStr;

    searchDirty = true;
    applyFiltersAndRender();
    rebuildWeekView();
    recomputeNextEntryId();
  }

  async function reloadData() {
    setBusy(true);
    setError(dataErrorEl, "");
    entriesTbody.innerHTML = "";
    statsEl.textContent = "";
    weekScrollEl.innerHTML = "";
    weekLabelEl.textContent = "";
    weekDom = null;
    try {
      await fetchManifest();
      await loadAllChunks();
    } catch (e) {
      setError(dataErrorEl, safeText(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectWithToken(newToken) {
    token = newToken;
    setAuthStatus("Connecting…");
    setBusy(true);
    try {
      const repoInfo = await ghJson(
        `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`,
        token,
      );
      ghUser = null;
      try {
        ghUser = await ghJson("https://api.github.com/user", token);
      } catch {
        // Fine-grained tokens may not have account-level permissions; repo access is enough.
      }

      const repoLabel = repoInfo?.full_name ? repoInfo.full_name : `${config.owner}/${config.repo}`;
      setAuthStatus(ghUser?.login ? `Logged in as ${ghUser.login}` : `Connected to ${repoLabel}`);
      setVisible(logoutBtn, true);
      setVisible(reloadDataBtn, true);
      setVisible(loginSection, false);
      setVisible(appSection, true);
      setVisible(viewTabsEl, true);
      setAppMode(true);
      setTab(activeTab);
      await reloadData();
    } catch (e) {
      ghUser = null;
      setAuthStatus("Not logged in");
      throw e;
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    token = "";
    ghUser = null;
    entriesManifest = null;
	    chunkFiles = [];
	    chunkCache.clear();
	    entriesById = new Map();
	    allEntries = [];
	    weekEntryIds = new Map();
	    weekSegmentsCache = new Map();
	    longEntryIds = new Set();
	    segmentsIndex = new Map();
	    latestWeekStartStr = null;
	    weekStartStr = null;
	    weekDom = null;
	    selectedSegKey = null;
	    selectedEntryId = null;
	    dialogEntryId = null;
	    searchDirty = false;
	    dirtyWeekStarts.clear();
	    undoStack.length = 0;
	    redoStack.length = 0;
	    setEditMode("normal");
	    entriesTbody.innerHTML = "";
	    projectSelect.innerHTML = "";
	    statsEl.textContent = "";
	    repoLabelEl.textContent = "";
    weekScrollEl.innerHTML = "";
    weekLabelEl.textContent = "";
    setProgress(0, 1, "");
    setAuthStatus("Not logged in");
    setVisible(viewTabsEl, false);
    setVisible(weekControlsEl, false);
    setVisible(reloadDataBtn, false);
    setVisible(logoutBtn, false);
    setVisible(appSection, false);
    setVisible(loginSection, true);
    setAppMode(false);
    sessionStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.token);
  }

  loginForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setError(loginErrorEl, "");

    const owner = $("ownerInput").value.trim();
    const repo = $("repoInput").value.trim();
    const ref = $("refInput").value.trim();
    const tok = $("tokenInput").value.trim();
    const remember = $("rememberInput").checked;

    if (!owner || !repo || !ref || !tok) {
      setError(loginErrorEl, "Please fill in owner, repo, ref, and token.");
      return;
    }

    config = { ...config, owner, repo, ref };
    saveConfig(config);
    saveToken(tok, remember);
    $("tokenInput").value = "";

    try {
      await connectWithToken(tok);
    } catch (e) {
      setError(loginErrorEl, safeText(e));
    }
  });

  clearSavedBtn.addEventListener("click", () => {
    clearSaved();
    config = { ...DEFAULT_CONFIG };
    $("ownerInput").value = config.owner;
    $("repoInput").value = config.repo;
    $("refInput").value = config.ref;
    $("tokenInput").value = "";
    $("rememberInput").checked = false;
    setAuthStatus("Cleared");
  });

  tabWeekBtn.addEventListener("click", () => setTab("week"));
  tabSearchBtn.addEventListener("click", () => setTab("search"));

  prevWeekBtn.addEventListener("click", () => {
    if (!weekStartStr) return;
    setWeekStart(addIsoDays(weekStartStr, -7));
  });
  nextWeekBtn.addEventListener("click", () => {
    if (!weekStartStr) return;
    setWeekStart(addIsoDays(weekStartStr, 7));
  });
  latestWeekBtn.addEventListener("click", () => {
    if (!latestWeekStartStr) return;
    setWeekStart(latestWeekStartStr);
  });

  zoomInput.addEventListener("input", () => {
    const nextZoom = Number.parseFloat(zoomInput.value || "1");
    if (!Number.isFinite(nextZoom) || nextZoom < 1) return;
    zoom = nextZoom;
    updateWeekScaleAndReposition();
  });

  function nudgeZoom(deltaSteps) {
    const stepText = String(zoomInput.step || "0.25");
    const step = Number.parseFloat(stepText);
    if (!Number.isFinite(step) || step <= 0) return;
    const min = Number.parseFloat(zoomInput.min || "1");
    const max = Number.parseFloat(zoomInput.max || "4");
    const current = Number.parseFloat(zoomInput.value || String(zoom || 1));
    const base = Number.isFinite(current) ? current : zoom;

    const currentSteps = Math.round((base - min) / step);
    let next = min + (currentSteps + deltaSteps) * step;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);

    const decimals = stepText.includes(".") ? stepText.split(".")[1].length : 0;
    next = Number(next.toFixed(Math.min(6, Math.max(0, decimals))));
    if (!Number.isFinite(next) || next < 1) return;

    zoom = next;
    zoomInput.value = String(next);
    updateWeekScaleAndReposition();
  }

  logoutBtn.addEventListener("click", () => logout());
  reloadDataBtn.addEventListener("click", () => reloadData());

  entryCloseBtn.addEventListener("click", () => closeEntryDialog());
  entryCancelBtn.addEventListener("click", () => closeEntryDialog());
  entryDialog.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeEntryDialog();
  });
  entryForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const id = dialogEntryId;
    if (!id) return closeEntryDialog();
    if (!weekStartStr) return closeEntryDialog();

    const entry = entriesById.get(id);
    if (!entry) return closeEntryDialog();
    if (weekStartForEntry(entry) !== weekStartStr) return closeEntryDialog();

    const project = entryProjectInput.value.trim();
    const description = entryDescInput.value.trim();
    const tags = textToTags(entryTagsInput.value);
    const billable = entryBillableInput.checked;

    applyWeekEdit({
      weekStart: weekStartStr,
      label: "details",
      focusAfter: id,
      getAfterRaw: () => {
        const raws = snapshotWeekRaw(weekStartStr);
        const idx = raws.findIndex((r) => Number(r?.id) === id);
        if (idx < 0) throw new Error("Entry not found in this week");
        raws[idx].project = project;
        raws[idx].description = description;
        raws[idx].tags = tags;
        raws[idx].billable = billable;
        raws[idx].updated_at = formatIsoWithOffset(new Date());
        return raws;
      },
    });

    closeEntryDialog();
  });

  for (const el of [searchInput, projectSelect, fromDateInput, toDateInput, maxRowsInput, sortSelect]) {
    el.addEventListener("input", () => applyFiltersAndRender());
    // Avoid re-rendering the table on input blur (some inputs fire `change` on blur),
    // which can swallow the first click on a search result row.
    if (el instanceof HTMLSelectElement) el.addEventListener("change", () => applyFiltersAndRender());
  }

  document.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey && !ev.altKey && !appSection.hidden && !viewTabsEl.hidden) {
      const key = String(ev.key || "");
      const keyLower = key.toLowerCase();

      if (keyLower === "k") {
        ev.preventDefault();
        setTab("search");
        queueMicrotask(() => {
          try {
            searchInput.focus();
            searchInput.select();
          } catch {
            // ignore
          }
        });
        return;
      }

      if (keyLower === "g" || keyLower === "w") {
        ev.preventDefault();
        setTab("week");
        return;
      }

      const isZoomOut = key === "[" || key === "{" || ev.code === "BracketLeft";
      const isZoomIn = key === "]" || key === "}" || ev.code === "BracketRight";
      if (isZoomOut || isZoomIn) {
        if (activeTab === "week" && !(appSection.hidden || weekViewSection.hidden)) {
          ev.preventDefault();
          nudgeZoom(isZoomOut ? -1 : 1);
        }
        return;
      }
    }

    if (activeTab !== "week") return;
    if (appSection.hidden || weekViewSection.hidden) return;
    if (entryDialog.open) return;
    if (isEditableTarget(ev.target)) return;

    const key = String(ev.key || "");
    const keyLower = key.toLowerCase();

    if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (keyLower === "z") {
        ev.preventDefault();
        undo();
        return;
      }
      if (keyLower === "y") {
        ev.preventDefault();
        redo();
        return;
      }
      if (keyLower === "s") {
        ev.preventDefault();
        saveDirtyWeeksNow("manual");
        return;
      }
    }

    if (key === "Escape") {
      ev.preventDefault();
      setEditMode("normal");
      weekScrollEl.focus();
      return;
    }

    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (keyLower === "a") {
        ev.preventDefault();
        enterAddMode();
        weekScrollEl.focus();
        return;
      }
      if (keyLower === "s") {
        ev.preventDefault();
        enterSplitMode();
        weekScrollEl.focus();
        return;
      }
    }

    if (editMode === "add") {
      if (key === "ArrowLeft") {
        ev.preventDefault();
        shiftAddCursorDay(-1);
        weekScrollEl.focus();
        return;
      }
      if (key === "ArrowRight") {
        ev.preventDefault();
        shiftAddCursorDay(1);
        weekScrollEl.focus();
        return;
      }
      if (key === "ArrowUp") {
        ev.preventDefault();
        nudgeAddCursor(-1);
        weekScrollEl.focus();
        return;
      }
      if (key === "ArrowDown") {
        ev.preventDefault();
        nudgeAddCursor(1);
        weekScrollEl.focus();
        return;
      }
      if (key === "Enter") {
        ev.preventDefault();
        addEntryFromCursor();
        weekScrollEl.focus();
        return;
      }
      return;
    }

    if (editMode === "split") {
      if (key === "ArrowUp") {
        ev.preventDefault();
        nudgeSplitCursor(-1);
        weekScrollEl.focus();
        return;
      }
      if (key === "ArrowDown") {
        ev.preventDefault();
        nudgeSplitCursor(1);
        weekScrollEl.focus();
        return;
      }
      if (key === "Enter") {
        ev.preventDefault();
        splitSelectedEntryAtCursor();
        weekScrollEl.focus();
        return;
      }
      return;
    }

    if (key === "Enter") {
      if (!selectedEntryId) return;
      ev.preventDefault();
      openEntryDialog(selectedEntryId);
      return;
    }

    if (keyLower === "d") {
      ev.preventDefault();
      deleteSelectedEntry();
      weekScrollEl.focus();
      return;
    }

    if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      ev.preventDefault();
      if (key === "ArrowUp") extendSelectedEntry(-MIN_ENTRY_MS, 0);
      else extendSelectedEntry(0, MIN_ENTRY_MS);
      weekScrollEl.focus();
      return;
    }

    if (ev.ctrlKey && !ev.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      ev.preventDefault();
      moveSelectedEntry(key === "ArrowUp" ? -MIN_ENTRY_MS : MIN_ENTRY_MS);
      weekScrollEl.focus();
      return;
    }

    if (key === "ArrowLeft") {
      ev.preventDefault();
      moveFocusDay(-1);
      weekScrollEl.focus();
      return;
    }
    if (key === "ArrowRight") {
      ev.preventDefault();
      moveFocusDay(1);
      weekScrollEl.focus();
      return;
    }
    if (key === "ArrowUp") {
      ev.preventDefault();
      moveFocusEntry(-1);
      weekScrollEl.focus();
      return;
    }
    if (key === "ArrowDown") {
      ev.preventDefault();
      moveFocusEntry(1);
      weekScrollEl.focus();
      return;
    }
    if (key === "PageUp") {
      if (!weekStartStr) return;
      ev.preventDefault();
      setEditMode("normal");
      setWeekStart(addIsoDays(weekStartStr, -7));
      weekScrollEl.focus();
      return;
    }
    if (key === "PageDown") {
      if (!weekStartStr) return;
      ev.preventDefault();
      setEditMode("normal");
      setWeekStart(addIsoDays(weekStartStr, 7));
      weekScrollEl.focus();
      return;
    }
  });

  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (resizeRaf) return;
    resizeRaf = window.requestAnimationFrame(() => {
      resizeRaf = 0;
      if (activeTab === "week") updateWeekScaleAndReposition();
    });
  });

  // Initial boot
  setProgress(0, 1, "");

  if (isLocalMode) {
    setAuthStatus("Local mode");
    setVisible(logoutBtn, false);
    setVisible(reloadDataBtn, true);
    setVisible(loginSection, false);
    setVisible(appSection, true);
    setVisible(viewTabsEl, true);
    setVisible(weekControlsEl, false);
    setAppMode(true);
    setTab(activeTab);
    await reloadData();
    return;
  }

  setVisible(loginSection, true);
  setVisible(appSection, false);
  setVisible(logoutBtn, false);
  setVisible(reloadDataBtn, false);
  setVisible(viewTabsEl, false);
  setVisible(weekControlsEl, false);
  setAppMode(false);
  setTab(activeTab);

  if (token) {
    try {
      await connectWithToken(token);
    } catch {
      // Fall back to login screen.
      setVisible(loginSection, true);
    }
  } else {
    setAuthStatus("Not logged in");
  }
}

main().catch((e) => {
  // Last-resort; avoid throwing unhandled rejection.
  console.error(e);
  const status = document.getElementById("authStatus");
  if (status) status.textContent = `Error: ${String(e)}`;
});
