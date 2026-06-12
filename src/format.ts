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

/** Like fmtAgo but also handles future instants ("in 2h 5m"). */
export function fmtRel(unixSeconds: number | bigint): string {
  const ms = Number(unixSeconds) * 1000;
  if (!ms || ms <= 0) return "—";
  const delta = Date.now() - ms;
  return delta >= 0 ? `${fmtDuration(delta)} ago` : `in ${fmtDuration(-delta)}`;
}

/** Format a fixed-point chain amount with the given decimals, e.g. 21000000000000 / 6 -> "21,000,000". */
export function fmtUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toLocaleString("en-US");
  const fracDigits = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${fracDigits ? `.${fracDigits}` : ""}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
