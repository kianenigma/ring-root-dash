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

  // Setup page
  setupChecklist:
    "One row per initial-setup script (individuality/scripts/initial-setup). Status reflects whether the storage that script writes exists on chain right now; the values column shows what was actually found.",
  setupStatus:
    "ok = the storage the script writes is present and matches the expected setup values. partial = present but differs from the scripted values. missing = not found. n/a = needs the relay chain or per-network account addresses, so it cannot be verified from a People + Asset Hub connection.",
  setupScript: "Script number(s) in scripts/initial-setup, e.g. 03a = 03a-setup-xtrnl-ah.sh.",
  setupValues: "The live on-chain values backing this step (amounts use token decimals).",
  setupOkCard: "Steps whose on-chain state is present and matches the scripted setup values.",
  setupWarnCard: "Steps whose on-chain state exists but differs from the scripted values (or is incomplete).",
  setupBadCard: "Steps whose on-chain state was not found — the script likely has not run on this network.",
  setupNaCard:
    "Steps that cannot be verified from here: relay-chain storage (HRMP) or balances of per-network accounts the dashboard does not know.",
  setupPeopleCollection:
    "People.PeopleCollectionCreated / PeopleLite.LitePeopleCollectionCreated — set once by create_people_collection (script 08).",
  setupCoinage:
    "Coinage.UnderlyingAssetId — the asset coinage coins are denominated in; script 03f points it at the XTRNL foreign asset (asset id 50000413).",
  setupXtrnlAlias:
    "Asset 50000413's symbol has been renamed over time (older networks show it as CASH; the setup scripts now call it XTRNL). Same asset either way — an older symbol counts as a match here.",
  setupForeignAssets:
    "Assets on the People chain are keyed by XCM location (foreign assets). Scripts 03d/04b create XTRNL, USDT and USDC pointing at the Asset Hub assets pallet.",
  setupLocation:
    "XCM location of the asset: ../ = up one level (the relay), Para(n) = sibling parachain, Pallet(n) = pallet instance, Index(n) = pallet-assets asset id.",
  setupRates:
    "AssetRate.ConversionRateToNative — fixed-point (1e18) rate from one asset unit to native planck; used to charge fees in the asset. Script 03e sets 1 XTRNL = 0.25 PAS.",
  setupRawRate: "FixedU128 value: native planck per smallest asset unit, scaled by 1e18.",
  setupChunks:
    "ChunksManager.Chunks — pages of Bandersnatch SRS chunks per ring-proof size, uploaded by script 07. The local setup uploads 3 pages for R2e9 and 5 pages for R2e10.",
  setupChunkPages: "page-index:chunk-count for every uploaded page of this proof size.",
  setupFamilies:
    "ProofOfInk.DesignFamilies — tattoo design families addable as proof-of-ink commitments. Script 11 loads 38 families from poi-design-families.json.",
  setupInvites:
    "ProofOfInk.AvailableInvites / Game.AvailableInvites — invite budgets per account. Script 12a grants 1,000,000 of each to the attestation account.",
  setupAllowances:
    "Attestation allowances: how many attestations an account may still perform (PeopleLite on People, DotnsGateway on Asset Hub). Script 12b sets 1,000,000.",
  setupProxies:
    "Proxy.Proxies — proxy delegations. Scripts 02 (sudo proxy on People) and 12c (attestation proxy on both chains) each add an Any proxy. Accounts are per-network.",
  setupProxyDeposit: "Reserved deposit (in native token) held for the delegator's proxy entries.",
  setupAliasFee:
    "AliasAccounts.AliasFee — fee (planck) charged for claiming an account alias. Script 06c sets 1000.",
  setupDispatcher:
    "DotnsGateway.DispatcherAddress — the 20-byte (Ethereum-style) address allowed to dispatch DotNS calls. Script 13 sets it; config-local.env ships a 0xdeadbeef… placeholder.",
  setupAhAssets:
    "The four assets the setup scripts create on Asset Hub: XTRNL (03a — asset 50000413; networks set up before its rename may show an older symbol like CASH), USDT + USDC (04a) and PGAS (06a), with supply, holder counts and metadata.",
  setupPools:
    "AssetConversion.Pools — each pool pairs two XCM locations (one side is usually native PAS). Scripts 03b, 04a and 06b create the XTRNL, USDT/USDC and PGAS pools and add liquidity.",
  setupLpToken: "Pool-assets id of the LP token minted for liquidity providers of this pool.",
  setupCurrentGame:
    "Game.Game — the game currently in progress (if any) with its phase deadlines. Cleared when the game completes.",
  setupGameIndex: "Index of the current game. GameIndex is the monotonic counter of games started.",
  setupGameState:
    "Current phase of the game state machine: Registration, Shuffle (4 steps), Reporting, PlayerProcess or Cancelling.",
  setupParticipants: "Game.GameParticipantCount for the current game index.",
  setupPhaseDurations:
    "Game.StoredPhaseDurations — how long each game phase lasts (seconds), driving the deadlines of every scheduled game.",
  setupPlayDeposit: "Game.PlayDepositAmount — deposit reserved from each player when joining.",
  setupGameSchedules:
    "Game.GameSchedules — upcoming (and past, until pruned) games by play time. A schedule may carry an airdrop prize that funds an Airdrop event for the game's participants.",
  setupPlayTime: "Unix time the game is scheduled to be played, with relative time.",
  setupGamePrize:
    "Optional airdrop attached to the scheduled game: prize asset + amount, max winners, and per-winner cap.",
  setupAirdrops:
    "Airdrop.Events — every airdrop event with its lifecycle status (Scheduled → Registering → DrawWinners → Claiming → cleanup) and its prize/timing parameters.",
  setupAirdropStatus:
    "Lifecycle status; the numbers show progress, e.g. registered participants, drawn winners, claims so far.",
  setupSupportedAssets:
    "Airdrop.SupportedAssets — assets enabled for airdrop prizes and how much funding has been verified for each.",
  setupActionSchedule:
    "Airdrop.ActionSchedule — when the offchain worker will next act on each event (advance registration, draw winners, finish claiming…).",
} as const;
