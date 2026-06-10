// Fetch the current (live) state from both chains.

import type { AhApi, ChainConn, PeopleApi } from "./papi";
import type {
  AhCollectionState,
  AhLive,
  AhRing,
  InTransitRow,
  LiveState,
  NotifierState,
  PeopleLive,
  PeopleRing,
} from "./domain";
import { ringKeyStr } from "./domain";

async function chainName(conn: ChainConn<unknown>): Promise<string> {
  try {
    return await conn.client._request<string>("system_chain", []);
  } catch {
    return "unknown";
  }
}

export async function fetchPeopleLive(conn: ChainConn<PeopleApi>): Promise<PeopleLive> {
  const { api } = conn;
  const at = { at: "finalized" } as const;

  const [
    name,
    head,
    activeEntries,
    ringIndexEntries,
    rootEntries,
    onboardingSizeEntries,
    ringStatusEntries,
    ringsStateEntries,
    queueEntries,
    sealedBatchSequence,
    pageState,
    currentBatch,
    subscriberEntries,
    withBatchEntries,
    pageCountEntries,
  ] = await Promise.all([
    chainName(conn),
    conn.client.getFinalizedBlock(),
    api.query.Members.ActiveMembers.getEntries(at),
    api.query.Members.CurrentRingIndex.getEntries(at),
    api.query.Members.Root.getEntries(at),
    api.query.Members.OnboardingSize.getEntries(at),
    api.query.Members.RingKeysStatus.getEntries(at),
    api.query.Members.RingsState.getEntries(at),
    api.query.Members.OnboardingQueue.getEntries(at),
    api.query.MembersNotifier.SealedBatchSequence.getValue(at),
    api.query.MembersNotifier.PageState.getValue(at),
    api.query.MembersNotifier.CurrentBatch.getValue(at),
    api.query.MembersNotifier.Subscribers.getEntries(at),
    api.query.MembersNotifier.SubscribersWithCurrentBatch.getEntries(at),
    api.query.MembersNotifier.PageUpdatesCount.getEntries(at),
  ]);

  const activeByCollection = new Map<string, number>();
  for (const e of activeEntries) activeByCollection.set(e.keyArgs[0].asHex(), e.value);

  const ringIndexByCollection = new Map<string, number>();
  for (const e of ringIndexEntries) ringIndexByCollection.set(e.keyArgs[0].asHex(), e.value);

  const onboardingSizeByCollection = new Map<string, number>();
  for (const e of onboardingSizeEntries) onboardingSizeByCollection.set(e.keyArgs[0].asHex(), e.value);

  // Members merged into a ring but not yet built into its root (the cohort-gated bucket).
  const notIncludedByCollection = new Map<string, number>();
  for (const e of ringStatusEntries) {
    const id = e.keyArgs[0].asHex();
    const pending = Math.max(0, e.value.total - e.value.included);
    notIncludedByCollection.set(id, (notIncludedByCollection.get(id) ?? 0) + pending);
  }

  // Members still in the onboarding queue (not yet merged into a ring).
  const queuedByCollection = new Map<string, number>();
  for (const e of queueEntries) {
    const id = e.keyArgs[0].asHex();
    queuedByCollection.set(id, (queuedByCollection.get(id) ?? 0) + e.value.length);
  }

  const appendOnlyByCollection = new Map<string, boolean>();
  for (const e of ringsStateEntries)
    appendOnlyByCollection.set(e.keyArgs[0].asHex(), e.value.type === "AppendOnly");

  const collectionIds = new Set<string>([
    ...activeByCollection.keys(),
    ...ringIndexByCollection.keys(),
    ...onboardingSizeByCollection.keys(),
    ...notIncludedByCollection.keys(),
    ...queuedByCollection.keys(),
  ]);
  const collections = [...collectionIds].map((identifier) => ({
    identifier,
    activeMembers: activeByCollection.get(identifier) ?? 0,
    currentRingIndex: ringIndexByCollection.get(identifier) ?? 0,
    onboardingSize: onboardingSizeByCollection.get(identifier) ?? 0,
    queued: queuedByCollection.get(identifier) ?? 0,
    notIncluded: notIncludedByCollection.get(identifier) ?? 0,
    appendOnly: appendOnlyByCollection.get(identifier) ?? true,
  }));
  const totalActiveMembers = collections.reduce((a, c) => a + c.activeMembers, 0);

  const rings: PeopleRing[] = rootEntries
    .map((e) => ({
      identifier: e.keyArgs[0].asHex(),
      ringIndex: e.keyArgs[1],
      root: e.value.root.asHex(),
      revision: e.value.revision,
    }))
    .sort((a, b) =>
      a.identifier === b.identifier
        ? a.ringIndex - b.ringIndex
        : a.identifier.localeCompare(b.identifier),
    );

  const notifier: NotifierState = {
    sealedBatchSequence,
    writePage: pageState.write_page,
    sendPage: pageState.send_page,
    lastUpdateBlock: pageState.last_update_block,
    currentBatch: currentBatch
      ? {
          sequence: currentBatch.sequence,
          sourceTimeS: currentBatch.source_time,
          sealedAt: currentBatch.sealed_at,
          remainingSubscribers: currentBatch.remaining_subscribers,
        }
      : null,
    subscribers: subscriberEntries
      .map((e) => ({ paraId: e.keyArgs[0], lastInitSequence: e.value.last_init_sequence }))
      .sort((a, b) => a.paraId - b.paraId),
    subscribersWithCurrentBatch: withBatchEntries.map((e) => e.keyArgs[0]).sort((a, b) => a - b),
    pendingUpdatesPerPage: pageCountEntries
      .map((e) => ({ page: e.keyArgs[0], count: e.value }))
      .filter((p) => p.count > 0)
      .sort((a, b) => a.page - b.page),
  };

  return { chainName: name, finalized: head.number, totalActiveMembers, collections, rings, notifier };
}

