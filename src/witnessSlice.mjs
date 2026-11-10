// WITNESS-V1: A FIXED SLICE OF MONERO BLOCKS, WITHOUT AN ORDER.
//
// The arrival check must not tell a public Monero node which order a visitor is checking. An exact `get_block`
// height is exactly that: the order's start and the payout block. This module serves one grid slice instead:
// a fixed number of consecutive blocks, aligned to a multiple of the grid, with no caller-provided height inside
// the slice.
//
// It reads only: no wallet, no keys, no transactions are signed, and no order id is accepted or logged.
//
// The slice is one HTTP request to the caller, but the daemon still has `get_block` per height. That is why the
// endpoint exists: the caller sends one slice number; the daemon sees a complete fixed slice, not the one height
// that belongs to an order.

export const WITNESS_VERSION = 1;
export const WITNESS_SLICE_BLOCKS = 20;

const HEX64 = /^[0-9a-f]{64}$/i;

export class WitnessSliceError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.name = "WitnessSliceError";
    this.code = code;
    this.params = params;
  }
}

export function witnessSliceBounds(slice, { grid = WITNESS_SLICE_BLOCKS } = {}) {
  const size = Number(grid);
  const index = Number(slice);
  if (!Number.isSafeInteger(size) || size <= 0) throw new WitnessSliceError("bad-grid", { grid });
  if (!Number.isSafeInteger(index) || index < 0) throw new WitnessSliceError("bad-slice", { slice });
  const from = index * size;
  if (!Number.isSafeInteger(from)) throw new WitnessSliceError("bad-slice", { slice });
  return { grid: size, slice: index, from, to: from + size - 1 };
}

/**
 * THE REQUEST IS CLOSED. The only fields are the protocol version, the network, the fixed grid and the slice.
 * A client that sends a height, a txid, an order id or a block hash is refused: adding such a field later
 * would silently restore the leak this endpoint exists to remove.
 */
export function parseWitnessSliceRequest(body, { network, grid = WITNESS_SLICE_BLOCKS } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WitnessSliceError("bad-request");
  const keys = Object.keys(body).sort();
  const allowed = ["grid", "network", "slice", "version"];
  if (keys.length !== allowed.length || keys.some((key, i) => key !== allowed[i])) {
    throw new WitnessSliceError("bad-request", { unexpected: keys.filter((key) => !allowed.includes(key)) });
  }
  if (body.version !== WITNESS_VERSION) throw new WitnessSliceError("bad-version", { want: WITNESS_VERSION });
  if (body.network !== String(network)) throw new WitnessSliceError("wrong-network", { want: String(network) });
  if (body.grid !== Number(grid)) throw new WitnessSliceError("bad-grid", { want: Number(grid) });
  if (typeof body.slice !== "number") throw new WitnessSliceError("bad-slice", { slice: body.slice });
  const bounds = witnessSliceBounds(body.slice, { grid });
  return { version: WITNESS_VERSION, network: String(network), ...bounds };
}

export function daemonBaseUrl(daemonUrl) {
  const text = String(daemonUrl || "").trim();
  if (!text) throw new WitnessSliceError("daemon-unavailable", { why: "no-daemon" });
  return text.replace(/\/json_rpc\/?$/i, "").replace(/\/+$/, "");
}

async function request(daemonUrl, path, body, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(daemonBaseUrl(daemonUrl) + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    throw new WitnessSliceError("daemon-unavailable", { why: String((error && error.name) || "network").slice(0, 40) });
  }
  if (!response || response.ok !== true) {
    throw new WitnessSliceError("daemon-unavailable", { status: response ? Number(response.status) || null : null });
  }
  let answer;
  try { answer = await response.json(); }
  catch { throw new WitnessSliceError("bad-daemon-answer", { why: "bad-json" }); }
  if (answer && answer.error) throw new WitnessSliceError("bad-daemon-answer", { why: "rpc-error" });
  return answer;
}

/**
 * A JSON-RPC read. Only the method the caller names is sent; the witness server exposes this for `get_info`
 * and refuses every other method, so the proxy does not become an arbitrary daemon client.
 */
export async function daemonJsonRpc(daemonUrl, method, params = {}, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  const answer = await request(daemonUrl, "/json_rpc", { jsonrpc: "2.0", id: "witness", method, params }, fetchImpl, timeoutMs);
  if (!answer || !answer.result) throw new WitnessSliceError("bad-daemon-answer", { why: "no-result" });
  return answer.result;
}

/**
 * READ THE DAEMON TIP AND ITS STATE. A daemon that is behind, busy, untrusted or on another network is not a
 * witness: its height is not evidence that a payment is absent. `/health`, `/json_rpc` and the slice route use this
 * read. `height` is the next block monerod will mine; the reachable top is one lower.
 */
export async function readDaemonTip({ daemonUrl, network, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const info = await daemonJsonRpc(daemonUrl, "get_info", {}, fetchImpl, timeoutMs);
  const height = Number(info && info.height);
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new WitnessSliceError("bad-daemon-answer", { why: "no-height" });
  }
  const why =
    info.synchronized !== true ? "not-synchronized" :
    info.busy === true || info.busy_syncing === true ? "busy" :
    info.untrusted === true ? "untrusted" :
    String(info.status || "") !== "OK" ? "status" :
    String(info.nettype || "").toLowerCase() !== String(network || "").toLowerCase() ? "wrong-network" : null;
  if (why) throw new WitnessSliceError("not-synchronized", { why });
  return { height, top: Math.max(0, height - 1), nettype: String(info.nettype) };
}

