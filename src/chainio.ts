// Low-level block helpers: hash-by-number (cached), finalized head, and a
// generic binary search over a monotonic-per-block integer metric.
//
// These let the history scanner locate the exact block where a ring revision
// landed without scanning every block — relying on `revision` being monotonic
// non-decreasing per (identifier, ring_index) on both chains.

import type { PolkadotClient } from "polkadot-api";

export interface FinalizedHead {
  hash: string;
  number: number;
}

export async function finalizedHead(client: PolkadotClient): Promise<FinalizedHead> {
  const b = await client.getFinalizedBlock();
  return { hash: b.hash, number: b.number };
}

/** Cache of block-number -> block-hash to avoid repeat RPC during binary search. */
export class HashCache {
  private cache = new Map<number, Promise<string | null>>();
  constructor(private client: PolkadotClient) {}

  hashAt(n: number): Promise<string | null> {
    let p = this.cache.get(n);
    if (!p) {
      p = this.client
        ._request<string | null>("chain_getBlockHash", [n])
        .catch(() => null);
      this.cache.set(n, p);
    }
    return p;
  }
}

/**
 * Find the smallest block number in [lo, hi] whose metric is >= target.
 * Assumes `metric` is monotonic non-decreasing in the block number.
 * Returns `hi + 1`-style sentinel via `null` if no block in range reaches target.
 *
 * `metric(n)` should return the integer metric at block n (e.g. a ring's
 * revision), or -Infinity when the entry is absent at that block.
 */
export async function firstBlockAtLeast(
  lo: number,
  hi: number,
  target: number,
  metric: (n: number) => Promise<number>,
): Promise<number | null> {
  if (await metric(hi) < target) return null;
  let result = hi;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await metric(mid) >= target) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}
