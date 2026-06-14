// App entry: shell, connection management, always-live storage subscriptions,
// and the History page (full-block scan).
//
// Three pages: "Live" shows current state via finalized-block subscriptions (no
// manual refresh); "History" runs an accurate full-block scan of the last day and
// auto-starts on connect; "Setup" verifies the chain's initial-setup steps
// (one snapshot on connect, manual refresh).

import "./styles.css";
import { type Endpoints, loadEndpoints, papiConsoleUrl, PRESETS, saveEndpoints } from "./config";
import { computeInTransit, fetchAhLive, fetchPeopleLive } from "./live";
import type { AhLive, HistoryResult, PeopleLive } from "./domain";
import { deriveHistory, type HistoryAcc, scanHistory, type Progress } from "./history";
import { connect, type Connections, disconnect } from "./papi";
import { historyCsv, type HistoryTable } from "./csv";
import { fetchSetup, type SetupState } from "./setup";
import { renderSetup } from "./setupui";
import { renderAhLive, renderHistory, renderInTransit, renderPeopleLive } from "./ui";
import { escapeHtml } from "./format";

interface Sub {
  unsubscribe: () => void;
}

interface AppState {
  endpoints: Endpoints;
  conns: Connections | null;
  people: PeopleLive | null;
  assetHub: AhLive | null;
  history: HistoryResult | null;
  /** Accumulated raw scan data; each load extends it further into the past. */
  historyAcc: HistoryAcc | null;
  subs: Sub[];
  /** Guards against overlapping reads when blocks arrive faster than a fetch. */
  peopleBusy: boolean;
  ahBusy: boolean;
  historyAbort: AbortController | null;
  /** Whether history has been auto-started for the current connection. */
  historyAutoStarted: boolean;
  setup: SetupState | null;
  /** Guards against overlapping setup fetches (refresh spam). */
  setupBusy: boolean;
  page: "live" | "history" | "setup";
  /** Per-table collapse/filter state, keyed by table id; survives live re-renders. */
  tableUi: Map<string, { collapsed: boolean; filter: string }>;
}

const state: AppState = {
  endpoints: loadEndpoints(),
  conns: null,
  people: null,
  assetHub: null,
  history: null,
  historyAcc: null,
  subs: [],
  peopleBusy: false,
  ahBusy: false,
  historyAbort: null,
  historyAutoStarted: false,
  setup: null,
  setupBusy: false,
  page: "live",
  tableUi: new Map(),
};

const app = document.querySelector<HTMLDivElement>("#app")!;

function shell(): string {
  const presetOptions = PRESETS.map((p) => `<option value="${p.name}">${p.name}</option>`).join("");
  return `
  <header>
    <h1>Ring Root Propagation Dashboard</h1>
    <div class="controls">
      <label title="Switch the People + Asset Hub endpoint pair. Choose a preset or edit the fields for a custom network.">Preset
        <select id="preset"><option value="">custom</option>${presetOptions}</select>
      </label>
      <label title="People chain RPC (members pallet + members-notifier).">People RPC <input id="ep-people" size="42" value="${escapeHtml(state.endpoints.people)}" /></label>
      <label title="Asset Hub chain RPC (members-subscriber).">Asset Hub RPC <input id="ep-ah" size="42" value="${escapeHtml(state.endpoints.assetHub)}" /></label>
      <button id="connect" title="Connect to the endpoints above and start live subscriptions. Live panels then update on every finalized block — no manual refresh.">Connect</button>
    </div>
    <div class="tabs">
      <button class="tab active" data-page="live" title="Current state, read live from chain storage on every finalized block.">Live</button>
      <button class="tab" data-page="history" title="Accurate full-block scan of the last day: register → ring built → received on AH.">History</button>
      <button class="tab" data-page="setup" title="Verify the initial-setup steps (assets, pools, chunks, collections, invites, games, airdrops) and show the live values used.">Setup</button>
    </div>
    <div id="status" class="status"></div>
  </header>
  <main>
    <div id="live-page" class="page">
      <div class="grid">
        <div id="people"></div>
        <div id="ah"></div>
      </div>
      <div id="intransit"></div>
    </div>
    <div id="history-page" class="page hidden">
      <div class="hist-toolbar">
        <span class="hist-load-label" title="Each button scans that much more history, going further into the past, and keeps what's already loaded (appended below). The most recent 1h auto-loads on connect. Every block in the range is read on both chains (accurate, not fast).">Load older:</span>
        <button class="load-history" data-window="60000" title="Scan 1 more minute of older history.">+1m</button>
        <button class="load-history" data-window="600000" title="Scan 10 more minutes of older history.">+10m</button>
        <button class="load-history" data-window="3600000" title="Scan 1 more hour of older history.">+1h</button>
        <button class="load-history" data-window="21600000" title="Scan 6 more hours of older history.">+6h</button>
        <button class="load-history" data-window="86400000" title="Scan 1 more day of older history.">+1d</button>
        <button id="stop-history" class="hidden" title="Abort the in-progress history scan.">Stop</button>
        <span id="progress" class="progress hidden"></span>
      </div>
      <div id="history"></div>
    </div>
    <div id="setup-page" class="page hidden">
      <div class="hist-toolbar">
        <button id="refresh-setup" title="Re-read all setup-related storage from both chains. The Setup page is a snapshot (taken on connect), not a live subscription.">Refresh</button>
        <span id="setup-meta" class="hist-load-label"></span>
      </div>
      <div id="setup"></div>
    </div>
  </main>
  <footer>
    Read-only — no transactions are ever signed or submitted. Live panels subscribe to each chain's
    finalized-block stream. History scans every block in the window on both chains (accurate, not fast)
    and reconstructs: register (People) → ring built (People) → received (Asset Hub). Setup verifies
    the on-chain state written by individuality's scripts/initial-setup and shows the values in use.
  </footer>`;
}

