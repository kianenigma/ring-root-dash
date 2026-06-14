// Pure render helpers: produce HTML strings from domain data. Event wiring lives
// in main.ts. BigInts are stringified; hex is shortened for readability.
//
// Tooltips: column headers, card labels and key/value rows carry a `title` from
// the TIPS glossary; shortened hex cells carry their full value as a `title`.

import { type Endpoints, papiConsoleUrl, SLOW_LAG_MS } from "./config";
import {
  type AhLive,
  type CohortStatus,
  cohortStatus,
  type HistoryResult,
  type InTransitRow,
  type PeopleCollection,
  type PeopleLive,
  type RegistrationDelay,
  type RingLifecycle,
  type TimedEvent,
} from "./domain";
import { escapeHtml, fmtAgo, fmtDuration, fmtTime, shortHex } from "./format";
import { identifierLabel } from "./identifiers";
import { TIPS } from "./tips";

/** A <th> with a tooltip. */
export function th(label: string, tip: string): string {
  return `<th title="${tip}">${label}</th>`;
}
/** A mono cell showing shortened hex, with the full value as a tooltip. */
export function hexCell(full: string): string {
  return `<td class="mono" title="${full}">${shortHex(full)}</td>`;
}
/** A collection-identifier cell: friendly label, full hex as tooltip. */
export function identCell(full: string): string {
  return `<td class="ident" title="${full}">${escapeHtml(identifierLabel(full))}</td>`;
}
/** Row attribute used by the per-table search to filter by identifier (label + hex). */
export function identAttr(full: string): string {
  return ` data-ident="${escapeHtml(`${identifierLabel(full)} ${full}`.toLowerCase())}"`;
}

export interface TableSpec {
  /** Stable id used to persist collapse/filter state across live re-renders. */
  id: string;
  title: string;
  tip?: string;
  /** Header cells, e.g. `${th(..)}${th(..)}`. */
  head: string;
  /** Body rows; each `<tr>` that should be searchable carries `data-ident`. */
  rows: string;
  /** Column count for the empty-state row. */
  cols: number;
  /** Show the slim identifier search bar. */
  searchable?: boolean;
  /** Render the body in a scroll area with a frozen (sticky) header row. */
  scroll?: boolean;
  /** If set, show a "⤓ CSV" button carrying this key; the download is wired in main.ts. */
  exportKey?: string;
}

/**
 * A titled table with a collapse toggle and (optionally) a slim search bar that
 * filters rows by identifier. Collapse/filter are wired by delegated listeners in
 * main.ts and persisted in app state, so they survive the live per-block re-render.
 */
export function table(spec: TableSpec): string {
  const search = spec.searchable
    ? `<input class="table-search" type="search" data-target="${spec.id}" placeholder="filter by identifier…" />`
    : "";
  const exportBtn = spec.exportKey
    ? `<button class="export-btn" data-export="${spec.exportKey}" title="Download this table as a CSV file (links stripped, full values kept)">⤓ CSV</button>`
    : "";
  const titleAttr = spec.tip ? ` title="${spec.tip}"` : "";
  return `
  <div class="tbl${spec.scroll ? " scroll" : ""}" data-table-id="${spec.id}">
    <div class="tbl-bar">
      <button class="collapse-btn" data-target="${spec.id}" title="Collapse / expand" aria-label="Collapse or expand">▾</button>
      <h3${titleAttr}>${spec.title}</h3>
      ${search}
      <span class="tbl-count" data-target="${spec.id}"></span>
      ${exportBtn}
    </div>
    <div class="tbl-body">
      <table>
        <thead><tr>${spec.head}</tr></thead>
        <tbody>${spec.rows || emptyRow(spec.cols)}</tbody>
      </table>
    </div>
  </div>`;
}

function cohortCell(status: CohortStatus): string {
  switch (status.kind) {
    case "blocked":
      return `<span class="bad" title="${TIPS.cohort}">⚠ waiting for cohort (${status.waiting}/${status.size})</span>`;
    case "ready":
      return `<span class="ok" title="${TIPS.cohort}">cohort ready (${status.waiting}/${status.size})</span>`;
    case "paused":
      return `<span class="warn" title="${TIPS.cohort}">onboarding paused (suspensions)</span>`;
    default:
      return `<span class="muted">—</span>`;
  }
}

