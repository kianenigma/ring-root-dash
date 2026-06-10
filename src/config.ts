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
    name: "paseo-next",
    people: "wss://paseo-people-next-system-rpc.polkadot.io",
    assetHub: "wss://paseo-asset-hub-next-rpc.polkadot.io",
  },
  {
    name: "summit",
    people: "wss://summit-people-rpc.polkadot.io",
    assetHub: "wss://summit-asset-hub-rpc.polkadot.io",
  },
];

/** Deep link to the PAPI dev console (dev.papi.how) connected to a given endpoint.
 *  Format: https://dev.papi.how/explorer#networkId=<id>&endpoint=<url-encoded-wss>
 *  networkId is just a label; the endpoint is what the console connects to. */
export function papiConsoleUrl(endpoint: string): string {
  let networkId = "custom";
  try {
    const host = new URL(endpoint).host; // e.g. paseo-people-next-rpc.polkadot.io
    networkId = host.split(".")[0].replace(/-rpc$/, "").replace(/-/g, "_") || "custom";
  } catch {
    // leave default networkId
  }
  return `https://dev.papi.how/explorer#networkId=${networkId}&endpoint=${encodeURIComponent(endpoint)}`;
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
