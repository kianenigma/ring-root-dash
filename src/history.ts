// Accurate historical scan, People ↔ Asset Hub.
//
// Sequential-by-design: we read System.Events at EVERY block in the window on
// both chains (concurrency is only for throughput — every block is still read,
// so nothing is missed). From those events we reconstruct, for each ring and each
// registration, the three-stage pipeline and its delays:
//
//   1. register   — Members.MemberAdded on People (a new member key enters)
//   2. ring built — Members.RingBuilt on People (the member's ring is (re)built)
//   3. received   — the ring's record appears/updates on Asset Hub
//
// Loads accumulate: the first scan covers the most recent window; each subsequent
// scan extends the loaded range further into the past (older blocks), and results
// are re-derived from the combined raw data. Everything is labeled by both block
// number and timestamp.

import {
  type AhExtract,
  coveredBy,
  loadCoverage,
  loadRange,
  type PeopleExtract,
  type Range,
  saveRange,
} from "./cache";
import { HISTORY_WINDOW_MS } from "./config";
import { firstBlockAtLeast, HashCache } from "./chainio";
import type {
  HistoryResult,
  RegistrationDelay,
  RingLifecycle,
  ScanWindow,
  TimedEvent,
} from "./domain";
import { ringKeyStr } from "./domain";
import type { AhApi, ChainConn, PeopleApi } from "./papi";

const EMPTY_PEOPLE: PeopleExtract = { t: null, added: [], built: [], onboard: [] };
const EMPTY_AH: AhExtract = { t: null, events: [], updates: [] };

type Hex = `0x${string}`;

export interface Progress {
  phase: string;
  done: number;
  total: number;
  events: number;
}
export type ProgressFn = (p: Progress) => void;

const CONCURRENCY = 16;

interface BuildRec {
  block: number;
  timeMs: number | null;
  revision: number;
}

/** Accumulated raw scan data across one or more (progressively older) loads. */
export interface HistoryAcc {
  subscribed: Set<string>;
  memberRing: Map<string, { identifier: string; ringIndex: number | null }>;
  events: TimedEvent[];
  peopleBuilds: Map<string, BuildRec[]>;
  ahUpdates: Map<string, BuildRec[]>;
  registrations: Array<{ key: string; block: number; timeMs: number | null }>;
  /** Rings present on AH just before the earliest scanned block. */
  receivedBeforeWindow: Set<string>;
  notes: string[];
  pHead: number;
  aHead: number;
  pHeadTimeMs: number | null;
  aHeadTimeMs: number | null;
  /** Oldest wall-clock time (ms) scanned so far, shared by both chains. Each load
   *  extends this by `windowMs` and scans *both* chains down to it, so the two
   *  chains stay time-aligned regardless of their (differing) block rates. */
  scanFloorMs: number;
  /** Earliest scanned block (inclusive); next load goes below this. */
  pMinScanned: number;
  aMinScanned: number;
  pMinTimeMs: number | null;
  aMinTimeMs: number | null;
  scannedPeople: number;
  scannedAh: number;
  /** Chain genesis hashes — the cache scope key. Null if they couldn't be read. */
  pGenesis: string | null;
  aGenesis: string | null;
  /** Timestamp (ms) of the earliest cached block per chain at connect time, so the
   *  first load can show max(default window, cached extent). Null if nothing cached. */
  pCachedFromTimeMs: number | null;
  aCachedFromTimeMs: number | null;
}

/** Bounded-concurrency map that still visits every item; honors abort. */
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

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

async function tsAt(
  read: (h: Hex) => Promise<bigint>,
  hashes: HashCache,
  n: number,
): Promise<number | null> {
  const h = (await hashes.hashAt(n)) as Hex | null;
  if (!h) return null;
  try {
    return Number(await read(h));
  } catch {
    return null;
  }
}

// A raw decoded event row from System.Events: { phase, event, topics }.
type RawEvent = { event: { type: string; value: { type: string; value: unknown } } };