function setStatus(msg: string, kind: "" | "ok" | "bad" = ""): void {
  const el = document.querySelector<HTMLDivElement>("#status")!;
  el.className = `status ${kind}`;
  el.textContent = msg;
}

function setProgress(p: Progress | null): void {
  const el = document.querySelector<HTMLDivElement>("#progress")!;
  if (!p) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  el.textContent = `${p.phase}… ${p.done}/${p.total} (${pct}%) · ${p.events} events`;
}

function setPage(page: AppState["page"]): void {
  state.page = page;
  for (const pg of ["live", "history", "setup"] as const)
    document.querySelector(`#${pg}-page`)!.classList.toggle("hidden", pg !== page);
  for (const t of document.querySelectorAll<HTMLElement>(".tab"))
    t.classList.toggle("active", t.getAttribute("data-page") === page);
}

/** True if a table-search input inside `containerSel` currently has focus.
 *  We skip live re-rendering that container so typing a filter isn't interrupted. */
function searchFocusedIn(containerSel: string): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.classList.contains("table-search")) return false;
  return !!active.closest(containerSel);
}

function renderPeople(): void {
  if (searchFocusedIn("#people")) return;
  if (state.people) {
    const el = document.querySelector("#people")!;
    el.innerHTML = renderPeopleLive(state.people, papiConsoleUrl(state.endpoints.people));
    applyTables(el);
  }
  renderInTransitIfReady();
}
function renderAh(): void {
  if (searchFocusedIn("#ah")) return;
  if (state.assetHub) {
    const el = document.querySelector("#ah")!;
    el.innerHTML = renderAhLive(state.assetHub, papiConsoleUrl(state.endpoints.assetHub));
    applyTables(el);
  }
  renderInTransitIfReady();
}
function renderInTransitIfReady(): void {
  if (!state.people || !state.assetHub) return;
  if (searchFocusedIn("#intransit")) return;
  const live = { people: state.people, assetHub: state.assetHub, fetchedAt: Date.now() };
  const el = document.querySelector("#intransit")!;
  el.innerHTML = renderInTransit(computeInTransit(live));
  applyTables(el);
}

// ---------- Collapsible / searchable tables ----------

function tableState(id: string) {
  let s = state.tableUi.get(id);
  if (!s) {
    s = { collapsed: false, filter: "" };
    state.tableUi.set(id, s);
  }
  return s;
}

/** Show/hide rows by the `data-ident` attribute and update the count badge. */
function filterTable(tbl: Element, query: string): void {
  const q = query.trim().toLowerCase();
  let total = 0;
  let shown = 0;
  for (const row of tbl.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
    const ident = row.getAttribute("data-ident");
    if (ident === null) continue; // skip the "no data" placeholder row
    total++;
    const match = q === "" || ident.includes(q);
    row.style.display = match ? "" : "none";
    if (match) shown++;
  }
  const count = tbl.querySelector(".tbl-count");
  if (count) count.textContent = q === "" ? `${total}` : `${shown} / ${total}`;
}

/** Re-apply persisted collapse + filter state to every table inside `root`. */
function applyTables(root: ParentNode): void {
  for (const tbl of root.querySelectorAll<HTMLElement>(".tbl")) {
    const id = tbl.getAttribute("data-table-id");
    if (!id) continue;
    const st = tableState(id);
    tbl.classList.toggle("collapsed", st.collapsed);
    const input = tbl.querySelector<HTMLInputElement>(".table-search");
    if (input && input.value !== st.filter) input.value = st.filter;
    filterTable(tbl, st.filter);
  }
}

