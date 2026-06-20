// App entry: shell, connection management, always-live storage subscriptions,
// and the History page (full-block scan).
//
// Three pages: "Live" shows current state via finalized-block subscriptions (no
// manual refresh); "History" runs an accurate full-block scan of the last day and
// auto-starts on connect; "Setup" verifies the chain's initial-setup steps
// (one snapshot on connect, manual refresh).

import "./styles.css";
import { type Endpoints, isSummit, loadEndpoints, papiConsoleUrl, PRESETS, saveEndpoints } from "./config";
import { computeInTransit, fetchAhLive, fetchPeopleLive } from "./live";
import type { AhLive, HistoryResult, PeopleLive } from "./domain";
import { deriveHistory, type HistoryAcc, scanHistory, type Progress } from "./history";
import { connect, type Connections, disconnect } from "./papi";
import { cacheStats, clearCache, exportCache, importCache } from "./cache";
import {
  deriveStats,
  type StatsProgress,
  type StatsResult,
  type StatsState,
  syncStats,
} from "./stats";
import { renderStats } from "./statsui";
import { clearStatsCache } from "./statscache";
import {
  closeStatsFullscreen,
  destroyMetricCharts,
  drawFlowChart,
  drawMetricChart,
  openStatsFullscreen,
  resetFullscreenZoom,
  resetStatsZoom,
} from "./statschart";
import {
  closeTimingChartModal,
  drawTimingChart,
  openTimingChartModal,
  resetZoom,
  resizeTimingChart,
} from "./chart";
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
  /** Summit usage stats (summit network only). */
  stats: StatsState | null;
  statsResult: StatsResult | null;
  statsBusy: boolean;
  statsAbort: AbortController | null;
  /** Whether the stats scan has been auto-started for the current connection. */
  statsAutoStarted: boolean;
  /** Throttle for incremental stats syncs triggered by finalized blocks. */
  statsLastSync: number;
  page: "live" | "history" | "setup" | "stats";
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
  stats: null,
  statsResult: null,
  statsBusy: false,
  statsAbort: null,
  statsAutoStarted: false,
  statsLastSync: 0,
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
      <button class="tab hidden" data-page="stats" id="stats-tab" title="Summit usage statistics, accumulated from the start of the summit (2026-06-18 09:00 CET) to the chain tip. Summit network only.">Stats</button>
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
        <button class="load-history" data-window="604800000" title="Scan 1 more week of older history. This reads every block on both chains over a week (~300k blocks/chain) and can take a long while — use Stop to cancel.">+1w</button>
        <button id="stop-history" class="hidden" title="Abort the in-progress history scan.">Stop</button>
        <span id="progress" class="progress hidden"></span>
        <span id="cache-stat" class="cache-stat" title="Local IndexedDB cache of scanned blocks, keyed per chain (genesis). Blocks already cached are replayed from disk instead of re-querying the chain, so re-loading an overlapping range is instant. 'blocks' is how many blocks are cached across all networks; size is an approximate, origin-wide figure reported by the browser.">cache: …</span>
        <button id="export-cache" title="Download the whole local block cache (all networks) as a JSON file you can share.">Export</button>
        <button id="import-cache" title="Merge a previously exported cache JSON into your local cache. Only finalized (immutable) blocks are cached, so merging never conflicts. A file from a different schema version is rejected.">Import</button>
        <input id="cache-file" type="file" accept="application/json,.json" class="hidden" />
        <button id="clear-cache" title="Delete the entire local block cache (IndexedDB) for all networks. The next scan re-fetches from the chain.">Clear cache</button>
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
    <div id="stats-page" class="page hidden">
      <div class="hist-toolbar">
        <button id="refresh-stats" title="Clear the stats cache and re-scan the whole summit window from chain — a full fresh reload (slower, but guarantees every chart is current and in sync).">Refresh</button>
        <span id="stats-progress" class="progress hidden"></span>
      </div>
      <div id="stats"></div>
    </div>
  </main>
  <footer>
    Read-only — no transactions are ever signed or submitted. Live panels subscribe to each chain's
    finalized-block stream. History scans every block in the window on both chains (accurate, not fast)
    and reconstructs: register (People) → ring built (People) → received (Asset Hub). Setup verifies
    the on-chain state written by individuality's scripts/initial-setup and shows the values in use.
  </footer>
  <div id="chart-modal" class="modal hidden">
    <div class="modal-bar">
      <span class="modal-title">Propagation times over scanned window</span>
      <button id="chart-modal-reset" title="Reset pan/zoom to fit all data">reset zoom</button>
      <button id="chart-modal-close" title="Close (Esc)">✕ close</button>
    </div>
    <div class="modal-canvas-wrap"><canvas id="chart-modal-canvas"></canvas></div>
  </div>
  <div id="stats-chart-modal" class="modal hidden">
    <div class="modal-bar">
      <span class="modal-title" id="stats-chart-title">Chart</span>
      <button id="stats-chart-reset" title="Reset pan/zoom to fit all data">reset zoom</button>
      <button id="stats-chart-close" title="Close (Esc)">✕ close</button>
    </div>
    <div class="modal-canvas-wrap"><canvas id="stats-chart-canvas"></canvas></div>
  </div>`;
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

/** The active tab, read from the URL hash (so a reload restores it). */
function pageFromHash(): AppState["page"] {
  const h = location.hash.replace(/^#/, "");
  if (h === "history" || h === "setup") return h;
  if (h === "stats" && isSummit(state.endpoints)) return "stats";
  return "live";
}

function setPage(page: AppState["page"]): void {
  state.page = page;
  for (const pg of ["live", "history", "setup", "stats"] as const)
    document.querySelector(`#${pg}-page`)!.classList.toggle("hidden", pg !== page);
  for (const t of document.querySelectorAll<HTMLElement>(".tab"))
    t.classList.toggle("active", t.getAttribute("data-page") === page);
  // Reflect the tab in the URL (no history entry) so reloading restores it.
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  // Chart.js can't measure the canvas while its tab is hidden; fix up on reveal.
  if (page === "history") resizeTimingChart();
  if (page === "stats") redrawStatsCharts();
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
  // The chart is a canvas hydrated by Chart.js, so it must be (re)drawn after the
  // panel's innerHTML is swapped in (or torn down when there's no history).
  drawTimingChart(el, state.history);
}

