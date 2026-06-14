// Propagation-timing chart for the History page (Chart.js).
//
// One point per registration, plotted at its registration time (x). Three series
// show the pipeline durations (y):
//   - reg→onboard  — queue wait + cohort gating + OCW build on People
//   - onboard→AH   — propagation (XCM transit + subscriber processing)
//   - total        — end-to-end (register → reflected on Asset Hub)
//
// All available timing data is shown; the SLOW_LAG_MS threshold (the "slow" line
// used by the tables) is drawn as a horizontal marker so stalls stand out. The chart
// is an overview, not an exact plot — overlapping points are dropped (see dedupe).

import { Chart, type ChartConfiguration, type Plugin, registerables } from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import { SLOW_LAG_MS } from "./config";
import type { HistoryResult, RegistrationDelay } from "./domain";
import { fmtDuration } from "./format";

Chart.register(...registerables, zoomPlugin);

/** The inline (History page) chart, and the optional full-screen modal chart. */
let instance: Chart | null = null;
let modalInstance: Chart | null = null;

/** Container markup; the canvas is hydrated by drawTimingChart after it's in the DOM. */
export function timingChartHtml(): string {
  return `<div class="chart">
    <div class="chart-legend">
      <span class="chart-title" title="Pipeline durations per registration over the timespan scanned locally: reg→onboard (queue + cohort gating + OCW build on People), onboard→AH (propagation), and total (end-to-end). The dashed line marks the ${fmtDuration(SLOW_LAG_MS)} slow threshold used by the tables. Load more history to extend the x axis. Scroll to zoom, drag to pan. An overview — overlapping points are not drawn.">Propagation times over scanned window</span>
      <button class="chart-fullscreen" title="Open this chart full screen">⤢ full screen</button>
      <button class="chart-reset" title="Reset pan/zoom to fit all data">reset zoom</button>
    </div>
    <div class="chart-canvas-wrap"><canvas class="timing-chart"></canvas></div>
  </div>`;
}

/** Reset pan/zoom on whichever chart(s) exist. */
export function resetZoom(): void {
  const reset = (c: Chart | null) => (c as unknown as { resetZoom?: () => void } | null)?.resetZoom?.();
  reset(instance);
  reset(modalInstance);
}

/** Resize the inline chart to its container — call when the History tab becomes
 *  visible, since Chart.js can't measure a display:none container at creation time. */
export function resizeTimingChart(): void {
  instance?.resize();
}

/** Compact x-axis / tooltip label: "MM/DD HH:MM". */
function xLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Collect a series' points, then drop ones that would land on the same spot.
 *  The chart is an overview, so we quantise to a coarse grid (~400×120 cells over
 *  the data range) and keep one point per occupied cell — cheap, and it preserves
 *  the visual shape while cutting thousands of overplotted points. */
function points(
  rows: RegistrationDelay[],
  pick: (r: RegistrationDelay) => number | null,
): { x: number; y: number }[] {
  const raw: { x: number; y: number }[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  for (const r of rows) {
    if (r.regTimeMs == null) continue;
    const y = pick(r);
    if (y == null) continue;
    raw.push({ x: r.regTimeMs, y });
    if (r.regTimeMs < minX) minX = r.regTimeMs;
    if (r.regTimeMs > maxX) maxX = r.regTimeMs;
    if (y > maxY) maxY = y;
  }
  raw.sort((a, b) => a.x - b.x);
  if (raw.length < 2) return raw;

  const xStep = Math.max(1, (maxX - minX) / 400);
  const yStep = Math.max(1, maxY / 120);
  const seen = new Set<string>();
  const out: { x: number; y: number }[] = [];
  for (const p of raw) {
    const key = `${Math.round(p.x / xStep)}:${Math.round(p.y / yStep)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Build the full Chart.js config from the history data — shared by the inline
 *  chart and the full-screen modal. */
function buildConfig(h: HistoryResult): ChartConfiguration<"line", { x: number; y: number }[]> {
  const warn = cssVar("--warn", "#fbbf24");
  const bad = cssVar("--bad", "#f87171");
  const accent = cssVar("--accent", "#6ea8fe");
  const muted = cssVar("--muted", "#9aa3b2");
  const text = cssVar("--text", "#e6e9ef");
  const border = cssVar("--border", "#2a2f3a");

  const dataset = (label: string, color: string, pick: (r: RegistrationDelay) => number | null) => ({
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
      const y = chart.scales.y.getPixelForValue(SLOW_LAG_MS);
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

  return {
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
          ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: (v) => xLabel(Number(v)) },
          grid: { color: border },
        },
        y: {
          type: "linear",
          min: 0,
          // Keep the threshold marker visible even when all data is below it.
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
        zoom: {
          // Scroll wheel to zoom, drag to pan — both axes. "reset zoom" restores fit.
          pan: { enabled: true, mode: "xy" },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "xy" },
        },
      },
    },
    plugins: [thresholdMarker],
  };
}

/** (Re)draw the inline timing chart into `root`'s canvas. Pass null to tear it down. */
export function drawTimingChart(root: ParentNode, h: HistoryResult | null): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
  const canvas = root.querySelector<HTMLCanvasElement>("canvas.timing-chart");
  if (!canvas || !h) return;
  instance = new Chart(canvas, buildConfig(h));
}

/** Draw the chart into the full-screen modal canvas (a snapshot of `h` at open time). */
export function openTimingChartModal(canvas: HTMLCanvasElement, h: HistoryResult | null): void {
  if (modalInstance) {
    modalInstance.destroy();
    modalInstance = null;
  }
  if (!h) return;
  modalInstance = new Chart(canvas, buildConfig(h));
}

/** Tear down the modal chart (on close). */
export function closeTimingChartModal(): void {
  if (modalInstance) {
    modalInstance.destroy();
    modalInstance = null;
  }
}
