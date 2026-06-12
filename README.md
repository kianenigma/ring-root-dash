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

Auto-runs a **1-hour** scan on connect; you can also load **1h / 6h / 1d**. The page shows
**nothing until the whole window has been scanned on both chains** (no partial results); a
progress indicator shows how far along the scan is, and **Stop** cancels it.

It reconstructs the three-stage pipeline for every member of an **AH-subscribed collection**
(coinage and other never-propagated collections are excluded):

1. **register** — `Members.MemberAdded` on People
2. **ring built** — `Members.RingBuilt` on People (the member's cohort is onboarded)
3. **received** — the ring's record appears/updates on Asset Hub

and shows:

- **Registrations → Asset Hub** — per registration: `reg→onboard` (queue + cohort gating +
  OCW build) and `onboard→AH` (propagation), with the end-to-end total flagged **slow** at
  ≥2 minutes (`SLOW_LAG_MS`). This is the headline: *a person registered but reported to AH
  late*.
- **Ring lifecycle** — per ring: built on People → received on AH + propagation delay.
- **Event timeline** — every relevant event from both chains in time order.

Everything is labeled by both **block number and timestamp**.

### How history is scanned

Accuracy over speed: the scanner reads `System.Events` at **every block** in the window on
both chains (concurrency is only for throughput — no block is skipped, so no event is
missed). Timestamps are read at event blocks, and AH ring receipts are reconstructed by
reading `RingRoots` at each AH update block. These chains are ~2s, so a full day is ~43k
blocks per chain and can take several minutes — use 1h/6h for a quick look, and watch
results stream in.

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
