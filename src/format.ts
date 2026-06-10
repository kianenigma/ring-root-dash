// Small formatting helpers shared across the UI.

export function shortHex(hex: string, head = 6, tail = 4): string {
  if (!hex.startsWith("0x")) hex = "0x" + hex;
  if (hex.length <= 2 + head + tail) return hex;
  return `${hex.slice(0, 2 + head)}…${hex.slice(-tail)}`;
}

/** Format a unix-seconds or unix-ms instant as a local time string. */
export function fmtTime(input: number | bigint, unit: "s" | "ms"): string {
  const ms = unit === "s" ? Number(input) * 1000 : Number(input);
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  return d.toLocaleString(undefined, { hour12: false });
}

/** Human-readable duration for a millisecond delta. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return (neg ? "-" : "") + parts.join(" ");
}

/** "x ago" relative to now, given a unix-seconds instant. */
export function fmtAgo(unixSeconds: number | bigint): string {
  const ms = Number(unixSeconds) * 1000;
  if (!ms || ms <= 0) return "—";
  return fmtDuration(Date.now() - ms) + " ago";
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