/** Open the full-screen chart modal with a snapshot of the current history. */
function openChartModal(): void {
  if (!state.history) {
    setStatus("No history loaded yet — run a scan first.", "bad");
    return;
  }
  const modal = document.querySelector<HTMLDivElement>("#chart-modal")!;
  modal.classList.remove("hidden");
  // Draw after the modal is visible so Chart.js can measure the now-sized canvas.
  const canvas = document.querySelector<HTMLCanvasElement>("#chart-modal-canvas")!;
  openTimingChartModal(canvas, state.history);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Refresh the cache stat readout in the History toolbar (block count + ≈ size). */
async function refreshCacheStat(): Promise<void> {
  const el = document.querySelector<HTMLSpanElement>("#cache-stat");
  if (!el) return;
  try {
    const s = await cacheStats();
    if (!s.available) {
      el.textContent = "cache: unavailable";
      return;
    }
    const size = s.bytes != null ? ` · ≈${fmtBytes(s.bytes)}` : "";
    el.textContent = `cache: ${s.blocks.toLocaleString()} blocks${size}`;
  } catch {
    el.textContent = "cache: unavailable";
  }
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Trigger a client-side download of CSV text (with a UTF-8 BOM so Excel reads hex/labels). */
function downloadCsv(filename: string, content: string): void {
  downloadBlob(filename, new Blob(["﻿" + content], { type: "text/csv;charset=utf-8;" }));
}

function downloadJson(filename: string, obj: unknown): void {
  downloadBlob(filename, new Blob([JSON.stringify(obj)], { type: "application/json" }));
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

// ---------- Summit Stats page ----------

function setStatsProgress(p: StatsProgress | null): void {
  const el = document.querySelector<HTMLDivElement>("#stats-progress")!;
  if (!p) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  el.textContent = `${p.phase}… ${p.done}/${p.total} (${pct}%)`;
}

/** (Re)draw all metric charts from the current result (after innerHTML swaps or tab reveal). */
function redrawStatsCharts(): void {
  if (!state.statsResult) return;
  const el = document.querySelector("#stats")!;
  const startMs = state.statsResult.startMs;
  for (const m of state.statsResult.metrics) drawMetricChart(el, m, startMs);
  drawFlowChart(el, "count", state.statsResult.recyclerFlow, startMs);
  drawFlowChart(el, "value", state.statsResult.recyclerFlow, startMs);
}

/** Human title for a stats chart key (for the full-screen modal header). */
function statsChartTitle(key: string): string {
  if (key === "flow:count") return "Recycler flow — event count";
  if (key === "flow:value") return "Recycler flow — value (CASH)";
  const mk = key.replace(/^metric:/, "");
  return state.statsResult?.metrics.find((m) => m.key === mk)?.label ?? "Chart";
}

function renderStatsSection(): void {
  if (searchFocusedIn("#stats-page")) return;
  const el = document.querySelector("#stats")!;
  if (!state.statsResult) {
    el.innerHTML = "";
    destroyMetricCharts();
    return;
  }
  el.innerHTML = renderStats(state.statsResult);
  redrawStatsCharts();
}

/** Show/hide the summit-only Stats tab; bounce off the page if it's no longer summit. */
function updateStatsTab(): void {
  const summit = isSummit(state.endpoints);
  document.querySelector("#stats-tab")!.classList.toggle("hidden", !summit);
  if (!summit && state.page === "stats") setPage("live");
}

/** Scan the summit window and render. `full` re-scans from scratch (cache replays the
 *  unchanged part); otherwise it extends the existing scan to the new tip (live update). */
async function doLoadStats(full: boolean): Promise<void> {
  if (!state.conns || !isSummit(state.endpoints)) return;
  if (state.statsBusy) return;
  state.statsBusy = true;
  const conns = state.conns;
  const abort = new AbortController();
  state.statsAbort = abort;
  const btn = document.querySelector<HTMLButtonElement>("#refresh-stats")!;
  if (full) btn.disabled = true;
  try {
    const prev = full ? null : state.stats;
    if (full) {
      state.stats = null;
      state.statsResult = null;
      renderStatsSection();
    }
    // Progressive render only matters for the long first (uncached) scan.
    const onPartial = full
      ? (s: StatsState) => {
          state.stats = s;
          state.statsResult = deriveStats(s, true);
          renderStatsSection();
        }
      : undefined;
    const next = await syncStats(
      conns,
      prev,
      full ? setStatsProgress : () => {},
      abort.signal,
      Date.now(),
      onPartial,
    );
    state.stats = next;
    state.statsResult = deriveStats(next, false);
    renderStatsSection();
    state.statsLastSync = Date.now();
  } catch (e) {
    if ((e as Error).name !== "AbortError")
      setStatus(`Stats scan failed: ${(e as Error).message}`, "bad");
  } finally {
    state.statsBusy = false;
    state.statsAbort = null;
    if (full) setStatsProgress(null);
    btn.disabled = false;
  }
}

/** Extend the stats scan to the new tip on a finalized block, throttled. */
function maybeSyncStatsLive(): void {
  if (!isSummit(state.endpoints) || !state.stats || state.statsBusy) return;
  if (Date.now() - state.statsLastSync < 6000) return;
  void doLoadStats(false);
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
          maybeSyncStatsLive();
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
          maybeSyncStatsLive();
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
  state.statsAbort?.abort();
  state.stats = null;
  state.statsResult = null;
  state.statsAutoStarted = false;
  state.statsLastSync = 0;
  destroyMetricCharts();
  document.querySelector("#people")!.innerHTML = "";
  document.querySelector("#ah")!.innerHTML = "";
  document.querySelector("#intransit")!.innerHTML = "";
  renderHistorySection();
  renderSetupSection();
  renderStatsSection();
  updateStatsTab();

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
    // Summit only: auto-start the usage-stats scan (background, progressive).
    if (isSummit(state.endpoints) && !state.statsAutoStarted) {
      state.statsAutoStarted = true;
      void doLoadStats(true);
    }
  } catch (e) {
    setStatus(`Connect failed: ${(e as Error).message}`, "bad");
  }
}

/** Progressive-render granularity: a load larger than this is split into chunks of
 *  this much *time*, re-deriving + re-rendering (and persisting to cache) after each.
 *  Loads at or below this run as a single chunk (unchanged behaviour). */
const HISTORY_CHUNK_MS = 600_000; // 10 minutes

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
  const abort = new AbortController();
  state.historyAbort = abort;
  stopBtn.classList.remove("hidden");
  for (const b of loadBtns) b.disabled = true;
  if (!extending) {
    // First load: blank stale data; chunks then fill it in progressively.
    state.history = null;
    renderHistorySection();
  }
  setProgress({ phase: "Starting", done: 0, total: 1, events: 0 });

  const chunkMs = Math.min(HISTORY_CHUNK_MS, windowMs);
  const totalChunks = Math.max(1, Math.ceil(windowMs / chunkMs));
  // Time floor this load must reach: `windowMs` below where scanning currently stands.
  // Known up front for an extend; for a first load we learn the head time after the
  // first chunk (and the cache may already carry us past it in one shot).
  let targetFloorMs: number | null =
    extending && state.historyAcc ? state.historyAcc.scanFloorMs - windowMs : null;

  // Re-render is throttled so cache-fast chunks don't thrash the DOM; the final state
  // is always forced. deriveHistory recomputes from the whole accumulator each time.
  let lastRenderMs = 0;
  const render = (force: boolean): void => {
    if (!state.historyAcc) return;
    const now = Date.now();
    if (!force && now - lastRenderMs < 400) return;
    lastRenderMs = now;
    state.history = deriveHistory(state.historyAcc);
    renderHistorySection();
    // The cache is written every chunk, so keep the block-count / size readout live.
    void refreshCacheStat();
  };

  try {
    for (let i = 0; i < totalChunks; i++) {
      if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
      const prevP = state.historyAcc?.pMinScanned ?? Number.POSITIVE_INFINITY;
      const prevA = state.historyAcc?.aMinScanned ?? Number.POSITIVE_INFINITY;
      const chunkNo = i + 1;
      const acc = await scanHistory(
        conns.people,
        conns.assetHub,
        (p) =>
          setProgress({
            phase: totalChunks > 1 ? `Loading ${chunkNo}/${totalChunks} · ${p.phase}` : p.phase,
            done: p.done,
            total: p.total,
            events: p.events,
          }),
        abort.signal,
        chunkMs,
        state.historyAcc ?? undefined,
      );
      state.historyAcc = acc;
      render(false);

      // Learn the overall target once the head time is known (first load). If a cache
      // exists, startup stops at the oldest cached extent (chunk 1's pull-down already
      // reached it) — fill the gap to the tip and stop, per CACHE-2. Otherwise scan the
      // default window below the head. Must mirror scanHistory's first-load target so
      // the loop breaks exactly when chunk 1 has reached it.
      if (targetFloorMs === null) {
        const cachedFloors = [acc.pCachedFromTimeMs, acc.aCachedFromTimeMs].filter(
          (t): t is number => t != null,
        );
        if (cachedFloors.length) {
          targetFloorMs = Math.min(...cachedFloors);
        } else {
          const headFloor = Math.min(
            acc.pHeadTimeMs ?? Number.POSITIVE_INFINITY,
            acc.aHeadTimeMs ?? Number.POSITIVE_INFINITY,
          );
          targetFloorMs = (Number.isFinite(headFloor) ? headFloor : acc.scanFloorMs) - windowMs;
        }
      }
      // Stop early if both chains hit genesis (nothing new scanned), or we/the cache
      // have already covered the requested window.
      const stuck = acc.pMinScanned >= prevP && acc.aMinScanned >= prevA;
      if (stuck || acc.scanFloorMs <= targetFloorMs) break;
    }
    render(true);
    if (state.history)
      setStatus(
        `History: ${state.history.registrations.length} registrations, ${state.history.rings.length} ring builds · People back to #${state.history.people.fromBlock}, AH back to #${state.history.assetHub.fromBlock}.`,
        "ok",
      );
  } catch (e) {
    render(true); // show whatever fully-scanned chunks accumulated
    if ((e as Error).name === "AbortError") setStatus("History scan stopped.", "");
    else setStatus(`History scan failed: ${(e as Error).message}`, "bad");
  } finally {
    setProgress(null);
    stopBtn.classList.add("hidden");
    for (const b of loadBtns) b.disabled = false;
    state.historyAbort = null;
    void refreshCacheStat();
  }
}

function wire(): void {
  document.querySelector("#connect")!.addEventListener("click", () => doConnect());
  for (const b of document.querySelectorAll<HTMLElement>(".load-history"))
    b.addEventListener("click", () => void doLoadHistory(Number(b.getAttribute("data-window"))));
  document.querySelector("#stop-history")!.addEventListener("click", () => state.historyAbort?.abort());
  document.querySelector("#refresh-setup")!.addEventListener("click", () => void doLoadSetup());
  document.querySelector("#refresh-stats")!.addEventListener("click", () => {
    // True fresh reload: drop the on-disk stats cache so nothing is replayed, then
    // re-scan the whole window from chain. Keeps every chart in sync.
    void (async () => {
      if (state.statsBusy) return;
      await clearStatsCache();
      await doLoadStats(true);
    })();
  });
  document.querySelector("#clear-cache")!.addEventListener("click", () => {
    void (async () => {
      await clearCache();
      await refreshCacheStat();
      setStatus("Local block cache cleared.", "ok");
    })();
  });

  document.querySelector("#export-cache")!.addEventListener("click", () => {
    void (async () => {
      const data = await exportCache();
      if (!data || (data.blocks.length === 0 && data.coverage.length === 0)) {
        setStatus("Cache is empty — nothing to export.", "bad");
        return;
      }
      downloadJson("ring-root-cache.json", { ...data, exportedAt: Date.now() });
      setStatus(`Exported cache: ${data.blocks.length.toLocaleString()} block row(s).`, "ok");
    })();
  });

  const cacheFile = document.querySelector<HTMLInputElement>("#cache-file")!;
  document.querySelector("#import-cache")!.addEventListener("click", () => cacheFile.click());
  cacheFile.addEventListener("change", () => {
    void (async () => {
      const file = cacheFile.files?.[0];
      if (!file) return;
      try {
        const res = await importCache(JSON.parse(await file.text()));
        if (!res.ok) setStatus(`Import failed: ${res.reason}`, "bad");
        else setStatus(`Imported ${res.blocksAdded.toLocaleString()} block row(s) into the cache.`, "ok");
        await refreshCacheStat();
      } catch (e) {
        setStatus(`Import failed: ${(e as Error).message}`, "bad");
      } finally {
        cacheFile.value = ""; // allow re-importing the same file
      }
    })();
  });

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

  // Delegated handlers for the chart's "reset zoom" / "full screen" buttons (they
  // are re-rendered with the panel, so listen on the persistent #app root).
  app.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest(".chart-reset")) resetZoom();
    else if (t.closest(".chart-fullscreen")) openChartModal();
  });

  const modal = document.querySelector<HTMLDivElement>("#chart-modal")!;
  const closeModal = (): void => {
    modal.classList.add("hidden");
    closeTimingChartModal();
  };
  document.querySelector("#chart-modal-close")!.addEventListener("click", closeModal);
  document.querySelector("#chart-modal-reset")!.addEventListener("click", () => resetZoom());

  // Stats charts: full-screen + reset zoom (delegated — charts re-render each update).
  const statsModal = document.querySelector<HTMLDivElement>("#stats-chart-modal")!;
  const statsCanvas = document.querySelector<HTMLCanvasElement>("#stats-chart-canvas")!;
  const closeStatsModal = (): void => {
    statsModal.classList.add("hidden");
    closeStatsFullscreen();
  };
  app.addEventListener("click", (ev) => {
    const fs = (ev.target as HTMLElement).closest<HTMLElement>(".chart-fs");
    if (fs) {
      const key = fs.getAttribute("data-chart");
      if (!key) return;
      document.querySelector("#stats-chart-title")!.textContent = statsChartTitle(key);
      statsModal.classList.remove("hidden");
      if (!openStatsFullscreen(statsCanvas, key)) closeStatsModal();
      return;
    }
    const rz = (ev.target as HTMLElement).closest<HTMLElement>(".chart-zoom-reset");
    if (rz) resetStatsZoom(rz.getAttribute("data-chart") ?? "");
  });
  document.querySelector("#stats-chart-close")!.addEventListener("click", closeStatsModal);
  document.querySelector("#stats-chart-reset")!.addEventListener("click", () => resetFullscreenZoom());

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!modal.classList.contains("hidden")) closeModal();
    if (!statsModal.classList.contains("hidden")) closeStatsModal();
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
// Restore the active tab from the URL hash (default: live) so a reload keeps it.
setPage(pageFromHash());
void refreshCacheStat();
doConnect();