/** Banner shown when members are stuck below the cohort size — the #1060 case. */
function cohortBanner(collections: PeopleCollection[]): string {
  const blocked = collections
    .map((c) => ({ c, s: cohortStatus(c) }))
    .filter((x) => x.s.kind === "blocked");
  if (!blocked.length) return "";
  const items = blocked
    .map(({ c, s }) => {
      const st = s as { waiting: number; size: number };
      return `<li><b>${escapeHtml(identifierLabel(c.identifier))}</b>: ${st.waiting} member(s) waiting, but cohort size is ${st.size} — ring not rebuilt, nothing propagates to Asset Hub until ${st.size - st.waiting} more join (or self_include is used).</li>`;
    })
    .join("");
  return `<div class="banner bad" title="${TIPS.cohort}">⚠ Cohort gating is blocking propagation:<ul>${items}</ul></div>`;
}

/** A small "open in PAPI console" link for a chain heading. */
function consoleLink(url: string): string {
  return `<a class="console-link" href="${url}" target="_blank" rel="noopener" title="Open this chain in the PAPI dev console (dev.papi.how)">↗ PAPI console</a>`;
}

export function renderPeopleLive(p: PeopleLive, consoleUrl: string): string {
  const collectionRows = p.collections
    .map(
      (c) =>
        `<tr${identAttr(c.identifier)}>${identCell(c.identifier)}<td>${c.activeMembers}</td><td>${c.currentRingIndex}</td><td>${c.onboardingSize || "—"}</td><td>${c.queued + c.notIncluded}</td><td>${cohortCell(cohortStatus(c))}</td></tr>`,
    )
    .join("");

  const ringRows = [...p.rings]
    .sort((x, y) => y.ringIndex - x.ringIndex || x.identifier.localeCompare(y.identifier))
    .map(
      (r) =>
        `<tr${identAttr(r.identifier)}>${identCell(r.identifier)}<td>${r.ringIndex}</td><td>${r.revision}</td>${hexCell(r.root)}</tr>`,
    )
    .join("");

  const n = p.notifier;
  const batch = n.currentBatch
    ? `seq ${n.currentBatch.sequence}, sealed@${n.currentBatch.sealedAt}, ${n.currentBatch.remainingSubscribers} subscriber(s) left, sealed ${fmtAgo(n.currentBatch.sourceTimeS)}`
    : `<span class="ok">none active</span>`;
  const pages = n.pendingUpdatesPerPage.length
    ? n.pendingUpdatesPerPage.map((x) => `p${x.page}:${x.count}`).join(", ")
    : "—";
  const subs = n.subscribers.length
    ? n.subscribers.map((s) => `${s.paraId} (initSeq ${s.lastInitSequence})`).join(", ")
    : "none";

  return `
  <section class="panel">
    <h2>People <small>${escapeHtml(p.chainName)} · #${p.finalized}</small>${consoleLink(consoleUrl)}</h2>
    ${cohortBanner(p.collections)}
    <div class="cards">
      <div class="card" title="${TIPS.registeredMembers}"><div class="k">Registered members</div><div class="v">${p.totalActiveMembers}</div></div>
      <div class="card" title="${TIPS.collections}"><div class="k">Collections</div><div class="v">${p.collections.length}</div></div>
      <div class="card" title="${TIPS.peopleRings}"><div class="k">Rings</div><div class="v">${p.rings.length}</div></div>
    </div>

    <h3 title="${TIPS.notifier}">Members-notifier</h3>
    <table class="kv">
      <tr>${th("Sealed batch sequence", TIPS.sealedBatchSeq)}<td>${n.sealedBatchSequence}</td></tr>
      <tr>${th("Page state", TIPS.pageState)}<td>write ${n.writePage} / send ${n.sendPage} · last update block ${n.lastUpdateBlock}</td></tr>
      <tr>${th("Pending updates / page", TIPS.pendingUpdates)}<td>${pages}</td></tr>
      <tr>${th("Current batch", TIPS.currentBatch)}<td>${batch}</td></tr>
      <tr>${th("Subscribers", TIPS.notifierSubscribers)}<td>${escapeHtml(subs)}</td></tr>
      <tr>${th("Already got current batch", TIPS.gotCurrentBatch)}<td>${n.subscribersWithCurrentBatch.join(", ") || "—"}</td></tr>
    </table>

    ${table({
      id: "people-collections",
      title: "Collections",
      head: `${th("Identifier", TIPS.identifier)}${th("Active members", TIPS.activeMembers)}${th("Current ring idx", TIPS.currentRingIdx)}${th("Cohort size", TIPS.onboardingSize)}${th("Awaiting", TIPS.awaiting)}${th("Onboarding", TIPS.cohort)}`,
      rows: collectionRows,
      cols: 6,
      searchable: true,
    })}

    ${table({
      id: "people-rings",
      title: "Ring roots (current)",
      head: `${th("Identifier", TIPS.identifier)}${th("Ring", TIPS.ringIndex)}${th("Rev", TIPS.revision)}${th("Root", TIPS.root)}`,
      rows: ringRows,
      cols: 4,
      searchable: true,
    })}
  </section>`;
}

