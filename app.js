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

function yearFromFilename(name) {
  const m = /^(\d{4})\.json$/.exec(name);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
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

async function main() {
  const authStatusEl = $("authStatus");
  const logoutBtn = $("logoutBtn");
  const loginSection = $("loginSection");
  const loginForm = $("loginForm");
  const loginErrorEl = $("loginError");
  const clearSavedBtn = $("clearSavedBtn");

  const appSection = $("appSection");
  const repoLabelEl = $("repoLabel");
  const refreshYearsBtn = $("refreshYearsBtn");
  const loadSelectedYearsBtn = $("loadSelectedYearsBtn");
  const yearsContainer = $("yearsContainer");
  const dataErrorEl = $("dataError");

  const searchInput = $("searchInput");
  const projectSelect = $("projectSelect");
  const fromDateInput = $("fromDate");
  const toDateInput = $("toDate");
  const maxRowsInput = $("maxRows");
  const sortSelect = $("sortSelect");
  const statsEl = $("stats");
  const entriesTbody = $("entriesTbody");

  let config = loadConfig();
  $("ownerInput").value = config.owner;
  $("repoInput").value = config.repo;
  $("refInput").value = config.ref;
  $("rememberInput").checked = localStorage.getItem(STORAGE_KEYS.tokenRemembered) === "1";

  let token = loadToken();
  let ghUser = null;
  let yearFiles = [];
  const yearData = new Map(); // year -> { sha, payload, entries[] }
  let allEntries = [];

  const { dateFmt, timeFmt } = makeTzFormatters(config.timezone);

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
    refreshYearsBtn.disabled = isBusy;
    loadSelectedYearsBtn.disabled = isBusy;
  }

  function selectedYears() {
    return Array.from(yearsContainer.querySelectorAll("input[type=checkbox][data-year]"))
      .filter((cb) => cb.checked)
      .map((cb) => Number.parseInt(cb.dataset.year, 10))
      .filter((y) => Number.isFinite(y))
      .sort((a, b) => a - b);
  }

  function renderYears() {
    yearsContainer.innerHTML = "";
    const frag = document.createDocumentFragment();
    const nowYear = new Date().getFullYear();
    const maxYear = yearFiles.length ? Math.max(...yearFiles.map((f) => f.year)) : null;
    const defaultYear = yearFiles.some((f) => f.year === nowYear) ? nowYear : maxYear;
    for (const f of yearFiles) {
      const pill = document.createElement("label");
      pill.className = "year-pill";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.year = String(f.year);
      cb.checked = defaultYear ? f.year === defaultYear : false;

      const name = document.createElement("span");
      name.textContent = String(f.year);
      pill.append(cb, name);
      frag.append(pill);
    }
    yearsContainer.append(frag);
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

  async function fetchYears() {
    setBusy(true);
    setError(dataErrorEl, "");
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
        config.repo,
      )}/contents/data/entries?ref=${encodeURIComponent(config.ref)}`;
      const items = await ghJson(url, token);
      if (!Array.isArray(items)) throw new Error("Unexpected response for contents listing.");

      yearFiles = items
        .map((it) => {
          const year = yearFromFilename(it.name || "");
          if (!year) return null;
          return { year, sha: it.sha, size: it.size };
        })
        .filter(Boolean)
        .sort((a, b) => a.year - b.year);

      renderYears();
      repoLabelEl.textContent = `${config.owner}/${config.repo}@${config.ref} • ${yearFiles.length} year file(s)`;
    } catch (e) {
      setError(dataErrorEl, safeText(e));
      yearFiles = [];
      renderYears();
    } finally {
      setBusy(false);
    }
  }

  async function loadYear(year) {
    const file = yearFiles.find((f) => f.year === year);
    if (!file) throw new Error(`Missing year file for ${year}.`);

    const existing = yearData.get(year);
    if (existing && existing.sha === file.sha) return;

    const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
      config.repo,
    )}/git/blobs/${encodeURIComponent(file.sha)}`;
    const raw = await ghRawText(url, token);
    const payload = JSON.parse(raw);
    const entries = Array.isArray(payload.entries) ? payload.entries.map(normalizeEntry) : [];
    yearData.set(year, { sha: file.sha, payload, entries });
  }

  async function loadSelectedYears() {
    const years = selectedYears();
    if (!years.length) {
      setError(dataErrorEl, "Select at least one year.");
      return;
    }

    setBusy(true);
    setError(dataErrorEl, "");
    try {
      for (const y of years) {
        await loadYear(y);
      }
      allEntries = years.flatMap((y) => yearData.get(y)?.entries || []);
      renderProjects(allEntries);
      applyFiltersAndRender();
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
      setVisible(loginSection, false);
      setVisible(appSection, true);
      await fetchYears();
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
    yearFiles = [];
    yearData.clear();
    allEntries = [];
    entriesTbody.innerHTML = "";
    projectSelect.innerHTML = "";
    statsEl.textContent = "";
    setAuthStatus("Not logged in");
    setVisible(logoutBtn, false);
    setVisible(appSection, false);
    setVisible(loginSection, true);
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

  logoutBtn.addEventListener("click", () => logout());
  refreshYearsBtn.addEventListener("click", () => fetchYears());
  loadSelectedYearsBtn.addEventListener("click", () => loadSelectedYears());

  for (const el of [searchInput, projectSelect, fromDateInput, toDateInput, maxRowsInput, sortSelect]) {
    el.addEventListener("input", () => applyFiltersAndRender());
    el.addEventListener("change", () => applyFiltersAndRender());
  }

  // Initial boot
  setVisible(loginSection, true);
  setVisible(appSection, false);
  setVisible(logoutBtn, false);

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
