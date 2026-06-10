// Friendly names for ring-collection identifiers.
//
// A collection identifier is a 32-byte value. Most are human-readable: the People
// collections are ASCII strings, and the coinage collections are a 16-byte ASCII
// prefix followed by an index/period. This maps a raw 0x-hex identifier to a short
// label; the full hex is still shown as the cell's tooltip.

import { shortHex } from "./format";

/** Well-known fixed identifiers -> short label. (from support/src/traits/reality.rs) */
export const KNOWN_IDENTIFIERS: Record<string, string> = {
  // b"pop:polkadot.network/people     "
  "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020": "people",
  // b"pop:polkadot.network/people-lite"
  "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652d6c697465": "people-lite",
};

// Coinage prefixes (16 bytes each), from pallets/coinage/src/lib.rs.
const RECYCLER_PREFIX = "636f696e6167652f72656379636c6572"; // b"coinage/recycler"
const PAIDTKN_PREFIX = "636f696e6167652f70616964746b6e21"; // b"coinage/paidtkn!"

function bytesOf(bodyHex: string): number[] {
  return bodyHex.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [];
}

/** Decode a byte array as ASCII, trimming trailing NUL/space. Null if not printable. */
function decodeAscii(bytes: number[]): string | null {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x20)) end--;
  if (end === 0) return null;
  let out = "";
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) return null; // not cleanly printable
    out += String.fromCharCode(b);
  }
  return out;
}

/** Human-readable label for a collection identifier (0x-hex). */
export function identifierLabel(hexInput: string): string {
  const hex = (hexInput.startsWith("0x") ? hexInput : `0x${hexInput}`).toLowerCase();
  const known = KNOWN_IDENTIFIERS[hex];
  if (known) return known;

  const body = hex.slice(2);
  const bytes = bytesOf(body);

  if (body.startsWith(RECYCLER_PREFIX)) return `coinage/recycler #${bytes[16] ?? "?"}`;
  if (body.startsWith(PAIDTKN_PREFIX)) {
    const period =
      ((bytes[16] ?? 0) |
        ((bytes[17] ?? 0) << 8) |
        ((bytes[18] ?? 0) << 16) |
        ((bytes[19] ?? 0) << 24)) >>>
      0;
    return `coinage/paidtkn #${period}`;
  }

  return decodeAscii(bytes) ?? shortHex(hex);
}
