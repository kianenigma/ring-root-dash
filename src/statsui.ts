// Render helpers for the summit Stats page: a grid of metric cards, each with a
// live value and a growth-since-start chart (hydrated separately by statschart.ts).

import type { MetricResult, StatsResult } from "./stats";
import { escapeHtml, fmtDuration, fmtTime } from "./format";

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
    <div class="metric-chart"><canvas data-metric="${m.key}"></canvas></div>
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
  </div>`;
}