export function renderAhLive(a: AhLive, consoleUrl: string): string {
  const stateRows = a.collections
    .map((c) => {
      const missing = c.missingIndices.length
        ? c.missingIndices.map((m) => `${m.index}(×${m.attempts})`).join(", ")
        : "—";
      const deleted = c.deletedIndices.length ? c.deletedIndices.join(", ") : "—";
      const cls = c.missingIndices.length ? "warn" : "";
      return `<tr class="${cls}"${identAttr(c.identifier)}>${identCell(c.identifier)}<td>${c.ringCount}</td><td>${c.nextRingIndex}</td><td>${escapeHtml(missing)}</td><td>${escapeHtml(deleted)}</td></tr>`;
    })
    .join("");

  // Most-recently-received first: order by the newest record's source sequence
  // (the notifier batch sequence that delivered it; monotonic, so higher = newer).
  const latestSeq = (r: (typeof a.rings)[number]): bigint =>
    r.records.length ? r.records[r.records.length - 1].sourceSequence : -1n;
  const ringRows = [...a.rings]
    .sort((x, y) => {
      const sx = latestSeq(x);
      const sy = latestSeq(y);
      return sy > sx ? 1 : sy < sx ? -1 : 0;
    })
    .map((r) => {
      const latest = r.records[r.records.length - 1];
      const rev = latest ? latest.revision : "—";
      const root = latest ? hexCell(latest.root) : "<td>—</td>";
      const src = latest ? fmtAgo(latest.sourceTimeS) : "—";
      const seq = latest ? latest.sourceSequence : "—";
      return `<tr${identAttr(r.identifier)}>${identCell(r.identifier)}<td>${r.ringIndex}</td><td>${rev}</td>${root}<td>${seq}</td><td>${src}</td></tr>`;
    })
    .join("");

  const pr = a.processing;
  return `
  <section class="panel">
    <h2>Asset Hub <small>${escapeHtml(a.chainName)} · #${a.finalized}</small>${consoleLink(consoleUrl)}</h2>
    <div class="cards">
      <div class="card" title="${TIPS.subscription}"><div class="k">Subscription</div><div class="v small">${escapeHtml(a.subscription)}</div></div>
      <div class="card" title="${TIPS.ringCollections}"><div class="k">Ring collections</div><div class="v">${a.collections.length}</div></div>
      <div class="card" title="${TIPS.ringsStored}"><div class="k">Rings stored</div><div class="v">${a.rings.length}</div></div>
    </div>

    <h3 title="${TIPS.subscriberProcessing}">Subscriber processing</h3>
    <table class="kv">
      <tr>${th("Last processed sequence", TIPS.lastProcessedSeq)}<td>${pr.lastProcessedSequence}</td></tr>
      <tr>${th("Last batch received", TIPS.lastBatchReceived)}<td>${fmtTime(pr.lastBatchReceivedTimeS, "s")} (${fmtAgo(pr.lastBatchReceivedTimeS)})</td></tr>
      <tr>${th("Last replay request", TIPS.lastReplayRequest)}<td>${pr.lastReplayRequestTimeS > 0n ? `${fmtTime(pr.lastReplayRequestTimeS, "s")} (${fmtAgo(pr.lastReplayRequestTimeS)})` : "—"}</td></tr>
    </table>

    ${table({
      id: "ah-collection-states",
      title: "Collection states",
      head: `${th("Identifier", TIPS.identifier)}${th("Ring count", TIPS.ringCount)}${th("Next idx", TIPS.nextIdx)}${th("Missing (attempts)", TIPS.missing)}${th("Deleted", TIPS.deleted)}`,
      rows: stateRows,
      cols: 5,
      searchable: true,
    })}

    ${table({
      id: "ah-rings",
      title: "Ring roots (latest received)",
      head: `${th("Identifier", TIPS.identifier)}${th("Ring", TIPS.ringIndex)}${th("Rev", TIPS.revision)}${th("Root", TIPS.root)}${th("Src seq", TIPS.srcSeq)}${th("Sealed", TIPS.ahSealed)}`,
      rows: ringRows,
      cols: 6,
      searchable: true,
    })}
  </section>`;
}

