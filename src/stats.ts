// Summit usage stats: scan blocks from the chain tip back to the summit start
// (2026-06-18 09:00 CET) and derive system-usage metrics, each with a live value
// and a growth-since-start time series.
//
// Two kinds of metric:
//   - event metrics: a cumulative count of a System.Events variant over the
//     window (e.g. coinage transfers, game sign-ups, PGAS claims). Scanned per
//     block and cached, exactly like the History page.
//   - storage metrics: a point-in-time count read from chain storage (CASH-asset
//     holders, coinage coin holders). The live value is read at the tip; the
//     growth curve is backfilled by sampling the value at a handful of historical
//     block heights (CASH is a cheap O(1) read so it samples densely; counting
//     coin holders enumerates a ~100k-key map, so it samples sparsely).
//
// Metrics span both chains: most individuality pallets live on the People chain;
// Pgas and AliasAccounts live on Asset Hub.

import { STATS_START_MS } from "./config";
import { firstBlockAtLeast, HashCache } from "./chainio";
import type { Chain } from "./domain";
import type { AhApi, ChainConn, Connections, PeopleApi } from "./papi";
import {
  loadSamples,
  loadStatsRange,
  saveSamples,
  saveStatsRange,
  type StatsExtract,
} from "./statscache";
import { addRange, coveredBy, type Range } from "./cache";

type Hex = `0x${string}`;

// ---------------- metric catalog ----------------

export interface EventMetric {
  key: string;
  label: string;
  description: string;
  chain: Chain;
  /** "Pallet.Variant" event ids that increment this metric. */
  events: string[];
}

export interface StorageMetric {
  key: string;
  label: string;
  /** Human-readable storage path scraped, shown on the card. */
  source: string;
  description: string;
  chain: Chain; // on People, but kept general
  /** Read the current value at a block hash (0 if the entity doesn't exist yet). */
  read: (people: ChainConn<PeopleApi>, at: Hex) => Promise<number>;
  /** Backfill the growth curve by sampling every this-many blocks. A FIXED step
   *  (anchored at the window start) keeps interior sample heights stable as the tip
   *  advances, so already-counted points stay cached and aren't re-read live. */
  sampleStepBlocks: number;
  /** Concurrency for backfilling historical samples (keep low for expensive reads). */
  sampleConcurrency: number;
  /** Don't re-read the live (tip) value more often than this (expensive reads). */
  liveEveryMs: number;
}

export const EVENT_METRICS: EventMetric[] = [
  {
    key: "coinageTransfers",
    label: "Coinage transfers",
    description: "Coinage.CoinTransferred — a coin moved to an account.",
    chain: "people",
    events: ["Coinage.CoinTransferred"],
  },
  {
    key: "liteRegistrations",
    label: "New lite people",
    description: "PeopleLite.PersonAttested — a lite person attested by a verifier.",
    chain: "people",
    events: ["PeopleLite.PersonAttested"],
  },
  {
    key: "gameSignups",
    label: "Game sign-ups",
    description: "Game.SignedUp — a player registered for a game.",
    chain: "people",
    events: ["Game.SignedUp"],
  },
  {
    key: "airdropRegistrations",
    label: "Airdrop registrations",
    description: "Airdrop.AccountRegistered + AliasRegistered — entries into an airdrop draw.",
    chain: "people",
    events: ["Airdrop.AccountRegistered", "Airdrop.AliasRegistered"],
  },
  {
    key: "airdropPrizes",
    label: "Airdrop prizes claimed",
    description: "Airdrop.PrizeClaimed — a winner claimed their prize.",
    chain: "people",
    events: ["Airdrop.PrizeClaimed"],
  },
  {
    key: "pgasClaims",
    label: "PGAS claims",
    description: "Pgas.PgasClaimed (Asset Hub) — a person claimed their daily gas.",
    chain: "assetHub",
    events: ["Pgas.PgasClaimed"],
  },
  {
    key: "aliasAccounts",
    label: "Alias accounts set",
    description: "AliasAccounts.AliasAccountSet (Asset Hub) — an account bound to a ring alias.",
    chain: "assetHub",
    events: ["AliasAccounts.AliasAccountSet"],
  },
];

