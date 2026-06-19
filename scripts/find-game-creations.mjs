// One-off: find the last few `Game.schedule_games` transactions on the summit
// People chain and show their arguments — in particular, whether an airdrop was
// enabled for each scheduled game.
//
// Background (from individuality/pallets/game + airdrop):
//   `Game.schedule_games(games_schedules: Vec<GameSchedule>)` is the privileged call
//   that creates/schedules games. Each GameSchedule is:
//     { game_play_time: u32, rounds: u8, max_group_size: u32,
//       airdrop_prize: Option<AirdropPrize> }
//   A per-game airdrop is ENABLED iff `airdrop_prize` is Some. AirdropPrize is:
//     { asset_id, asset_amount, max_winners, winner_cap (Permill) }
//
// The call may be wrapped (Sudo/Utility), so we search the decoded call tree.
// Candidate blocks are found cheaply via the `Game.GamesScheduled` event (typed API),
// then the extrinsic args are decoded with live metadata (papi internals).
//
// Usage: node scripts/find-game-creations.mjs [--ws wss://...] [--n 5] [--max 80000]

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href);
const sb = await imp("node_modules/.pnpm/@polkadot-api+substrate-bindings@0.17.0/node_modules/@polkadot-api/substrate-bindings/dist/esm/index.mjs");
const mb = await imp("node_modules/.pnpm/@polkadot-api+metadata-builders@0.13.9/node_modules/@polkadot-api/metadata-builders/dist/esm/index.mjs");
const { createClient } = await import("polkadot-api");
const { getWsProvider } = await import("polkadot-api/ws-provider/web");
const { people } = await import("@polkadot-api/descriptors");

const { decAnyMetadata, unifyMetadata, extrinsicFormat, compactNumber, Tuple, Binary } = sb;
const { getLookupFn, getDynamicBuilder } = mb;

const argv = process.argv.slice(2);
const getArg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const WS = getArg("ws", "wss://summit-people-rpc.polkadot.io");
const WANT = Number(getArg("n", "3"));
const MAX_BLOCKS = Number(getArg("max", "80000"));
const FROM = getArg("from", null); // optional: start scanning downward from this block
const BATCH = 80;

const u8a = (hex) => { const h = hex.startsWith("0x") ? hex.slice(2) : hex; const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const u32le = (n) => "0x" + [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].map((b) => b.toString(16).padStart(2, "0")).join("");

async function fetchMetadata(req, hash) {
  for (const ver of [16, 15]) {
    const optHex = await req("state_call", ["Metadata_metadata_at_version", u32le(ver), hash]);
    const b = u8a(optHex);
    if (b[0] === 0) continue;
    const rest = b.slice(1);
    const len = compactNumber.dec(rest);
    return rest.slice(compactNumber.enc(len).length);
  }
  throw new Error("No V15/V16 metadata available");
}

function buildDecoder(metadataBytes) {
  const m = unifyMetadata(decAnyMetadata(metadataBytes));
  const dyn = getDynamicBuilder(getLookupFn(m));
  const callCodec = dyn.buildDefinition(m.extrinsic.call);
  const addrCodec = dyn.buildDefinition(m.extrinsic.address);
  const sigCodec = dyn.buildDefinition(m.extrinsic.signature);
  const seByVer = m.extrinsic.signedExtensions;
  const extCodecsFor = (ver) => (seByVer[String(ver)] || []).map((e) => dyn.buildDefinition(e.type));
  const stripLen = (bytes) => { const len = compactNumber.dec(bytes); const c = compactNumber.enc(len).length; const rest = bytes.slice(c); return len === rest.length ? rest : bytes; };

  function decodeExtrinsic(hex) {
    let bytes = stripLen(u8a(hex));
    const fmt = extrinsicFormat.dec(bytes.slice(0, 1));
    bytes = bytes.slice(1);
    if (fmt.type === "signed") {
      const exts = extCodecsFor(0);
      const parts = Tuple(addrCodec, sigCodec, ...exts, callCodec).dec(bytes);
      return { format: "signed", address: parts[0], call: parts[parts.length - 1] };
    }
    if (fmt.type === "general") {
      const extVersion = bytes[0];
      bytes = bytes.slice(1);
      const exts = extCodecsFor(extVersion);
      const parts = Tuple(...exts, callCodec).dec(bytes);
      return { format: "general", call: parts[parts.length - 1] };
    }
    return { format: "bare", call: callCodec.dec(bytes) };
  }
  return { m, decodeExtrinsic };
}

function pretty(v) {
  if (v == null) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function") return undefined;
  if (v instanceof Binary || (v && typeof v.asHex === "function")) return v.asHex();
  if (v instanceof Uint8Array) return "0x" + Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return v.map(pretty);
  if (typeof v === "object") { const o = {}; for (const [k, val] of Object.entries(v)) { const p = pretty(val); if (p !== undefined) o[k] = p; } return o; }
  return v;
}

/** Recursively find every Game.schedule_games call in a decoded call tree (handles
 *  Sudo/Utility wrapping). Returns the args objects ({ games_schedules: [...] }). */
function findScheduleGames(call) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Game" && node.value?.type === "schedule_games") {
      found.push(node.value.value);
      return;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(call);
  return found;
}

