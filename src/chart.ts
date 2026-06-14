// Propagation-timing chart for the History page (Chart.js).
//
// One point per registration, plotted at its registration time (x). Three series
// show the pipeline durations (y):
//   - reg→onboard  — queue wait + cohort gating + OCW build on People
//   - onboard→AH   — propagation (XCM transit + subscriber processing)
//   - total        — end-to-end (register → reflected on Asset Hub)
//
// All available timing data is shown; the SLOW_LAG_MS threshold (the "slow" line
// used by the tables) is drawn as a horizontal marker so stalls stand out.

import { Chart, registerables, type Plugin } from "chart.js";
import { SLOW_LAG_MS } from "./config";
import type { HistoryResult, RegistrationDelay } from "./domain";
import { fmtDuration } from "./format";

Chart.register(...registerables);

/** Module-level instance: the History page hosts a single timing chart. */
let instance: Chart | null = null;

/** Container markup; the canvas is hydrated by drawTimingChart after it's in the DOM. */
export function timingChartHtml(): string {
  return `<div class="chart">
    <div class="chart-legend">
      <span class="chart-title" title="Pipeline durations per registration over the timespan scanned locally: reg→onboard (queue + cohort gating + OCW build on People), onboard→AH (propagation), and total (end-to-end). The dashed line marks the ${fmtDuration(SLOW_LAG_MS)} slow threshold used by the tables. Load more history to extend the x axis.">Propagation times over scanned window</span>
    </div>
    <div class="chart-canvas-wrap"><canvas class="timing-chart"></canvas></div>
  </div>`;
}

/** Resize the chart to its container — call when the History tab becomes visible,
 *  since Chart.js can't measure a display:none container at creation time. */
export function resizeTimingChart(): void {
  instance?.resize();
}

/** Compact x-axis / tooltip label: "MM/DD HH:MM". */
function xLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function points(
  rows: RegistrationDelay[],
  pick: (r: RegistrationDelay) => number | null,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const r of rows) {
    if (r.regTimeMs == null) continue;
    const y = pick(r);
    if (y == null) continue;
    out.push({ x: r.regTimeMs, y });
  }
  return out.sort((a, b) => a.x - b.x);
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** (Re)draw the timing chart into `root`'s canvas. Pass null to tear it down. */
export function drawTimingChart(root: ParentNode, h: HistoryResult | null): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
  const canvas = root.querySelector<HTMLCanvasElement>("canvas.timing-chart");
  if (!canvas || !h) return;

  const warn = cssVar("--warn", "#fbbf24");
  const bad = cssVar("--bad", "#f87171");
  const accent = cssVar("--accent", "#6ea8fe");
  const muted = cssVar("--muted", "#9aa3b2");
  const text = cssVar("--text", "#e6e9ef");
  const border = cssVar("--border", "#2a2f3a");

  const dataset = (
    label: string,
    color: string,
    pick: (r: RegistrationDelay) => number | null,
  ) => ({
    label,
    data: points(h.registrations, pick),
    borderColor: color,
    backgroundColor: color,
    pointRadius: 2.5,
    pointHoverRadius: 4.5,
    borderWidth: 1.5,
    tension: 0,
    spanGaps: false,
  });

  // Inline plugin: a dashed horizontal marker at the slow threshold.
  const thresholdMarker: Plugin = {
    id: "thresholdMarker",
    afterDatasetsDraw(chart) {
      const yScale = chart.scales.y;
      const y = yScale.getPixelForValue(SLOW_LAG_MS);
      const { left, right, top, bottom } = chart.chartArea;
      if (y < top || y > bottom) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = bad;
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = bad;
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(`slow ≥ ${fmtDuration(SLOW_LAG_MS)}`, right - 4, y - 3);
      ctx.restore();
    },
  };

  instance = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        dataset("reg→onboard", warn, (r) => r.onboardMs),
        dataset("onboard→AH", bad, (r) => r.propagationMs),
        dataset("total", accent, (r) => r.totalMs),
      ],
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "scanned window", color: muted },
          ticks: {
            color: muted,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
            callback: (v) => xLabel(Number(v)),
          },
          grid: { color: border },
        },
        y: {
          type: "linear",
          min: 0,
          // Keep the threshold marker visible even when all data is well below it,
          // while data above it still expands the axis.
          suggestedMax: SLOW_LAG_MS * 1.15,
          title: { display: true, text: "duration", color: muted },
          ticks: { color: muted, callback: (v) => fmtDuration(Number(v)) },
          grid: { color: border },
        },
      },
      plugins: {
        legend: { labels: { color: text, usePointStyle: true, boxWidth: 8, padding: 14 } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? xLabel(Number(items[0].parsed.x)) : ""),
            label: (item) => `${item.dataset.label}: ${fmtDuration(Number(item.parsed.y))}`,
          },
        },
      },
    },
    plugins: [thresholdMarker],
  });
}
