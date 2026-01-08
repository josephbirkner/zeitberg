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
  let allEntries = [];

  const { dateFmt, timeFmt } = makeTzFormatters(config.timezone);

  let segmentsIndex = new Map(); // dateStr -> segment[]
  let latestWeekStartStr = null;
  let weekStartStr = null;
  let focusedDayIndex = 0; // 0..6 (Mon..Sun)
  const focusedEntryIndexByDay = Array(7).fill(0);
  let weekDom = null;
  let zoom = Number.parseFloat(zoomInput.value || "1");
  if (!Number.isFinite(zoom) || zoom < 1) zoom = 1;

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
  }

  function applyFiltersAndRender() {
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

  function buildSegmentsIndexFromEntries(entries) {
    const index = new Map();
    const now = new Date();

    for (const entry of entries) {
      if (!(entry.startDate instanceof Date) || Number.isNaN(entry.startDate.getTime())) continue;
      const start = entry.startDate;
      const end = entry.endDate instanceof Date && !Number.isNaN(entry.endDate.getTime()) ? entry.endDate : entry.is_running ? now : null;
      if (!end) continue;
      if (end.getTime() < start.getTime()) continue;

      const startDay = dateFmt.format(start);
      const endDay = dateFmt.format(end);
      const startMin = hhmmToMinutes(timeFmt.format(start));
      const endMin = hhmmToMinutes(timeFmt.format(end));
      if (startMin === null || endMin === null) continue;

      let day = startDay;
      // Safety: cap at 14 days to avoid pathological entries.
      for (let iter = 0; iter < 14; iter++) {
        const segStart = day === startDay ? startMin : 0;
        const segEnd = day === endDay ? endMin : 1440;
        if (segEnd > segStart) {
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

  function computeLatestWeekStart(entries) {
    let latest = null;
    for (const e of entries) {
      if (!(e.startDate instanceof Date) || Number.isNaN(e.startDate.getTime())) continue;
      if (!latest || e.startDate.getTime() > latest.getTime()) latest = e.startDate;
    }
    if (!latest) return null;
    return isoWeekStart(dateFmt.format(latest));
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

    scrollWeekFocusIntoView();
  }

  function rebuildWeekView() {
    weekScrollEl.innerHTML = "";
    weekDom = null;

    if (!weekStartStr) {
      weekLabelEl.textContent = "";
      return;
    }

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
    scrollWeekFocusIntoView();

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

  async function fetchManifest() {
    setProgress(0, 1, isLocalMode ? "Loading manifest (local)…" : "Loading manifest…");

    let raw;
    if (isLocalMode) {
      const resp = await fetch(localRepoUrl("data/index/entries-manifest.json"), { cache: "no-store" });
      if (!resp.ok) {
        throw new Error(
          `Local manifest not found (${resp.status}). Serve the repo root (not docs): python3 -m http.server`,
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
      allEntries = [];
      renderProjects(allEntries);
      applyFiltersAndRender();
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

    allEntries = Array.from(byId.values());
    projectColorCache.clear();
    segmentsIndex = buildSegmentsIndexFromEntries(allEntries);
    latestWeekStartStr = computeLatestWeekStart(allEntries);
    if (!weekStartStr && latestWeekStartStr) weekStartStr = latestWeekStartStr;

    renderProjects(allEntries);
    applyFiltersAndRender();
    rebuildWeekView();
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
    allEntries = [];
    segmentsIndex = new Map();
    latestWeekStartStr = null;
    weekStartStr = null;
    weekDom = null;
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
    if (isEditableTarget(ev.target)) return;

    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      moveFocusDay(-1);
      weekScrollEl.focus();
      return;
    }
    if (ev.key === "ArrowRight") {
      ev.preventDefault();
      moveFocusDay(1);
      weekScrollEl.focus();
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      moveFocusEntry(-1);
      weekScrollEl.focus();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      moveFocusEntry(1);
      weekScrollEl.focus();
      return;
    }
    if (ev.key === "PageUp") {
      if (!weekStartStr) return;
      ev.preventDefault();
      setWeekStart(addIsoDays(weekStartStr, -7));
      weekScrollEl.focus();
      return;
    }
    if (ev.key === "PageDown") {
      if (!weekStartStr) return;
      ev.preventDefault();
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
