// Endpoint presets and persistence.
//
// A "network" is a pair of RPC endpoints: the People chain (members pallet +
// members-notifier) and the Asset Hub chain (members-subscriber). The dashboard
// reads ring-root state from both and correlates propagation between them.

export interface Endpoints {
  /** People chain RPC (members + members-notifier). */
  people: string;
  /** Asset Hub chain RPC (members-subscriber). */
  assetHub: string;
}

export interface Preset extends Endpoints {
  name: string;
}

export const PRESETS: Preset[] = [
  {
    name: "summit",
    people: "wss://summit-people-rpc.polkadot.io",
    assetHub: "wss://summit-asset-hub-rpc.polkadot.io",
  },
  {
    name: "paseo-next",
    people: "wss://paseo-people-next-system-rpc.polkadot.io",
    assetHub: "wss://paseo-asset-hub-next-rpc.polkadot.io",
  },
];

/** The summit preset — its presence drives the summit-only Stats page. */
export const SUMMIT_PRESET = PRESETS.find((p) => p.name === "summit")!;

/** True when the connected endpoints are the summit network. Matches either the
 *  exact preset pair or any endpoint whose host mentions "summit", so a custom
 *  summit RPC still unlocks the Stats page. */
export function isSummit(e: Endpoints): boolean {
  if (e.people === SUMMIT_PRESET.people && e.assetHub === SUMMIT_PRESET.assetHub) return true;
  return /summit/i.test(e.people) && /summit/i.test(e.assetHub);
}

/** Start of the summit-stats window: 2026-06-18 09:00 CET (CEST = UTC+2) → 07:00 UTC.
 *  Stats accumulate from here to the chain tip. */
export const STATS_START_MS = Date.UTC(2026, 5, 18, 7, 0, 0);

/** Deep link to the PAPI dev console (dev.papi.how) connected to a given endpoint.
 *  Format: https://dev.papi.how/explorer[/<block>]#networkId=custom&endpoint=<url-encoded-wss>
 *  Pass `block` (number or hash) to deep-link a specific block; omit it for the
 *  console root.
 *
 *  networkId MUST be "custom": the console honors the `endpoint` param only for the
 *  custom network. Any recognizable label (e.g. a derived "paseo_asset_hub_next")
 *  makes the console load its own built-in chain by that id and ignore `endpoint`,
 *  which is how a paseo endpoint ended up showing mainnet Asset Hub. */
export function papiConsoleUrl(endpoint: string, block?: number | string): string {
  const path = block === undefined ? "" : `/${block}`;
  return `https://dev.papi.how/explorer${path}#networkId=custom&endpoint=${encodeURIComponent(endpoint)}`;
}

const STORAGE_KEY = "ring-root-dashboard.endpoints";

export function loadEndpoints(): Endpoints {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Endpoints>;
      if (parsed.people && parsed.assetHub) {
        return { people: parsed.people, assetHub: parsed.assetHub };
      }
    }
  } catch {
    // ignore malformed storage; fall back to default preset
  }
  return { people: PRESETS[0].people, assetHub: PRESETS[0].assetHub };
}

export function saveEndpoints(e: Endpoints): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(e));
}

/** Window of history to scan when the user clicks "Load 1 day", in milliseconds. */
export const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Propagation lag (People build -> AH applied) above which a row is flagged slow. */
export const SLOW_LAG_MS = 2 * 60 * 1000;

/**
 * Safety caps for the historical binary-search scan, so a pathological chain
 * (e.g. a ring rebuilt every block) cannot issue unbounded RPC reads. When a cap
 * is hit the UI reports it explicitly rather than silently truncating.
 */
export const MAX_REVISIONS_PER_RING = 150;
export const MAX_TARGETED_SCAN_BLOCKS = 1200;