/** Read the symbol→text of a papi Binary defensively. */
function asText(v: { asText?: () => string } | undefined): string {
  try {
    return v?.asText?.() ?? "";
  } catch {
    return "";
  }
}

/** Count CASH-asset holders: the `accounts` field of the CASH asset on People. */
async function readCashHolders(people: ChainConn<PeopleApi>, at: Hex): Promise<number> {
  const metas = await people.api.query.Assets.Metadata.getEntries({ at });
  const cash = metas.find((e) => asText(e.value.symbol) === "CASH");
  if (!cash) return 0;
  const details = await people.api.query.Assets.Asset.getValue(cash.keyArgs[0] as never, { at });
  return details ? details.accounts : 0;
}

export const STORAGE_METRICS: StorageMetric[] = [
  {
    key: "cashHolders",
    label: "CASH holders",
    source: "Assets.Asset(CASH).accounts",
    description: "Accounts holding the CASH asset (Assets.Asset(CASH).accounts) on People.",
    chain: "people",
    read: readCashHolders,
    sampleStepBlocks: 200, // cheap O(1) read → fairly dense (~every 7 min)
    sampleConcurrency: 8,
    liveEveryMs: 0, // refresh tip every block
  },
];

export const ALL_METRIC_KEYS = [
  ...EVENT_METRICS.map((m) => m.key),
  ...STORAGE_METRICS.map((m) => m.key),
];

// ---------------- scan state ----------------

interface ChainWindow {
  genesis: string | null;
  startBlock: number;
  tip: number;
  tipTimeMs: number | null;
}

export interface StatsState {
  startMs: number;
  people: ChainWindow;
  assetHub: ChainWindow;
  /** Per-block event counts merged so far (sparse), per chain. */
  pBlocks: Map<number, StatsExtract>;
  aBlocks: Map<number, StatsExtract>;
  /** Blocks already merged into the maps above (so re-syncs only scan new ones). */
  pCovered: Range[];
  aCovered: Range[];
  /** metricKey → (block → sample). Storage-metric growth points. */
  samples: Map<string, Map<number, { t: number | null; v: number }>>;
  /** metricKey → last wall-clock ms a live (tip) sample was taken. */
  lastSampledAt: Map<string, number>;
  notes: string[];
}

export interface StatsProgress {
  phase: string;
  done: number;
  total: number;
}
export type StatsProgressFn = (p: StatsProgress) => void;

const CONCURRENCY = 16;

async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  onTick: () => void,
  signal: AbortSignal,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (true) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
      onTick();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function uncoveredBlocks(from: number, to: number, covered: Range[]): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) if (!coveredBy(covered, n)) out.push(n);
  return out;
}

/** Retry a flaky RPC read a few times; null after the last failure. Keeps the final
 *  counts accurate by riding out transient drops instead of skipping the block. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch {
      if (i === attempts - 1) return null;
    }
  }
  return null;
}

/** [from,to] split into contiguous runs that exclude `failed` blocks, so a block is
 *  only marked covered once its events were actually read (failures retry next sync). */
function rangesExcluding(from: number, to: number, failed: Set<number>): Range[] {
  const fails = [...failed].filter((n) => n >= from && n <= to).sort((a, b) => a - b);
  if (fails.length === 0) return [[from, to]];
  const runs: Range[] = [];
  let cur = from;
  for (const f of fails) {
    if (f > cur) runs.push([cur, f - 1]);
    cur = f + 1;
  }
  if (cur <= to) runs.push([cur, to]);
  return runs;
}

type RawEvent = { event: { type: string; value: { type: string } } };

const hashCaches = new WeakMap<object, HashCache>();
function hashCacheFor(client: object): HashCache {
  let c = hashCaches.get(client);
  if (!c) {
    c = new HashCache(client as never);
    hashCaches.set(client, c);
  }
  return c;
}

async function tsAt(api: { query: { Timestamp: { Now: { getValue: (o: { at: Hex }) => Promise<bigint> } } } }, hashes: HashCache, n: number): Promise<number | null> {
  const h = (await hashes.hashAt(n)) as Hex | null;
  if (!h) return null;
  try {
    return Number(await api.query.Timestamp.Now.getValue({ at: h }));
  } catch {
    return null;
  }
}