// Hash caches are kept per chain across loads (module-level cache would also work,
// but tying them to the connection keeps things simple). They are recreated when a
// fresh accumulator is built and reused via the closure during a single scan.
const pHashCaches = new WeakMap<object, HashCache>();
const aHashCaches = new WeakMap<object, HashCache>();
function hashCacheFor(client: object, store: WeakMap<object, HashCache>, make: () => HashCache) {
  let c = store.get(client);
  if (!c) {
    c = make();
    store.set(client, c);
  }
  return c;
}

/**
 * Scan one window and merge it into `acc`. With no `acc`, scans the most recent
 * `windowMs` and creates a fresh accumulator. With an `acc`, scans the window
 * immediately *older* than what's already loaded and extends it.
 */
export async function scanHistory(
  people: ChainConn<PeopleApi>,
  assetHub: ChainConn<AhApi>,
  onProgress: ProgressFn,
  signal: AbortSignal,
  windowMs: number = HISTORY_WINDOW_MS,
  acc?: HistoryAcc,
): Promise<HistoryAcc> {
  const isFirstLoad = acc === undefined;
  const pHashes = hashCacheFor(people.client, pHashCaches, () => new HashCache(people.client));
  const aHashes = hashCacheFor(assetHub.client, aHashCaches, () => new HashCache(assetHub.client));
  const pTs = (h: Hex) => people.api.query.Timestamp.Now.getValue({ at: h });
  const aTs = (h: Hex) => assetHub.api.query.Timestamp.Now.getValue({ at: h });

  // ---- Set up a fresh accumulator on first load ----
  if (!acc) {
    onProgress({ phase: "Locating window", done: 0, total: 1, events: 0 });
    const [pHead, aHead] = await Promise.all([
      people.client.getFinalizedBlock(),
      assetHub.client.getFinalizedBlock(),
    ]);
    const [pHeadTimeMs, aHeadTimeMs, pGenesis, aGenesis] = await Promise.all([
      tsAt(pTs, pHashes, pHead.number),
      tsAt(aTs, aHashes, aHead.number),
      people.client._request<string>("chain_getBlockHash", [0]).catch(() => null),
      assetHub.client._request<string>("chain_getBlockHash", [0]).catch(() => null),
    ]);

    const subscribed = new Set<string>();
    const memberRing = new Map<string, { identifier: string; ringIndex: number | null }>();
    const notes: string[] = [];
    try {
      const [states, roots] = await Promise.all([
        assetHub.api.query.MembersSubscriber.RingCollectionStates.getEntries({ at: "finalized" }),
        assetHub.api.query.MembersSubscriber.RingRoots.getEntries({ at: "finalized" }),
      ]);
      for (const e of states) subscribed.add(e.keyArgs[0].asHex());
      for (const e of roots) subscribed.add(e.keyArgs[0].asHex());
    } catch (err) {
      notes.push(`Could not read AH subscribed collections: ${(err as Error).message}`);
    }
    try {
      for (const e of await people.api.query.Members.Members.getEntries({ at: "finalized" })) {
        const pos = e.value as { type: string; value?: { ring_index: number } };
        memberRing.set(e.keyArgs[1].asHex(), {
          identifier: e.keyArgs[0].asHex(),
          ringIndex: pos.type === "Included" && pos.value ? pos.value.ring_index : null,
        });
      }
    } catch (err) {
      notes.push(`Could not read current Members for attribution: ${(err as Error).message}`);
    }

    // Earliest already-cached block per chain → its timestamp, so the first load
    // can show max(default window, cached extent) instead of just the default window.
    const [pCov, aCov] = await Promise.all([
      loadCoverage(pGenesis, "people"),
      loadCoverage(aGenesis, "assetHub"),
    ]);
    const earliestOf = (rs: Range[]): number | null => (rs.length ? Math.min(...rs.map((r) => r[0])) : null);
    const pCachedFrom = earliestOf(pCov);
    const aCachedFrom = earliestOf(aCov);
    const [pCachedFromTimeMs, aCachedFromTimeMs] = await Promise.all([
      pCachedFrom != null ? tsAt(pTs, pHashes, pCachedFrom) : Promise.resolve(null),
      aCachedFrom != null ? tsAt(aTs, aHashes, aCachedFrom) : Promise.resolve(null),
    ]);

    // Both chains scan down to a shared wall-clock floor; start it at the (older of
    // the two) head times so a 1h window means 1h on both, not "N blocks each".
    const headFloor = Math.min(
      pHeadTimeMs ?? Number.POSITIVE_INFINITY,
      aHeadTimeMs ?? Number.POSITIVE_INFINITY,
    );

    acc = {
      subscribed,
      memberRing,
      events: [],
      peopleBuilds: new Map(),
      ahUpdates: new Map(),
      registrations: [],
      receivedBeforeWindow: new Set(),
      notes,
      pHead: pHead.number,
      aHead: aHead.number,
      pHeadTimeMs,
      aHeadTimeMs,
      scanFloorMs: Number.isFinite(headFloor) ? headFloor : Date.now(),
      pMinScanned: pHead.number + 1, // nothing scanned yet
      aMinScanned: aHead.number + 1,
      pMinTimeMs: pHeadTimeMs,
      aMinTimeMs: aHeadTimeMs,
      scannedPeople: 0,
      scannedAh: 0,
      pGenesis,
      aGenesis,
      pCachedFromTimeMs,
      aCachedFromTimeMs,
    };
  }

  // ---- Determine the block range for this scan, by TIMESTAMP (not block count) ----
  // Both chains run at different block rates, so a fixed block count per chain drifts
  // their scanned time-windows apart — a People build can then fall in a time band the
  // AH side never scanned, showing a permanent false "pending". Instead we pick one
  // shared wall-clock floor and binary-search each chain for the first block at/after
  // it, so both chains always cover the same time span.
  let targetMs = acc.scanFloorMs - windowMs;
  // First load shows max(default window, cached extent): pull the floor down to the
  // oldest cached block's time so prior scans reappear instantly (gaps are re-fetched).
  if (isFirstLoad) {
    if (acc.pCachedFromTimeMs != null) targetMs = Math.min(targetMs, acc.pCachedFromTimeMs);
    if (acc.aCachedFromTimeMs != null) targetMs = Math.min(targetMs, acc.aCachedFromTimeMs);
  }
  targetMs = Math.max(0, targetMs);

  const pTo = acc.pMinScanned - 1; // one below the earliest already scanned (or head on first load)
  const aTo = acc.aMinScanned - 1;
  // The from-block sits at most ~window/MIN_BLOCK_MS blocks below `to`, so we bound the
  // binary search to that span instead of the whole chain (log2(span) vs log2(height) —
  // a big saving when this runs once per 10m chunk). If the bound was too tight (chain
  // faster than MIN_BLOCK_MS, or a deep cached-extent pull-down), we fall back to a full
  // search, so the result stays exact.
  const MIN_BLOCK_MS = 500;
  const locate = async (read: (h: Hex) => Promise<bigint>, hashes: HashCache, to: number) => {
    if (to < 1) return null;
    const metric = async (n: number) => {
      const t = await tsAt(read, hashes, n);
      return t == null ? Number.NEGATIVE_INFINITY : t;
    };
    const lo = Math.max(1, to - Math.ceil(windowMs / MIN_BLOCK_MS));
    let from = await firstBlockAtLeast(lo, to, targetMs, metric);
    if (from === lo && lo > 1) from = await firstBlockAtLeast(1, to, targetMs, metric);
    return from;
  };
  const [pFromRaw, aFromRaw] = await Promise.all([
    locate(pTs, pHashes, pTo),
    locate(aTs, aHashes, aTo),
  ]);
  // firstBlockAtLeast returns null only when even the newest unscanned block is older
  // than the target (nothing left in this window) → empty range via from > to.
  const pFrom = pFromRaw ?? pTo + 1;
  const aFrom = aFromRaw ?? aTo + 1;
  const pBlocks = pTo >= 1 && pFrom <= pTo ? range(pFrom, pTo) : [];
  const aBlocks = aTo >= 1 && aFrom <= aTo ? range(aFrom, aTo) : [];
  if (pBlocks.length === 0 && aBlocks.length === 0) {
    acc.notes = dedupeNotes([...acc.notes, "Reached genesis — no older blocks to load."]);
    return acc;
  }

  const ahKinds = [
    "RingRootsUpdated",
    "RingRootsInitialized",
    "MissingRingsDetected",
    "ReplayRequestSent",
    "SubscriptionTerminated",
    "DeletedIndicesAtCapacity",
  ];
  const a = acc; // non-null alias for closures

  // Per-chunk staging: merges write here, and are folded into `acc` only after the
  // whole chunk scans successfully. So an aborted chunk leaves `acc` untouched (no
  // half-merged data, no double-counting on the next load) — each chunk is atomic.
  const stageEvents: TimedEvent[] = [];
  const stageRegs: HistoryAcc["registrations"] = [];
  const stageBuilds = new Map<string, BuildRec[]>();
  const stageUpdates = new Map<string, BuildRec[]>();
  const pushTo = (m: Map<string, BuildRec[]>, k: string, rec: BuildRec) => {
    const arr = m.get(k);
    if (arr) arr.push(rec);
    else m.set(k, [rec]);
  };

  let pDone = 0;
  let aDone = 0;
  const totalBlocks = pBlocks.length + aBlocks.length;
  const report = () => {
    if ((pDone + aDone) % 50 === 0)
      onProgress({
        phase: "Scanning People + AH blocks",
        done: pDone + aDone,
        total: totalBlocks,
        events: a.events.length + stageEvents.length,
      });
  };

  // ---- Merge raw per-block extracts into the chunk stage. Filtering/attribution
  // uses current-session subscribed/memberRing state, so cached raw facts re-filter
  // correctly even if subscriptions or membership changed since they were cached. ----
  const mergePeople = (n: number, e: PeopleExtract) => {
    for (const key of e.added) {
      const attr = a.memberRing.get(key);
      if (!attr || !a.subscribed.has(attr.identifier)) continue;
      stageRegs.push({ key, block: n, timeMs: e.t });
      stageEvents.push({ chain: "people", block: n, timeMs: e.t, kind: "Registered", identifier: attr.identifier, detail: short(key) });
    }
    for (const b of e.built) {
      if (!a.subscribed.has(b.id)) continue;
      const k = ringKeyStr({ identifier: b.id, ringIndex: b.ri });
      pushTo(stageBuilds, k, { block: n, timeMs: e.t, revision: b.rev });
      stageEvents.push({ chain: "people", block: n, timeMs: e.t, kind: "RingBuilt", identifier: b.id, ringIndex: b.ri, detail: `rev ${b.rev}` });
    }
    for (const id of e.onboard) {
      if (!a.subscribed.has(id)) continue;
      stageEvents.push({ chain: "people", block: n, timeMs: e.t, kind: "Onboarded", identifier: id });
    }
  };
  const mergeAh = (n: number, e: AhExtract) => {
    for (const ev of e.events)
      stageEvents.push({ chain: "assetHub", block: n, timeMs: e.t, kind: ev.k, detail: ev.d });
    for (const u of e.updates)
      pushTo(stageUpdates, ringKeyStr({ identifier: u.id, ringIndex: u.ri }), { block: n, timeMs: e.t, revision: u.rev });
  };

  // ---- Network extractors: read one block's relevant facts (the expensive path). ----
  const fetchPeople = async (n: number): Promise<PeopleExtract | null> => {
    const h = (await pHashes.hashAt(n)) as Hex | null;
    if (!h) return null;
    let recs: RawEvent[];
    try {
      recs = (await people.api.query.System.Events.getValue({ at: h })) as unknown as RawEvent[];
    } catch {
      return null;
    }
    const relevant = recs.filter(
      (r) =>
        r.event.type === "Members" &&
        ["MemberAdded", "RingBuilt", "MembersOnboarded"].includes(r.event.value.type),
    );
    if (relevant.length === 0) return EMPTY_PEOPLE;
    const timeMs = await tsAt(pTs, pHashes, n);
    const added: string[] = [];
    const built: Array<{ id: string; ri: number; rev: number }> = [];
    const onboard: string[] = [];
    for (const r of relevant) {
      const v = r.event.value;
      if (v.type === "MemberAdded") {
        added.push(asHex((v.value as { key: unknown }).key));
      } else if (v.type === "RingBuilt") {
        const o = v.value as { identifier: unknown; ring_index: number };
        let revision = 0;
        try {
          const root = await people.api.query.Members.Root.getValue(o.identifier as never, o.ring_index, { at: h });
          if (root) revision = root.revision;
        } catch {
          /* leave 0 */
        }
        built.push({ id: asHex(o.identifier), ri: o.ring_index, rev: revision });
      } else if (v.type === "MembersOnboarded") {
        onboard.push(asHex((v.value as { identifier: unknown }).identifier));
      }
    }
    return { t: timeMs, added, built, onboard };
  };
  const fetchAh = async (n: number): Promise<AhExtract | null> => {
    const h = (await aHashes.hashAt(n)) as Hex | null;
    if (!h) return null;
    let recs: RawEvent[];
    try {
      recs = (await assetHub.api.query.System.Events.getValue({ at: h })) as unknown as RawEvent[];
    } catch {
      return null;
    }
    const relevant = recs.filter(
      (r) => r.event.type === "MembersSubscriber" && ahKinds.includes(r.event.value.type),
    );
    if (relevant.length === 0) return EMPTY_AH;
    const timeMs = await tsAt(aTs, aHashes, n);
    let ringChanging = false;
    const events: Array<{ k: string; d: string }> = [];
    for (const r of relevant) {
      const v = r.event.value;
      if (v.type === "RingRootsUpdated" || v.type === "RingRootsInitialized") ringChanging = true;
      events.push({ k: v.type, d: detailOf(v.value) });
    }
    const updates: Array<{ id: string; ri: number; rev: number }> = [];
    if (ringChanging) {
      try {
        for (const e of await assetHub.api.query.MembersSubscriber.RingRoots.getEntries({ at: h })) {
          const rev = e.value.reduce((m, rec) => Math.max(m, rec.revision), -1);
          updates.push({ id: e.keyArgs[0].asHex(), ri: e.keyArgs[1], rev });
        }
      } catch {
        /* skip this block's storage read */
      }
    }
    return { t: timeMs, events, updates };
  };

  const hasPeople = (e: PeopleExtract) => e.added.length + e.built.length + e.onboard.length > 0;
  const hasAh = (e: AhExtract) => e.events.length > 0;

  // ---- Preload the cache for the ranges about to be scanned (one read per chain). ----
  const [pCache, aCache] = await Promise.all([
    pBlocks.length ? loadRange(a.pGenesis, "people", pFrom, pTo) : null,
    aBlocks.length ? loadRange(a.aGenesis, "assetHub", aFrom, aTo) : null,
  ]);
  const pWrite = new Map<number, PeopleExtract>();
  const aWrite = new Map<number, AhExtract>();

  const peopleScan = pool(
    pBlocks,
    CONCURRENCY,
    async (n) => {
      let e: PeopleExtract | null;
      if (pCache && coveredBy(pCache.ranges, n)) {
        // Covered already: a stored row, or (no row) a scanned-but-empty block.
        e = (pCache.blocks.get(n) as PeopleExtract | undefined) ?? EMPTY_PEOPLE;
      } else {
        e = await fetchPeople(n);
        if (e && hasPeople(e)) pWrite.set(n, e);
      }
      if (e) mergePeople(n, e);
    },
    () => {
      pDone++;
      report();
    },
    signal,
  );

  const ahScan = pool(
    aBlocks,
    CONCURRENCY,
    async (n) => {
      let e: AhExtract | null;
      if (aCache && coveredBy(aCache.ranges, n)) {
        e = (aCache.blocks.get(n) as AhExtract | undefined) ?? EMPTY_AH;
      } else {
        e = await fetchAh(n);
        if (e && hasAh(e)) aWrite.set(n, e);
      }
      if (e) mergeAh(n, e);
    },
    () => {
      aDone++;
      report();
    },
    signal,
  );

  await Promise.all([peopleScan, ahScan]);

  // ---- Commit the chunk atomically: fold the stage into the accumulator. Reached
  // only if the whole chunk scanned without aborting, so `acc` never holds a
  // half-scanned chunk. ----
  a.events.push(...stageEvents);
  a.registrations.push(...stageRegs);
  for (const [k, recs] of stageBuilds) {
    const arr = a.peopleBuilds.get(k);
    if (arr) arr.push(...recs);
    else a.peopleBuilds.set(k, recs);
  }
  for (const [k, recs] of stageUpdates) {
    const arr = a.ahUpdates.get(k);
    if (arr) arr.push(...recs);
    else a.ahUpdates.set(k, recs);
  }

  // ---- Persist freshly-scanned blocks + extend coverage to the iterated ranges.
  // (Skipped on abort: the throw above bypasses this, so a partial range is never
  // marked covered and will be re-scanned next time.) ----
  await Promise.all([
    pBlocks.length ? saveRange(a.pGenesis, "people", pFrom, pTo, pWrite) : null,
    aBlocks.length ? saveRange(a.aGenesis, "assetHub", aFrom, aTo, aWrite) : null,
  ]);

  // ---- Merge coverage + snapshot the new earliest boundary ----
  // Advance the shared time floor so the next load extends another window below it.
  acc.scanFloorMs = targetMs;
  if (pBlocks.length) {
    acc.pMinScanned = pFrom;
    acc.scannedPeople += pBlocks.length;
    acc.pMinTimeMs = await tsAt(pTs, pHashes, pFrom);
  }
  if (aBlocks.length) {
    acc.aMinScanned = aFrom;
    acc.scannedAh += aBlocks.length;
    acc.aMinTimeMs = await tsAt(aTs, aHashes, aFrom);
  }
  // Rings present on AH just before the (new) earliest scanned block.
  try {
    const before = new Set<string>();
    const h = (await aHashes.hashAt(Math.max(1, acc.aMinScanned - 1))) as Hex | null;
    if (h) {
      for (const e of await assetHub.api.query.MembersSubscriber.RingRoots.getEntries({ at: h }))
        before.add(ringKeyStr({ identifier: e.keyArgs[0].asHex(), ringIndex: e.keyArgs[1] }));
    }
    acc.receivedBeforeWindow = before;
  } catch {
    /* keep previous */
  }

  return acc;
}

