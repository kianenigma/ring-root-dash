// Setup verification: read the on-chain state produced by the initial-setup
// scripts (individuality/scripts/initial-setup) and derive a per-script checklist.
//
// Each script step maps to storage that should exist after it has run. Every
// read is wrapped defensively — a network whose runtime lacks a pallet (or whose
// metadata diverges from the generated descriptors) degrades to a note instead
// of failing the whole page. Steps that touch the relay chain (HRMP channels)
// or rely on per-network account addresses (funding, swaps) cannot be verified
// from a People + Asset Hub connection alone and are reported as "n/a".

import { fmtUnits, shortHex } from "./format";
import type { AhApi, ChainConn, Connections, PeopleApi } from "./papi";

// ---------- Expected values (from scripts/initial-setup/config-*.env) ----------

export const EXPECTED = {
  /** b"pop:polkadot.network/people     " */
  PEOPLE_ID: "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020",
  /** b"pop:polkadot.network/people-lite" */
  PEOPLE_LITE_ID: "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652d6c697465",
  /** 09-override-onboarding-sizes.sh */
  ONBOARDING_SIZE: 1,
  /** 11-setup-poi-design-families.sh (poi-design-families.json has 38 entries) */
  DESIGN_FAMILIES: 38,
  /** 12a-setup-attestation-invites.sh (DIM1_INVITES / DIM2_INVITES) */
  INVITES: 1_000_000,
  /** 12b-setup-attestation-allowances.sh */
  ATTESTATION_ALLOWANCE: 1_000_000,
  /** 06c-setup-alias-fee.sh (PGAS_ALIAS_FEE) */
  ALIAS_FEE: 1000n,
  /** 07-add-zk-chunks.sh uploads this many pages per proof kind. */
  CHUNK_PAGES: { R2e9: 3, R2e10: 5 } as Record<string, number>,
  /** 03a/03c/03d: XTRNL_* env vars. The asset's symbol was renamed over time, so
   *  networks set up before the latest rename still carry an older metadata symbol
   *  (e.g. CASH). All aliases refer to the same asset id and count as a match. */
  XTRNL: {
    id: 50000413,
    symbol: "XTRNL",
    aliases: ["XTRNL", "CASH"],
    decimals: 6,
    supply: 21_000_000_000_000n,
  },
  /** 04a/04b: USDT_* env vars (Paseo Asset Hub well-known id). */
  USDT: { id: 1984, symbol: "USDt", aliases: ["USDT"], decimals: 6, supply: 21_000_000_000_000n },
  /** 04a/04b: USDC_* env vars (Paseo Asset Hub well-known id). */
  USDC: { id: 1337, symbol: "USDC", aliases: ["USDC"], decimals: 6, supply: 21_000_000_000_000n },
  /** 06a-setup-pgas.sh (PGAS_ASSET_ID) */
  PGAS_ID: 2_000_000_000,
  NATIVE_DECIMALS: 10,
  /** 13-setup-dotns-dispatcher-address.sh ships this placeholder in config-local.env. */
  PLACEHOLDER_DISPATCHER: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
};

// ---------- XCM location view ----------

/** A display-oriented view of an XCM location used as an asset id / pool side. */
export interface LocView {
  /** Compact human string, e.g. "../Para(1500)/Pallet(50)/Index(1984)". */
  display: string;
  /** The GeneralIndex junction value (the pallet-assets id), if any. */
  generalIndex: number | null;
  /** parents=1, interior Here — the relay native token (PAS). */
  native: boolean;
}

interface AnyEnum {
  type: string;
  value?: unknown;
}

interface RawLocation {
  parents: number;
  interior: AnyEnum;
}

export function locView(loc: RawLocation): LocView {
  const interior = loc.interior;
  const junctions: AnyEnum[] =
    interior.type === "Here"
      ? []
      : Array.isArray(interior.value)
        ? (interior.value as AnyEnum[])
        : [interior.value as AnyEnum];
  let generalIndex: number | null = null;
  const parts = junctions.map((j) => {
    switch (j.type) {
      case "Parachain":
        return `Para(${j.value})`;
      case "PalletInstance":
        return `Pallet(${j.value})`;
      case "GeneralIndex":
        generalIndex = Number(j.value);
        return `Index(${j.value})`;
      case "AccountId32": {
        const id = (j.value as { id?: { asHex?: () => string } })?.id;
        return `Account(${shortHex(id?.asHex?.() ?? "0x?")})`;
      }
      case "AccountKey20": {
        const key = (j.value as { key?: { asHex?: () => string } })?.key;
        return `Account(${shortHex(key?.asHex?.() ?? "0x?")})`;
      }
      case "GlobalConsensus":
        return `Consensus(${(j.value as AnyEnum)?.type ?? "?"})`;
      default:
        return j.type;
    }
  });
  const display = `${"../".repeat(loc.parents)}${parts.length ? parts.join("/") : "Here"}`;
  return { display, generalIndex, native: loc.parents === 1 && junctions.length === 0 };
}

