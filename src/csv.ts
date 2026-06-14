// CSV export of the three History tables.
//
// Built from the domain data (HistoryResult), not from the rendered HTML, so the
// output carries plain values with all links/markup stripped. Block numbers are
// emitted as bare numbers and times as ISO-8601 (no locale commas); the in-cell
// time+block pairing from the UI is split into separate columns for processing.

import { SLOW_LAG_MS } from "./config";
import type { HistoryResult, RegistrationDelay, RingLifecycle, TimedEvent } from "./domain";
import { fmtDuration } from "./format";
import { identifierLabel } from "./identifiers";

export type HistoryTable = "registrations" | "rings" | "timeline";

type Cell = string | number | null;

/** ISO-8601 instant for a unix-ms value (empty for missing). */
function iso(ms: number | null): string {
  return ms ? new Date(ms).toISOString() : "";
}

/** Human duration for a ms delta (empty for missing). */
function dur(ms: number | null): string {
  return ms !== null ? fmtDuration(ms) : "";
}

/** Quote a field per RFC 4180 when it contains a comma, quote, or newline. */
function field(v: Cell): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows].map((r) => r.map(field).join(",")).join("\r\n");
}

function registrationsCsv(rows: RegistrationDelay[]): string {
  const headers = [
    "member_key",
    "registered_time",
    "registered_block_people",
    "collection",
    "ring_index",
    "onboarded_time",
    "onboarded_block_people",
    "received_time",
    "received_block_ah",
    "reg_to_onboard",
    "onboard_to_ah",
    "total",
    "status",
  ];
  const body: Cell[][] = rows.map((r) => {
    const slow =
      r.totalMs !== null
        ? r.totalMs >= SLOW_LAG_MS
        : r.pending && r.regTimeMs !== null && Date.now() - r.regTimeMs >= SLOW_LAG_MS;
    return [
      r.memberKey,
      iso(r.regTimeMs),
      r.regBlock,
      r.identifier ? identifierLabel(r.identifier) : "pending",
      r.ringIndex,
      iso(r.builtTimeMs),
      r.builtBlock,
      iso(r.receivedTimeMs),
      r.receivedBlock,
      dur(r.onboardMs),
      dur(r.propagationMs),
      dur(r.totalMs),
      r.pending ? "pending" : slow ? "slow" : "ok",
    ];
  });
  return toCsv(headers, body);
}

function ringsCsv(rows: RingLifecycle[]): string {
  const headers = [
    "collection",
    "ring_index",
    "built_time_people",
    "built_block_people",
    "received_time_ah",
    "received_block_ah",
    "propagation",
    "status",
  ];
  const body: Cell[][] = rows.map((r) => [
    identifierLabel(r.identifier),
    r.ringIndex,
    iso(r.builtTimeMs),
    r.builtBlock,
    iso(r.receivedTimeMs),
    r.receivedBlock,
    dur(r.propagationMs),
    r.receivedBeforeWindow
      ? "received before window"
      : r.receivedBlock === null
        ? "not on AH"
        : "received",
  ]);
  return toCsv(headers, body);
}

function timelineCsv(rows: TimedEvent[]): string {
  const headers = ["time", "block", "chain", "event", "collection", "ring_index", "detail"];
  const body: Cell[][] = rows.map((e) => [
    iso(e.timeMs),
    e.block,
    e.chain === "people" ? "People" : "AssetHub",
    e.kind,
    e.identifier !== undefined ? identifierLabel(e.identifier) : "",
    e.ringIndex ?? "",
    e.detail ?? "",
  ]);
  return toCsv(headers, body);
}

/** Build a downloadable CSV for one History table. */
export function historyCsv(h: HistoryResult, which: HistoryTable): { filename: string; content: string } {
  switch (which) {
    case "registrations":
      return { filename: "history-registrations.csv", content: registrationsCsv(h.registrations) };
    case "rings":
      return { filename: "history-ring-lifecycle.csv", content: ringsCsv(h.rings) };
    case "timeline":
      return { filename: "history-timeline.csv", content: timelineCsv(h.events) };
  }
}