/** Discover the [startBlock, tip] window for a chain (first block at/after the start). */
async function discoverWindow(
  client: { getFinalizedBlock: () => Promise<{ number: number }>; _request: <T>(m: string, p: unknown[]) => Promise<T> },
  api: { query: { Timestamp: { Now: { getValue: (o: { at: Hex }) => Promise<bigint> } } } },
): Promise<ChainWindow> {
  const hashes = hashCacheFor(client);
  const head = await client.getFinalizedBlock();
  const [tipTimeMs, genesis] = await Promise.all([
    tsAt(api, hashes, head.number),
    client._request<string>("chain_getBlockHash", [0]).catch(() => null),
  ]);
  const metric = async (n: number) => (await tsAt(api, hashes, n)) ?? Number.NEGATIVE_INFINITY;
  const startBlock = (await firstBlockAtLeast(1, head.number, STATS_START_MS, metric)) ?? head.number;
  return { genesis, startBlock, tip: head.number, tipTimeMs };
}

/** Build the (event id → metric key) map for one chain. */
function matchersFor(chain: Chain): Map<string, string> {
  const m = new Map<string, string>();
  for (const em of EVENT_METRICS) if (em.chain === chain) for (const e of em.events) m.set(e, em.key);
  return m;
}

/** Scan/replay the given blocks for one chain, merging event counts into `blocks`. */
async function scanChainEvents(
  conn: ChainConn<PeopleApi> | ChainConn<AhApi>,
  chain: Chain,
  genesis: string | null,
  targetFrom: number,
  targetTo: number,
  blocks: Map<number, StatsExtract>,
  covered: Range[],
  onTick: () => void,
  signal: AbortSignal,
): Promise<Range[]> {
  const todo = uncoveredBlocks(targetFrom, targetTo, covered);
  if (todo.length === 0) return covered;
  const matchers = matchersFor(chain);
  const client = conn.client;
  const api = conn.api as unknown as {
    query: {
      System: { Events: { getValue: (o: { at: Hex }) => Promise<unknown> } };
      Timestamp: { Now: { getValue: (o: { at: Hex }) => Promise<bigint> } };
    };
  };

  // Replay from cache where possible; fetch the rest from chain.
  const cache = await loadStatsRange(genesis, chain, todo[0], todo[todo.length - 1]);
  const toWrite = new Map<number, StatsExtract>();
  // Blocks whose events we could not read this pass: NOT marked covered, so the next
  // sync retries them. This is what keeps the final totals exact under flaky RPC.
  const failed = new Set<number>();

  await pool(
    todo,
    CONCURRENCY,
    async (n) => {
      let e: StatsExtract | undefined;
      if (coveredBy(cache.ranges, n)) {
        e = cache.blocks.get(n) ?? { t: null, c: {} };
      } else {
        const h = (await withRetry(() => client._request<string | null>("chain_getBlockHash", [n]))) as Hex | null;
        if (!h) {
          failed.add(n);
          return;
        }
        const recs = (await withRetry(() => api.query.System.Events.getValue({ at: h }))) as RawEvent[] | null;
        if (!recs) {
          failed.add(n);
          return;
        }
        const counts: Record<string, number> = {};
        for (const r of recs) {
          const id = `${r.event.type}.${r.event.value.type}`;
          const key = matchers.get(id);
          if (key) counts[key] = (counts[key] ?? 0) + 1;
        }
        const hasAny = Object.keys(counts).length > 0;
        // Timestamp is best-effort: it positions the block on the chart, but its
        // absence never drops the block's counts from the totals.
        let t: number | null = null;
        if (hasAny) {
          const raw = await withRetry(() => api.query.Timestamp.Now.getValue({ at: h }));
          t = raw == null ? null : Number(raw);
        }
        e = { t, c: counts };
        if (hasAny) toWrite.set(n, e);
      }
      if (e && Object.keys(e.c).length > 0) blocks.set(n, e);
    },
    onTick,
    signal,
  );

  // Persist + mark covered only the blocks actually resolved (excluding failures).
  const runs = rangesExcluding(targetFrom, targetTo, failed);
  let next = covered;
  for (const [f, t] of runs) {
    await saveStatsRange(genesis, chain, f, t, toWrite);
    next = addRange(next, f, t);
  }
  return next;
}

