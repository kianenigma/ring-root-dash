// IndexedDB cache of scanned blocks.
//
// The History scan reads System.Events (plus a few storage items) at every block
// on both chains. That is the expensive part. This module memoizes the *parsed
// contribution* of each block so a later scan over an overlapping range — even in
// a new session — replays from disk instead of re-querying the chain.
//
// What's stored, per (genesis, chain, block):
//   - a sparse `blocks` row with the extracted facts, only for blocks that had any
//     relevant event (most blocks have none, so most produce no row);
//   - a `coverage` row per (genesis, chain): the merged set of block ranges we have
//     fully scanned, so empty blocks are skipped too (a covered block with no row =
//     "scanned, nothing relevant").
//
// Scoping: keyed by each chain's genesis hash, so the same chain shares a cache
// across different RPC URLs and one network's data is never served for another.
//
// Invalidation: the IndexedDB version IS the SCHEMA_VERSION. Bumping it fires
// onupgradeneeded, which drops and recreates the stores — a clean wipe, no
// migrations. Every cache operation is also wrapped so a corrupt/blocked/absent
// store degrades to a miss and never breaks scanning.

import type { Chain } from "./domain";

/** Bump this whenever the stored shape (PeopleExtract/AhExtract) or what we extract
 *  changes. The old cache is dropped automatically on the next open.
 *  v2: added coinage recycler facts (recLoads/recUnloads/recBuilt) to PeopleExtract. */
export const SCHEMA_VERSION = 2;

const DB_NAME = "ring-root-cache";
const BLOCKS = "blocks";
const COVER = "coverage";

/** Parsed People-block facts (raw — subscription/attribution filtering is applied
 *  at merge time against current state, so cached facts stay correct over time). */
export interface PeopleExtract {
  /** Block timestamp (ms), or null if not read (empty blocks). */
  t: number | null;
  /** MemberAdded ring-VRF keys (0x-hex). */
  added: string[];
  /** RingBuilt: collection id, ring index, and the revision read at this block. */
  built: Array<{ id: string; ri: number; rev: number }>;
  /** MembersOnboarded collection ids. */
  onboard: string[];
  /** Coinage recycler loads: coin values loaded into a recycler this block (each
   *  entry = one coin removed from its owner → balance temporarily unavailable). */
  recLoads?: number[];
  /** Coinage recycler unloads: { v: coin value, c: aliases unloaded (coins freed) }. */
  recUnloads?: Array<{ v: number; c: number }>;
  /** RingBuilt for recycler collections: { v: coin value, ri: ring index, rev }. */
  recBuilt?: Array<{ v: number; ri: number; rev: number }>;
}

/** Parsed Asset-Hub-block facts. */
export interface AhExtract {
  t: number | null;
  /** MembersSubscriber events: kind + detail string. */
  events: Array<{ k: string; d: string }>;
  /** RingRoots snapshot (per ring, max revision) — populated on ring-changing blocks. */
  updates: Array<{ id: string; ri: number; rev: number }>;
}

export type Range = [number, number];

// ---------- range helpers ----------

/** Merge [from,to] into a sorted, non-overlapping range set (adjacent ranges fuse). */
export function addRange(ranges: Range[], from: number, to: number): Range[] {
  const all: Range[] = [...ranges, [from, to] as Range].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [f, t] of all) {
    const last = out[out.length - 1];
    if (last && f <= last[1] + 1) last[1] = Math.max(last[1], t);
    else out.push([f, t]);
  }
  return out;
}

export function coveredBy(ranges: Range[], b: number): boolean {
  for (const [f, t] of ranges) if (b >= f && b <= t) return true;
  return false;
}

function countCovered(ranges: Range[]): number {
  return ranges.reduce((s, [f, t]) => s + (t - f + 1), 0);
}

// ---------- IndexedDB plumbing ----------

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

/** Open (and memoize) the cache DB. Resolves null if IndexedDB is unavailable or
 *  the open fails — callers then operate without a cache. */
function getDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // No migrations: wipe and recreate on any version change.
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore(BLOCKS, { keyPath: ["g", "c", "b"] });
      db.createObjectStore(COVER, { keyPath: ["g", "c"] });
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades/deletes the DB, release our handle so we don't block it.
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

export interface LoadedRange {
  ranges: Range[];
  blocks: Map<number, PeopleExtract | AhExtract>;
}

const EMPTY_LOADED: LoadedRange = { ranges: [], blocks: new Map() };

/** Read coverage + any cached block rows for [from,to]. Never throws. */
export async function loadRange(
  genesis: string | null,
  chain: Chain,
  from: number,
  to: number,
): Promise<LoadedRange> {
  const db = await getDb();
  if (!db || !genesis) return EMPTY_LOADED;
  try {
    const tx = db.transaction([BLOCKS, COVER], "readonly");
    const cover = (await reqP(tx.objectStore(COVER).get([genesis, chain]))) as CoverRow | undefined;
    const range = IDBKeyRange.bound([genesis, chain, from], [genesis, chain, to]);
    const rows = (await reqP(tx.objectStore(BLOCKS).getAll(range))) as Array<{
      b: number;
      v: PeopleExtract | AhExtract;
    }>;
    const blocks = new Map<number, PeopleExtract | AhExtract>();
    for (const r of rows) blocks.set(r.b, r.v);
    return { ranges: cover?.ranges ?? [], blocks };
  } catch {
    return EMPTY_LOADED;
  }
}

