// Render helpers for the Setup page: the per-script checklist plus the detailed
// value tables for both chains and the games/airdrops section.

import { escapeHtml, fmtDuration, fmtRel, fmtTime, fmtUnits, shortHex } from "./format";
import type {
  AccountAmount,
  AhSetup,
  CheckRow,
  ForeignAsset,
  PeopleSetup,
  PrizeView,
  ProxyEntry,
  SetupState,
} from "./setup";
import { deriveChecks, EXPECTED } from "./setup";
import { eventIdLabel } from "./identifiers";
import { TIPS } from "./tips";
import { hexCell, identAttr, identCell, table, th } from "./ui";

function chip(status: CheckRow["status"]): string {
  const label = { ok: "✓ ok", warn: "⚠ partial", bad: "✗ missing", na: "n/a" }[status];
  return `<span class="chip ${status}">${label}</span>`;
}

/** Mono cell for an account address, shortened with the full value as tooltip. */
function accountCell(addr: string): string {
  return `<td class="mono" title="${escapeHtml(addr)}">${escapeHtml(addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr)}</td>`;
}

/** "12:00 (in 2h)" cell for a unix-seconds instant. */
function whenCell(unixS: number): string {
  if (!unixS) return "<td>—</td>";
  return `<td>${fmtTime(unixS, "s")} <small class="muted">(${fmtRel(unixS)})</small></td>`;
}

/** Format a prize using People foreign-asset metadata for symbol/decimals when possible. */
function prizeText(prize: PrizeView | null, foreignAssets: ForeignAsset[] | null): string {
  if (!prize) return "—";
  const amount = (() => {
    if (prize.asset.native) return `${fmtUnits(prize.amount, EXPECTED.NATIVE_DECIMALS)} PAS`;
    const meta = (foreignAssets ?? []).find(
      (f) =>
        f.loc.display === prize.asset.display ||
        (prize.asset.generalIndex !== null && f.loc.generalIndex === prize.asset.generalIndex),
    );
    return meta
      ? `${fmtUnits(prize.amount, meta.decimals)} ${meta.symbol || "?"}`
      : `${prize.amount} @ ${prize.asset.display}`;
  })();
  return `${amount} · ${prize.maxWinners} winner(s) max · cap ${prize.winnerCap}`;
}