/** Render nested enum/struct values generically, e.g. a game state or airdrop status. */
export function plainDetail(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v;
  const maybe = v as { asHex?: () => string; type?: string; value?: unknown };
  if (typeof maybe.asHex === "function") return shortHex(maybe.asHex());
  if (typeof maybe.type === "string") {
    const inner = plainDetail(maybe.value);
    return inner ? `${maybe.type}(${inner})` : maybe.type;
  }
  if (Array.isArray(v)) return v.map(plainDetail).join(", ");
  if (typeof v === "object")
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}=${plainDetail(val)}`)
      .join(" ");
  return String(v);
}

// ---------- Domain ----------

export interface ProxyEntry {
  delegator: string;
  deposit: bigint;
  delegates: Array<{ delegate: string; proxyType: string; delay: number }>;
}

export interface ForeignAsset {
  loc: LocView;
  symbol: string;
  name: string;
  decimals: number;
  supply: bigint;
  minBalance: bigint;
  holders: number;
  status: string;
  owner: string;
}

export interface AhAsset {
  id: number;
  /** Which setup asset this slot is for (XTRNL / USDt / USDC / PGAS). */
  label: string;
  found: boolean;
  symbol: string;
  name: string;
  decimals: number;
  supply: bigint;
  minBalance: bigint;
  holders: number;
  status: string;
  owner: string;
}

export interface PoolEntry {
  asset0: LocView;
  asset1: LocView;
  lpToken: number;
}

export interface RateEntry {
  loc: LocView;
  /** AssetRate FixedU128: native planck per asset unit, 1e18 fixed point. */
  rate: bigint;
}

export interface ChunkGroup {
  proofType: string;
  pages: Array<{ page: number; chunks: number }>;
}

export interface SubscriberEntry {
  paraId: number;
  palletIndex: number;
  lastInitSequence: bigint;
  collections: Array<{ identifier: string; format: string }>;
}

export interface DesignFamily {
  index: number;
  kind: string;
  range: number | null;
  id: string;
}

export interface AccountAmount {
  account: string;
  amount: number;
}

export interface PrizeView {
  asset: LocView;
  amount: bigint;
  maxWinners: number;
  winnerCap: number;
}

export interface GameSchedule {
  playTimeS: number;
  rounds: number;
  maxGroupSize: number;
  prize: PrizeView | null;
}

export interface CurrentGame {
  index: number;
  stateType: string;
  stateDetail: string;
  registrationEndsS: number;
  shuffleDeadlineS: number;
  gameDateS: number;
  reportEndsS: number;
  maxGroupSize: number;
  participants: number | null;
}

export interface PhaseDurations {
  registrationS: number;
  shuffleS: number;
  postShuffleMarginS: number;
  reportingS: number;
  playerProcessS: number;
  airdropClaimWindowS: number;
}

export interface AirdropEvent {
  id: string;
  status: string;
  statusDetail: string;
  prize: PrizeView;
  registrationStartsS: number;
  drawTimeS: number;
  endTimeS: number;
}

export interface SupportedAsset {
  asset: LocView;
  funded: bigint;
}

export interface ScheduledAction {
  timeS: number;
  eventId: string;
}

/** People-chain setup state. `null` sections could not be read (see notes). */
export interface PeopleSetup {
  finalized: number;
  proxies: ProxyEntry[] | null;
  foreignAssets: ForeignAsset[] | null;
  rates: RateEntry[] | null;
  /** Coinage underlying asset; null = unset (or unreadable — see notes). */
  coinageUnderlying: LocView | null;
  chunks: ChunkGroup[] | null;
  peopleCollectionCreated: boolean | null;
  liteCollectionCreated: boolean | null;
  onboardingSizes: Array<{ identifier: string; size: number }> | null;
  subscribers: SubscriberEntry[] | null;
  designFamilies: DesignFamily[] | null;
  poiInvites: AccountAmount[] | null;
  gameInvites: AccountAmount[] | null;
  liteAllowances: AccountAmount[] | null;
  schedules: GameSchedule[] | null;
  currentGame: CurrentGame | null;
  gameIndex: number | null;
  phaseDurations: PhaseDurations | null;
  playDeposit: bigint | null;
  airdropEvents: AirdropEvent[] | null;
  supportedAssets: SupportedAsset[] | null;
  actions: ScheduledAction[] | null;
}

/** Asset Hub setup state. `null` sections could not be read (see notes). */
export interface AhSetup {
  finalized: number;
  assets: AhAsset[] | null;
  pools: PoolEntry[] | null;
  aliasFee: bigint | null;
  dispatcher: string | null;
  dotnsAllowances: AccountAmount[] | null;
  proxies: ProxyEntry[] | null;
  subscription: string;
  subscriptionActive: boolean;
}

export interface SetupState {
  fetchedAt: number;
  people: PeopleSetup;
  assetHub: AhSetup;
  /** Per-storage-item read failures (typically a pallet missing on this network). */
  notes: string[];
}

// ---------- Fetch ----------

type Q = <T>(label: string, fn: () => Promise<T>) => Promise<T | null>;

const AT = { at: "finalized" } as const;

function mapProxies(
  entries: Array<{
    keyArgs: [string];
    value: [Array<{ delegate: string; proxy_type: { type: string }; delay: number }>, bigint];
  }>,
): ProxyEntry[] {
  return entries
    .map((e) => ({
      delegator: e.keyArgs[0],
      deposit: e.value[1],
      delegates: e.value[0].map((d) => ({
        delegate: d.delegate,
        proxyType: d.proxy_type.type,
        delay: d.delay,
      })),
    }))
    .sort((a, b) => a.delegator.localeCompare(b.delegator));
}

function mapAmounts(entries: Array<{ keyArgs: [string]; value: number }>): AccountAmount[] {
  return entries
    .map((e) => ({ account: e.keyArgs[0], amount: e.value }))
    .sort((a, b) => b.amount - a.amount);
}

function prizeView(p: {
  asset_id: RawLocation;
  asset_amount: bigint;
  max_winners: number;
  winner_cap: number;
}): PrizeView {
  return {
    asset: locView(p.asset_id),
    amount: p.asset_amount,
    maxWinners: p.max_winners,
    winnerCap: p.winner_cap,
  };
}

async function fetchPeopleSetup(conn: ChainConn<PeopleApi>, q: Q): Promise<PeopleSetup> {
  const { api } = conn;
  const head = await conn.client.getFinalizedBlock();

  const [
    proxiesRaw,
    assetsRaw,
    metaRaw,
    ratesRaw,
    coinageRaw,
    chunksRaw,
    peopleCreated,
    liteCreated,
    onboardingRaw,
    subscribersRaw,
    familiesRaw,
    poiInvitesRaw,
    gameInvitesRaw,
    liteAllowanceRaw,
    schedulesRaw,
    currentGameRaw,
    gameIndex,
    durationsRaw,
    playDeposit,
    airdropsRaw,
    supportedRaw,
    actionsRaw,
  ] = await Promise.all([
    q("People Proxy.Proxies", () => api.query.Proxy.Proxies.getEntries(AT)),
    q("People Assets.Asset", () => api.query.Assets.Asset.getEntries(AT)),
    q("People Assets.Metadata", () => api.query.Assets.Metadata.getEntries(AT)),
    q("People AssetRate.ConversionRateToNative", () =>
      api.query.AssetRate.ConversionRateToNative.getEntries(AT),
    ),
    q("People Coinage.UnderlyingAssetId", () => api.query.Coinage.UnderlyingAssetId.getValue(AT)),
    q("People ChunksManager.Chunks", () => api.query.ChunksManager.Chunks.getEntries(AT)),
    q("People People.PeopleCollectionCreated", () =>
      api.query.People.PeopleCollectionCreated.getValue(AT),
    ),
    q("People PeopleLite.LitePeopleCollectionCreated", () =>
      api.query.PeopleLite.LitePeopleCollectionCreated.getValue(AT),
    ),
    q("People Members.OnboardingSize", () => api.query.Members.OnboardingSize.getEntries(AT)),
    q("People MembersNotifier.Subscribers", () =>
      api.query.MembersNotifier.Subscribers.getEntries(AT),
    ),
    q("People ProofOfInk.DesignFamilies", () => api.query.ProofOfInk.DesignFamilies.getEntries(AT)),
    q("People ProofOfInk.AvailableInvites", () =>
      api.query.ProofOfInk.AvailableInvites.getEntries(AT),
    ),
    q("People Game.AvailableInvites", () => api.query.Game.AvailableInvites.getEntries(AT)),
    q("People PeopleLite.AttestationAllowance", () =>
      api.query.PeopleLite.AttestationAllowance.getEntries(AT),
    ),
    q("People Game.GameSchedules", () => api.query.Game.GameSchedules.getValue(AT)),
    q("People Game.Game", () => api.query.Game.Game.getValue(AT)),
    q("People Game.GameIndex", () => api.query.Game.GameIndex.getValue(AT)),
    q("People Game.StoredPhaseDurations", () => api.query.Game.StoredPhaseDurations.getValue(AT)),
    q("People Game.PlayDepositAmount", () => api.query.Game.PlayDepositAmount.getValue(AT)),
    q("People Airdrop.Events", () => api.query.Airdrop.Events.getEntries(AT)),
    q("People Airdrop.SupportedAssets", () => api.query.Airdrop.SupportedAssets.getEntries(AT)),
    q("People Airdrop.ActionSchedule", () => api.query.Airdrop.ActionSchedule.getEntries(AT)),
  ]);

  // Join asset details with metadata by location display string.
  const metaByLoc = new Map<string, { symbol: string; name: string; decimals: number }>();
  for (const m of metaRaw ?? [])
    metaByLoc.set(locView(m.keyArgs[0]).display, {
      symbol: m.value.symbol.asText(),
      name: m.value.name.asText(),
      decimals: m.value.decimals,
    });
  const foreignAssets = assetsRaw
    ? assetsRaw
        .map((e) => {
          const loc = locView(e.keyArgs[0]);
          const meta = metaByLoc.get(loc.display);
          return {
            loc,
            symbol: meta?.symbol ?? "",
            name: meta?.name ?? "",
            decimals: meta?.decimals ?? 0,
            supply: e.value.supply,
            minBalance: e.value.min_balance,
            holders: e.value.accounts,
            status: e.value.status.type,
            owner: e.value.owner,
          };
        })
        .sort((a, b) => a.loc.display.localeCompare(b.loc.display))
    : null;

  const chunkGroups = new Map<string, Array<{ page: number; chunks: number }>>();
  for (const e of chunksRaw ?? []) {
    const proofType = e.keyArgs[0].type;
    const pages = chunkGroups.get(proofType) ?? [];
    pages.push({ page: e.keyArgs[1], chunks: e.value.length });
    chunkGroups.set(proofType, pages);
  }
  const ringExp = (t: string) => Number(t.replace("R2e", "")) || 0;
  const chunks = chunksRaw
    ? [...chunkGroups.entries()]
        .map(([proofType, pages]) => ({
          proofType,
          pages: pages.sort((a, b) => a.page - b.page),
        }))
        .sort((a, b) => ringExp(a.proofType) - ringExp(b.proofType))
    : null;

  let currentGame: CurrentGame | null = null;
  if (currentGameRaw) {
    const participants = await q("People Game.GameParticipantCount", () =>
      api.query.Game.GameParticipantCount.getValue(currentGameRaw.index, AT),
    );
    currentGame = {
      index: currentGameRaw.index,
      stateType: currentGameRaw.state.type,
      stateDetail: plainDetail(currentGameRaw.state.value),
      registrationEndsS: currentGameRaw.registration_ends,
      shuffleDeadlineS: currentGameRaw.shuffle_deadline,
      gameDateS: currentGameRaw.game_date,
      reportEndsS: currentGameRaw.report_ends,
      maxGroupSize: currentGameRaw.max_group_size,
      participants,
    };
  }

  return {
    finalized: head.number,
    proxies: proxiesRaw ? mapProxies(proxiesRaw) : null,
    foreignAssets,
    rates: ratesRaw
      ? ratesRaw
          .map((e) => ({ loc: locView(e.keyArgs[0]), rate: e.value }))
          .sort((a, b) => a.loc.display.localeCompare(b.loc.display))
      : null,
    coinageUnderlying: coinageRaw ? locView(coinageRaw) : null,
    chunks,
    peopleCollectionCreated: peopleCreated,
    liteCollectionCreated: liteCreated,
    onboardingSizes: onboardingRaw
      ? onboardingRaw
          .map((e) => ({ identifier: e.keyArgs[0].asHex(), size: e.value }))
          .sort((a, b) => a.identifier.localeCompare(b.identifier))
      : null,
    subscribers: subscribersRaw
      ? subscribersRaw
          .map((e) => ({
            paraId: e.keyArgs[0],
            palletIndex: e.value.pallet_index,
            lastInitSequence: e.value.last_init_sequence,
            collections: e.value.collections.map(([id, fmt]) => ({
              identifier: id.asHex(),
              format: fmt.type,
            })),
          }))
          .sort((a, b) => a.paraId - b.paraId)
      : null,
    designFamilies: familiesRaw
      ? familiesRaw
          .map((e) => ({
            index: e.keyArgs[0],
            kind: e.value.kind.type,
            range: e.value.kind.type === "Procedural" ? e.value.kind.value.range : null,
            id: e.value.id.asHex(),
          }))
          .sort((a, b) => a.index - b.index)
      : null,
    poiInvites: poiInvitesRaw ? mapAmounts(poiInvitesRaw) : null,
    gameInvites: gameInvitesRaw ? mapAmounts(gameInvitesRaw) : null,
    liteAllowances: liteAllowanceRaw ? mapAmounts(liteAllowanceRaw) : null,
    schedules: schedulesRaw
      ? schedulesRaw
          .map((s) => ({
            playTimeS: s.game_play_time,
            rounds: s.rounds,
            maxGroupSize: s.max_group_size,
            prize: s.airdrop_prize ? prizeView(s.airdrop_prize) : null,
          }))
          .sort((a, b) => a.playTimeS - b.playTimeS)
      : null,
    currentGame,
    gameIndex,
    phaseDurations: durationsRaw
      ? {
          registrationS: durationsRaw.registration,
          shuffleS: durationsRaw.shuffle,
          postShuffleMarginS: durationsRaw.post_shuffle_margin,
          reportingS: durationsRaw.reporting,
          playerProcessS: durationsRaw.player_process,
          airdropClaimWindowS: durationsRaw.airdrop_claim_window,
        }
      : null,
    playDeposit,
    airdropEvents: airdropsRaw
      ? airdropsRaw
          .map((e) => ({
            id: e.value.id.asHex(),
            status: e.value.status.type,
            statusDetail: plainDetail(e.value.status.value),
            prize: prizeView(e.value.info.prize),
            registrationStartsS: Number(e.value.info.registration_starts),
            drawTimeS: Number(e.value.info.draw_time),
            endTimeS: Number(e.value.info.end_time),
          }))
          .sort((a, b) => a.registrationStartsS - b.registrationStartsS)
      : null,
    supportedAssets: supportedRaw
      ? supportedRaw
          .map((e) => ({ asset: locView(e.keyArgs[0]), funded: e.value }))
          .sort((a, b) => a.asset.display.localeCompare(b.asset.display))
      : null,
    actions: actionsRaw
      ? actionsRaw
          .map((e) => {
            // Key is (BigEndianU64 unix-seconds, event id) under Identity hashers.
            let t = 0n;
            for (const byte of e.keyArgs[0].asBytes()) t = (t << 8n) | BigInt(byte);
            return { timeS: Number(t), eventId: e.keyArgs[1].asHex() };
          })
          .sort((a, b) => a.timeS - b.timeS)
      : null,
  };
}

async function fetchAhSetup(conn: ChainConn<AhApi>, q: Q): Promise<AhSetup> {
  const { api } = conn;
  const head = await conn.client.getFinalizedBlock();

  const KNOWN_ASSETS = [
    { id: EXPECTED.XTRNL.id, label: "XTRNL" },
    { id: EXPECTED.USDT.id, label: "USDt" },
    { id: EXPECTED.USDC.id, label: "USDC" },
    { id: EXPECTED.PGAS_ID, label: "PGAS" },
  ];

  const [assets, poolsRaw, aliasFee, dispatcherRaw, dotnsAllowanceRaw, proxiesRaw, subscriptionRaw] =
    await Promise.all([
      Promise.all(
        KNOWN_ASSETS.map(async ({ id, label }) => {
          const [details, meta] = await Promise.all([
            q(`AH Assets.Asset(${id})`, () => api.query.Assets.Asset.getValue(id, AT)),
            q(`AH Assets.Metadata(${id})`, () => api.query.Assets.Metadata.getValue(id, AT)),
          ]);
          return {
            id,
            label,
            found: !!details,
            symbol: meta?.symbol.asText() ?? "",
            name: meta?.name.asText() ?? "",
            decimals: meta?.decimals ?? 0,
            supply: details?.supply ?? 0n,
            minBalance: details?.min_balance ?? 0n,
            holders: details?.accounts ?? 0,
            status: details?.status.type ?? "",
            owner: details?.owner ?? "",
          };
        }),
      ),
      q("AH AssetConversion.Pools", () => api.query.AssetConversion.Pools.getEntries(AT)),
      q("AH AliasAccounts.AliasFee", () => api.query.AliasAccounts.AliasFee.getValue(AT)),
      q("AH DotnsGateway.DispatcherAddress", () =>
        api.query.DotnsGateway.DispatcherAddress.getValue(AT),
      ),
      q("AH DotnsGateway.AttestationAllowance", () =>
        api.query.DotnsGateway.AttestationAllowance.getEntries(AT),
      ),
      q("AH Proxy.Proxies", () => api.query.Proxy.Proxies.getEntries(AT)),
      q("AH MembersSubscriber.Subscription", () =>
        api.query.MembersSubscriber.Subscription.getValue(AT),
      ),
    ]);

  return {
    finalized: head.number,
    assets,
    pools: poolsRaw
      ? poolsRaw
          .map((e) => ({
            asset0: locView(e.keyArgs[0][0]),
            asset1: locView(e.keyArgs[0][1]),
            lpToken: e.value,
          }))
          .sort((a, b) => a.lpToken - b.lpToken)
      : null,
    aliasFee: aliasFee ?? null,
    dispatcher: dispatcherRaw ? dispatcherRaw.asHex() : null,
    dotnsAllowances: dotnsAllowanceRaw ? mapAmounts(dotnsAllowanceRaw) : null,
    proxies: proxiesRaw ? mapProxies(proxiesRaw) : null,
    subscription: subscriptionRaw
      ? subscriptionRaw.type === "Active"
        ? `Active (init seq ${subscriptionRaw.value.initialized_at_sequence})`
        : subscriptionRaw.type
      : "unknown",
    subscriptionActive: subscriptionRaw?.type === "Active",
  };
}

export async function fetchSetup(conns: Connections): Promise<SetupState> {
  const notes: string[] = [];
  const q: Q = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      notes.push(`${label}: ${(e as Error).message}`);
      return null;
    }
  };
  const [people, assetHub] = await Promise.all([
    fetchPeopleSetup(conns.people, q),
    fetchAhSetup(conns.assetHub, q),
  ]);
  return { fetchedAt: Date.now(), people, assetHub, notes };
}

// ---------- Checklist derivation ----------

export type CheckStatus = "ok" | "warn" | "bad" | "na";

export interface CheckRow {
  /** Script number(s) in scripts/initial-setup, e.g. "03a/c". */
  step: string;
  title: string;
  chain: string;
  status: CheckStatus;
  /** Values found on chain — plain text, escaped by the renderer. */
  values: string;
}

/** "1 XTRNL ≈ 0.25 PAS" from an AssetRate FixedU128 (native planck per asset unit, 1e18 FP). */
function ratePerToken(rate: bigint, assetDecimals: number): number {
  return (Number(rate) / 1e18) * 10 ** assetDecimals * 10 ** -EXPECTED.NATIVE_DECIMALS;
}

interface AssetSpec {
  symbol: string;
  aliases: string[];
}

/** Case-insensitive match against the accepted symbol aliases (the asset was renamed
 *  over time, e.g. CASH → XTRNL, so live metadata may carry an older name). */
function symbolOk(spec: AssetSpec, symbol: string | undefined): boolean {
  return !!symbol && spec.aliases.some((a) => a.toLowerCase() === symbol.toLowerCase());
}

/** " (= XTRNL, renamed)" when the on-chain symbol is an older alias of the asset. */
function aliasNote(spec: AssetSpec, symbol: string): string {
  return symbol.toLowerCase() === spec.symbol.toLowerCase() ? "" : ` (= ${spec.symbol}, renamed)`;
}

export function deriveChecks(s: SetupState): CheckRow[] {
  const p = s.people;
  const a = s.assetHub;
  const rows: CheckRow[] = [];

  const foreign = p.foreignAssets ?? [];
  const foreignByIndex = (idx: number) => foreign.find((f) => f.loc.generalIndex === idx);
  const pools = a.pools ?? [];
  const poolFor = (idx: number) =>
    pools.find(
      (x) =>
        (x.asset0.native && x.asset1.generalIndex === idx) ||
        (x.asset1.native && x.asset0.generalIndex === idx),
    );
  const ahAsset = (id: number) => (a.assets ?? []).find((x) => x.id === id);
  const unreadable = (section: unknown): section is null => section === null;

  // -- Steps that need the relay chain or per-network accounts --
  rows.push({
    step: "00/01a/01d",
    title: "Tooling + account funding (relay, People, AH)",
    chain: "—",
    status: "na",
    values:
      "Account addresses are per-network (config-local.env only covers local dev) — balances not checkable from here.",
  });
  rows.push({
    step: "01b/01c",
    title: "HRMP channels People↔AH, People↔Bulletin",
    chain: "Relay",
    status: "na",
    values: "Lives in relay Hrmp.HrmpChannels storage; this dashboard has no relay connection.",
  });

  // -- 02: sudo proxy on People --
  {
    const n = p.proxies?.length ?? 0;
    const delegations = (p.proxies ?? []).reduce((acc, x) => acc + x.delegates.length, 0);
    rows.push({
      step: "02",
      title: "Sudo proxy registered (Proxy.add_proxy)",
      chain: "People",
      status: unreadable(p.proxies) ? "na" : n > 0 ? "ok" : "bad",
      values: unreadable(p.proxies)
        ? "Proxy.Proxies unreadable (see notes)."
        : `${n} delegator(s), ${delegations} delegation(s) — see Proxies table.`,
    });
  }

  // -- 03a/03c: XTRNL on AH --
  {
    const x = ahAsset(EXPECTED.XTRNL.id);
    const metaOk = symbolOk(EXPECTED.XTRNL, x?.symbol) && x?.decimals === EXPECTED.XTRNL.decimals;
    rows.push({
      step: "03a/c",
      title: `XTRNL asset (${EXPECTED.XTRNL.id}) created + metadata`,
      chain: "Asset Hub",
      status: !x?.found ? "bad" : metaOk ? "ok" : "warn",
      values: x?.found
        ? `supply ${fmtUnits(x.supply, x.decimals)} ${x.symbol || "?"}${aliasNote(EXPECTED.XTRNL, x.symbol)} · decimals ${x.decimals} · ${x.holders} holder(s) · status ${x.status}${metaOk ? "" : ` · expected symbol ${EXPECTED.XTRNL.aliases.join("/")} with ${EXPECTED.XTRNL.decimals}dec`}`
        : "asset not found",
    });
  }

  // -- 03b: XTRNL/PAS pool --
  {
    const pool = poolFor(EXPECTED.XTRNL.id);
    rows.push({
      step: "03b",
      title: "PAS/XTRNL conversion pool + liquidity",
      chain: "Asset Hub",
      status: unreadable(a.pools) ? "na" : pool ? "ok" : "bad",
      values: pool
        ? `pool exists · LP token id ${pool.lpToken}`
        : unreadable(a.pools)
          ? "AssetConversion.Pools unreadable (see notes)."
          : "no PAS/XTRNL pool found",
    });
  }

  // -- 03d: XTRNL foreign asset on People --
  {
    const x = foreignByIndex(EXPECTED.XTRNL.id);
    rows.push({
      step: "03d",
      title: "XTRNL foreign asset + metadata",
      chain: "People",
      status: unreadable(p.foreignAssets)
        ? "na"
        : x
          ? symbolOk(EXPECTED.XTRNL, x.symbol)
            ? "ok"
            : "warn"
          : "bad",
      values: x
        ? `${x.loc.display} · ${x.symbol}${aliasNote(EXPECTED.XTRNL, x.symbol)}/${x.decimals}dec · supply on People ${fmtUnits(x.supply, x.decimals)}`
        : unreadable(p.foreignAssets)
          ? "Assets.Asset unreadable (see notes)."
          : "no foreign asset with GeneralIndex " + EXPECTED.XTRNL.id,
    });
  }

  // -- 03e: XTRNL conversion rate on People --
  {
    const x = foreignByIndex(EXPECTED.XTRNL.id);
    const r = (p.rates ?? []).find((e) => e.loc.generalIndex === EXPECTED.XTRNL.id);
    rows.push({
      step: "03e",
      title: "XTRNL → native conversion rate (AssetRate)",
      chain: "People",
      status: unreadable(p.rates) ? "na" : r ? "ok" : "bad",
      values: r
        ? `1 ${x?.symbol || "XTRNL"} ≈ ${ratePerToken(r.rate, x?.decimals ?? EXPECTED.XTRNL.decimals)} PAS (raw ${r.rate})`
        : unreadable(p.rates)
          ? "AssetRate unreadable (see notes)."
          : "no rate set for the XTRNL location",
    });
  }

  // -- 03f: coinage underlying asset --
  {
    const u = p.coinageUnderlying;
    rows.push({
      step: "03f",
      title: "Coinage underlying asset = XTRNL",
      chain: "People",
      status: !u ? "bad" : u.generalIndex === EXPECTED.XTRNL.id ? "ok" : "warn",
      values: u
        ? `${u.display}${u.generalIndex === EXPECTED.XTRNL.id ? "" : ` · expected GeneralIndex ${EXPECTED.XTRNL.id}`}`
        : "not set (or unreadable — see notes)",
    });
  }

  // -- 04a: USDT + USDC on AH (asset + metadata + pool) --
  {
    const parts = [EXPECTED.USDT, EXPECTED.USDC].map((spec) => {
      const x = ahAsset(spec.id);
      const pool = poolFor(spec.id);
      const okOne = !!x?.found && symbolOk(spec, x.symbol) && !!pool;
      const text = x?.found
        ? `${spec.symbol}(${spec.id}): supply ${fmtUnits(x.supply, x.decimals)} · ${x.holders} holder(s) · pool ${pool ? `LP ${pool.lpToken}` : "MISSING"}`
        : `${spec.symbol}(${spec.id}): asset not found`;
      return { okOne, someOne: !!x?.found, text };
    });
    rows.push({
      step: "04a",
      title: "USDT + USDC assets, metadata + pools",
      chain: "Asset Hub",
      status: parts.every((x) => x.okOne) ? "ok" : parts.some((x) => x.someOne) ? "warn" : "bad",
      values: parts.map((x) => x.text).join(" · "),
    });
  }

  // -- 04b: USDT + USDC foreign assets on People --
  {
    const parts = [EXPECTED.USDT, EXPECTED.USDC].map((spec) => {
      const x = foreignByIndex(spec.id);
      return {
        okOne: !!x && symbolOk(spec, x.symbol),
        someOne: !!x,
        text: x
          ? `${x.symbol}/${x.decimals}dec at ${x.loc.display}`
          : `GeneralIndex ${spec.id} not found`,
      };
    });
    rows.push({
      step: "04b",
      title: "USDT + USDC foreign assets + metadata",
      chain: "People",
      status: unreadable(p.foreignAssets)
        ? "na"
        : parts.every((x) => x.okOne)
          ? "ok"
          : parts.some((x) => x.someOne)
            ? "warn"
            : "bad",
      values: unreadable(p.foreignAssets)
        ? "Assets.Asset unreadable (see notes)."
        : parts.map((x) => x.text).join(" · "),
    });
  }

  // -- 05a/05c: stablecoin swaps into named accounts (not checkable without account list) --
  {
    const usdt = ahAsset(EXPECTED.USDT.id);
    const usdc = ahAsset(EXPECTED.USDC.id);
    rows.push({
      step: "05a/c",
      title: "Asset-owner + faucet stablecoin balances",
      chain: "Asset Hub",
      status: "na",
      values: `Per-network accounts unknown; holder counts as a hint: USDt ${usdt?.holders ?? "?"}, USDC ${usdc?.holders ?? "?"}.`,
    });
  }

  // -- 05b: faucet stablecoins on People (foreign-asset supply reflects XCM transfers in) --
  {
    const parts = [EXPECTED.USDT, EXPECTED.USDC].map((spec) => {
      const x = foreignByIndex(spec.id);
      return {
        okOne: !!x && x.supply > 0n,
        text: x
          ? `${spec.symbol} supply on People ${fmtUnits(x.supply, x.decimals)} (${x.holders} holder(s))`
          : `${spec.symbol}: no foreign asset`,
      };
    });
    rows.push({
      step: "05b",
      title: "Stablecoins transferred to People (faucet funding)",
      chain: "People",
      status: unreadable(p.foreignAssets) ? "na" : parts.every((x) => x.okOne) ? "ok" : "bad",
      values: unreadable(p.foreignAssets)
        ? "Assets.Asset unreadable (see notes)."
        : parts.map((x) => x.text).join(" · "),
    });
  }

  // -- 06a: PGAS asset --
  {
    const x = ahAsset(EXPECTED.PGAS_ID);
    rows.push({
      step: "06a",
      title: `PGAS asset (${EXPECTED.PGAS_ID}) created`,
      chain: "Asset Hub",
      status: x?.found ? "ok" : "bad",
      values: x?.found
        ? `supply ${fmtUnits(x.supply, x.decimals)} · ${x.holders} holder(s) · status ${x.status}`
        : "asset not found",
    });
  }

  // -- 06b: PGAS pool --
  {
    const pool = poolFor(EXPECTED.PGAS_ID);
    rows.push({
      step: "06b",
      title: "PAS/PGAS conversion pool + liquidity",
      chain: "Asset Hub",
      status: unreadable(a.pools) ? "na" : pool ? "ok" : "bad",
      values: pool
        ? `pool exists · LP token id ${pool.lpToken}`
        : unreadable(a.pools)
          ? "AssetConversion.Pools unreadable (see notes)."
          : "no PAS/PGAS pool found",
    });
  }

  // -- 06c: alias fee --
  rows.push({
    step: "06c",
    title: "Alias fee set (AliasAccounts)",
    chain: "Asset Hub",
    status:
      a.aliasFee === null ? "bad" : a.aliasFee === EXPECTED.ALIAS_FEE ? "ok" : "warn",
    values:
      a.aliasFee === null
        ? "not set (or unreadable — see notes)"
        : `${a.aliasFee} planck${a.aliasFee === EXPECTED.ALIAS_FEE ? "" : ` · expected ${EXPECTED.ALIAS_FEE}`}`,
  });

  // -- 07: ZK chunks --
  {
    const groups = p.chunks ?? [];
    const summary = groups
      .map((g) => {
        const total = g.pages.reduce((acc, x) => acc + x.chunks, 0);
        const expected = EXPECTED.CHUNK_PAGES[g.proofType];
        return `${g.proofType}: ${g.pages.length} page(s)${expected ? `/${expected} expected` : ""}, ${total} chunk(s)`;
      })
      .join(" · ");
    const complete = Object.entries(EXPECTED.CHUNK_PAGES).every(([t, n]) => {
      const g = groups.find((x) => x.proofType === t);
      return !!g && g.pages.length >= n;
    });
    rows.push({
      step: "07",
      title: "ZK proof chunks uploaded (ChunksManager)",
      chain: "People",
      status: unreadable(p.chunks)
        ? "na"
        : complete
          ? "ok"
          : groups.length
            ? "warn"
            : "bad",
      values: unreadable(p.chunks)
        ? "ChunksManager unreadable (see notes)."
        : summary || "no chunks uploaded",
    });
  }

  // -- 08: people collection --
  rows.push({
    step: "08",
    title: "People collection created",
    chain: "People",
    status:
      p.peopleCollectionCreated === null ? "na" : p.peopleCollectionCreated ? "ok" : "bad",
    values: `PeopleCollectionCreated=${p.peopleCollectionCreated ?? "?"} · LitePeopleCollectionCreated=${p.liteCollectionCreated ?? "?"}`,
  });

  // -- 09: onboarding sizes --
  {
    const sizes = p.onboardingSizes ?? [];
    const get = (id: string) => sizes.find((x) => x.identifier === id)?.size;
    const people = get(EXPECTED.PEOPLE_ID);
    const lite = get(EXPECTED.PEOPLE_LITE_ID);
    const okBoth = people === EXPECTED.ONBOARDING_SIZE && lite === EXPECTED.ONBOARDING_SIZE;
    rows.push({
      step: "09",
      title: `Onboarding sizes overridden to ${EXPECTED.ONBOARDING_SIZE}`,
      chain: "People",
      status: unreadable(p.onboardingSizes)
        ? "na"
        : okBoth
          ? "ok"
          : people !== undefined || lite !== undefined
            ? "warn"
            : "bad",
      values: unreadable(p.onboardingSizes)
        ? "Members.OnboardingSize unreadable (see notes)."
        : `people=${people ?? "unset"} · people-lite=${lite ?? "unset"}`,
    });
  }

  // -- 10: AH subscribed to ring-root updates --
  {
    const sub = (p.subscribers ?? []).find((x) => {
      const ids = x.collections.map((c) => c.identifier);
      return ids.includes(EXPECTED.PEOPLE_ID) && ids.includes(EXPECTED.PEOPLE_LITE_ID);
    });
    const status: CheckStatus =
      sub && a.subscriptionActive ? "ok" : sub || a.subscriptionActive ? "warn" : "bad";
    rows.push({
      step: "10",
      title: "AH subscribed to ring-root updates (both collections)",
      chain: "People + AH",
      status: unreadable(p.subscribers) ? "na" : status,
      values: sub
        ? `notifier: para ${sub.paraId}, pallet idx ${sub.palletIndex}, init seq ${sub.lastInitSequence}, formats ${sub.collections.map((c) => c.format).join("/")} · subscriber: ${a.subscription}`
        : `no subscriber covers both collections · AH-side subscription: ${a.subscription}`,
    });
  }

  // -- 11: design families --
  {
    const n = p.designFamilies?.length ?? 0;
    rows.push({
      step: "11",
      title: `Proof-of-ink design families (${EXPECTED.DESIGN_FAMILIES} expected)`,
      chain: "People",
      status: unreadable(p.designFamilies)
        ? "na"
        : n >= EXPECTED.DESIGN_FAMILIES
          ? "ok"
          : n > 0
            ? "warn"
            : "bad",
      values: unreadable(p.designFamilies)
        ? "ProofOfInk.DesignFamilies unreadable (see notes)."
        : `${n} / ${EXPECTED.DESIGN_FAMILIES} families — see Design families table.`,
    });
  }

  // -- 12a: attestation invites --
  {
    const fmt = (xs: AccountAmount[] | null, what: string) =>
      xs === null
        ? `${what}: unreadable`
        : xs.length
          ? `${what}: ${xs.length} account(s), max ${Math.max(...xs.map((x) => x.amount)).toLocaleString("en-US")}`
          : `${what}: none`;
    const okBoth =
      (p.poiInvites ?? []).some((x) => x.amount > 0) &&
      (p.gameInvites ?? []).some((x) => x.amount > 0);
    rows.push({
      step: "12a",
      title: `Attestation invites granted (${EXPECTED.INVITES.toLocaleString("en-US")} each expected)`,
      chain: "People",
      status:
        unreadable(p.poiInvites) && unreadable(p.gameInvites) ? "na" : okBoth ? "ok" : "bad",
      values: `${fmt(p.poiInvites, "ProofOfInk")} · ${fmt(p.gameInvites, "Game")}`,
    });
  }

  // -- 12b: attestation allowances --
  {
    const okBoth =
      (p.liteAllowances ?? []).some((x) => x.amount > 0) &&
      (a.dotnsAllowances ?? []).some((x) => x.amount > 0);
    const fmt = (xs: AccountAmount[] | null, what: string) =>
      xs === null
        ? `${what}: unreadable`
        : xs.length
          ? `${what}: ${xs.length} account(s), max ${Math.max(...xs.map((x) => x.amount)).toLocaleString("en-US")}`
          : `${what}: none`;
    rows.push({
      step: "12b",
      title: `Attestation allowances (${EXPECTED.ATTESTATION_ALLOWANCE.toLocaleString("en-US")} each expected)`,
      chain: "People + AH",
      status:
        unreadable(p.liteAllowances) && unreadable(a.dotnsAllowances)
          ? "na"
          : okBoth
            ? "ok"
            : "bad",
      values: `${fmt(p.liteAllowances, "PeopleLite")} · ${fmt(a.dotnsAllowances, "DotnsGateway")}`,
    });
  }

  // -- 12c: attestation proxies --
  {
    const pn = p.proxies?.length ?? 0;
    const an = a.proxies?.length ?? 0;
    rows.push({
      step: "12c",
      title: "Attestation proxy on both chains",
      chain: "People + AH",
      status:
        unreadable(p.proxies) && unreadable(a.proxies)
          ? "na"
          : pn > 0 && an > 0
            ? "ok"
            : "bad",
      values: `People: ${unreadable(p.proxies) ? "unreadable" : `${pn} delegator(s)`} · AH: ${unreadable(a.proxies) ? "unreadable" : `${an} delegator(s)`} — accounts are per-network; see Proxies tables.`,
    });
  }

  // -- 13: dotns dispatcher --
  {
    const d = a.dispatcher;
    rows.push({
      step: "13",
      title: "DotNS dispatcher address set",
      chain: "Asset Hub",
      status:
        d === null
          ? "bad"
          : d.toLowerCase() === EXPECTED.PLACEHOLDER_DISPATCHER
            ? "warn"
            : "ok",
      values:
        d === null
          ? "not set (or unreadable — see notes)"
          : `${d}${d.toLowerCase() === EXPECTED.PLACEHOLDER_DISPATCHER ? " · placeholder value from config-local.env!" : ""}`,
    });
  }

  return rows;
}