function liveStatus(): void {
  const p = state.people ? `People #${state.people.finalized}` : "People …";
  const a = state.assetHub ? `AH #${state.assetHub.finalized}` : "AH …";
  setStatus(`Live · ${p} · ${a} · ${new Date().toLocaleTimeString(undefined, { hour12: false })}`, "ok");
}

function renderHistorySection(): void {
  // Don't wipe a history search box mid-type during progressive updates.
  if (searchFocusedIn("#history-page")) return;
  const el = document.querySelector("#history")!;
  el.innerHTML = state.history ? renderHistory(state.history, state.endpoints) : "";
  applyTables(el);
}

/** Trigger a client-side download of CSV text (with a UTF-8 BOM so Excel reads hex/labels). */
function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderSetupSection(): void {
  if (searchFocusedIn("#setup-page")) return;
  const el = document.querySelector("#setup")!;
  el.innerHTML = state.setup ? renderSetup(state.setup) : "";
  applyTables(el);
  document.querySelector("#setup-meta")!.textContent = state.setup
    ? `Snapshot ${new Date(state.setup.fetchedAt).toLocaleTimeString(undefined, { hour12: false })} · People #${state.setup.people.finalized} · AH #${state.setup.assetHub.finalized}`
    : "";
}

async function doLoadSetup(): Promise<void> {
  if (!state.conns) {
    setStatus("Connect first.", "bad");
    return;
  }
  if (state.setupBusy) return;
  state.setupBusy = true;
  const btn = document.querySelector<HTMLButtonElement>("#refresh-setup")!;
  btn.disabled = true;
  document.querySelector("#setup-meta")!.textContent = "Reading setup storage…";
  try {
    state.setup = await fetchSetup(state.conns);
    renderSetupSection();
  } catch (e) {
    setStatus(`Setup read failed: ${(e as Error).message}`, "bad");
    document.querySelector("#setup-meta")!.textContent = "";
  } finally {
    state.setupBusy = false;
    btn.disabled = false;
  }
}

function teardownSubs(): void {
  for (const s of state.subs) {
    try {
      s.unsubscribe();
    } catch {
      // already gone
    }
  }
  state.subs = [];
}

/** Subscribe to each chain's finalized block and re-read storage on every block. */
function startLiveSubscriptions(conns: Connections): void {
  const peopleSub = conns.people.client.finalizedBlock$.subscribe({
    next: () => {
      if (state.peopleBusy) return;
      state.peopleBusy = true;
      fetchPeopleLive(conns.people)
        .then((p) => {
          state.people = p;
          renderPeople();
          liveStatus();
        })
        .catch((e) => setStatus(`People read failed: ${(e as Error).message}`, "bad"))
        .finally(() => {
          state.peopleBusy = false;
        });
    },
    error: (e) => setStatus(`People subscription error: ${(e as Error).message}`, "bad"),
  });

  const ahSub = conns.assetHub.client.finalizedBlock$.subscribe({
    next: () => {
      if (state.ahBusy) return;
      state.ahBusy = true;
      fetchAhLive(conns.assetHub)
        .then((a) => {
          state.assetHub = a;
          renderAh();
          liveStatus();
        })
        .catch((e) => setStatus(`AH read failed: ${(e as Error).message}`, "bad"))
        .finally(() => {
          state.ahBusy = false;
        });
    },
    error: (e) => setStatus(`AH subscription error: ${(e as Error).message}`, "bad"),
  });

  state.subs.push(peopleSub, ahSub);
}

function doConnect(): void {
  const people = document.querySelector<HTMLInputElement>("#ep-people")!.value.trim();
  const assetHub = document.querySelector<HTMLInputElement>("#ep-ah")!.value.trim();
  if (!people || !assetHub) {
    setStatus("Both endpoints are required.", "bad");
    return;
  }
  state.endpoints = { people, assetHub };
  saveEndpoints(state.endpoints);

  teardownSubs();
  if (state.conns) {
    disconnect(state.conns);
    state.conns = null;
  }
  // Clear stale state (it belongs to the previous network).
  state.people = null;
  state.assetHub = null;
  state.history = null;
  state.historyAcc = null;
  state.historyAutoStarted = false;
  state.setup = null;
  document.querySelector("#people")!.innerHTML = "";
  document.querySelector("#ah")!.innerHTML = "";
  document.querySelector("#intransit")!.innerHTML = "";
  renderHistorySection();
  renderSetupSection();

  setStatus("Connecting…");
  try {
    state.conns = connect(state.endpoints);
    startLiveSubscriptions(state.conns);
    // Auto-start a 1-hour history scan for this connection (runs in background).
    if (!state.historyAutoStarted) {
      state.historyAutoStarted = true;
      void doLoadHistory(3_600_000);
    }
    // One setup snapshot per connection; the Setup page has a manual refresh.
    void doLoadSetup();
  } catch (e) {
    setStatus(`Connect failed: ${(e as Error).message}`, "bad");
  }
}