export function renderInTransit(rows: InTransitRow[]): string {
  const body = [...rows]
    .sort((x, y) => y.ringIndex - x.ringIndex || x.identifier.localeCompare(y.identifier))
    .map((r) => {
      const status =
        r.ahRevision === null
          ? `<span class="bad">not on AH</span>`
          : r.behindBy > 0
            ? `<span class="warn">AH behind by ${r.behindBy}</span>`
            : `<span class="ok">in sync</span>`;
      return `<tr${identAttr(r.identifier)}>${identCell(r.identifier)}<td>${r.ringIndex}</td><td>${r.peopleRevision}</td><td>${r.ahRevision ?? "—"}</td><td>${status}</td></tr>`;
    })
    .join("");
  return `
  <section class="panel full">
    ${table({
      id: "intransit",
      title: "In transit",
      tip: TIPS.inTransit,
      head: `${th("Identifier", TIPS.identifier)}${th("Ring", TIPS.ringIndex)}${th("People rev", TIPS.peopleRev)}${th("AH rev", TIPS.ahRev)}${th("Status", TIPS.inTransitStatus)}`,
      rows: body,
      cols: 5,
      searchable: true,
    })}
  </section>`;
}

/** A block number rendered as a deep link into the PAPI explorer for its chain. */
function blockLink(block: number | null, chain: "people" | "assetHub", ep: Endpoints): string {
  if (block === null) return "";
  const endpoint = chain === "people" ? ep.people : ep.assetHub;
  return `<a class="block-link" href="${papiConsoleUrl(endpoint, block)}" target="_blank" rel="noopener" title="Open ${chain === "people" ? "People" : "Asset Hub"} block #${block} in the PAPI explorer">#${block}</a>`;
}

/** time + clickable block label, e.g. "12:01:03 #1234" where #1234 links to the explorer. */
function tb(timeMs: number | null, block: number | null, chain: "people" | "assetHub", ep: Endpoints): string {
  if (block === null && timeMs === null) return "—";
  const t = timeMs ? fmtTime(timeMs, "ms") : "—";
  return `${t}${block !== null ? ` <small>${blockLink(block, chain, ep)}</small>` : ""}`;
}

function ringLabel(identifier: string | null, ringIndex: number | null): string {
  if (!identifier) return `<span class="muted">pending</span>`;
  return `<span class="ident" title="${identifier}">${escapeHtml(identifierLabel(identifier))}</span> · ${ringIndex}`;
}

export function renderHistory(h: HistoryResult, ep: Endpoints): string {
  const notes = h.notes.length
    ? `<div class="notes">${h.notes.map((n) => `<div>⚠️ ${escapeHtml(n)}</div>`).join("")}</div>`
    : "";
  const summary = `
    <div class="hist-summary" title="${TIPS.historyWindow}">
      <div><b>People</b> window ${tb(h.people.fromTimeMs, h.people.fromBlock, "people", ep)} → ${tb(h.people.headTimeMs, h.people.headBlock, "people", ep)} · ${h.scannedPeople} blocks scanned</div>
      <div><b>Asset Hub</b> window ${tb(h.assetHub.fromTimeMs, h.assetHub.fromBlock, "assetHub", ep)} → ${tb(h.assetHub.headTimeMs, h.assetHub.headBlock, "assetHub", ep)} · ${h.scannedAh} blocks scanned</div>
      <div>${h.registrations.length} registrations · ${h.rings.length} ring builds · ${h.events.length} events${h.inProgress ? " · <span class=\"warn\">scanning…</span>" : ""}</div>
    </div>`;

  return `
  <section class="panel full">
    <h2>History <small>3-stage pipeline: register → ring built (People) → received (AH)</small></h2>
    ${notes}
    ${summary}
    ${renderRegistrationDelays(h.registrations, ep)}
    ${renderRingLifecycles(h.rings, ep)}
    ${renderTimeline(h.events, ep)}
  </section>`;
}

