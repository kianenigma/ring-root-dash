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

import { HISTORY_WINDOW_MS } from "./config";
import { HashCache } from "./chainio";
import type {
  HistoryResult,
  RegistrationDelay,
  RingLifecycle,
  ScanWindow,
  TimedEvent,
} from "./domain";
import { ringKeyStr } from "./domain";
import type { AhApi, ChainConn, PeopleApi } from "./papi";

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
  pBlockMs: number;
  aBlockMs: number;
  /** Earliest scanned block (inclusive); next load goes below this. */
  pMinScanned: number;
  aMinScanned: number;
  pMinTimeMs: number | null;
  aMinTimeMs: number | null;
  scannedPeople: number;
  scannedAh: number;
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

async function blockTimeMs(
  read: (h: Hex) => Promise<bigint>,
  hashes: HashCache,
  head: number,
): Promise<number> {
  const sample = Math.min(500, Math.max(1, head - 1));
  const [a, b] = await Promise.all([tsAt(read, hashes, head), tsAt(read, hashes, head - sample)]);
  return a && b && a > b ? (a - b) / sample : 6000;
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
    const [pBlockMs, aBlockMs, pHeadTimeMs, aHeadTimeMs] = await Promise.all([
      blockTimeMs(pTs, pHashes, pHead.number),
      blockTimeMs(aTs, aHashes, aHead.number),
      tsAt(pTs, pHashes, pHead.number),
      tsAt(aTs, aHashes, aHead.number),
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
      pBlockMs,
      aBlockMs,
      pMinScanned: pHead.number + 1, // nothing scanned yet
      aMinScanned: aHead.number + 1,
      pMinTimeMs: pHeadTimeMs,
      aMinTimeMs: aHeadTimeMs,
      scannedPeople: 0,
      scannedAh: 0,
    };
  }

  // ---- Determine the block range for this scan ----
  const pTo = acc.pMinScanned - 1; // one below the earliest already scanned (or head on first load)
  const aTo = acc.aMinScanned - 1;
  const pFrom = Math.max(1, pTo - Math.floor(windowMs / acc.pBlockMs) + 1);
  const aFrom = Math.max(1, aTo - Math.floor(windowMs / acc.aBlockMs) + 1);
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
  let pDone = 0;
  let aDone = 0;
  const totalBlocks = pBlocks.length + aBlocks.length;
  const report = () => {
    if ((pDone + aDone) % 50 === 0)
      onProgress({
        phase: "Scanning People + AH blocks",
        done: pDone + aDone,
        total: totalBlocks,
        events: a.events.length,
      });
  };

  const peopleScan = pool(
    pBlocks,
    CONCURRENCY,
    async (n) => {
      const h = (await pHashes.hashAt(n)) as Hex | null;
      if (!h) return;
      let recs: RawEvent[];
      try {
        recs = (await people.api.query.System.Events.getValue({ at: h })) as unknown as RawEvent[];
      } catch {
        return;
      }
      const relevant = recs.filter(
        (r) =>
          r.event.type === "Members" &&
          ["MemberAdded", "RingBuilt", "MembersOnboarded"].includes(r.event.value.type),
      );
      if (relevant.length === 0) return;
      const timeMs = await tsAt(pTs, pHashes, n);
      for (const r of relevant) {
        const v = r.event.value;
        if (v.type === "MemberAdded") {
          const key = asHex((v.value as { key: unknown }).key);
          const attr = a.memberRing.get(key);
          if (!attr || !a.subscribed.has(attr.identifier)) continue;
          a.registrations.push({ key, block: n, timeMs });
          a.events.push({
            chain: "people",
            block: n,
            timeMs,
            kind: "Registered",
            identifier: attr.identifier,
            detail: short(key),
          });
        } else if (v.type === "RingBuilt") {
          const o = v.value as { identifier: unknown; ring_index: number };
          const identifier = asHex(o.identifier);
          if (!a.subscribed.has(identifier)) continue;
          const ringIndex = o.ring_index;
          let revision = 0;
          try {
            const root = await people.api.query.Members.Root.getValue(o.identifier as never, ringIndex, {
              at: h,
            });
            if (root) revision = root.revision;
          } catch {
            /* leave 0 */
          }
          const k = ringKeyStr({ identifier, ringIndex });
          if (!a.peopleBuilds.has(k)) a.peopleBuilds.set(k, []);
          a.peopleBuilds.get(k)!.push({ block: n, timeMs, revision });
          a.events.push({ chain: "people", block: n, timeMs, kind: "RingBuilt", identifier, ringIndex, detail: `rev ${revision}` });
        } else if (v.type === "MembersOnboarded") {
          const identifier = asHex((v.value as { identifier: unknown }).identifier);
          if (!a.subscribed.has(identifier)) continue;
          a.events.push({ chain: "people", block: n, timeMs, kind: "Onboarded", identifier });
        }
      }
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
      const h = (await aHashes.hashAt(n)) as Hex | null;
      if (!h) return;
      let recs: RawEvent[];
      try {
        recs = (await assetHub.api.query.System.Events.getValue({ at: h })) as unknown as RawEvent[];
      } catch {
        return;
      }
      const relevant = recs.filter(
        (r) => r.event.type === "MembersSubscriber" && ahKinds.includes(r.event.value.type),
      );
      if (relevant.length === 0) return;
      const timeMs = await tsAt(aTs, aHashes, n);
      let ringChanging = false;
      for (const r of relevant) {
        const v = r.event.value;
        if (v.type === "RingRootsUpdated" || v.type === "RingRootsInitialized") ringChanging = true;
        a.events.push({ chain: "assetHub", block: n, timeMs, kind: v.type, detail: detailOf(v.value) });
      }
      if (ringChanging) {
        try {
          for (const e of await assetHub.api.query.MembersSubscriber.RingRoots.getEntries({ at: h })) {
            const k = ringKeyStr({ identifier: e.keyArgs[0].asHex(), ringIndex: e.keyArgs[1] });
            const rev = e.value.reduce((m, rec) => Math.max(m, rec.revision), -1);
            if (!a.ahUpdates.has(k)) a.ahUpdates.set(k, []);
            a.ahUpdates.get(k)!.push({ block: n, timeMs, revision: rev });
          }
        } catch {
          /* skip this block's storage read */
        }
      }
    },
    () => {
      aDone++;
      report();
    },
    signal,
  );

  await Promise.all([peopleScan, ahScan]);

  // ---- Merge coverage + snapshot the new earliest boundary ----
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
