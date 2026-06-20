// Charts for the summit Stats page (Chart.js).
//
// Two kinds:
//   - per-metric growth charts (one line) on each metric card;
//   - recycler inflow/outflow flow charts (two lines: in vs out), by event count and
//     by CASH value.
//
// Every chart supports pan + zoom (chartjs-plugin-zoom) and can be opened full screen.
// Inline charts require Ctrl/⌘ for wheel-zoom so normal page scroll still works; the
// full-screen view zooms with a bare wheel. The full-screen modal rebuilds the chart
// from a stored config, so any chart can be promoted to full screen by its key.

import { Chart, type ChartConfiguration, type ChartDataset, registerables } from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import type { MetricResult, RecyclerFlow } from "./stats";

Chart.register(...registerables, zoomPlugin);

type LineConfig = ChartConfiguration<"line", { x: number; y: number }[]>;

const inlineInstances = new Map<string, Chart>(); // chartKey -> inline chart
const configs = new Map<string, LineConfig>(); // chartKey -> full-screen config
let fullscreenInstance: Chart | null = null;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function xLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fmtNum = (n: number, cash: boolean) =>
  cash ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.round(n).toLocaleString();

function zoomOptions(fullscreen: boolean) {
  return {
    pan: { enabled: true, mode: "xy" as const },
    zoom: {
      wheel: { enabled: true, modifierKey: fullscreen ? undefined : ("ctrl" as const) },
      pinch: { enabled: true },
      mode: "xy" as const,
    },
  };
}

/** Shared line-chart config; `datasets` already built by the caller. */
function lineConfig(
  datasets: ChartDataset<"line", { x: number; y: number }[]>[],
  startMs: number,
  fullscreen: boolean,
  opts: { cash: boolean; legend: boolean },
): LineConfig {
  const muted = cssVar("--muted", "#9aa3b2");
  const border = cssVar("--border", "#2a2f3a");
  const text = cssVar("--text", "#e6e9ef");
  return {
    type: "line",
    data: { datasets },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear",
          min: startMs,
          ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: fullscreen ? 10 : 5, callback: (v) => xLabel(Number(v)) },
          grid: { color: border },
        },
        y: {
          type: "linear",
          min: 0,
          ticks: { color: muted, maxTicksLimit: fullscreen ? 8 : 4, callback: (v) => fmtNum(Number(v), opts.cash) },
          grid: { color: border },
        },
      },
      plugins: {
        legend: { display: opts.legend, labels: { color: text, usePointStyle: true, boxWidth: 8, padding: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? xLabel(Number(items[0].parsed.x)) : ""),
            label: (item) => `${item.dataset.label}: ${fmtNum(Number(item.parsed.y), opts.cash)}${opts.cash ? " CASH" : ""}`,
          },
        },
        zoom: zoomOptions(fullscreen),
      },
    },
  };
}

function metricDatasets(metric: MetricResult): ChartDataset<"line", { x: number; y: number }[]>[] {
  const accent = cssVar("--accent", "#6ea8fe");
  return [
    {
      label: metric.label,
      data: metric.points,
      borderColor: accent,
      backgroundColor: "rgba(110,168,254,0.12)",
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 3,
      borderWidth: 1.5,
      tension: 0.15,
    },
  ];
}

function flowDatasets(flow: RecyclerFlow, which: "count" | "value"): ChartDataset<"line", { x: number; y: number }[]>[] {
  const ok = cssVar("--ok", "#4ade80");
  const bad = cssVar("--bad", "#f87171");
  const s = flow[which];
  return [
    { label: "inflow (loaded)", data: s.inflow, borderColor: ok, backgroundColor: "rgba(74,222,128,0.10)", fill: true, pointRadius: 0, pointHoverRadius: 3, borderWidth: 1.5, tension: 0.15 },
    { label: "outflow (unloaded)", data: s.outflow, borderColor: bad, backgroundColor: "rgba(248,113,113,0.08)", fill: true, pointRadius: 0, pointHoverRadius: 3, borderWidth: 1.5, tension: 0.15 },
  ];
}

function render(root: ParentNode, selector: string, key: string, inline: LineConfig, full: LineConfig): void {
  const canvas = root.querySelector<HTMLCanvasElement>(selector);
  inlineInstances.get(key)?.destroy();
  inlineInstances.delete(key);
  configs.set(key, full); // always keep latest config so full-screen reflects current data
  if (!canvas) return;
  inlineInstances.set(key, new Chart(canvas, inline));
}

/** (Re)draw a metric card chart. Key: `metric:<metric.key>`. */
export function drawMetricChart(root: ParentNode, metric: MetricResult, startMs: number): void {
  const key = `metric:${metric.key}`;
  const cash = metric.key === "cashHolders" || metric.key === "airdropPot" || metric.key === "gamePot";
  render(
    root,
    `canvas[data-metric="${metric.key}"]`,
    key,
    lineConfig(metricDatasets(metric), startMs, false, { cash, legend: false }),
    lineConfig(metricDatasets(metric), startMs, true, { cash, legend: false }),
  );
}

/** (Re)draw a recycler flow chart. `which` is "count" or "value". Key: `flow:<which>`. */
export function drawFlowChart(root: ParentNode, which: "count" | "value", flow: RecyclerFlow, startMs: number): void {
  const cash = which === "value";
  render(
    root,
    `canvas[data-flow="${which}"]`,
    `flow:${which}`,
    lineConfig(flowDatasets(flow, which), startMs, false, { cash, legend: true }),
    lineConfig(flowDatasets(flow, which), startMs, true, { cash, legend: true }),
  );
}

/** Reset pan/zoom on an inline chart (by key). */
export function resetStatsZoom(key: string): void {
  (inlineInstances.get(key) as unknown as { resetZoom?: () => void } | undefined)?.resetZoom?.();
}

/** Open `key`'s chart full screen in `canvas` (rebuilds from the stored full config). */
export function openStatsFullscreen(canvas: HTMLCanvasElement, key: string): boolean {
  const cfg = configs.get(key);
  closeStatsFullscreen();
  if (!cfg) return false;
  fullscreenInstance = new Chart(canvas, cfg);
  return true;
}
export function resetFullscreenZoom(): void {
  (fullscreenInstance as unknown as { resetZoom?: () => void } | null)?.resetZoom?.();
}
export function closeStatsFullscreen(): void {
  fullscreenInstance?.destroy();
  fullscreenInstance = null;
}

/** Tear down every stats chart (on disconnect / network switch). */
export function destroyMetricCharts(): void {
  for (const c of inlineInstances.values()) c.destroy();
  inlineInstances.clear();
  configs.clear();
  closeStatsFullscreen();
}
