// One-off: find a recent block containing a `Pgas.claim_pgas` transaction on the
// Paseo "next" network and print it in human-readable form, including every
// transaction extension carried by the extrinsic.
//
// NOTE: `claim_pgas` lives in the `Pgas` pallet, which on this network is
// deployed on ASSET HUB, not the People chain (the People runtime has no Pgas
// pallet). The script verifies this against live metadata before scanning.
//
// `claim_pgas` is dispatched as a v5 "general" transaction (no signature): the
// origin is authorized by the `AsPgas` transaction extension instead.
//
// Usage:
//   node scripts/find-claim-pgas.mjs [--ws wss://...] [--max 4000] [--block <hash|number>]
//
// Decoders are pulled directly from the pnpm store (papi internals) since they
// are not direct dependencies of this project.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href);

const sb = await imp(
  "node_modules/.pnpm/@polkadot-api+substrate-bindings@0.17.0/node_modules/@polkadot-api/substrate-bindings/dist/esm/index.mjs",
);
const mb = await imp(
  "node_modules/.pnpm/@polkadot-api+metadata-builders@0.13.9/node_modules/@polkadot-api/metadata-builders/dist/esm/index.mjs",
);
const papi = await import("polkadot-api");
const { getWsProvider } = await import("polkadot-api/ws-provider/web");

const {
  decAnyMetadata,
  unifyMetadata,
  extrinsicFormat,
  compactNumber,
  Tuple,
  Binary,
} = sb;
const { getLookupFn, getDynamicBuilder } = mb;
const { createClient } = papi;

// ---- CLI args -------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const WS = getArg("ws", "wss://paseo-asset-hub-next-rpc.polkadot.io");
const MAX_BLOCKS = Number(getArg("max", "5000"));
const BATCH = 40;
const ONE_BLOCK = getArg("block", null); // optional: inspect a specific block

const TARGET_PALLET = 99; // Pgas
const TARGET_CALL = 0; // claim_pgas

const u8a = (hex) => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};

