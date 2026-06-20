// Render helpers for the summit Stats page: a grid of metric cards, each with a
// live value and a growth-since-start chart (hydrated separately by statschart.ts).

import type { AirdropEventRow, MetricResult, StatsResult } from "./stats";
import { escapeHtml, fmtDuration, fmtTime } from "./format";

const fmtCash = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });

/** Full-screen + reset-zoom controls for a chart, keyed so main.ts can target it. */
function chartTools(key: string): string {
  return `<div class="chart-tools">
    <button class="chart-zoom-reset" data-chart="${key}" title="Reset pan/zoom (drag to pan, Ctrl/⌘+wheel to zoom)">⟲</button>
    <button class="chart-fs" data-chart="${key}" title="Open full screen (bare wheel to zoom)">⤢</button>
  </div>`;
}

function chainChip(chain: MetricResult["chain"]): string {
  const label = chain === "people" ? "People" : "Asset Hub";
  return `<span class="chip na metric-chain">${label}</span>`;
}

function metricCard(m: MetricResult): string {
  return `<div class="metric-card" title="${escapeHtml(m.description)}">
    <div class="metric-head">
      <span class="k">${escapeHtml(m.label)}</span>
      ${chainChip(m.chain)}
    </div>
    <div class="v">${m.pending ? "…" : m.value.toLocaleString()}</div>
    <div class="metric-source mono" title="The exact on-chain ${m.kind === "event" ? "event" : "storage item"} scraped for this metric.">${escapeHtml(m.source)}</div>
    <div class="metric-chart">${chartTools(`metric:${m.key}`)}<canvas data-metric="${m.key}"></canvas></div>
  </div>`;
}

export function renderStats(r: StatsResult): string {
  const start = fmtTime(r.startMs, "ms");
  const headTime = Math.max(r.peopleTipTimeMs ?? 0, r.assetHubTipTimeMs ?? 0);
  const elapsed = headTime ? fmtDuration(headTime - r.startMs) : "—";
  const progress = r.inProgress
    ? `<span class="chip warn">scanning…</span>`
    : `<span class="chip ok">live</span>`;

  const meta = `<div class="stats-meta">
    <span title="The summit window starts here; all metrics accumulate from this instant.">Since <strong>${start}</strong> (${elapsed} ago)</span>
    <span title="Finalized blocks scanned in the window, per chain.">People #${r.peopleTip.toLocaleString()} · AH #${r.assetHubTip.toLocaleString()}</span>
    <span title="Blocks read on each chain over the window.">${r.scannedPeople.toLocaleString()} + ${r.scannedAh.toLocaleString()} blocks scanned</span>
    ${progress}
  </div>`;

  const notes = r.notes.length
    ? `<div class="notes">${r.notes.map((n) => `<div>• ${escapeHtml(n)}</div>`).join("")}</div>`
    : "";

  const cards = r.metrics.map(metricCard).join("");

  return `<div class="panel full">
    <h2 title="Usage statistics for the summit network, accumulated from the start instant to the chain tip.">Summit usage stats</h2>
    ${meta}
    <div class="stats-grid">${cards}</div>
    ${notes}
  </div>
  ${recyclerFlowPanel(r)}
  ${airdropEventsPanel(r)}`;
}