function checklist(rows: CheckRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr data-ident="${escapeHtml(`${r.step} ${r.title} ${r.chain} ${r.status}`.toLowerCase())}">
          <td>${chip(r.status)}</td>
          <td class="mono">${escapeHtml(r.step)}</td>
          <td>${escapeHtml(r.chain)}</td>
          <td>${escapeHtml(r.title)}</td>
          <td class="detail">${escapeHtml(r.values)}</td>
        </tr>`,
    )
    .join("");
  return table({
    id: "setup-checklist",
    title: "Initial-setup checklist",
    tip: TIPS.setupChecklist,
    head: `${th("Status", TIPS.setupStatus)}${th("Script", TIPS.setupScript)}<th>Chain</th><th>Step</th>${th("Values found on chain", TIPS.setupValues)}`,
    rows: body,
    cols: 5,
    searchable: true,
  });
}

function proxiesTable(id: string, title: string, proxies: ProxyEntry[] | null): string {
  const body = (proxies ?? [])
    .flatMap((e) =>
      e.delegates.map(
        (d) =>
          `<tr data-ident="${escapeHtml(`${e.delegator} ${d.delegate} ${d.proxyType}`.toLowerCase())}">
            ${accountCell(e.delegator)}${accountCell(d.delegate)}
            <td>${escapeHtml(d.proxyType)}</td><td>${d.delay}</td>
            <td>${fmtUnits(e.deposit, EXPECTED.NATIVE_DECIMALS)}</td>
          </tr>`,
      ),
    )
    .join("");
  return table({
    id,
    title,
    tip: TIPS.setupProxies,
    head: `<th>Delegator</th><th>Delegate</th><th>Type</th><th>Delay</th>${th("Deposit", TIPS.setupProxyDeposit)}`,
    rows: body,
    cols: 5,
    searchable: true,
  });
}

function amountsTable(id: string, title: string, tip: string, rows: AccountAmount[] | null): string {
  const body = (rows ?? [])
    .map(
      (x) =>
        `<tr data-ident="${escapeHtml(x.account.toLowerCase())}">${accountCell(x.account)}<td>${x.amount.toLocaleString("en-US")}</td></tr>`,
    )
    .join("");
  return table({ id, title, tip, head: `<th>Account</th><th>Amount</th>`, rows: body, cols: 2, searchable: true });
}

function renderPeopleSetup(p: PeopleSetup): string {
  const assetRows = (p.foreignAssets ?? [])
    .map(
      (x) =>
        `<tr data-ident="${escapeHtml(`${x.symbol} ${x.name} ${x.loc.display}`.toLowerCase())}">
          <td class="mono" title="${escapeHtml(x.loc.display)}">${escapeHtml(x.loc.display)}</td>
          <td>${escapeHtml(x.symbol) || "—"}</td><td>${x.decimals}</td>
          <td>${fmtUnits(x.supply, x.decimals)}</td><td>${fmtUnits(x.minBalance, x.decimals)}</td>
          <td>${x.holders}</td><td>${escapeHtml(x.status)}</td>${accountCell(x.owner)}
        </tr>`,
    )
    .join("");

  const rateRows = (p.rates ?? [])
    .map((r) => {
      const asset = (p.foreignAssets ?? []).find((f) => f.loc.display === r.loc.display);
      const perToken = asset
        ? `1 ${asset.symbol || "token"} ≈ ${(Number(r.rate) / 1e18) * 10 ** asset.decimals * 10 ** -EXPECTED.NATIVE_DECIMALS} PAS`
        : "—";
      return `<tr data-ident="${escapeHtml(r.loc.display.toLowerCase())}">
        <td class="mono">${escapeHtml(r.loc.display)}</td><td class="mono">${r.rate}</td><td>${escapeHtml(perToken)}</td>
      </tr>`;
    })
    .join("");

  const chunkRows = (p.chunks ?? [])
    .map((g) => {
      const expected = EXPECTED.CHUNK_PAGES[g.proofType];
      const total = g.pages.reduce((acc, x) => acc + x.chunks, 0);
      const pages = g.pages.map((x) => `${x.page}:${x.chunks}`).join(", ");
      const ok = expected === undefined || g.pages.length >= expected;
      return `<tr data-ident="${g.proofType.toLowerCase()}">
        <td>${g.proofType}</td>
        <td><span class="${ok ? "ok" : "warn"}">${g.pages.length}${expected ? ` / ${expected} expected` : ""}</span></td>
        <td>${total}</td><td class="mono">${pages}</td>
      </tr>`;
    })
    .join("");

  const sizeRows = (p.onboardingSizes ?? [])
    .map(
      (x) =>
        `<tr${identAttr(x.identifier)}>${identCell(x.identifier)}<td>${x.size}</td><td>${x.size === EXPECTED.ONBOARDING_SIZE ? `<span class="ok">matches setup (${EXPECTED.ONBOARDING_SIZE})</span>` : `<span class="warn">setup used ${EXPECTED.ONBOARDING_SIZE}</span>`}</td></tr>`,
    )
    .join("");

  const subRows = (p.subscribers ?? [])
    .map((x) => {
      const cols = x.collections
        .map((c) => `${escapeHtml(identifierShort(c.identifier))} (${c.format})`)
        .join(", ");
      return `<tr data-ident="${escapeHtml(`para ${x.paraId} ${cols}`.toLowerCase())}">
        <td>${x.paraId}</td><td>${x.palletIndex}</td><td>${x.lastInitSequence}</td><td>${cols}</td>
      </tr>`;
    })
    .join("");

  const familyRows = (p.designFamilies ?? [])
    .map(
      (f) =>
        `<tr data-ident="${escapeHtml(`${f.index} ${f.kind} ${f.id}`.toLowerCase())}">
          <td>${f.index}</td><td>${escapeHtml(f.kind)}</td><td>${f.range ?? "—"}</td>${hexCell(f.id)}
        </tr>`,
    )
    .join("");

  const inviteRows = [
    ...(p.poiInvites ?? []).map((x) => ({ src: "ProofOfInk", ...x })),
    ...(p.gameInvites ?? []).map((x) => ({ src: "Game", ...x })),
  ]
    .map(
      (x) =>
        `<tr data-ident="${escapeHtml(`${x.src} ${x.account}`.toLowerCase())}"><td>${x.src}</td>${accountCell(x.account)}<td>${x.amount.toLocaleString("en-US")}</td></tr>`,
    )
    .join("");

  return `
  <section class="panel">
    <h2>People — setup values</h2>
    <table class="kv">
      <tr>${th("People collection created", TIPS.setupPeopleCollection)}<td>${flag(p.peopleCollectionCreated)}</td></tr>
      <tr>${th("Lite collection created", TIPS.setupPeopleCollection)}<td>${flag(p.liteCollectionCreated)}</td></tr>
      <tr>${th("Coinage underlying asset", TIPS.setupCoinage)}<td class="mono">${p.coinageUnderlying ? escapeHtml(p.coinageUnderlying.display) : '<span class="bad">not set</span>'}</td></tr>
    </table>

    ${table({
      id: "setup-foreign-assets",
      title: "Foreign assets (Assets pallet)",
      tip: TIPS.setupForeignAssets,
      head: `${th("Location", TIPS.setupLocation)}<th>Symbol</th><th>Dec</th><th>Supply</th><th>Min balance</th><th>Holders</th><th>Status</th><th>Owner</th>`,
      rows: assetRows,
      cols: 8,
      searchable: true,
    })}

    ${table({
      id: "setup-rates",
      title: "Conversion rates (AssetRate)",
      tip: TIPS.setupRates,
      head: `${th("Location", TIPS.setupLocation)}${th("Raw rate", TIPS.setupRawRate)}<th>≈ native</th>`,
      rows: rateRows,
      cols: 3,
      searchable: true,
    })}

    ${table({
      id: "setup-chunks",
      title: "ZK chunks (ChunksManager)",
      tip: TIPS.setupChunks,
      head: `<th>Proof</th><th>Pages</th><th>Total chunks</th>${th("Chunks per page", TIPS.setupChunkPages)}`,
      rows: chunkRows,
      cols: 4,
    })}

    ${table({
      id: "setup-onboarding",
      title: "Onboarding sizes (Members)",
      tip: TIPS.onboardingSize,
      head: `${th("Identifier", TIPS.identifier)}<th>Size</th><th></th>`,
      rows: sizeRows,
      cols: 3,
      searchable: true,
    })}

    ${table({
      id: "setup-subscribers",
      title: "Ring-root subscribers (MembersNotifier)",
      tip: TIPS.notifierSubscribers,
      head: `<th>Para</th><th>Pallet idx</th><th>Init seq</th><th>Collections (format)</th>`,
      rows: subRows,
      cols: 4,
    })}

    ${table({
      id: "setup-families",
      title: "Design families (ProofOfInk)",
      tip: TIPS.setupFamilies,
      head: `<th>Index</th><th>Kind</th><th>Range</th><th>Id</th>`,
      rows: familyRows,
      cols: 4,
      searchable: true,
    })}

    ${table({
      id: "setup-invites",
      title: "Available invites",
      tip: TIPS.setupInvites,
      head: `<th>Pallet</th><th>Account</th><th>Invites</th>`,
      rows: inviteRows,
      cols: 3,
      searchable: true,
    })}

    ${amountsTable("setup-lite-allowance", "Attestation allowance (PeopleLite)", TIPS.setupAllowances, p.liteAllowances)}
    ${proxiesTable("setup-people-proxies", "Proxies", p.proxies)}
  </section>`;
}

function renderAhSetup(a: AhSetup): string {
  const assetRows = (a.assets ?? [])
    .map((x) => {
      const labelCell =
        x.id === EXPECTED.XTRNL.id
          ? `<td class="ident" title="${TIPS.setupXtrnlAlias}">${escapeHtml(x.label)}</td>`
          : `<td>${escapeHtml(x.label)}</td>`;
      return x.found
        ? `<tr data-ident="${escapeHtml(`${x.label} ${x.symbol} ${x.id}`.toLowerCase())}">
            ${labelCell}<td>${x.id}</td>
            <td>${escapeHtml(x.symbol) || "—"}</td><td>${x.decimals}</td>
            <td>${fmtUnits(x.supply, x.decimals)}</td><td>${fmtUnits(x.minBalance, x.decimals)}</td>
            <td>${x.holders}</td><td>${escapeHtml(x.status)}</td>${accountCell(x.owner)}
          </tr>`
        : `<tr data-ident="${escapeHtml(`${x.label} ${x.id}`.toLowerCase())}">
            ${labelCell}<td>${x.id}</td>
            <td colspan="7"><span class="bad">not found</span></td>
          </tr>`;
    })
    .join("");

  const poolRows = (a.pools ?? [])
    .map((pl) => {
      const side = (s: typeof pl.asset0) => (s.native ? "PAS (native)" : s.display);
      return `<tr data-ident="${escapeHtml(`${side(pl.asset0)} ${side(pl.asset1)}`.toLowerCase())}">
        <td class="mono">${escapeHtml(side(pl.asset0))}</td><td class="mono">${escapeHtml(side(pl.asset1))}</td><td>${pl.lpToken}</td>
      </tr>`;
    })
    .join("");

  const dispatcherCell =
    a.dispatcher === null
      ? '<span class="bad">not set</span>'
      : a.dispatcher.toLowerCase() === EXPECTED.PLACEHOLDER_DISPATCHER
        ? `<span class="warn mono">${a.dispatcher} (placeholder!)</span>`
        : `<span class="mono">${a.dispatcher}</span>`;

  return `
  <section class="panel">
    <h2>Asset Hub — setup values</h2>
    <table class="kv">
      <tr>${th("Subscription", TIPS.subscription)}<td>${escapeHtml(a.subscription)}</td></tr>
      <tr>${th("Alias fee", TIPS.setupAliasFee)}<td>${a.aliasFee === null ? '<span class="bad">not set</span>' : `${a.aliasFee} planck ${a.aliasFee === EXPECTED.ALIAS_FEE ? '<span class="ok">(matches setup)</span>' : `<span class="warn">(setup used ${EXPECTED.ALIAS_FEE})</span>`}`}</td></tr>
      <tr>${th("DotNS dispatcher", TIPS.setupDispatcher)}<td>${dispatcherCell}</td></tr>
    </table>

    ${table({
      id: "setup-ah-assets",
      title: "Setup assets (Assets pallet)",
      tip: TIPS.setupAhAssets,
      head: `<th>Asset</th><th>Id</th><th>Symbol</th><th>Dec</th><th>Supply</th><th>Min balance</th><th>Holders</th><th>Status</th><th>Owner</th>`,
      rows: assetRows,
      cols: 9,
      searchable: true,
    })}

    ${table({
      id: "setup-pools",
      title: "Conversion pools (AssetConversion)",
      tip: TIPS.setupPools,
      head: `<th>Asset A</th><th>Asset B</th>${th("LP token", TIPS.setupLpToken)}`,
      rows: poolRows,
      cols: 3,
      searchable: true,
    })}

    ${amountsTable("setup-dotns-allowance", "Attestation allowance (DotnsGateway)", TIPS.setupAllowances, a.dotnsAllowances)}
    ${proxiesTable("setup-ah-proxies", "Proxies", a.proxies)}
  </section>`;
}

function renderGamesAirdrops(p: PeopleSetup): string {
  const now = Date.now() / 1000;

  const scheduleRows = (p.schedules ?? [])
    .map((s) => {
      const state =
        s.playTimeS > now
          ? '<span class="ok">upcoming</span>'
          : '<span class="muted">past</span>';
      return `<tr data-ident="${escapeHtml(`${fmtTime(s.playTimeS, "s")} ${s.prize ? "prize" : ""}`.toLowerCase())}">
        ${whenCell(s.playTimeS)}<td>${s.rounds}</td><td>${s.maxGroupSize}</td>
        <td>${escapeHtml(prizeText(s.prize, p.foreignAssets))}</td><td>${state}</td>
      </tr>`;
    })
    .join("");

  const g = p.currentGame;
  const currentGame = g
    ? `<table class="kv">
        <tr>${th("Game index", TIPS.setupGameIndex)}<td>${g.index} <small class="muted">(next index counter: ${p.gameIndex ?? "?"})</small></td></tr>
        <tr>${th("State", TIPS.setupGameState)}<td>${escapeHtml(g.stateType)}${g.stateDetail ? ` <small class="muted">${escapeHtml(g.stateDetail)}</small>` : ""}</td></tr>
        <tr><th>Registration ends</th><td>${fmtTime(g.registrationEndsS, "s")} (${fmtRel(g.registrationEndsS)})</td></tr>
        <tr><th>Shuffle deadline</th><td>${fmtTime(g.shuffleDeadlineS, "s")} (${fmtRel(g.shuffleDeadlineS)})</td></tr>
        <tr><th>Game date</th><td>${fmtTime(g.gameDateS, "s")} (${fmtRel(g.gameDateS)})</td></tr>
        <tr><th>Report ends</th><td>${fmtTime(g.reportEndsS, "s")} (${fmtRel(g.reportEndsS)})</td></tr>
        <tr><th>Max group size</th><td>${g.maxGroupSize}</td></tr>
        <tr>${th("Participants", TIPS.setupParticipants)}<td>${g.participants ?? "—"}</td></tr>
      </table>`
    : `<div class="muted">No game in progress${p.gameIndex !== null ? ` — ${p.gameIndex} game(s) played so far` : ""}.</div>`;

  const d = p.phaseDurations;
  const durations = d
    ? `<table class="kv">
        <tr><th>Registration</th><td>${fmtDuration(d.registrationS * 1000)}</td></tr>
        <tr><th>Shuffle</th><td>${fmtDuration(d.shuffleS * 1000)}</td></tr>
        <tr><th>Post-shuffle margin</th><td>${fmtDuration(d.postShuffleMarginS * 1000)}</td></tr>
        <tr><th>Reporting</th><td>${fmtDuration(d.reportingS * 1000)}</td></tr>
        <tr><th>Player process</th><td>${fmtDuration(d.playerProcessS * 1000)}</td></tr>
        <tr><th>Airdrop claim window</th><td>${fmtDuration(d.airdropClaimWindowS * 1000)}</td></tr>
        <tr>${th("Play deposit", TIPS.setupPlayDeposit)}<td>${p.playDeposit !== null ? `${fmtUnits(p.playDeposit, EXPECTED.NATIVE_DECIMALS)} PAS` : "—"}</td></tr>
      </table>`
    : `<div class="muted">No stored phase durations (runtime defaults apply).${p.playDeposit !== null ? ` Play deposit: ${fmtUnits(p.playDeposit, EXPECTED.NATIVE_DECIMALS)} PAS.` : ""}</div>`;

  const airdropRows = (p.airdropEvents ?? [])
    .map(
      (e) =>
        `<tr data-ident="${escapeHtml(`${eventIdLabel(e.id)} ${e.id} ${e.status}`.toLowerCase())}">
          <td class="ident" title="${escapeHtml(e.id)}">${escapeHtml(eventIdLabel(e.id))}</td>
          <td>${escapeHtml(e.status)}${e.statusDetail ? ` <small class="muted">${escapeHtml(e.statusDetail)}</small>` : ""}</td>
          ${whenCell(e.registrationStartsS)}${whenCell(e.drawTimeS)}${whenCell(e.endTimeS)}
          <td>${escapeHtml(prizeText(e.prize, p.foreignAssets))}</td>
        </tr>`,
    )
    .join("");

  const supportedRows = (p.supportedAssets ?? [])
    .map((x) => {
      const meta = (p.foreignAssets ?? []).find((f) => f.loc.display === x.asset.display);
      const funded = meta
        ? `${fmtUnits(x.funded, meta.decimals)} ${meta.symbol || "?"}`
        : x.asset.native
          ? `${fmtUnits(x.funded, EXPECTED.NATIVE_DECIMALS)} PAS`
          : String(x.funded);
      return `<tr data-ident="${escapeHtml(x.asset.display.toLowerCase())}">
        <td class="mono">${escapeHtml(x.asset.native ? "PAS (native)" : x.asset.display)}</td><td>${escapeHtml(funded)}</td>
      </tr>`;
    })
    .join("");

  const actionRows = (p.actions ?? [])
    .map(
      (x) =>
        `<tr data-ident="${escapeHtml(`${eventIdLabel(x.eventId)} ${x.eventId}`.toLowerCase())}">${whenCell(x.timeS)}<td class="ident" title="${escapeHtml(x.eventId)}">${escapeHtml(eventIdLabel(x.eventId))}</td></tr>`,
    )
    .join("");

  return `
  <section class="panel full">
    <h2>Games &amp; airdrops <small>People chain · Game + Airdrop pallets</small></h2>
    <div class="grid">
      <div>
        <h3 title="${TIPS.setupCurrentGame}">Current game</h3>
        ${currentGame}
      </div>
      <div>
        <h3 title="${TIPS.setupPhaseDurations}">Game phase durations</h3>
        ${durations}
      </div>
    </div>

    ${table({
      id: "setup-game-schedules",
      title: "Scheduled games (Game.GameSchedules)",
      tip: TIPS.setupGameSchedules,
      head: `${th("Play time", TIPS.setupPlayTime)}<th>Rounds</th><th>Max group</th>${th("Airdrop prize", TIPS.setupGamePrize)}<th></th>`,
      rows: scheduleRows,
      cols: 5,
      searchable: true,
    })}

    ${table({
      id: "setup-airdrops",
      title: "Airdrop events (Airdrop.Events)",
      tip: TIPS.setupAirdrops,
      head: `<th>Event id</th>${th("Status", TIPS.setupAirdropStatus)}<th>Registration opens</th><th>Draw</th><th>Ends</th><th>Prize</th>`,
      rows: airdropRows,
      cols: 6,
      searchable: true,
    })}

    ${table({
      id: "setup-supported-assets",
      title: "Airdrop supported assets",
      tip: TIPS.setupSupportedAssets,
      head: `<th>Asset</th><th>Funded</th>`,
      rows: supportedRows,
      cols: 2,
      searchable: true,
    })}

    ${table({
      id: "setup-actions",
      title: "Airdrop action schedule (OCW)",
      tip: TIPS.setupActionSchedule,
      head: `<th>Next action at</th><th>Event id</th>`,
      rows: actionRows,
      cols: 2,
    })}
  </section>`;
}

function flag(v: boolean | null): string {
  if (v === null) return '<span class="muted">unreadable</span>';
  return v ? '<span class="ok">yes</span>' : '<span class="bad">no</span>';
}

/** Short label for an identifier without importing the full ui helper set. */
function identifierShort(hex: string): string {
  if (hex === EXPECTED.PEOPLE_ID) return "people";
  if (hex === EXPECTED.PEOPLE_LITE_ID) return "people-lite";
  return shortHex(hex);
}

export function renderSetup(s: SetupState): string {
  const checks = deriveChecks(s);
  const counts = { ok: 0, warn: 0, bad: 0, na: 0 };
  for (const c of checks) counts[c.status]++;

  const notes = s.notes.length
    ? `<div class="notes">${s.notes.map((n) => `<div>⚠️ ${escapeHtml(n)}</div>`).join("")}</div>`
    : "";

  return `
  <section class="panel full">
    <h2>Setup status <small>state written by scripts/initial-setup, read live from both chains</small></h2>
    ${notes}
    <div class="cards">
      <div class="card" title="${TIPS.setupOkCard}"><div class="k">Complete</div><div class="v ok">${counts.ok}</div></div>
      <div class="card" title="${TIPS.setupWarnCard}"><div class="k">Partial / unexpected</div><div class="v warn">${counts.warn}</div></div>
      <div class="card" title="${TIPS.setupBadCard}"><div class="k">Missing</div><div class="v ${counts.bad ? "bad" : ""}">${counts.bad}</div></div>
      <div class="card" title="${TIPS.setupNaCard}"><div class="k">Not checkable</div><div class="v muted">${counts.na}</div></div>
    </div>
    ${checklist(checks)}
  </section>
  <div class="grid">
    ${renderPeopleSetup(s.people)}
    ${renderAhSetup(s.assetHub)}
  </div>
  ${renderGamesAirdrops(s.people)}`;
}