async function doLoadHistory(windowMs: number): Promise<void> {
  if (!state.conns) {
    setStatus("Connect first.", "bad");
    return;
  }
  if (state.historyAbort) return; // a scan is already running
  const conns = state.conns;
  const stopBtn = document.querySelector<HTMLButtonElement>("#stop-history")!;
  const loadBtns = [...document.querySelectorAll<HTMLButtonElement>(".load-history")];
  const extending = state.historyAcc !== null;
  state.historyAbort = new AbortController();
  stopBtn.classList.remove("hidden");
  for (const b of loadBtns) b.disabled = true;
  if (!extending) {
    // First load: show nothing until the whole window is scanned for both chains.
    state.history = null;
    renderHistorySection();
  }
  setProgress({ phase: "Starting", done: 0, total: 1, events: 0 });

  try {
    // No acc → fresh most-recent window. With acc → extend further into the past.
    const acc = await scanHistory(
      conns.people,
      conns.assetHub,
      (p) => setProgress(p),
      state.historyAbort.signal,
      windowMs,
      state.historyAcc ?? undefined,
    );
    state.historyAcc = acc;
    state.history = deriveHistory(acc);
    renderHistorySection();
    setStatus(
      `History: ${state.history.registrations.length} registrations, ${state.history.rings.length} ring builds · People back to #${state.history.people.fromBlock}, AH back to #${state.history.assetHub.fromBlock}.`,
      "ok",
    );
  } catch (e) {
    if ((e as Error).name === "AbortError") setStatus("History scan stopped.", "");
    else setStatus(`History scan failed: ${(e as Error).message}`, "bad");
  } finally {
    setProgress(null);
    stopBtn.classList.add("hidden");
    for (const b of loadBtns) b.disabled = false;
    state.historyAbort = null;
  }
}

function wire(): void {
  document.querySelector("#connect")!.addEventListener("click", () => doConnect());
  for (const b of document.querySelectorAll<HTMLElement>(".load-history"))
    b.addEventListener("click", () => void doLoadHistory(Number(b.getAttribute("data-window"))));
  document.querySelector("#stop-history")!.addEventListener("click", () => state.historyAbort?.abort());
  document.querySelector("#refresh-setup")!.addEventListener("click", () => void doLoadSetup());

  for (const tab of document.querySelectorAll<HTMLElement>(".tab"))
    tab.addEventListener("click", () => setPage(tab.getAttribute("data-page") as AppState["page"]));

  document.querySelector<HTMLSelectElement>("#preset")!.addEventListener("change", (ev) => {
    const name = (ev.target as HTMLSelectElement).value;
    const preset = PRESETS.find((p) => p.name === name);
    if (preset) {
      document.querySelector<HTMLInputElement>("#ep-people")!.value = preset.people;
      document.querySelector<HTMLInputElement>("#ep-ah")!.value = preset.assetHub;
    }
  });

  // Delegated handler for the per-table CSV export buttons (History page).
  app.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>(".export-btn");
    if (!btn) return;
    const key = btn.getAttribute("data-export") as HistoryTable | null;
    if (!key) return;
    if (!state.history) {
      setStatus("No history loaded yet — run a scan first.", "bad");
      return;
    }
    const { filename, content } = historyCsv(state.history, key);
    downloadCsv(filename, content);
  });

  // Delegated handlers for table collapse/search. Attached to the persistent #app
  // root so they survive the per-block innerHTML swaps of the panels.
  app.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>(".collapse-btn");
    if (!btn) return;
    const id = btn.getAttribute("data-target");
    if (!id) return;
    const st = tableState(id);
    st.collapsed = !st.collapsed;
    const tbl = app.querySelector(`.tbl[data-table-id="${id}"]`);
    tbl?.classList.toggle("collapsed", st.collapsed);
  });

  app.addEventListener("input", (ev) => {
    const input = ev.target as HTMLElement;
    if (!input.classList.contains("table-search")) return;
    const id = input.getAttribute("data-target");
    if (!id) return;
    const value = (input as HTMLInputElement).value;
    tableState(id).filter = value;
    const tbl = input.closest(".tbl");
    if (tbl) filterTable(tbl, value);
  });
}

app.innerHTML = shell();
// Reflect the matching preset (if any) in the dropdown on first load.
const matching = PRESETS.find(
  (p) => p.people === state.endpoints.people && p.assetHub === state.endpoints.assetHub,
);
if (matching) document.querySelector<HTMLSelectElement>("#preset")!.value = matching.name;
wire();
doConnect();
