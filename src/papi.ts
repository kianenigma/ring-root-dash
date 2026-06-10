// PAPI client + typed API construction.
//
// Descriptors (`people`, `ah`) are generated from the paseo-next endpoints via
// `pnpm papi:people` / `pnpm papi:ah`. They are reused for the summit preset too,
// which shares the same runtime pallets; if summit metadata ever diverges, storage
// reads are wrapped defensively at the call sites so a decode failure degrades
// gracefully instead of crashing the page.

import { ah, people } from "@polkadot-api/descriptors";
import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import type { Endpoints } from "./config";

function peopleApiOf(client: PolkadotClient) {
  return client.getTypedApi(people);
}
function ahApiOf(client: PolkadotClient) {
  return client.getTypedApi(ah);
}

export type PeopleApi = ReturnType<typeof peopleApiOf>;
export type AhApi = ReturnType<typeof ahApiOf>;

export interface ChainConn<Api> {
  client: PolkadotClient;
  api: Api;
}

export interface Connections {
  people: ChainConn<PeopleApi>;
  assetHub: ChainConn<AhApi>;
}

export function connect(endpoints: Endpoints): Connections {
  const peopleClient = createClient(getWsProvider(endpoints.people));
  const ahClient = createClient(getWsProvider(endpoints.assetHub));
  return {
    people: { client: peopleClient, api: peopleApiOf(peopleClient) },
    assetHub: { client: ahClient, api: ahApiOf(ahClient) },
  };
}

export function disconnect(conns: Connections): void {
  conns.people.client.destroy();
  conns.assetHub.client.destroy();
}