const banner = (s) => `\n${"=".repeat(74)}\n${s}\n${"=".repeat(74)}`;
const fmtTime = (unixSecs) => { const ms = Number(unixSecs) * 1000; return `${unixSecs} (${new Date(ms).toISOString()})`; };

const client = createClient(getWsProvider(WS));
const req = (m, p = []) => client._request(m, p);
try {
  console.log(`Connecting to ${WS} ...`);
  const api = client.getTypedApi(people);
  const head = await client.getFinalizedBlock();
  console.log(`Finalized head: #${head.number}`);
  const { decodeExtrinsic } = buildDecoder(await fetchMetadata(req, head.hash));

  // 1) Find candidate blocks (most-recent first) via the Game.GamesScheduled event,
  //    decoding + printing each as it's found.
  const candidates = [];
  let txCount = 0;
  const top = FROM ? Number(FROM) : head.number;
  const stopAt = Math.max(1, top - MAX_BLOCKS);
  console.log(`Scanning #${top} → #${stopAt} for Game.GamesScheduled events…`);
  for (let hi = top; hi > stopAt && txCount < WANT; hi -= BATCH) {
    const lo = Math.max(stopAt + 1, hi - BATCH + 1);
    const nums = []; for (let n = hi; n >= lo; n--) nums.push(n);
    const results = await Promise.all(nums.map(async (n) => {
      const h = await req("chain_getBlockHash", [n]).catch(() => null);
      if (!h) return null;
      let recs; try { recs = await api.query.System.Events.getValue({ at: h }); } catch { return null; }
      const hit = recs.some((r) => r.event.type === "Game" && r.event.value?.type === "GamesScheduled");
      return hit ? { n, h } : null;
    }));
    // Decode + print each hit immediately (most-recent first), so results stream out
    // even if the scan is slow or interrupted. Stop once we've printed WANT of them.
    for (const r of results) {
      if (!r) continue;
      candidates.push(r);
      if (decodeAndPrint(r.n, r.h, await req("chain_getBlock", [r.h]))) txCount++;
      if (txCount >= WANT) break;
    }
    if (txCount >= WANT) break;
    process.stdout.write(`  …checked down to #${lo}, printed ${txCount}\r`);
  }
  process.stdout.write("\n");
  console.log(
    txCount === 0
      ? `No Game.schedule_games transactions found in the last ${MAX_BLOCKS} blocks.`
      : `\nPrinted ${txCount} schedule_games transaction(s).`,
  );
} finally {
  client.destroy();
}

function decodeAndPrint(n, h, blk) {
  let ts = null;
  for (const xt of blk.block.extrinsics) {
    let dec; try { dec = decodeExtrinsic(xt); } catch { continue; }
    if (dec.call?.type === "Timestamp" && dec.call.value?.type === "set") ts = Number(dec.call.value.value.now);
  }
  let printed = false;
  blk.block.extrinsics.forEach((xt, index) => {
    let dec; try { dec = decodeExtrinsic(xt); } catch { return; }
    const schedules = findScheduleGames(dec.call);
    if (schedules.length === 0) return;
    printed = true;
    console.log(banner(`Block #${n}  ext #${index}  —  Game.schedule_games  (${dec.format})`));
    if (ts) console.log(`block time: ${new Date(ts).toISOString()}`);
    if (dec.address !== undefined) console.log(`signer:     ${JSON.stringify(pretty(dec.address))}`);
    for (const args of schedules) {
      const games = pretty(args.games_schedules) ?? [];
      console.log(`scheduled ${games.length} game(s):`);
      games.forEach((g, i) => {
        const prize = g.airdrop_prize;
        const airdrop = prize
          ? `YES  asset_id=${JSON.stringify(prize.asset_id)} amount=${prize.asset_amount} max_winners=${prize.max_winners} winner_cap=${prize.winner_cap}(ppm)`
          : "NO";
        console.log(
          `  [${i}] play_time=${fmtTime(g.game_play_time)}  rounds=${g.rounds}  max_group_size=${g.max_group_size}\n` +
          `      airdrop: ${airdrop}`,
        );
      });
    }
  });
  return printed;
}