export async function fetchAhLive(conn: ChainConn<AhApi>): Promise<AhLive> {
  const { api } = conn;
  const at = { at: "finalized" } as const;

  const [name, head, subscription, processing, stateEntries, ringEntries] = await Promise.all([
    chainName(conn),
    conn.client.getFinalizedBlock(),
    api.query.MembersSubscriber.Subscription.getValue(at),
    api.query.MembersSubscriber.ProcessingState.getValue(at),
    api.query.MembersSubscriber.RingCollectionStates.getEntries(at),
    api.query.MembersSubscriber.RingRoots.getEntries(at),
  ]);

  const subscriptionStr =
    subscription.type === "Active"
      ? `Active (init seq ${subscription.value.initialized_at_sequence})`
      : subscription.type;

  const collections: AhCollectionState[] = stateEntries
    .map((e) => ({
      identifier: e.keyArgs[0].asHex(),
      ringCount: e.value.ring_count,
      nextRingIndex: e.value.next_ring_index,
      missingIndices: e.value.missing_indices.map(([index, attempts]) => ({ index, attempts })),
      deletedIndices: [...e.value.deleted_indices],
    }))
    .sort((a, b) => a.identifier.localeCompare(b.identifier));

  const rings: AhRing[] = ringEntries
    .map((e) => ({
      identifier: e.keyArgs[0].asHex(),
      ringIndex: e.keyArgs[1],
      records: e.value.map((r) => ({
        root: r.root.asHex(),
        revision: r.revision,
        sourceTimeS: r.source_time,
        sourceSequence: r.source_sequence,
      })),
    }))
    .sort((a, b) =>
      a.identifier === b.identifier
        ? a.ringIndex - b.ringIndex
        : a.identifier.localeCompare(b.identifier),
    );

  return {
    chainName: name,
    finalized: head.number,
    subscription: subscriptionStr,
    processing: {
      lastProcessedSequence: processing.last_processed_sequence,
      lastBatchReceivedTimeS: processing.last_batch_received_time,
      lastReplayRequestTimeS: processing.last_replay_request_time,
    },
    collections,
    rings,
  };
}

export async function fetchLiveState(
  people: ChainConn<PeopleApi>,
  assetHub: ChainConn<AhApi>,
): Promise<LiveState> {
  const [p, a] = await Promise.all([fetchPeopleLive(people), fetchAhLive(assetHub)]);
  return { people: p, assetHub: a, fetchedAt: Date.now() };
}

/** Compare People's current ring revisions against AH's highest applied revision.
 *  Restricted to collections AH actually subscribes to — other People collections
 *  (e.g. coinage/recycler) are not meant to propagate and would only add noise. */
export function computeInTransit(live: LiveState): InTransitRow[] {
  const subscribedCollections = new Set<string>([
    ...live.assetHub.collections.map((c) => c.identifier),
    ...live.assetHub.rings.map((r) => r.identifier),
  ]);

  const ahHighest = new Map<string, number>();
  for (const r of live.assetHub.rings) {
    const hi = r.records.reduce((m, rec) => Math.max(m, rec.revision), -1);
    ahHighest.set(ringKeyStr(r), hi);
  }

  return live.people.rings
    .filter((pr) => subscribedCollections.has(pr.identifier))
    .map((pr) => {
      const key = ringKeyStr(pr);
      const ahRev = ahHighest.has(key) ? (ahHighest.get(key) as number) : null;
      const behindBy = ahRev === null ? pr.revision + 1 : pr.revision - ahRev;
      return {
        identifier: pr.identifier,
        ringIndex: pr.ringIndex,
        peopleRevision: pr.revision,
        ahRevision: ahRev,
        behindBy,
      };
    })
    .sort((a, b) => b.behindBy - a.behindBy);
}