/** Sample heights on a fixed grid anchored at `from` (stable as `to` advances),
 *  always including both ends. */
function sampleHeights(from: number, to: number, step: number): number[] {
  if (to <= from) return [to];
  const set = new Set<number>([from, to]);
  for (let n = from; n < to; n += Math.max(1, step)) set.add(n);
  return [...set].sort((a, b) => a - b);
}

/** How many uncached samples this metric needs (for the progress total). */
function pendingSampleCount(
  metric: StorageMetric,
  win: ChainWindow,
  series: Map<number, { t: number | null; v: number }> | undefined,
): number {
  const heights = sampleHeights(win.startBlock, win.tip, metric.sampleStepBlocks);
  return heights.filter((n) => n === win.tip || !series?.has(n)).length;
}

/** Backfill + refresh a storage metric's samples. Reads the live (tip) value FIRST
 *  (so the headline number appears immediately), then backfills the historical curve
 *  with bounded concurrency, calling `onPartial` as values land. */
async function syncStorageMetric(
  people: ChainConn<PeopleApi>,
  metric: StorageMetric,
  win: ChainWindow,
  state: StatsState,
  nowMs: number,
  onTick: () => void,
  onPartial: (() => void) | undefined,
  signal: AbortSignal,
): Promise<void> {
  const hashes = hashCacheFor(people.client);
  let series = state.samples.get(metric.key);
  if (!series) {
    series = await loadSamples(win.genesis, "people", metric.key);
    state.samples.set(metric.key, series);
  }
  const seriesRef = series;
  const fresh = new Map<number, { t: number | null; v: number }>();

  const sampleAt = async (n: number): Promise<void> => {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const h = (await hashes.hashAt(n)) as Hex | null;
    if (!h) return;
    let v: number;
    try {
      v = await metric.read(people, h);
    } catch {
      return;
    }
    const t = await tsAt(people.api as never, hashes, n);
    const sample = { t, v };
    seriesRef.set(n, sample);
    if (n !== win.tip) fresh.set(n, sample); // historical samples are immutable → cache them
    onTick();
  };

  // Tip first → the live value shows up right away, before the chart backfills.
  await sampleAt(win.tip);
  onPartial?.();

  const heights = sampleHeights(win.startBlock, win.tip, metric.sampleStepBlocks).filter(
    (n) => n !== win.tip && !seriesRef.has(n),
  );
  let lastPartial = Date.now();
  await pool(
    heights,
    metric.sampleConcurrency,
    sampleAt,
    () => {
      if (onPartial && Date.now() - lastPartial > 1000) {
        lastPartial = Date.now();
        onPartial();
      }
    },
    signal,
  );
  state.lastSampledAt.set(metric.key, nowMs);
  if (fresh.size) void saveSamples(win.genesis, "people", metric.key, fresh);
}

/**
 * Bring `state` up to the current tip. With no prior state, discovers the window
 * and does the full backfill; with prior state, only scans new tip blocks and
 * refreshes storage samples (respecting each metric's live-refresh throttle).
 */