function renderRegistrationDelays(rows: RegistrationDelay[], ep: Endpoints): string {
  const body = rows
    .map((r) => {
      const total = r.totalMs;
      const slow =
        total !== null
          ? total >= SLOW_LAG_MS
          : r.pending && r.regTimeMs !== null && Date.now() - r.regTimeMs >= SLOW_LAG_MS;
      const flag = r.pending
        ? `<span class="bad">pending</span>`
        : slow
          ? `<span class="bad">slow</span>`
          : `<span class="ok">ok</span>`;
      const totalCell =
        total !== null
          ? `<span class="${slow ? "bad" : ""}">${fmtDuration(total)}</span>`
          : r.pending && r.regTimeMs
            ? `<span class="bad">${fmtDuration(Date.now() - r.regTimeMs)}+</span>`
            : "—";
      const search = escapeHtml(
        `${r.memberKey} ${r.identifier ? identifierLabel(r.identifier) : "pending"}`.toLowerCase(),
      );
      return `<tr data-ident="${search}">
        <td class="mono" title="${r.memberKey}">${shortHex(r.memberKey)}</td>
        <td>${tb(r.regTimeMs, r.regBlock, "people", ep)}</td>
        <td>${ringLabel(r.identifier, r.ringIndex)}</td>
        <td>${tb(r.builtTimeMs, r.builtBlock, "people", ep)}</td>
        <td>${tb(r.receivedTimeMs, r.receivedBlock, "assetHub", ep)}</td>
        <td>${r.onboardMs !== null ? fmtDuration(r.onboardMs) : "—"}</td>
        <td>${r.propagationMs !== null ? fmtDuration(r.propagationMs) : "—"}</td>
        <td>${totalCell}</td>
        <td>${flag}</td>
      </tr>`;
    })
    .join("");
  return table({
    id: "history-registrations",
    title: "Registrations → Asset Hub",
    tip: TIPS.regDelayTable,
    head: `${th("Member", TIPS.identifier)}${th("Registered", TIPS.regCol)}${th("Ring", TIPS.ringCol)}${th("Onboarded", TIPS.builtCol)}${th("Received (AH)", TIPS.receivedCol)}${th("reg→onboard", TIPS.regToOnboard)}${th("onboard→AH", TIPS.onboardToAh)}${th("total", TIPS.endToEnd)}${th("", TIPS.statusFlag)}`,
    rows: body,
    cols: 9,
    searchable: true,
    scroll: true,
    exportKey: "registrations",
  });
}

function renderRingLifecycles(rings: RingLifecycle[], ep: Endpoints): string {
  const body = rings
    .map((r) => {
      const note = r.receivedBeforeWindow
        ? `<span class="muted">received before window</span>`
        : r.receivedBlock === null
          ? `<span class="bad">not on AH</span>`
          : `<span class="ok">received</span>`;
      return `<tr${identAttr(r.identifier)}>
        ${identCell(r.identifier)}
        <td>${r.ringIndex}</td>
        <td>${tb(r.builtTimeMs, r.builtBlock, "people", ep)}</td>
        <td>${tb(r.receivedTimeMs, r.receivedBlock, "assetHub", ep)}</td>
        <td>${r.propagationMs !== null ? fmtDuration(r.propagationMs) : "—"}</td>
        <td>${note}</td>
      </tr>`;
    })
    .join("");
  return table({
    id: "history-rings",
    title: "Ring lifecycle (built → received)",
    tip: TIPS.lifecycle,
    head: `${th("Identifier", TIPS.identifier)}${th("Ring", TIPS.ringIndex)}${th("Built (People)", TIPS.builtPeople)}${th("Received (AH)", TIPS.appliedAh)}${th("propagation", TIPS.onboardToAh)}${th("Status", TIPS.statusFlag)}`,
    rows: body,
    cols: 6,
    searchable: true,
    scroll: true,
    exportKey: "rings",
  });
}

function renderTimeline(events: TimedEvent[], ep: Endpoints): string {
  const body = events
    .map((e) => {
      const where = e.chain === "people" ? "People" : "AH";
      const ring =
        e.identifier !== undefined
          ? `${identifierLabel(e.identifier)}${e.ringIndex !== undefined ? ` · ${e.ringIndex}` : ""}`
          : "";
      const detail = [ring, e.detail].filter(Boolean).join(" — ");
      const search = escapeHtml(`${e.kind} ${ring} ${e.detail ?? ""}`.toLowerCase());
      return `<tr class="${e.chain}" data-ident="${search}"><td>${e.timeMs ? fmtTime(e.timeMs, "ms") : "—"}</td><td><small>${blockLink(e.block, e.chain, ep)}</small></td><td>${where}</td><td>${escapeHtml(e.kind)}</td><td class="mono detail">${escapeHtml(detail)}</td></tr>`;
    })
    .join("");
  return table({
    id: "history-timeline",
    title: "Event timeline",
    tip: TIPS.timeline,
    head: `<th>Time</th><th>Block</th><th>Chain</th><th>Event</th><th>Detail</th>`,
    rows: body,
    cols: 5,
    searchable: true,
    scroll: true,
    exportKey: "timeline",
  });
}

function emptyRow(cols: number): string {
  return `<tr><td colspan="${cols}" class="empty">no data</td></tr>`;
}