/** Read just the coverage ranges for one (genesis, chain). Never throws. */
export async function loadCoverage(genesis: string | null, chain: Chain): Promise<Range[]> {
  const db = await getDb();
  if (!db || !genesis) return [];
  try {
    const tx = db.transaction([COVER], "readonly");
    const cover = (await reqP(tx.objectStore(COVER).get([genesis, chain]))) as CoverRow | undefined;
    return cover?.ranges ?? [];
  } catch {
    return [];
  }
}

/** Persist freshly-scanned block rows and extend coverage to [from,to]. Never throws. */
export async function saveRange(
  genesis: string | null,
  chain: Chain,
  from: number,
  to: number,
  blocks: Map<number, PeopleExtract | AhExtract>,
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
    // A cache write failure must not affect the scan.
  }
}

export interface CacheStats {
  /** Whether IndexedDB is usable at all. */
  available: boolean;
  /** Total covered (cached) blocks across all networks + both chains. */
  blocks: number;
  /** Approximate origin-wide storage usage in bytes (navigator.storage), or null. */
  bytes: number | null;
}

export async function cacheStats(): Promise<CacheStats> {
  const db = await getDb();
  if (!db) return { available: false, blocks: 0, bytes: null };
  let blocks = 0;
  try {
    const tx = db.transaction([COVER], "readonly");
    const all = (await reqP(tx.objectStore(COVER).getAll())) as CoverRow[];
    for (const c of all) blocks += countCovered(c.ranges);
  } catch {
    // leave blocks at 0
  }
  let bytes: number | null = null;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      bytes = est.usage ?? null;
    }
  } catch {
    // leave bytes null
  }
  return { available: true, blocks, bytes };
}

export interface CacheExport {
  schemaVersion: number;
  /** Set by the exporter (ms). Informational only; ignored on import. */
  exportedAt?: number;
  blocks: Array<{ g: string; c: Chain; b: number; v: PeopleExtract | AhExtract }>;
  coverage: CoverRow[];
}

/** Dump the whole cache (all networks) for sharing. Null if unavailable. */
export async function exportCache(): Promise<CacheExport | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const tx = db.transaction([BLOCKS, COVER], "readonly");
    // Both requests issued before awaiting, so the transaction stays active.
    const [blocks, coverage] = await Promise.all([
      reqP(tx.objectStore(BLOCKS).getAll()) as Promise<CacheExport["blocks"]>,
      reqP(tx.objectStore(COVER).getAll()) as Promise<CoverRow[]>,
    ]);
    return { schemaVersion: SCHEMA_VERSION, blocks, coverage };
  } catch {
    return null;
  }
}

export interface ImportResult {
  ok: boolean;
  reason?: string;
  /** Block rows written (merged in). */
  blocksAdded: number;
}

/** Merge an exported cache into the local one. Safe because we only ever cache
 *  finalized (immutable) blocks, so any two caches of the same chain agree. A
 *  schema-version mismatch is rejected (consistent with the no-migration policy). */
export async function importCache(data: unknown): Promise<ImportResult> {
  const d = data as Partial<CacheExport> | null;
  if (!d || typeof d !== "object") return { ok: false, reason: "not a cache file", blocksAdded: 0 };
  if (d.schemaVersion !== SCHEMA_VERSION)
    return {
      ok: false,
      reason: `incompatible schema (file v${d.schemaVersion ?? "?"}, app v${SCHEMA_VERSION})`,
      blocksAdded: 0,
    };
  if (!Array.isArray(d.blocks) || !Array.isArray(d.coverage))
    return { ok: false, reason: "missing blocks/coverage", blocksAdded: 0 };

  const db = await getDb();
  if (!db) return { ok: false, reason: "cache unavailable", blocksAdded: 0 };

  const isChain = (c: unknown): c is Chain => c === "people" || c === "assetHub";
  try {
    const tx = db.transaction([BLOCKS, COVER], "readwrite");
    const bs = tx.objectStore(BLOCKS);
    let added = 0;
    for (const r of d.blocks) {
      if (r && typeof r.g === "string" && isChain(r.c) && typeof r.b === "number" && r.v && typeof r.v === "object") {
        bs.put({ g: r.g, c: r.c, b: r.b, v: r.v });
        added++;
      }
    }
    // Merge coverage: load existing, fold incoming ranges in, write back.
    const cs = tx.objectStore(COVER);
    const existing = (await reqP(cs.getAll())) as CoverRow[];
    const merged = new Map<string, CoverRow>();
    for (const c of existing) merged.set(`${c.g}|${c.c}`, { g: c.g, c: c.c, ranges: c.ranges });
    for (const row of d.coverage) {
      if (!row || typeof row.g !== "string" || !isChain(row.c) || !Array.isArray(row.ranges)) continue;
      const key = `${row.g}|${row.c}`;
      let cur = merged.get(key);
      if (!cur) {
        cur = { g: row.g, c: row.c, ranges: [] };
        merged.set(key, cur);
      }
      for (const rg of row.ranges)
        if (Array.isArray(rg) && typeof rg[0] === "number" && typeof rg[1] === "number")
          cur.ranges = addRange(cur.ranges, rg[0], rg[1]);
    }
    for (const row of merged.values()) cs.put(row);
    await txDone(tx);
    return { ok: true, blocksAdded: added };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, blocksAdded: 0 };
  }
}

/** Delete the entire cache database (all networks). Never throws. */
export async function clearCache(): Promise<void> {
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
