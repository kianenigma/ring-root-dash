// Tooltip glossary. Rendered as standard HTML `title` attributes in the UI.
// Keep these free of double-quotes and angle brackets so they are safe to embed
// directly inside title="..." attributes.

export const TIPS = {
  // Core concepts
  identifier:
    "Collection identifier — a 32-byte id for a ring-membership collection. Shown as a friendly label (people, people-lite, coinage/recycler #n, …); hover a row's id cell to see the full 0x-hex value.",
  ringIndex:
    "Ring index — a collection is split into fixed-capacity rings; this is the index of one ring within the collection. As the collection grows, new members fill higher ring indices.",
  revision:
    "Revision — a counter incremented every time this ring's root is rebuilt (members added/removed/suspended). Higher means newer. It is monotonic per (collection, ring), which is what lets this tool binary-search history.",
  root:
    "Ring root — the Bandersnatch ring-VRF commitment (a hash) to the set of member public keys in this ring. It is what membership proofs are verified against.",

  // People summary cards
  registeredMembers:
    "Total members currently included in rings across all collections on the People chain (sum of ActiveMembers).",
  collections: "Number of ring-membership collections on this chain.",
  peopleRings:
    "Number of (collection, ring index) entries currently in the People chain's live Root map. Completed rings may rotate out of this map over time.",
  activeMembers: "Members currently included in rings for this collection.",
  currentRingIdx: "The ring index currently being filled with new members for this collection.",
  onboardingSize:
    "Cohort size — members are only onboarded (and the ring then rebuilt + propagated) once at least this many are waiting, unless the batch fills the ring. This protects the anonymity set. 0 or 1 means no gating. This is the LIVE on-chain value from Members.OnboardingSize (what the runtime enforces), not the runtime constant LitePeopleOnboardingSize — it is seeded from that constant at collection creation but can be changed by the set_onboarding_size root call.",
  awaiting:
    "Members waiting to be onboarded = queued (not yet merged into a ring) + merged-but-not-yet-included in the root. If this is below the cohort size, no ring is built and nothing propagates to Asset Hub until more members join (or self_include is used).",
  cohort:
    "Cohort gating status. blocked = members are waiting but fewer than the cohort size, so the ring is NOT rebuilt or propagated (issue #1060). ready = enough to onboard. paused = onboarding halted by in-progress suspensions. This is evaluated in members::should_onboard_members.",

  // Members-notifier (People)
  notifier:
    "Members-notifier (People chain) — buffers ring-root changes and pushes them to subscriber chains (Asset Hub) over XCM, one batch at a time.",
  sealedBatchSeq:
    "Sealed batch sequence — monotonic counter of batches the notifier has sealed. Subscribers compare it to what they have applied to detect missing data.",
  pageState:
    "Pending ring-root updates are buffered in pages. write_page = where new changes are recorded; send_page = the page being distributed. write != send means a page is sealed and ready to send.",
  pendingUpdates:
    "Count of buffered ring-root updates not yet sealed into a batch, per page. Should drain quickly; a growing backlog indicates the notifier is stuck.",
  currentBatch:
    "The batch currently being distributed: sequence, the block it was sealed at, how many subscribers still need it, and how long ago it was sealed. 'none active' means the notifier is idle. A batch that stays here for many minutes is the prime suspect for propagation lag.",
  notifierSubscribers:
    "Parachains subscribed to receive ring-root updates (para id + the batch sequence they were initialized at).",
  gotCurrentBatch:
    "Subscriber para ids that have already received the current batch this distribution cycle.",

  // Members-subscriber (Asset Hub)
  subscription:
    "Whether this chain is subscribed to the notifier, and the batch sequence it was initialized at.",
  ringCollections: "Number of collections this subscriber tracks.",
  ringsStored:
    "Number of (collection, ring index) ring roots stored by the subscriber. It keeps a sliding window of the most recent roots per ring.",
  subscriberProcessing:
    "Members-subscriber (Asset Hub) — receives ring-root batches over XCM and applies them to local storage.",
  lastProcessedSeq:
    "Sequence number of the most recent batch the subscriber successfully applied.",
  lastBatchReceived: "When the subscriber last received a batch from the notifier.",
  lastReplayRequest:
    "When the subscriber last asked the notifier to re-send missing ring roots. Frequent replays indicate roots are being lost or delayed in transit.",
  ringCount: "Number of distinct rings the subscriber has stored for this collection.",
  nextIdx:
    "Upper bound of the ring index space for this collection (highest index seen + 1). Used as the scan range to detect missing rings.",
  missing:
    "Ring indices the subscriber expected but has not received, each with the number of replay requests sent for it. A non-empty list here is a key signal of lag or data loss.",
  deleted:
    "Ring indices known to have been deleted by the notifier, tracked so they are not falsely flagged as missing.",
  srcSeq: "Source sequence — the notifier batch sequence that delivered this root.",
  ahSealed:
    "When the notifier sealed the batch carrying this root, on the People chain (the record's source_time), shown relative to now.",

  // In transit
  inTransit:
    "Compares the current ring revision on People against the highest revision applied on Asset Hub, per ring. Restricted to collections Asset Hub actually subscribes to.",
  peopleRev: "Highest ring-root revision currently on the People chain for this ring.",
  ahRev:
    "Highest ring-root revision applied on Asset Hub for this ring. A dash means Asset Hub has never received this ring.",
  inTransitStatus:
    "in sync = Asset Hub matches People; AH behind by N = Asset Hub is N revisions stale; not on AH = no root received yet for this ring.",

  // History / correlation
  correlation:
    "Reconstructs ring-root propagation over the last 24h, matching each People build / notifier seal to when Asset Hub applied it, per (collection, ring, revision).",
  builtPeople:
    "When this revision's ring root was first built on the People chain (with the block number). A dash means the build was before the 24h window, or the ring rotated out of People's live Root map.",
  sealedNotifier:
    "When the notifier sealed the batch carrying this root (the record's source_time, on the People chain).",
  appliedAh: "When Asset Hub first applied this revision (with the block number).",
  buildToSeal:
    "Time from People building the root to the notifier sealing it into a batch — the People-side OCW + notifier delay.",
  propagation:
    "Headline lag: time from the notifier sealing the batch to Asset Hub applying it — XCM transit plus subscriber processing, including any stuck-batch waits. Flagged red at 2 minutes or more. This is the number issue #1060 is about.",
  total:
    "End-to-end: People build to Asset Hub apply. Only available when the People build falls inside the 24h window.",
  statusFlag:
    "ok = applied within threshold; slow = propagation took 2 minutes or more; pending = built on People but not yet applied on Asset Hub.",
  eventsInWindows:
    "Notifier and subscriber events found by scanning the blocks around each slow/pending propagation — the activity that explains the delay.",

  // History (full scan)
  historyWindow:
    "The scan reads System.Events at every block in the window on both chains, so no event is missed. Window and head are shown as block number + timestamp.",
  lifecycle:
    "Per ring: when it was first built on People vs when it first appeared on Asset Hub, and the propagation delay between them. Rings built before the window started have no People time here.",
  regDelayTable:
    "Every member registration (Members.MemberAdded on People) in the window, with the delay until it is reflected on Asset Hub. This is the headline: a person registered but reported to AH late.",
  regCol: "When the member key was added on People (Members.MemberAdded) — block + timestamp.",
  ringCol:
    "The collection + ring the member ended up in (from current Members storage). 'pending' = not yet onboarded into any ring.",
  builtCol:
    "When the member's ring was (re)built on People at/after their registration — i.e. when their cohort was onboarded.",
  receivedCol: "When that ring build was reflected on Asset Hub (its record reached the built revision).",
  regToOnboard: "register → onboarded: queue wait + cohort gating + OCW build time on People.",
  onboardToAh: "onboarded → Asset Hub: XCM transit + subscriber processing (the propagation hop).",
  endToEnd: "register → reflected on Asset Hub: the full pipeline. Flagged red at 2 minutes or more.",
  timeline:
    "Every relevant event from both chains in time order. People: Registered (MemberAdded), RingBuilt, Onboarded. Asset Hub: RingRootsUpdated/Initialized, MissingRingsDetected, ReplayRequestSent. Labeled by timestamp + block.",
} as const;
