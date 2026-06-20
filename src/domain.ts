// Shared domain types for live state and historical correlation.

/** A single ring within a collection, identified by collection id + ring index. */
export interface RingKey {
  /** Collection identifier, as 0x-hex of the 32-byte id. */
  identifier: string;
  ringIndex: number;
}

export function ringKeyStr(k: RingKey): string {
  return `${k.identifier}:${k.ringIndex}`;
}

// ---------------- Live (current) state ----------------

export interface PeopleRing extends RingKey {
  /** Current root commitment hex on the People chain. */
  root: string;
  revision: number;
}

export interface NotifierState {
  sealedBatchSequence: bigint;
  writePage: number;
  sendPage: number;
  lastUpdateBlock: number;
  /** Active batch being distributed, or null. */
  currentBatch:
    | {
        sequence: bigint;
        sourceTimeS: bigint;
        sealedAt: number;
        remainingSubscribers: number;
      }
    | null;
  subscribers: Array<{ paraId: number; lastInitSequence: bigint }>;
  /** Para ids that already received the current batch. */
  subscribersWithCurrentBatch: number[];
  /** write-page -> pending update count. */
  pendingUpdatesPerPage: Array<{ page: number; count: number }>;
}

export interface PeopleCollection {
  identifier: string;
  activeMembers: number;
  currentRingIndex: number;
  /** Cohort size: members are only onboarded (and the ring rebuilt) once at least
   *  this many are waiting — unless the batch fills the ring. 0/1 = no gating. */
  onboardingSize: number;
  /** Members added but not yet merged into a ring (sitting in the onboarding queue). */
  queued: number;
  /** Members merged into a ring but not yet included in its root (cohort-gated). */
  notIncluded: number;
  /** AppendOnly = accepting onboarding; otherwise mutating (suspensions in progress). */
  appendOnly: boolean;
}

export interface PeopleLive {
  chainName: string;
  finalized: number;
  /** Sum of ActiveMembers across all collections. */
  totalActiveMembers: number;
  collections: PeopleCollection[];
  rings: PeopleRing[];
  notifier: NotifierState;
}

/** Cohort onboarding status for a collection (the people-lite #1060 case). */
export type CohortStatus =
  | { kind: "none" } // nothing waiting
  | { kind: "ready"; waiting: number; size: number } // cohort met, will onboard
  | { kind: "blocked"; waiting: number; size: number } // waiting < cohort, stuck
  | { kind: "paused" }; // not append-only (suspensions)

export function cohortStatus(c: PeopleCollection): CohortStatus {
  const waiting = c.queued + c.notIncluded;
  if (!c.appendOnly) return waiting > 0 ? { kind: "paused" } : { kind: "none" };
  if (waiting === 0) return { kind: "none" };
  if (c.onboardingSize > 1 && waiting < c.onboardingSize)
    return { kind: "blocked", waiting, size: c.onboardingSize };
  return { kind: "ready", waiting, size: c.onboardingSize };
}

export interface AhRingRecord {
  root: string;
  revision: number;
  sourceTimeS: bigint;
  sourceSequence: bigint;
}

export interface AhRing extends RingKey {
  /** Sliding window of recent records; last element is the newest. */
  records: AhRingRecord[];
}

export interface AhCollectionState {
  identifier: string;
  ringCount: number;
  nextRingIndex: number;
  missingIndices: Array<{ index: number; attempts: number }>;
  deletedIndices: number[];
}

export interface AhLive {
  chainName: string;
  finalized: number;
  subscription: string;
  processing: {
    lastProcessedSequence: bigint;
    lastBatchReceivedTimeS: bigint;
    lastReplayRequestTimeS: bigint;
  };
  collections: AhCollectionState[];
  rings: AhRing[];
}

export interface LiveState {
  people: PeopleLive;
  assetHub: AhLive;
  fetchedAt: number;
}

// ---------------- In transit ----------------

export interface InTransitRow extends RingKey {
  peopleRevision: number;
  /** Highest revision applied on AH, or null if the ring is unknown to AH. */
  ahRevision: number | null;
  /** peopleRevision - ahRevision (0 = in sync, >0 = AH lagging). */
  behindBy: number;
}

// ---------------- History (full event scan) ----------------

export type Chain = "people" | "assetHub";