export async function syncStats(
  conns: Connections,
  prev: StatsState | null,
  onProgress: StatsProgressFn,
  signal: AbortSignal,
  nowMs: number,
  onPartial?: (s: StatsState) => void,
): Promise<StatsState> {
  onProgress({ phase: "Locating window", done: 0, total: 1 });
  const state: StatsState =
    prev ??
    (await (async (): Promise<StatsState> => {
      const [people, assetHub] = await Promise.all([
        discoverWindow(conns.people.client, conns.people.api as never),
        discoverWindow(conns.assetHub.client, conns.assetHub.api as never),
      ]);
      return {
        startMs: STATS_START_MS,
        people,
        assetHub,
        pBlocks: new Map(),
        aBlocks: new Map(),
        pCovered: [],
        aCovered: [],
        samples: new Map(),
        lastSampledAt: new Map(),
        notes: [],
      };
    })());

  if (prev) {
    // Refresh tips to the current finalized heads.
    const [p, a] = await Promise.all([
      conns.people.client.getFinalizedBlock(),
      conns.assetHub.client.getFinalizedBlock(),
    ]);
    state.people.tip = p.number;
    state.assetHub.tip = a.number;
  }

  // ---- event coverage on both chains ----
  let pDone = 0;
  let aDone = 0;
  const pTodo = uncoveredBlocks(state.people.startBlock, state.people.tip, state.pCovered).length;
  const aTodo = uncoveredBlocks(state.assetHub.startBlock, state.assetHub.tip, state.aCovered).length;
  const total = pTodo + aTodo;
  let lastPartial = 0;
  const tick = () => {
    const done = pDone + aDone;
    if (done % 25 === 0 || done === total) {
      onProgress({ phase: "Scanning People + Asset Hub blocks", done, total });
      // Progressive render: re-derive from the (in-place mutated) state, throttled.
      if (onPartial && Date.now() - lastPartial > 1200) {
        lastPartial = Date.now();
        onPartial(state);
      }
    }
  };

  const [pCov, aCov] = await Promise.all([
    scanChainEvents(
      conns.people,
      "people",
      state.people.genesis,
      state.people.startBlock,
      state.people.tip,
      state.pBlocks,
      state.pCovered,
      () => {
        pDone++;
        tick();
      },
      signal,
    ),
    scanChainEvents(
      conns.assetHub,
      "assetHub",
      state.assetHub.genesis,
      state.assetHub.startBlock,
      state.assetHub.tip,
      state.aBlocks,
      state.aCovered,
      () => {
        aDone++;
        tick();
      },
      signal,
    ),
  ]);
  state.pCovered = pCov;
  state.aCovered = aCov;

  // tip timestamps (for the "live" readout)
  const pHashes = hashCacheFor(conns.people.client);
  const aHashes = hashCacheFor(conns.assetHub.client);
  state.people.tipTimeMs = await tsAt(conns.people.api as never, pHashes, state.people.tip);
  state.assetHub.tipTimeMs = await tsAt(conns.assetHub.api as never, aHashes, state.assetHub.tip);

  // ---- storage metrics (both on People) ----
  // Decide which metrics to (re)sample now: always on the first pass; afterwards
  // honour each metric's live-refresh throttle.
  const due = STORAGE_METRICS.filter((m) => {
    const last = state.lastSampledAt.get(m.key) ?? 0;
    return !(prev && m.liveEveryMs > 0 && nowMs - last < m.liveEveryMs);
  });
  // Preload cached sample maps so the progress total reflects only uncached work.
  for (const m of due) {
    if (!state.samples.has(m.key))
      state.samples.set(m.key, await loadSamples(state.people.genesis, "people", m.key));
  }
  const sampleTotal = due.reduce(
    (s, m) => s + pendingSampleCount(m, state.people, state.samples.get(m.key)),
    0,
  );
  let sampleDone = 0;
  const sampleTick = () => {
    sampleDone++;
    if (sampleDone % 2 === 0 || sampleDone === sampleTotal)
      onProgress({ phase: "Sampling storage metrics", done: sampleDone, total: sampleTotal });
  };
  onProgress({ phase: "Sampling storage metrics", done: 0, total: sampleTotal });
  const renderPartial = onPartial ? () => onPartial(state) : undefined;
  for (const metric of due) {
    await syncStorageMetric(conns.people, metric, state.people, state, nowMs, sampleTick, renderPartial, signal);
  }

  return state;
}

// ---------------- derivation ----------------

export interface MetricResult {
  key: string;
  label: string;
  description: string;
  /** Exact on-chain event(s) or storage item this metric is scraped from. */
  source: string;
  chain: Chain;
  kind: "event" | "storage";
  /** Current/live value. */
  value: number;
  /** Growth series: cumulative count (event) or sampled value (storage) over time. */
  points: Array<{ x: number; y: number }>;
  /** A storage metric not yet sampled this run — show a placeholder, not a misleading 0. */
  pending?: boolean;
}

