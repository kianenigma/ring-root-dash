# Ring Root Propagation Dashboard

A **read-only** dashboard for inspecting and debugging how member **ring roots** propagate
from the **People** chain (members pallet + members-notifier) to the **Asset Hub** chain
(members-subscriber). Built to investigate
[paritytech/individuality#1060](https://github.com/paritytech/individuality/issues/1060)
("intermittent ring root propagation lag from People to AH").

It never signs or submits transactions — it only reads storage and events over RPC. It has
three pages: **Live**, **History** and **Setup**.

## Live page

Always live — subscribes to each chain's finalized-block stream and re-reads storage on
every new finalized block; there is no manual refresh.

- **People** — registered members (sum of `ActiveMembers`), per-collection ring indices,
  **cohort/onboarding state** (cohort size, members awaiting onboarding, and a banner when
  members are stuck below the cohort size), current ring roots + revisions, and the full
  members-notifier state: `SealedBatchSequence`, `PageState`, pending updates per page, the
  active `CurrentBatch`, subscribers, and which already received the current batch.
- **Asset Hub** — subscription status, subscriber `ProcessingState`, per-collection
  `RingCollectionStates` (ring count, next index, **missing indices** + replay attempts,
  deleted indices), and the latest received ring root per ring with its `source_time`.
- **In transit** — People's current ring revisions vs Asset Hub's highest applied
  revision, per ring (restricted to collections AH actually subscribes to).

## History page

On connect it shows **max(last 1 hour, whatever is already cached)** — i.e. it scans back to
the earliest block still in the local cache (per chain), or the last hour if that's larger,
so a prior session's data reappears instantly and only the recent gap is fetched. You can
then load **+1m / +10m / +1h / +6h / +1d / +1w** more, each extending further into the past
**from the earliest block currently shown** (re-using the cache, fetching only what's
missing). Loads larger than **10 minutes** are scanned in **10-minute chunks and rendered
progressively** — results (and the cache) update after each chunk instead of waiting for the
whole window, so a `+1w` fills in as it goes. Each chunk is committed atomically, so **Stop**
(or a failure) keeps every fully-scanned chunk and discards only the one in flight. A
progress indicator shows the current chunk and block position. (`+1w` is hundreds of
thousands of blocks per chain and can take a long while — but you see data the whole time.)

It reconstructs the three-stage pipeline for every member of an **AH-subscribed collection**
(coinage and other never-propagated collections are excluded):

1. **register** — `Members.MemberAdded` on People
2. **ring built** — `Members.RingBuilt` on People (the member's cohort is onboarded)
3. **received** — the ring's record appears/updates on Asset Hub

and shows:

- **Propagation times over scanned window** (chart, top of page) — a [Chart.js](https://www.chartjs.org/)
  line chart, one point per registration at its register time, with three series: `reg→onboard`,
  `onboard→AH`, and `total` (durations). A dashed marker shows the `SLOW_LAG_MS` threshold; the
  axis always includes it so it stays visible. It's an **overview, not an exact plot** —
  overlapping points (same spot on a coarse grid) are dropped, so a week of data stays light.
  **Scroll to zoom, drag to pan** (both axes, via
  [`chartjs-plugin-zoom`](https://github.com/chartjs/chartjs-plugin-zoom)); **reset zoom** refits,
  and **⤢ full screen** opens it in a whole-screen modal (Esc to close). Extends as you load more
  history.
- **Registrations → Asset Hub** — per registration: `reg→onboard` (queue + cohort gating +
  OCW build) and `onboard→AH` (propagation), with the end-to-end total flagged **slow** at
  ≥2 minutes (`SLOW_LAG_MS`). This is the headline: *a person registered but reported to AH
  late*.
- **Ring lifecycle** — per ring: built on People → received on AH + propagation delay.
- **Event timeline** — every relevant event from both chains in time order.

Everything is labeled by both **block number and timestamp**; every block number deep-links
into the PAPI explorer for the right chain. Each of the three tables has a **⤓ CSV** button
(links stripped, full values kept) and a frozen header row while scrolling.

### How history is scanned

Accuracy over speed: the scanner reads `System.Events` at **every block** in the window on
both chains (concurrency is only for throughput — no block is skipped, so no event is
missed). Timestamps are read at event blocks, and AH ring receipts are reconstructed by
reading `RingRoots` at each AH update block.

Windows are **timestamp-based, not block-count-based**. People and Asset Hub run at
different block rates, so a fixed block count per chain would drift their scanned time-spans
apart — and a People build whose Asset Hub receipt fell in the un-scanned gap would show a
permanent false "pending". Instead each load picks one shared wall-clock floor (`previous
floor − window`) and binary-searches *each* chain for the first block at/after it, so both
chains always cover the exact same time span (the faster chain simply scrapes more blocks).
Because the full result is **re-derived from the entire accumulated dataset on every load**
(not per-increment), a later load that fills in the Asset Hub side automatically upgrades an
earlier "pending" to "received". A full day is tens of thousands of blocks per chain and can
take several minutes — use 1h/6h for a quick look, and watch results stream in.

### Local block cache

Scanned blocks are cached in the browser's **IndexedDB** so an overlapping range — even in a
later session — replays from disk instead of re-querying the chain. For each block the cache
stores only the *parsed contribution* (relevant events + the ring revisions read at it);
blocks with nothing relevant store no row but are still recorded as scanned (via a coverage
range), so empty blocks are skipped too. Filtering/attribution is re-applied from current
state on replay, so cached facts stay correct even if subscriptions or membership change.

- **Scope** — keyed by each chain's **genesis hash**, so one network's data is never served
  for another, and the same chain shares its cache across different RPC URLs.
- **Coverage** — `+1d`/`+1w` scan the same ranges as before; they just skip the network read
  for any already-cached block. Aborting a scan leaves its range *uncached* (re-scanned next
  time), never partially marked.
- **Stats + Clear** — the History toolbar shows the cached block count and an approximate
  (origin-wide) size, with a **Clear cache** button that deletes the whole database.
- **Export / Import** — **Export** downloads the whole cache (all networks) as a JSON file
  to share; **Import** merges a file back in. Merging is always safe because only finalized
  (immutable) blocks are cached, so two caches of the same chain can only agree — coverage
  ranges are unioned and block rows are put by `[genesis, chain, block]`. A file from a
  different `SCHEMA_VERSION` (or non-cache JSON) is rejected rather than misread.
- **Invalidation** — the store is versioned by a `SCHEMA_VERSION`; bumping it (e.g. when we
  start extracting new data) drops and recreates the database automatically — no migrations.
  Any read/write error degrades to a cache miss and never breaks scanning.

## Setup page

Verifies the on-chain state written by individuality's
[`scripts/initial-setup`](https://github.com/paritytech/individuality/tree/master/scripts/initial-setup)
against the connected network — e.g. point it at the summit endpoints and see at a glance
which setup steps have run and with what values. One snapshot is taken on connect (manual
**Refresh** to re-read).

- **Checklist** — one row per setup script (02 sudo proxy, 03 XTRNL asset/pool/rate/coinage,
  04 USDT+USDC, 05 faucet funding, 06 PGAS + alias fee, 07 ZK chunks, 08 people collection,
  09 onboarding sizes, 10 ring-root subscription, 11 design families, 12 attestation
  invites/allowances/proxies, 13 DotNS dispatcher) with status — **ok** (present, matches
  the scripted values), **partial** (present but differs), **missing**, or **n/a** (needs
  the relay chain or per-network account addresses) — and the actual values found on chain.
- **People / Asset Hub detail panels** — the full values behind each check: foreign assets
  with metadata + supply, AssetRate conversion rates, ZK chunk pages, onboarding sizes,
  notifier subscribers, the 38 PoI design families, invites, attestation allowances,
  proxies; on AH: the four setup assets, AssetConversion pools, alias fee, DotNS dispatcher
  + allowances.
- **Games & airdrops** — the current game (phase + deadlines + participants), stored phase
  durations + play deposit, scheduled games (`Game.GameSchedules`, with attached airdrop
  prizes), every airdrop event (`Airdrop.Events`) with lifecycle status, timings and prize,
  supported airdrop assets + funding, and the OCW action schedule.

Expected values (asset ids, supplies, invite counts, …) are taken from
`scripts/initial-setup/config-base.env` and surfaced as tooltips/comparisons; anything that
differs is shown with the live value rather than hidden.

## Networks

Two presets (editable in the UI; the last endpoints are saved to `localStorage`):

| Preset       | People                                       | Asset Hub                                       |
| ------------ | -------------------------------------------- | ----------------------------------------------- |
| `paseo-next` | `wss://paseo-people-next-system-rpc.polkadot.io` | `wss://paseo-asset-hub-next-rpc.polkadot.io` |
| `summit`     | `wss://summit-people-rpc.polkadot.io`        | `wss://summit-asset-hub-rpc.polkadot.io`        |

PAPI descriptors are generated from the paseo-next endpoints and reused for summit (same
runtime pallets). All storage reads are wrapped defensively, so if summit metadata ever
diverges a decode failure degrades gracefully instead of crashing the page.

## Develop / build

```bash
pnpm install          # also runs `papi` to wire up generated descriptors
pnpm dev              # local dev server
pnpm build            # static bundle in dist/ (deploy this anywhere static)
pnpm typecheck
```

To regenerate the typed descriptors (e.g. after a runtime upgrade):

```bash
pnpm papi:people      # papi add people -w wss://paseo-people-next-rpc.polkadot.io
pnpm papi:ah          # papi add ah     -w wss://paseo-asset-hub-next-rpc.polkadot.io
```

Built with [polkadot-api (PAPI)](https://papi.how) and Vite. Type-safe end to end.

## Deploy

Every push to `main` is built and published to GitHub Pages by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The live site is at
<https://kianenigma.github.io/ring-root-dash/>.

One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
The build is fully offline — `pnpm install` regenerates the PAPI descriptors from the
committed `.papi/metadata/*.scale` files, so no RPC access is needed in CI.