/**
 * A direct daemon route. The witness uses it for `/get_transactions`, whose request is the whole slice's txids.
 */
export async function daemonDirect(daemonUrl, path, body, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  return request(daemonUrl, path, body, fetchImpl, timeoutMs);
}

function hashOf(value) {
  const hash = String(value || "").replace(/^0x/, "").toLowerCase();
  return HEX64.test(hash) ? hash : null;
}

function txidsOf(block) {
  const list = Array.isArray(block && block.tx_hashes) ? block.tx_hashes : null;
  if (!list) throw new WitnessSliceError("bad-daemon-answer", { why: "no-tx-hashes" });
  return list.map((value) => {
    const txid = hashOf(value);
    if (!txid) throw new WitnessSliceError("bad-daemon-answer", { why: "bad-txid" });
    return txid;
  });
}

/**
 * READ ONE SLICE from the daemon. Every block in the slice is read, including empty ones, so the caller can
 * prove the whole slice was covered rather than only the block where a payment happened to be.
 */
export async function readWitnessSlice({
  daemonUrl, network, slice, grid = WITNESS_SLICE_BLOCKS, fetchImpl = globalThis.fetch, timeoutMs = 8000,
  top = null,
} = {}) {
  if (typeof fetchImpl !== "function") throw new WitnessSliceError("bad-request", { field: "fetch" });
  const bounds = witnessSliceBounds(slice, { grid });
  const tipHeight = top === null ? (await readDaemonTip({ daemonUrl, network, fetchImpl, timeoutMs })).top : Number(top);
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new WitnessSliceError("bad-slice", { why: "bad-tip", top });
  }
  if (bounds.from > tipHeight) {
    throw new WitnessSliceError("bad-slice", { why: "beyond-tip", from: bounds.from, top: tipHeight });
  }
  // THE TIP SLICE IS PARTIAL. monerod refuses a height above its top, and the client asks for the slice that
  // contains the tip on every walk. Stop at the top and name it, rather than turning a normal tip into a 502.
  const to = Math.min(bounds.to, tipHeight);
  const blocks = [];
  for (let height = bounds.from; height <= to; height++) {
    const block = await daemonJsonRpc(daemonUrl, "get_block", { height }, fetchImpl, timeoutMs);
    const hash = hashOf(block && block.block_header && block.block_header.hash);
    if (!hash) throw new WitnessSliceError("bad-daemon-answer", { why: "no-block-hash", height });
    blocks.push({ height, hash, txids: txidsOf(block) });
  }
  const complete = to === bounds.to;
  return { version: WITNESS_VERSION, network: String(network), ...bounds, to, complete,
    blocks, tip: complete ? null : { height: to, hash: blocks[blocks.length - 1].hash } };
}

/**
 * THE SHAPE A CLIENT NEEDS TO CHECK. A slice whose blocks are not consecutive, whose hash is missing, or whose
 * count differs from the grid is not a slice: the caller must refuse it, not scan a partial answer.
 */
export function assertWitnessSliceShape(slice, { network, grid = WITNESS_SLICE_BLOCKS } = {}) {
  if (!slice || typeof slice !== "object") throw new WitnessSliceError("bad-daemon-answer", { why: "no-slice" });
  if (Number(slice.version) !== WITNESS_VERSION) throw new WitnessSliceError("bad-daemon-answer", { why: "version" });
  if (String(slice.network) !== String(network)) throw new WitnessSliceError("bad-daemon-answer", { why: "network" });
  const bounds = witnessSliceBounds(slice.slice, { grid });
  const from = Number(slice.from);
  const to = Number(slice.to);
  if (Number(slice.grid) !== bounds.grid || from !== bounds.from || !Number.isSafeInteger(to) || to < bounds.from || to > bounds.to) {
    throw new WitnessSliceError("bad-daemon-answer", { why: "bounds" });
  }
  if (typeof slice.complete !== "boolean" || slice.complete !== (to === bounds.to)) {
    throw new WitnessSliceError("bad-daemon-answer", { why: "complete" });
  }
  const count = to - bounds.from + 1;
  if (!Array.isArray(slice.blocks) || slice.blocks.length !== count) {
    throw new WitnessSliceError("bad-daemon-answer", { why: "block-count" });
  }
  for (let i = 0; i < count; i++) {
    const block = slice.blocks[i];
    if (!block || Number(block.height) !== bounds.from + i) throw new WitnessSliceError("bad-daemon-answer", { why: "height" });
    if (!hashOf(block.hash)) throw new WitnessSliceError("bad-daemon-answer", { why: "hash" });
    if (!Array.isArray(block.txids) || block.txids.some((txid) => !hashOf(txid))) {
      throw new WitnessSliceError("bad-daemon-answer", { why: "txids" });
    }
  }
  if (slice.complete) {
    if (slice.tip !== null && slice.tip !== undefined) throw new WitnessSliceError("bad-daemon-answer", { why: "tip" });
  } else {
    const tip = slice.tip;
    if (!tip || typeof tip !== "object" || Number(tip.height) !== to || !hashOf(tip.hash)
      || String(tip.hash).toLowerCase() !== String(slice.blocks[count - 1].hash).toLowerCase()) {
      throw new WitnessSliceError("bad-daemon-answer", { why: "tip" });
    }
  }
  return slice;
}