export interface StatsResult {
  startMs: number;
  peopleTip: number;
  assetHubTip: number;
  peopleTipTimeMs: number | null;
  assetHubTipTimeMs: number | null;
  scannedPeople: number;
  scannedAh: number;
  metrics: MetricResult[];
  notes: string[];
  inProgress: boolean;
}

/** Number of buckets used to decimate cumulative event curves. */
const BUCKETS = 240;

function eventSeries(
  blocks: Map<number, StatsExtract>,
  key: string,
  startMs: number,
  tipMs: number | null,
): { value: number; points: Array<{ x: number; y: number }> } {
  // Collect (t, count) for this metric. The total counts every event; the chart
  // only uses timestamped blocks (a missing timestamp never drops the count).
  const rows: Array<{ t: number; n: number }> = [];
  let total = 0;
  for (const e of blocks.values()) {
    const n = e.c[key];
    if (!n) continue;
    total += n;
    if (e.t != null) rows.push({ t: e.t, n });
  }
  if (rows.length === 0) return { value: total, points: [{ x: startMs, y: 0 }] };
  rows.sort((a, b) => a.t - b.t);
  const end = tipMs ?? rows[rows.length - 1].t;
  const span = Math.max(1, end - startMs);
  const bucketTotals = new Array<number>(BUCKETS).fill(0);
  for (const r of rows) {
    const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor(((r.t - startMs) / span) * BUCKETS)));
    bucketTotals[idx] += r.n;
  }
  const points: Array<{ x: number; y: number }> = [{ x: startMs, y: 0 }];
  let cum = 0;
  for (let i = 0; i < BUCKETS; i++) {
    if (bucketTotals[i] === 0) continue;
    cum += bucketTotals[i];
    const x = startMs + Math.round(((i + 1) / BUCKETS) * span);
    points.push({ x, y: cum });
  }
  if (points[points.length - 1].x < end) points.push({ x: end, y: cum });
  return { value: total, points };
}

function storageSeries(
  series: Map<number, { t: number | null; v: number }> | undefined,
  tip: number,
): { value: number; points: Array<{ x: number; y: number }>; pending: boolean } {
  if (!series || series.size === 0) return { value: 0, points: [], pending: true };
  const points = [...series.values()]
    .filter((s): s is { t: number; v: number } => s.t != null)
    .map((s) => ({ x: s.t, y: s.v }))
    .sort((a, b) => a.x - b.x);
  const tipSample = series.get(tip);
  const value = tipSample ? tipSample.v : (points.length ? points[points.length - 1].y : 0);
  return { value, points, pending: false };
}

export function deriveStats(state: StatsState, inProgress: boolean): StatsResult {
  const metrics: MetricResult[] = [];
  for (const em of EVENT_METRICS) {
    const blocks = em.chain === "people" ? state.pBlocks : state.aBlocks;
    const tipMs = em.chain === "people" ? state.people.tipTimeMs : state.assetHub.tipTimeMs;
    const { value, points } = eventSeries(blocks, em.key, state.startMs, tipMs);
    metrics.push({ ...metricMeta(em), kind: "event", value, points });
  }
  for (const sm of STORAGE_METRICS) {
    const tip = sm.chain === "people" ? state.people.tip : state.assetHub.tip;
    const { value, points, pending } = storageSeries(state.samples.get(sm.key), tip);
    metrics.push({ ...metricMeta(sm), kind: "storage", value, points, pending });
  }
  return {
    startMs: state.startMs,
    peopleTip: state.people.tip,
    assetHubTip: state.assetHub.tip,
    peopleTipTimeMs: state.people.tipTimeMs,
    assetHubTipTimeMs: state.assetHub.tipTimeMs,
    scannedPeople: state.pCovered.reduce((s, [f, t]) => s + (t - f + 1), 0),
    scannedAh: state.aCovered.reduce((s, [f, t]) => s + (t - f + 1), 0),
    metrics,
    notes: state.notes,
    inProgress,
  };
}

function metricMeta(m: EventMetric | StorageMetric) {
  const source = "events" in m ? m.events.join(" + ") : m.source;
  return { key: m.key, label: m.label, description: m.description, source, chain: m.chain };
}
