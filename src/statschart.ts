// Per-metric growth charts for the summit Stats page (Chart.js).
//
// One small line chart per metric card: x = wall-clock time since the summit start,
// y = the metric's value (cumulative count for event metrics, sampled value for
// storage metrics). Charts are redrawn in place on each live update; instances are
// tracked per metric key so the previous one is torn down first.

import { Chart, type ChartConfiguration } from "chart.js";
import type { MetricResult } from "./stats";

// chart.ts registers the controllers/scales globally on import; main.ts imports
// both, so registration has run by the time these draw.

const instances = new Map<string, Chart>();

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function xLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function config(metric: MetricResult, startMs: number): ChartConfiguration<"line", { x: number; y: number }[]> {
  const accent = cssVar("--accent", "#6ea8fe");
  const muted = cssVar("--muted", "#9aa3b2");
  const border = cssVar("--border", "#2a2f3a");
  return {
    type: "line",
    data: {
      datasets: [
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
      ],
    },
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
          ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 5, callback: (v) => xLabel(Number(v)) },
          grid: { color: border },
        },
        y: {
          type: "linear",
          min: 0,
          ticks: { color: muted, maxTicksLimit: 4, precision: 0 },
          grid: { color: border },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? xLabel(Number(items[0].parsed.x)) : ""),
            label: (item) => `${metric.label}: ${Number(item.parsed.y).toLocaleString()}`,
          },
        },
      },
    },
  };
}

/** (Re)draw the chart for one metric into its card canvas. */
export function drawMetricChart(root: ParentNode, metric: MetricResult, startMs: number): void {
  const canvas = root.querySelector<HTMLCanvasElement>(`canvas[data-metric="${metric.key}"]`);
  const existing = instances.get(metric.key);
  if (existing) {
    existing.destroy();
    instances.delete(metric.key);
  }
  if (!canvas) return;
  instances.set(metric.key, new Chart(canvas, config(metric, startMs)));
}

/** Tear down every metric chart (on disconnect / network switch). */
export function destroyMetricCharts(): void {
  for (const c of instances.values()) c.destroy();
  instances.clear();
}