function recyclerFlowPanel(r: StatsResult): string {
  const f = r.recyclerFlow;
  const heldN = Math.max(0, f.count.inflowTotal - f.count.outflowTotal);
  const heldCash = Math.max(0, f.value.inflowTotal - f.value.outflowTotal);
  return `<div class="panel full">
    <h2 title="Flow of coins into and out of the coinage recyclers since the summit start. The gap between cumulative inflow and outflow is how much is currently held (locked) in recyclers.">Coinage recycler flow <small>cumulative inflow (loaded) vs outflow (unloaded)</small></h2>
    <div class="stats-meta">
      <span title="Coins loaded into / unloaded from recyclers (count).">count: <strong>${f.count.inflowTotal.toLocaleString()}</strong> in · <strong>${f.count.outflowTotal.toLocaleString()}</strong> out · <strong>${heldN.toLocaleString()}</strong> held</span>
      <span title="CASH value (each coin = 2^value × 0.01 CASH) loaded / unloaded.">value: <strong>${fmtCash(f.value.inflowTotal)}</strong> in · <strong>${fmtCash(f.value.outflowTotal)}</strong> out · <strong>${fmtCash(heldCash)} CASH</strong> held</span>
    </div>
    <div class="flow-charts">
      <div class="flow-chart">
        <div class="flow-head">Event count <small>loads vs unloaded coins</small></div>
        <div class="flow-canvas-wrap">${chartTools("flow:count")}<canvas data-flow="count"></canvas></div>
      </div>
      <div class="flow-chart">
        <div class="flow-head">Value <small>CASH (2^value weighted)</small></div>
        <div class="flow-canvas-wrap">${chartTools("flow:value")}<canvas data-flow="value"></canvas></div>
      </div>
    </div>
  </div>`;
}

function airdropRow(e: AirdropEventRow): string {
  const claimed =
    e.claimed != null
      ? `${e.claimed}${e.claimedCash != null ? ` <span class="muted">(${fmtCash(e.claimedCash)})</span>` : ""}`
      : "—";
  return `<tr>
    <td>${e.gameIndex ?? "—"}</td>
    <td>${escapeHtml(e.status)}</td>
    <td>${e.participants ?? "—"}</td>
    <td>${e.effectiveWinners ?? "—"} / ${e.maxWinners}</td>
    <td>${fmtCash(e.prizePerWinner)}</td>
    <td><strong>${fmtCash(e.totalPool)}</strong></td>
    <td>${claimed}</td>
    <td class="mono" title="draw_time">${fmtTime(e.drawTime, "s")}</td>
    <td class="mono" title="end_time (claim window closes)">${fmtTime(e.endTime, "s")}</td>
  </tr>`;
}

function airdropEventsPanel(r: StatsResult): string {
  const evs = r.airdropEvents;
  if (!evs.length) {
    const msg = r.inProgress ? "loading…" : "No active airdrop events.";
    return `<div class="panel full"><h2>Airdrop events — registered prizes per game</h2><div class="empty">${msg}</div></div>`;
  }
  const totalPool = evs.reduce((s, e) => s + e.totalPool, 0);
  const totalClaimed = evs.reduce((s, e) => s + (e.claimedCash ?? 0), 0);
  return `<div class="panel full">
    <h2 title="One active airdrop event per game, with the CASH prize registered for it. Live snapshot from Airdrop.Events storage — completed events are removed by the chain, so this shows currently scheduled / running / claiming events.">Airdrop events — registered prizes per game</h2>
    <div class="stats-meta">
      <span>${evs.length} active event(s)</span>
      <span>total registered prize pool: <strong>${fmtCash(totalPool)} CASH</strong></span>
      <span>claimed so far: <strong>${fmtCash(totalClaimed)} CASH</strong></span>
    </div>
    <div class="stats-table-wrap"><table class="stats-table">
      <thead><tr>
        <th title="Game index (decoded from the airdrop event id)">Game #</th>
        <th title="Airdrop event lifecycle stage">Status</th>
        <th title="Registered participants">Players</th>
        <th title="Effective winners / max winners">Winners</th>
        <th title="Prize per winner (CASH)">Prize/winner</th>
        <th title="Total registered prize pool = prize/winner × max winners (CASH)">Total pool</th>
        <th title="Winners that have claimed (CASH paid out)">Claimed</th>
        <th title="When winners are drawn">Draw</th>
        <th title="When the claim window closes">Ends</th>
      </tr></thead>
      <tbody>${evs.map(airdropRow).join("")}</tbody>
    </table></div>
  </div>`;
}