const u32le = (n) =>
  "0x" +
  [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// The legacy `state_getMetadata` RPC only returns V14, whose extrinsic type ids
// (call/address/signature) are absent — useless for decoding v5 transactions.
// Fetch V16 (falling back to V15) via the `Metadata_metadata_at_version`
// runtime call, which returns `Option<OpaqueMetadata>`.
async function fetchMetadata(req, hash) {
  for (const ver of [16, 15]) {
    const optHex = await req("state_call", [
      "Metadata_metadata_at_version",
      u32le(ver),
      hash,
    ]);
    const b = u8a(optHex);
    if (b[0] === 0) continue; // None
    const rest = b.slice(1); // Vec<u8>: compact len + raw metadata
    const len = compactNumber.dec(rest);
    return { version: ver, bytes: rest.slice(compactNumber.enc(len).length) };
  }
  throw new Error("No V15/V16 metadata available from runtime");
}

// ---- build a decoder from raw metadata bytes ------------------------------
function buildDecoder(metadataBytes) {
  const m = unifyMetadata(decAnyMetadata(metadataBytes));
  const lookup = getLookupFn(m);
  const dyn = getDynamicBuilder(lookup);

  const callCodec = dyn.buildDefinition(m.extrinsic.call);
  const addrCodec = dyn.buildDefinition(m.extrinsic.address);
  const sigCodec = dyn.buildDefinition(m.extrinsic.signature);
  // signedExtensions is keyed by extension version: { "0": [{identifier,type,..}] }
  const seByVer = m.extrinsic.signedExtensions;

  const extCodecsFor = (ver) =>
    (seByVer[String(ver)] || []).map((e) => ({
      identifier: e.identifier,
      codec: dyn.buildDefinition(e.type),
    }));

  function stripLengthPrefix(bytes) {
    const len = compactNumber.dec(bytes);
    const consumed = compactNumber.enc(len).length;
    const rest = bytes.slice(consumed);
    return len === rest.length ? rest : bytes; // fall back if not prefixed
  }

  function decodeExtrinsic(hex) {
    let bytes = stripLengthPrefix(u8a(hex));
    const fmt = extrinsicFormat.dec(bytes.slice(0, 1));
    bytes = bytes.slice(1);

    if (fmt.type === "signed") {
      const exts = extCodecsFor(0);
      const parts = Tuple(
        addrCodec,
        sigCodec,
        ...exts.map((e) => e.codec),
        callCodec,
      ).dec(bytes);
      const [address, signature, ...rest] = parts;
      const call = rest.pop();
      return {
        format: `v${fmt.version} signed`,
        address,
        signature,
        extensions: exts.map((e, i) => ({ identifier: e.identifier, value: rest[i] })),
        call,
      };
    }

    if (fmt.type === "general") {
      const extVersion = bytes[0];
      bytes = bytes.slice(1);
      const exts = extCodecsFor(extVersion);
      const parts = Tuple(...exts.map((e) => e.codec), callCodec).dec(bytes);
      const call = parts.pop();
      return {
        format: `v${fmt.version} general`,
        extensionVersion: extVersion,
        extensions: exts.map((e, i) => ({ identifier: e.identifier, value: parts[i] })),
        call,
      };
    }

    // bare (inherent / unsigned)
    return { format: `v${fmt.version} bare`, call: callCodec.dec(bytes) };
  }

  return { m, decodeExtrinsic };
}

// ---- pretty printing ------------------------------------------------------
function pretty(v) {
  if (v == null) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function") return undefined;
  if (v instanceof Binary || (v && typeof v.asHex === "function")) {
    const hex = v.asHex();
    return hex;
  }
  if (v instanceof Uint8Array) return "0x" + Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return v.map(pretty);
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const p = pretty(val);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  return v;
}

const banner = (s) => `\n${"=".repeat(72)}\n${s}\n${"=".repeat(72)}`;

// ---- main -----------------------------------------------------------------
const client = createClient(getWsProvider(WS));
const req = (method, params = []) => client._request(method, params);

try {
  console.log(`Connecting to ${WS} ...`);
  const finalized = await client.getFinalizedBlock();
  console.log(`Finalized head: #${finalized.number}  ${finalized.hash}`);

  // Live metadata at finalized head — guarantees the decoder matches the runtime.
  const meta = await fetchMetadata(req, finalized.hash);
  const { m, decodeExtrinsic } = buildDecoder(meta.bytes);
  const hasPgas = m.pallets.some((p) => p.name === "Pgas");
  console.log(
    `Runtime metadata v${m.version}, ${m.pallets.length} pallets, Pgas pallet present: ${hasPgas}`,
  );
  if (!hasPgas) {
    console.log(
      "\n!! This chain has no `Pgas` pallet, so it cannot contain `claim_pgas`.\n" +
        "   On the Paseo-next network the Pgas pallet lives on Asset Hub.\n" +
        "   Re-run against Asset Hub: --ws wss://paseo-asset-hub-next-rpc.polkadot.io",
    );
    process.exit(3);
  }

  const tsCallId = (() => {
    const ts = m.pallets.find((p) => p.name === "Timestamp");
    return ts ? ts.index : -1;
  })();

  async function getBlock(numberOrHash) {
    const hash =
      typeof numberOrHash === "string" && numberOrHash.startsWith("0x")
        ? numberOrHash
        : await req("chain_getBlockHash", [Number(numberOrHash)]);
    const res = await req("chain_getBlock", [hash]);
    return { hash, header: res.block.header, extrinsics: res.block.extrinsics };
  }

  function scanBlock(block, blockNumber) {
    const hits = [];
    let timestamp = null;
    block.extrinsics.forEach((xt, index) => {
      let decoded;
      try {
        decoded = decodeExtrinsic(xt);
      } catch (e) {
        return; // skip undecodable
      }
      const c = decoded.call;
      // Timestamp.set inherent → block time
      if (c?.value && c?.type === "Timestamp" && c.value.type === "set") {
        timestamp = Number(c.value.value.now);
      }
      if (c?.type === "Pgas" && c?.value?.type === "claim_pgas") {
        hits.push({ index, decoded, raw: xt });
      }
    });
    return { hits, timestamp };
  }

  // Single-block mode
  if (ONE_BLOCK) {
    const block = await getBlock(ONE_BLOCK);
    const num = parseInt(block.header.number, 16);
    const { hits, timestamp } = scanBlock(block, num);
    report(num, block.hash, timestamp, hits);
    process.exit(hits.length ? 0 : 2);
  }

  // Backward scan
  const headNum = finalized.number;
  const stopAt = Math.max(0, headNum - MAX_BLOCKS);
  console.log(
    `\nScanning finalized blocks #${headNum} → #${stopAt} for Pgas.claim_pgas (pallet ${TARGET_PALLET}, call ${TARGET_CALL}) ...`,
  );

  let found = null;
  for (let hi = headNum; hi > stopAt && !found; hi -= BATCH) {
    const lo = Math.max(stopAt + 1, hi - BATCH + 1);
    const nums = [];
    for (let n = hi; n >= lo; n--) nums.push(n);
    const blocks = await Promise.all(
      nums.map(async (n) => {
        try {
          return { n, ...(await getBlock(n)) };
        } catch {
          return null;
        }
      }),
    );
    for (const b of blocks) {
      if (!b) continue;
      const { hits, timestamp } = scanBlock(b, b.n);
      if (hits.length) {
        found = { num: b.n, hash: b.hash, timestamp, hits };
        break;
      }
    }
    process.stdout.write(`  …checked down to #${lo}\r`);
  }
  process.stdout.write("\n");

  if (!found) {
    console.log(
      `No Pgas.claim_pgas found in the last ${MAX_BLOCKS} finalized blocks.`,
    );
    process.exit(2);
  }

  report(found.num, found.hash, found.timestamp, found.hits);
} finally {
  client.destroy();
}

function report(num, hash, timestamp, hits) {
  console.log(banner(`Block #${num}`));
  console.log(`hash:      ${hash}`);
  if (timestamp)
    console.log(`timestamp: ${timestamp}  (${new Date(timestamp).toISOString()})`);
  console.log(`found:     ${hits.length} claim_pgas extrinsic(s)`);

  for (const { index, decoded, raw } of hits) {
    console.log(banner(`Extrinsic #${index}  —  Pgas.claim_pgas`));
    console.log(`format:    ${decoded.format}`);
    if (decoded.extensionVersion !== undefined)
      console.log(`ext ver:   ${decoded.extensionVersion}`);
    if (decoded.address !== undefined)
      console.log(`signer:    ${JSON.stringify(pretty(decoded.address))}`);

    const call = pretty(decoded.call);
    console.log(`\ncall:      ${call.type}.${call.value.type}`);
    console.log(`args:      ${JSON.stringify(call.value.value, null, 2)}`);

    console.log(`\ntransaction extensions (${decoded.extensions?.length ?? 0}):`);
    for (const ext of decoded.extensions ?? []) {
      const val = pretty(ext.value);
      const rendered =
        val === undefined ? "—" : JSON.stringify(val);
      console.log(`  • ${ext.identifier.padEnd(22)} ${rendered}`);
    }

    console.log(`\nraw extrinsic:\n${raw}`);
  }
}