/** One on-chain event found during the scan, labeled by block + timestamp. */
export interface TimedEvent {
  chain: Chain;
  block: number;
  timeMs: number | null;
  /** Short kind, e.g. "Registered", "RingBuilt", "Onboarded", "RingRootsUpdated". */
  kind: string;
  /** Collection identifier (0x-hex) if the event carries one. */
  identifier?: string;
  ringIndex?: number;
  /** Free-form extra detail (member key, sequence, count, …). */
  detail?: string;
}

/** Lifecycle of a single ring: built on People → received on Asset Hub. */
export interface RingLifecycle extends RingKey {
  builtBlock: number | null;
  builtTimeMs: number | null;
  receivedBlock: number | null;
  receivedTimeMs: number | null;
  /** receivedTime − builtTime (propagation People→AH). */
  propagationMs: number | null;
  /** Received before the scan window started (so propagation can't be measured). */
  receivedBeforeWindow: boolean;
}

/** End-to-end delay for a single registration: register → onboarded(ring built) → received on AH. */
export interface RegistrationDelay {
  /** Member ring-VRF key (0x-hex). */
  memberKey: string;
  regBlock: number;
  regTimeMs: number | null;
  /** Collection + ring the member ended up in (from current Members storage). */
  identifier: string | null;
  ringIndex: number | null;
  /** When that ring was (first) built on People. */
  builtTimeMs: number | null;
  builtBlock: number | null;
  /** When that ring was received on AH. */
  receivedTimeMs: number | null;
  receivedBlock: number | null;
  /** builtTime − regTime: queue + cohort-gating + OCW build delay. */
  onboardMs: number | null;
  /** receivedTime − builtTime: propagation delay. */
  propagationMs: number | null;
  /** receivedTime − regTime: end-to-end. */
  totalMs: number | null;
  /** Member not yet onboarded into a ring, or its ring not yet on AH. */
  pending: boolean;
}

export interface ScanWindow {
  fromBlock: number;
  fromTimeMs: number | null;
  headBlock: number;
  headTimeMs: number | null;
}

// ---------------- Coinage recycler lifecycle ----------------
// Coins at MaximumAge must be loaded into a per-value recycler ring (a Members
// collection), which is (re)built before the owner can unload a fresh coin. While
// loaded, the coin is removed from its owner — the "balance unavailable" window.

/** A single recycler ring (re)build, by coin value + ring index. */
export interface RecyclerRingBuild {
  /** Coin denomination (signed exponent) the recycler is for. */
  value: number;
  ringIndex: number;
  revision: number;
  builtBlock: number;
  builtTimeMs: number | null;
}

/** One load paired to the recycler ring build that next made it unloadable. */
export interface RecyclerLockSample {
  value: number;
  loadBlock: number;
  loadTimeMs: number | null;
  builtBlock: number | null;
  builtTimeMs: number | null;
  /** builtTime − loadTime: how long the coin was locked before becoming unloadable. */
  lockMs: number | null;
  /** No recycler ring build seen after this load yet (still locked). */
  pending: boolean;
}

/** Per-coin-value recycler activity over the scanned window. */
export interface RecyclerValueSummary {
  value: number;
  /** Coins loaded (each = one balance made temporarily unavailable). */
  loads: number;
  /** Coins freed by unloads (sum of unloaded alias counts). */
  unloadedCoins: number;
  /** Recycler ring (re)builds. */
  builds: number;
  /** loads − unloadedCoins within the window (≥0): coins still locked. */
  outstanding: number;
  firstLoadTimeMs: number | null;
  lastLoadTimeMs: number | null;
  lastBuiltTimeMs: number | null;
  /** Max / avg lock window (load → next ring build) observed. */
  maxLockMs: number | null;
  avgLockMs: number | null;
  /** Loads with no subsequent recycler ring build yet (stuck/locked). */
  pendingLoads: number;
}

export interface RecyclingResult {
  byValue: RecyclerValueSummary[];
  builds: RecyclerRingBuild[];
  lockSamples: RecyclerLockSample[];
  totalLoads: number;
  totalUnloadedCoins: number;
  totalOutstanding: number;
}

export interface HistoryResult {
  people: ScanWindow;
  assetHub: ScanWindow;
  events: TimedEvent[];
  rings: RingLifecycle[];
  registrations: RegistrationDelay[];
  /** Coinage recycler lifecycle (load → ring built → unload). */
  recycling: RecyclingResult;
  /** Blocks actually scanned (coverage), reported rather than silently truncated. */
  scannedPeople: number;
  scannedAh: number;
  notes: string[];
  /** True while the scan is still running (progressive results). */
  inProgress: boolean;
}