/** Sort by block ascending and keep only the points where the revision increases. */
function compress(list: BuildRec[]): BuildRec[] {
  const sorted = [...list].sort((x, y) => x.block - y.block);
  const out: BuildRec[] = [];
  let max = Number.NEGATIVE_INFINITY;
  for (const r of sorted) {
    if (r.revision > max) {
      out.push(r);
      max = r.revision;
    }
  }
  return out;
}

/** Build the renderable result from the accumulated raw data. */
export function deriveHistory(acc: HistoryAcc): HistoryResult {
  // Most recent first.
  const events = [...acc.events].sort(
    (x, y) => (y.timeMs ?? 0) - (x.timeMs ?? 0) || y.block - x.block,
  );

  const ringKeys = new Set<string>([...acc.peopleBuilds.keys(), ...acc.ahUpdates.keys()]);
  const rings: RingLifecycle[] = [];
  for (const k of ringKeys) {
    const [identifier, ringIdxStr] = k.split(":");
    const built = compress(acc.peopleBuilds.get(k) ?? [])[0] ?? null;
    const recv = compress(acc.ahUpdates.get(k) ?? [])[0] ?? null;
    rings.push({
      identifier,
      ringIndex: Number(ringIdxStr),
      builtBlock: built?.block ?? null,
      builtTimeMs: built?.timeMs ?? null,
      receivedBlock: recv?.block ?? null,
      receivedTimeMs: recv?.timeMs ?? null,
      propagationMs:
        built && recv && recv.timeMs !== null && built.timeMs !== null
          ? recv.timeMs - built.timeMs
          : null,
      receivedBeforeWindow: recv === null && acc.receivedBeforeWindow.has(k),
    });
  }
  // Most recently built (or received) ring first.
  const recency = (r: RingLifecycle) => r.builtBlock ?? r.receivedBlock ?? -1;
  rings.sort((x, y) => recency(y) - recency(x) || y.ringIndex - x.ringIndex);

  const registrations: RegistrationDelay[] = acc.registrations.map((reg) => {
    const attr = acc.memberRing.get(reg.key) ?? null;
    const k =
      attr && attr.ringIndex !== null
        ? ringKeyStr({ identifier: attr.identifier, ringIndex: attr.ringIndex })
        : null;
    const builds = k ? compress(acc.peopleBuilds.get(k) ?? []) : [];
    const build = builds.find((b) => b.block >= reg.block) ?? null;
    const ahu = k ? compress(acc.ahUpdates.get(k) ?? []) : [];
    const recv = build ? ahu.find((u) => u.revision >= build.revision) ?? null : null;
    return {
      memberKey: reg.key,
      regBlock: reg.block,
      regTimeMs: reg.timeMs,
      identifier: attr?.identifier ?? null,
      ringIndex: attr?.ringIndex ?? null,
      builtTimeMs: build?.timeMs ?? null,
      builtBlock: build?.block ?? null,
      receivedTimeMs: recv?.timeMs ?? null,
      receivedBlock: recv?.block ?? null,
      onboardMs: build && build.timeMs !== null && reg.timeMs !== null ? build.timeMs - reg.timeMs : null,
      propagationMs:
        recv && build && recv.timeMs !== null && build.timeMs !== null
          ? recv.timeMs - build.timeMs
          : null,
      totalMs: recv && recv.timeMs !== null && reg.timeMs !== null ? recv.timeMs - reg.timeMs : null,
      pending: recv === null,
    };
  });
  // Most recent registration first.
  registrations.sort((x, y) => y.regBlock - x.regBlock);

  const mkWindow = (from: number, head: number, fromMs: number | null, headMs: number | null): ScanWindow => ({
    fromBlock: from,
    fromTimeMs: fromMs,
    headBlock: head,
    headTimeMs: headMs,
  });

  return {
    people: mkWindow(acc.pMinScanned, acc.pHead, acc.pMinTimeMs, acc.pHeadTimeMs),
    assetHub: mkWindow(acc.aMinScanned, acc.aHead, acc.aMinTimeMs, acc.aHeadTimeMs),
    events,
    rings,
    registrations,
    scannedPeople: acc.scannedPeople,
    scannedAh: acc.scannedAh,
    notes: acc.notes,
    inProgress: false,
  };
}

function dedupeNotes(notes: string[]): string[] {
  return [...new Set(notes)];
}

function asHex(v: unknown): string {
  if (v && typeof v === "object" && "asHex" in v && typeof (v as { asHex: unknown }).asHex === "function")
    return (v as { asHex: () => string }).asHex();
  return String(v);
}
function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}
function detailOf(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, x) =>
      typeof x === "bigint"
        ? x.toString()
        : x && typeof x === "object" && "asHex" in (x as object) && typeof (x as { asHex?: unknown }).asHex === "function"
          ? (x as { asHex: () => string }).asHex()
          : x,
    );
  } catch {
    return "";
  }
}
