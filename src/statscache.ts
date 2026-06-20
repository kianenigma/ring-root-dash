// IndexedDB cache for the summit Stats page.
//
// Mirrors the design of cache.ts (per-block extracts + merged coverage ranges,
// scoped by chain genesis), but in a SEPARATE database so the stats scan and the
// ring-root History scan never interfere — and so bumping one schema can't wipe
// the other. Two kinds of cached data:
//
//   - event counts per block: a sparse `c: {metricKey -> count}` row, only for
//     blocks that had at least one counted event. A covered block with no row =
//     "scanned, nothing relevant" (so empty blocks are skipped on re-scan too).
//   - storage samples: the value of a storage-snapshot metric (CASH holders, coin
//     holders) at a specific block — keyed by (metric, block) since these are
//     sampled at chosen heights rather than over contiguous ranges.
//
// Every operation degrades to a miss on any error, exactly like cache.ts.

import type { Chain } from "./domain";
import { addRange, type Range } from "./cache";

/** Bump when the stored per-block shape OR what we extract into it changes — the old
 *  cache is dropped on next open so stale blocks (missing newly-added keys) can't be
 *  replayed out of sync with freshly-scanned ones.
 *  v2: added recycler inflow/outflow aggregates (load/unload count + CASH) to the
 *      per-block counts, incl. the plural multi-recycler unload variants. */
export const STATS_SCHEMA_VERSION = 2;

const DB_NAME = "summit-stats-cache";
const BLOCKS = "blocks";
const COVER = "coverage";
const SAMPLES = "samples";

/** Per-block event counts: timestamp + nonzero counts keyed by metric id. */
export interface StatsExtract {
  t: number | null;
  c: Record<string, number>;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, STATS_SCHEMA_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore(BLOCKS, { keyPath: ["g", "c", "b"] });
      db.createObjectStore(COVER, { keyPath: ["g", "c"] });
      db.createObjectStore(SAMPLES, { keyPath: ["g", "c", "m", "b"] });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

interface CoverRow {
  g: string;
  c: Chain;
  ranges: Range[];
}

export interface LoadedStats {
  ranges: Range[];
  blocks: Map<number, StatsExtract>;
}
const EMPTY: LoadedStats = { ranges: [], blocks: new Map() };

/** Read coverage + cached event-count rows for [from,to]. Never throws. */
export async function loadStatsRange(
  genesis: string | null,
  chain: Chain,
  from: number,
  to: number,
): Promise<LoadedStats> {
  const db = await getDb();
  if (!db || !genesis) return EMPTY;
  try {
    const tx = db.transaction([BLOCKS, COVER], "readonly");
    const cover = (await reqP(tx.objectStore(COVER).get([genesis, chain]))) as CoverRow | undefined;
    const range = IDBKeyRange.bound([genesis, chain, from], [genesis, chain, to]);
    const rows = (await reqP(tx.objectStore(BLOCKS).getAll(range))) as Array<{ b: number; v: StatsExtract }>;
    const blocks = new Map<number, StatsExtract>();
    for (const r of rows) blocks.set(r.b, r.v);
    return { ranges: cover?.ranges ?? [], blocks };
  } catch {
    return EMPTY;
  }
}

/** Persist freshly-scanned event-count rows and extend coverage to [from,to]. Never throws. */
export async function saveStatsRange(
  genesis: string | null,
  chain: Chain,
  from: number,
  to: number,
  blocks: Map<number, StatsExtract>,
): Promise<void> {
  const db = await getDb();
  if (!db || !genesis) return;
  try {
    const tx = db.transaction([BLOCKS, COVER], "readwrite");
    const bs = tx.objectStore(BLOCKS);
    for (const [b, v] of blocks) bs.put({ g: genesis, c: chain, b, v });
    const cs = tx.objectStore(COVER);
    const cur = (await reqP(cs.get([genesis, chain]))) as CoverRow | undefined;
    cs.put({ g: genesis, c: chain, ranges: addRange(cur?.ranges ?? [], from, to) });
    await txDone(tx);
  } catch {
    // a cache write failure must not affect the scan
  }
}

/** Read all cached storage samples for one (genesis, chain, metric). Never throws. */
export async function loadSamples(
  genesis: string | null,
  chain: Chain,
  metric: string,
): Promise<Map<number, { t: number | null; v: number }>> {
  const out = new Map<number, { t: number | null; v: number }>();
  const db = await getDb();
  if (!db || !genesis) return out;
  try {
    const tx = db.transaction([SAMPLES], "readonly");
    const range = IDBKeyRange.bound([genesis, chain, metric, 0], [genesis, chain, metric, Number.MAX_SAFE_INTEGER]);
    const rows = (await reqP(tx.objectStore(SAMPLES).getAll(range))) as Array<{ b: number; t: number | null; v: number }>;
    for (const r of rows) out.set(r.b, { t: r.t, v: r.v });
    return out;
  } catch {
    return out;
  }
}

/** Persist storage samples for one (genesis, chain, metric). Never throws. */
export async function saveSamples(
  genesis: string | null,
  chain: Chain,
  metric: string,
  samples: Map<number, { t: number | null; v: number }>,
): Promise<void> {
  const db = await getDb();
  if (!db || !genesis) return;
  try {
    const tx = db.transaction([SAMPLES], "readwrite");
    const st = tx.objectStore(SAMPLES);
    for (const [b, { t, v }] of samples) st.put({ g: genesis, c: chain, m: metric, b, t, v });
    await txDone(tx);
  } catch {
    // ignore
  }
}

/** Delete the entire stats cache database. Never throws. */
export async function clearStatsCache(): Promise<void> {
  const db = await getDb();
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  dbPromise = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    let req: IDBRequest;
    try {
      req = indexedDB.deleteDatabase(DB_NAME);
    } catch {
      return resolve();
    }
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    (req as IDBOpenDBRequest).onblocked = () => resolve();
  });
}
