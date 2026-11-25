#!/usr/bin/env node
// WITNESS-V1 IS A SLICE, NOT A HEIGHT.
//
// The check drives the real reader and the real HTTP route against a stand-in Monero daemon. It proves four
// things that would otherwise be prose:
//   * a request names only the slice, and an extra height/txid/order field is refused;
//   * the reader covers every block in the fixed grid, empty blocks included;
//   * the route answers with the same slice and CORS, and refuses a malformed body;
//   * a partial or non-consecutive answer is rejected, not scanned.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { createWitnessServer, isLoopbackAddress, listenHostFromEnv, listenPortFromEnv } from "../src/witnessServer.mjs";
import {
  WITNESS_SLICE_BLOCKS, WitnessSliceError,
  assertWitnessSliceShape, parseWitnessSliceRequest, readWitnessSlice, witnessSliceBounds,
} from "../src/witnessSlice.mjs";

const problems = [];
const check = (condition, message) => { if (condition) console.log("  ok    " + message); else problems.push(message); };
const rejects = async (fn, code, message) => {
  try { await fn(); } catch (error) {
    check(error instanceof WitnessSliceError && error.code === code, message + (error.code ? " (" + error.code + ")" : ""));
    return;
  }
  check(false, message + " (accepted)");
};

const hash = (height) => String(height).padStart(64, "0");
const TXID = "ab".repeat(32);
const calls = [];
const daemonState = {
  height: 120, synchronized: true, nettype: "stagenet", busy: false, busy_syncing: false,
  untrusted: false, status: "OK", version: "0.18.5.4", peers: 3,
};

const daemon = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push(body);
      if (body.method === "get_info") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ...daemonState,
          top_block_hash: daemonState.top_block_hash ?? hash(daemonState.height - 1) } }));
      }
      if (body.method !== "get_block" && !Array.isArray(body.txs_hashes)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "unexpected method" } }));
      }
      if (Array.isArray(body.txs_hashes)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ txs: [{ tx_hash: TXID, block_height: 105 }], txs_as_json: ['{"version":2}'],
          status: daemonState.status, untrusted: daemonState.untrusted }));
      }
      const height = Number(body.params.height);
      if (height < 100 || height > 119) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "wrong height" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      const empty = height === 106;
      const answer = JSON.stringify({
        result: {
          block_header: { hash: hash(height), prev_hash: hash(height - 1), num_txes: empty ? 0 : (height === 105 ? 1 : 0) },
          ...(empty ? {} : { tx_hashes: height === 105 ? [TXID] : [] }),
        },
      });
      res.end(answer);
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, url: "http://127.0.0.1:" + server.address().port }));
});

const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

try {
  const bounds = witnessSliceBounds(5);
  check(bounds.from === 100 && bounds.to === 119, "slice 5 covers blocks 100..119");
  check(listenHostFromEnv({}) === "127.0.0.1", "the witness binds loopback by default");
  check(listenPortFromEnv({}) === 8796, "the witness default port avoids the screen-hook example on 8795");
  check(listenPortFromEnv({ RFQ_WITNESS_PORT: "9000" }) === 9000, "the witness port is configurable");
  check(isLoopbackAddress("127.0.0.1") && isLoopbackAddress("::1") && isLoopbackAddress("::ffff:127.0.0.1"),
    "the metrics guard recognises loopback forms");
  check(!isLoopbackAddress("203.0.113.7") && !isLoopbackAddress(""), "the metrics guard does not treat remote callers as loopback");

  await rejects(() => witnessSliceBounds(-1), "bad-slice", "a negative slice is refused");
  await rejects(() => witnessSliceBounds(1.5), "bad-slice", "a fractional slice is refused");

  const good = { version: 1, network: "stagenet", grid: WITNESS_SLICE_BLOCKS, slice: 5 };
  const parsed = parseWitnessSliceRequest(good, { network: "stagenet" });
  check(parsed.from === 100 && parsed.to === 119, "the request is expanded to the fixed bounds");
  await rejects(() => parseWitnessSliceRequest({ ...good, height: 105 }, { network: "stagenet" }), "bad-request",
    "a request carrying an exact height is refused");
  await rejects(() => parseWitnessSliceRequest({ ...good, txid: TXID }, { network: "stagenet" }), "bad-request",
    "a request carrying a txid is refused");
  await rejects(() => parseWitnessSliceRequest({ ...good, network: "mainnet" }, { network: "stagenet" }), "wrong-network",
    "a request for another network is refused");
  await rejects(() => parseWitnessSliceRequest({ ...good, grid: 10 }, { network: "stagenet" }), "bad-grid",
    "a request for another grid is refused");
  await rejects(() => parseWitnessSliceRequest({ ...good, slice: "5" }, { network: "stagenet" }), "bad-slice",
    "a string slice is refused instead of coerced");
  await rejects(() => parseWitnessSliceRequest({ ...good, version: "1" }, { network: "stagenet" }), "bad-version",
    "a string version is refused instead of coerced");

  const slice = await readWitnessSlice({ daemonUrl: daemon.url, network: "stagenet", slice: 5 });
  check(slice.blocks.length === 20, "the reader returns every block in the slice");
  check(slice.complete === true && slice.tip === null, "a slice below the tip is complete and names no partial tip");
  check(slice.blocks[0].height === 100 && slice.blocks[19].height === 119, "the slice starts and ends on the grid");
  check(slice.blocks[5].txids.length === 1 && slice.blocks[5].txids[0] === TXID, "a block keeps its transactions");
  check(slice.blocks[0].prev_hash === hash(99) && slice.blocks[0].num_txes === 0,
    "a block carries its parent hash and transaction count");
  check(slice.blocks[6].txids.length === 0, "an empty block without tx_hashes is accepted by num_txes: 0");
  const blockCalls = calls.filter((call) => call.method === "get_block");
  check(blockCalls.length === 20 && blockCalls.every((call) => call.method === "get_block"), "the daemon is asked for blocks only");
  check(blockCalls.map((call) => call.params.height).join(",") === Array.from({ length: 20 }, (_, i) => 100 + i).join(","),
    "the daemon sees the whole slice, not one order height");
  assertWitnessSliceShape(slice, { network: "stagenet" });

  // Synthetic monerod heights: height counts blocks, so slice 5 starts at the tip when height is 101.
  for (const [height, blockHeights] of [[100, []], [101, [100]], [102, [100, 101]]]) {
    daemonState.height = height;
    calls.length = 0;
    if (blockHeights.length === 0) {
      await assert.rejects(() => readWitnessSlice({ daemonUrl: daemon.url, network: "stagenet", slice: 5 }),
        (error) => error instanceof WitnessSliceError && error.code === "not-synchronized"
          && error.params.why === "beyond-tip" && error.params.from === 100 && error.params.top === 99);
    } else {
      const atTip = await readWitnessSlice({ daemonUrl: daemon.url, network: "stagenet", slice: 5 });
      assert.equal(atTip.blocks.length, blockHeights.length, "every available block is returned");
      assert.deepEqual(atTip.blocks, blockHeights.map((height) => ({ height, hash: hash(height),
        prev_hash: hash(height - 1), num_txes: 0, txids: [] })));
      assert.deepEqual({ version: atTip.version, network: atTip.network, grid: atTip.grid, slice: atTip.slice,
        from: atTip.from, to: atTip.to, complete: atTip.complete, tip: atTip.tip },
      { version: 1, network: "stagenet", grid: 20, slice: 5, from: 100, to: height - 1,
        complete: false, tip: { height: height - 1, hash: hash(height - 1) } });
      assertWitnessSliceShape(atTip, { network: "stagenet" });
    }
    assert.deepEqual(calls.filter((call) => call.method === "get_block").map((call) => call.params.height),
      blockHeights, "only existing heights are requested, including the tip itself");
    calls.length = 0;
    await assert.rejects(() => readWitnessSlice({ daemonUrl: daemon.url, network: "stagenet", slice: 6 }),
      (error) => error instanceof WitnessSliceError && error.code === "not-synchronized"
        && error.params.why === "beyond-tip" && error.params.from === 120 && error.params.top === height - 1);
    assert.equal(calls.filter((call) => call.method === "get_block").length, 0, "no block read beyond the tip");
  }
  check(true, "slice start below, at and above the tip preserves its blocks and refuses the next slice");

  daemonState.height = 116;
  calls.length = 0;
  const tipSlice = await readWitnessSlice({ daemonUrl: daemon.url, network: "stagenet", slice: 5 });
  check(tipSlice.blocks.length === 16 && tipSlice.blocks[15].height === 115,
    "the tip slice stops at the daemon's top block");
  check(tipSlice.complete === false && tipSlice.to === 115 && tipSlice.tip && tipSlice.tip.height === 115,
    "the tip slice is partial and names the tip it reached");
  check(tipSlice.tip.hash === tipSlice.blocks[15].hash, "the named tip is the last block in the partial answer");
  check(calls.filter((call) => call.method === "get_block").map((call) => call.params.height).join(",")
    === Array.from({ length: 16 }, (_, i) => 100 + i).join(","), "the reader never asks for a height above the tip");
  assertWitnessSliceShape(tipSlice, { network: "stagenet" });
  daemonState.height = 120;
  calls.length = 0;

  await rejects(() => assertWitnessSliceShape({ ...slice, blocks: slice.blocks.slice(0, 19) }, { network: "stagenet" }),
    "bad-daemon-answer", "a partial slice is refused");
  const wrongHash = { ...slice, blocks: slice.blocks.map((block, i) => i === 0 ? { ...block, hash: "not-hex" } : block) };
  await rejects(() => assertWitnessSliceShape(wrongHash, { network: "stagenet" }), "bad-daemon-answer",
    "a bad block hash is refused");
  const wrongHeight = { ...slice, blocks: slice.blocks.map((block, i) => i === 0 ? { ...block, height: 101 } : block) };
  await rejects(() => assertWitnessSliceShape(wrongHeight, { network: "stagenet" }), "bad-daemon-answer",
    "a non-consecutive block height is refused");
  const wrongParent = { ...slice, blocks: slice.blocks.map((block, i) => i === 1 ? { ...block, prev_hash: hash(42) } : block) };
  await rejects(() => assertWitnessSliceShape(wrongParent, { network: "stagenet" }), "bad-daemon-answer",
    "a block whose parent is not the previous block hash is refused");
  const wrongCount = { ...slice, blocks: slice.blocks.map((block, i) => i === 5 ? { ...block, num_txes: 2 } : block) };
  await rejects(() => assertWitnessSliceShape(wrongCount, { network: "stagenet" }), "bad-daemon-answer",
    "a transaction count that disagrees with the txids is refused");
  const missingParent = { ...slice, blocks: slice.blocks.map((block, i) => i === 0 ? { ...block, prev_hash: null } : block) };
  await rejects(() => assertWitnessSliceShape(missingParent, { network: "stagenet" }), "bad-daemon-answer",
    "a block without a parent hash is refused");
  await rejects(() => assertWitnessSliceShape({ ...tipSlice, complete: true }, { network: "stagenet" }),
    "bad-daemon-answer", "a partial slice that claims to be complete is refused");
  await rejects(() => assertWitnessSliceShape({ ...tipSlice, tip: { ...tipSlice.tip, height: 119 } }, { network: "stagenet" }),
    "bad-daemon-answer", "a partial slice whose tip height does not match its last block is refused");
  await rejects(() => assertWitnessSliceShape({ ...tipSlice, tip: { ...tipSlice.tip, hash: hash(119) } }, { network: "stagenet" }),
    "bad-daemon-answer", "a partial slice whose tip hash does not match its last block is refused");

  const missingTxHashes = async () => ({
    ok: true,
    json: async () => ({ result: { block_header: { hash: hash(100) } } }),
  });
  await rejects(() => readWitnessSlice({ daemonUrl: "http://127.0.0.1:1", network: "stagenet", slice: 5, top: 119,
    fetchImpl: missingTxHashes, timeoutMs: 50 }), "bad-daemon-answer",
  "a daemon answer without tx_hashes or num_txes is refused");

  const missingTxHashesWithTxes = async () => ({
    ok: true,
    json: async () => ({ result: { block_header: { hash: hash(100), num_txes: 1 } } }),
  });
  await rejects(() => readWitnessSlice({ daemonUrl: "http://127.0.0.1:1", network: "stagenet", slice: 5, top: 119,
    fetchImpl: missingTxHashesWithTxes, timeoutMs: 50 }), "bad-daemon-answer",
  "a daemon answer without tx_hashes but with transactions is refused");

  const rpcErrorFetch = async () => ({ ok: true, json: async () => ({ error: { message: "daemon refused" } }) });
  await rejects(() => readWitnessSlice({ daemonUrl: "http://127.0.0.1:1", network: "stagenet", slice: 5, top: 119,
    fetchImpl: rpcErrorFetch, timeoutMs: 50 }), "bad-daemon-answer", "a daemon RPC error is not an empty slice");

  const slowFetch = (url, init) => new Promise((resolve, reject) => {
    if (init.signal) init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await rejects(() => readWitnessSlice({ daemonUrl: "http://127.0.0.1:1", network: "stagenet", slice: 5, top: 119,
    fetchImpl: slowFetch, timeoutMs: 10 }), "daemon-unavailable", "a daemon call that exceeds its deadline is refused");

  let dyingCalls = 0;
  const dyingFetch = async () => {
    dyingCalls += 1;
    if (dyingCalls > 2) throw new Error("daemon socket closed");
    return { ok: true, json: async () => ({ result: { block_header: { hash: hash(100 + dyingCalls),
      prev_hash: hash(99 + dyingCalls), num_txes: 0 }, tx_hashes: [] } }) };
  };
  await rejects(() => readWitnessSlice({ daemonUrl: "http://127.0.0.1:1", network: "stagenet", slice: 5, top: 119,
    fetchImpl: dyingFetch, timeoutMs: 50 }), "daemon-unavailable", "a daemon that dies mid-slice does not become empty blocks");

  const witness = createWitnessServer({
    network: "stagenet", daemonUrl: daemon.url, operator: "Local Operator", contact: "ops@example.test",
  });
  await new Promise((resolve) => witness.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + witness.address().port;
  try {
    const live = await fetch(base + "/live");
    const liveBody = await live.json();
    check(live.status === 200 && liveBody.grid === 20, "the witness advertises its grid");
    check(liveBody.routes.includes("/health") && liveBody.routes.includes("/metrics") && liveBody.routes.includes("/info"),
      "liveness names the standard endpoints");

    const info = await fetch(base + "/json_rpc", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "info", method: "get_info", params: {} }),
    });
    const infoBody = await info.json();
    check(info.status === 200 && infoBody.result && infoBody.result.height === 120,
      "the witness proxies get_info so the SDK can read its tip");
    check(infoBody.result.status === "OK" && infoBody.result.nettype === "stagenet",
      "the proxied tip carries the readiness fields the client checks");
    check(!("version" in infoBody.result) && !("peers" in infoBody.result) && !("bootstrap" in infoBody.result),
      "the proxied tip does not publish the daemon's version, peers or bootstrap address");

    const health = await fetch(base + "/health");
    const healthBody = await health.json();
    check(health.status === 200 && healthBody.status === "ready", "readiness passes on a matching daemon");
    check(healthBody.checks.daemon === "ok" && healthBody.checks.network === "ok",
      "readiness names the daemon and network checks");

    const identity = await fetch(base + "/info");
    const identityBody = await identity.json();
    check(identity.status === 200 && identityBody.protocol === "witness-v1" && identityBody.grid === 20,
      "info names the protocol and grid");
    check(identityBody.operator === "Local Operator" && identityBody.contact === "ops@example.test",
      "info carries the configured operator and contact");
    check(!JSON.stringify(identityBody).includes(daemon.url), "info does not leak the daemon URL");

    const metrics = await fetch(base + "/metrics");
    const metricsBody = await metrics.text();
    check(metrics.status === 200 && metrics.headers.get("content-type").startsWith("text/plain; version=0.0.4"),
      "metrics answer in Prometheus text format");
    check(metricsBody.includes("ninsei_witness_up 1") && metricsBody.includes("ninsei_witness_health_up 1"),
      "metrics report process and readiness state");
    check(metricsBody.includes('ninsei_witness_info{network="stagenet",operator="Local Operator"'),
      "metrics expose the witness identity");
    check(metricsBody.includes('route="/health"'), "metrics count requests by route");
    check(!metricsBody.includes(daemon.url), "metrics do not leak the daemon URL");

    // A NON-LOOPBACK CALLER MUST NOT READ METRICS. The check is conditional on a second interface being present;
    // a host with loopback only cannot make the assertion and says so instead of passing silently.
    const lan = Object.values(networkInterfaces()).flat()
      .find((address) => address && address.family === "IPv4" && address.internal === false);
    if (!lan) console.log("  skip  a non-loopback metrics caller (no second IPv4 interface)");
    else {
      const exposed = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url });
      await new Promise((resolve) => exposed.listen(0, "0.0.0.0", resolve));
      try {
        const remote = await fetch("http://" + lan.address + ":" + exposed.address().port + "/metrics");
        check(remote.status === 403, "a non-loopback caller does not read metrics");
      } catch {
        console.log("  skip  a non-loopback metrics caller (the interface is not reachable)");
      } finally {
        await close(exposed);
      }
    }

    const txs = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: [TXID], decode_as_json: true }),
    });
    const txsBody = await txs.json();
    check(txs.status === 200 && Array.isArray(txsBody.txs_as_json) && txsBody.txs_as_json.length === 1,
      "the witness proxies the slice's transactions");

    daemonState.untrusted = true;
    const untrustedTx = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: [TXID], decode_as_json: true }),
    });
    const untrustedBody = await untrustedTx.json();
    check(untrustedTx.status === 503 && untrustedBody.code === "not-synchronized",
      "an untrusted daemon does not relay transactions");
    daemonState.untrusted = false;

    daemonState.status = "BUSY";
    const busyTx = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: [TXID], decode_as_json: true }),
    });
    const busyBody = await busyTx.json();
    check(busyTx.status === 503 && busyBody.code === "busy",
      "a busy daemon does not relay transactions");
    daemonState.status = "ERROR";
    const failedTx = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: [TXID], decode_as_json: true }),
    });
    const failedBody = await failedTx.json();
    check(failedTx.status === 502 && failedBody.code === "bad-daemon-answer",
      "a daemon with a non-OK status does not relay transactions");
    daemonState.status = "OK";

    daemonState.height = 115;
    const behind = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...good, slice: 7 }),
    });
    const behindBody = await behind.json();
    check(behind.status === 503 && behindBody.code === "not-synchronized",
      "a slice above the daemon tip is a retryable 503");
    daemonState.height = 120;

    const notProxied = await fetch(base + "/json_rpc", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height: 105 } }),
    });
    check(notProxied.status === 400, "a JSON-RPC method other than get_info is refused");

    const compat = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url, allowGetBlock: true });
    await new Promise((resolve) => compat.listen(0, "127.0.0.1", resolve));
    try {
      const compatBase = "http://127.0.0.1:" + compat.address().port;
      const compatLive = await fetch(compatBase + "/live");
      const compatLiveBody = await compatLive.json();
      check(compatLive.status === 200 && compatLiveBody.features && compatLiveBody.features.getBlock === true,
        "the explicit flag advertises get_block on liveness");
      const blockAnswer = await fetch(compatBase + "/json_rpc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height: 105 } }),
      });
      const blockBody = await blockAnswer.json();
      check(blockAnswer.status === 200 && blockBody.result && blockBody.result.block_header.hash === hash(105),
        "the explicit flag answers get_block");
      check(blockBody.result.block_header.prev_hash === hash(104)
        && blockBody.result.block_header.num_txes === 1
        && blockBody.result.tx_hashes.length === 1 && blockBody.result.tx_hashes[0] === TXID,
        "the compatibility answer carries the parent, count and txids");
      check(!("blob" in blockBody.result) && !("json" in blockBody.result),
        "the compatibility answer does not relay the daemon blob or full body");
      const beyond = await fetch(compatBase + "/json_rpc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height: 120 } }),
      });
      const beyondBody = await beyond.json();
      check(beyond.status === 503 && beyondBody.code === "not-synchronized" && beyondBody.params.why === "beyond-tip",
        "the compatibility read refuses a height above the tip");
      const badHeight = await fetch(compatBase + "/json_rpc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height: "105" } }),
      });
      check(badHeight.status === 400, "the compatibility read refuses a non-integer height");
    } finally {
      await close(compat);
    }

    const badTxids = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: ["not-a-txid"], decode_as_json: true }),
    });
    check(badTxids.status === 400, "a malformed txid list is refused");

    const noTxids = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decode_as_json: true }),
    });
    check(noTxids.status === 400, "a request without tx_hashes is refused");

    const emptyTxids = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txs_hashes: [] }),
    });
    check(emptyTxids.status === 400, "an empty txid list is refused");

    const tooMany = Array.from({ length: 4097 }, () => TXID);
    const overCap = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txs_hashes: tooMany }),
    });
    check(overCap.status === 400, "more than 4096 txids is refused");

    const oversizedProxy = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: [TXID], padding: "x".repeat(520 * 1024) }),
    });
    const oversizedBody = await oversizedProxy.json();
    check(oversizedProxy.status === 400 && oversizedBody.params && oversizedBody.params.why === "body-too-large",
      "an oversized transaction request is refused before the daemon");

    const answer = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
    });
    check(answer.status === 200, "the route serves a valid slice");
    check(answer.headers.get("access-control-allow-origin") === "*", "the route carries CORS for the browser");
    const body = await answer.json();
    check(body.blocks.length === 20 && body.blocks[0].height === 100, "the route returns the requested slice");
    check(body.complete === true && body.to === 119, "the route marks a slice below the tip complete");

    daemonState.height = 101;
    const firstTipAnswer = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
    });
    const firstTipBody = await firstTipAnswer.json();
    assert.equal(firstTipAnswer.status, 200, "a slice starting at the tip is available through HTTP");
    assert.deepEqual(firstTipBody, { version: 1, network: "stagenet", grid: 20, slice: 5,
      from: 100, to: 100, complete: false, blocks: [{ height: 100, hash: hash(100), prev_hash: hash(99), num_txes: 0, txids: [] }],
      tip: { height: 100, hash: hash(100) } });
    const nextTipAnswer = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...good, slice: 6 }),
    });
    assert.equal(nextTipAnswer.status, 503);
    const nextTipBody = await nextTipAnswer.json();
    assert.equal(nextTipBody.code, "not-synchronized");
    assert.deepEqual(nextTipBody.params, { why: "beyond-tip", from: 120, top: 100 });
    check(true, "HTTP serves the one-block tip slice and names the next slice's beyond-tip refusal");

    daemonState.height = 116;
    const tipAnswer = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
    });
    const tipBody = await tipAnswer.json();
    check(tipAnswer.status === 200 && tipBody.complete === false && tipBody.to === 115 && tipBody.blocks.length === 16,
      "the route serves the tip slice partially instead of refusing it");
    check(tipBody.tip && tipBody.tip.height === 115 && tipBody.tip.hash === tipBody.blocks[15].hash,
      "the partial route answer names the tip hash");
    daemonState.height = 120;

    daemonState.height = 116;
    daemonState.top_block_hash = hash(114);
    const reorgAnswer = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
    });
    const reorgBody = await reorgAnswer.json();
    check(reorgAnswer.status === 502 && reorgBody.code === "bad-daemon-answer",
      "a tip hash that differs from the last block is a daemon answer refusal");
    delete daemonState.top_block_hash;
    daemonState.height = 120;

    const exact = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...good, height: 105 }),
    });
    check(exact.status === 400, "the route refuses a request carrying an exact height");

    const bad = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    check(bad.status === 400, "the route refuses malformed JSON");

    const oversized = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, network: "stagenet" + "x".repeat(2048), grid: 20, slice: 5 }),
    });
    check(oversized.status === 400, "the route refuses an oversized body without draining it");

    const unknown = await fetch(base + "/v1/witness/unknown");
    check(unknown.status === 404, "an unknown route is a 404");

    const wrongNetwork = createWitnessServer({ network: "mainnet", daemonUrl: daemon.url });
    await new Promise((resolve) => wrongNetwork.listen(0, "127.0.0.1", resolve));
    try {
      const wrongBase = "http://127.0.0.1:" + wrongNetwork.address().port;
      const wrongHealth = await fetch(wrongBase + "/health");
      const wrongBody = await wrongHealth.json();
      check(wrongHealth.status === 503 && wrongBody.checks.network === "mismatch"
        && wrongBody.checks.daemon === "ok", "readiness names a reachable daemon on another network");
      const wrongMetrics = await fetch(wrongBase + "/metrics");
      check((await wrongMetrics.text()).includes("ninsei_witness_health_up 0"),
        "metrics report a failed readiness probe");
    } finally {
      await close(wrongNetwork);
    }

    const stateServer = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url, healthTtlMs: 0 });
    await new Promise((resolve) => stateServer.listen(0, "127.0.0.1", resolve));
    try {
      const stateBase = "http://127.0.0.1:" + stateServer.address().port;
      for (const [field, value, label] of [
        ["synchronized", false, "a daemon that is not synchronized"],
        ["busy_syncing", true, "a daemon that is still syncing"],
        ["untrusted", true, "a daemon that serves a third party's chain"],
        ["status", "BUSY", "a daemon whose status is not OK"],
        ["nettype", "mainnet", "a daemon on another network"],
      ]) {
        const previous = daemonState[field];
        daemonState[field] = value;
        const healthAnswer = await fetch(stateBase + "/health");
        const jsonAnswer = await fetch(stateBase + "/json_rpc", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "info", method: "get_info", params: {} }),
        });
        const sliceAnswer = await fetch(stateBase + "/v1/witness/slice", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
        });
        const sliceBody = await sliceAnswer.json();
        check(healthAnswer.status === 503 && jsonAnswer.status === 503 && sliceAnswer.status === 503,
          label + " is refused by health, the tip route and the slice route");
        check(sliceBody.code === "not-synchronized", label + " is named as not-synchronized");
        daemonState[field] = previous;
      }
    } finally {
      await close(stateServer);
    }

    // The first block read holds a real server slot until explicitly released. No clock race decides busy.
    let blockStarted, releaseBlock;
    const started = new Promise((resolve) => { blockStarted = resolve; });
    const released = new Promise((resolve) => { releaseBlock = resolve; });
    let held = false;
    const limited = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url, maxInflight: 1,
      fetchImpl: async (url, init) => {
        const request = JSON.parse(init.body);
        if (!held && request.method === "get_block") {
          held = true;
          blockStarted();
          await released;
        }
        return fetch(url, init);
      },
    });
    await new Promise((resolve) => limited.listen(0, "127.0.0.1", resolve));
    let firstRequest;
    try {
      const limitedBase = "http://127.0.0.1:" + limited.address().port;
      const requestSlice = () => fetch(limitedBase + "/v1/witness/slice", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
      });
      firstRequest = requestSlice();
      await Promise.race([started, firstRequest.then(() => { throw new Error("first slice ended before the block gate"); })]);
      const beforeSecond = calls.length;
      const second = await requestSlice();
      const secondBody = await second.json();
      check(second.status === 503 && secondBody.code === "busy",
        "the in-flight ceiling refuses work while the first block read is held");
      check(calls.length === beforeSecond, "the refused request does not amplify daemon work");
      releaseBlock();
      const first = await firstRequest;
      const firstBody = await first.json();
      check(first.status === 200 && firstBody.blocks.length === 20 && firstBody.complete === true,
        "releasing the block gate lets the first slice complete");
      const afterRelease = await requestSlice();
      check(afterRelease.status === 200, "the completed request releases its daemon slot");
      await afterRelease.arrayBuffer();
    } finally {
      releaseBlock();
      if (firstRequest) await firstRequest.catch(() => {});
      await close(limited);
    }

    const idle = createWitnessServer({
      network: "stagenet", daemonUrl: daemon.url, maxInflight: 1, requestTimeoutMs: 200, headersTimeoutMs: 200,
    });
    await new Promise((resolve) => idle.listen(0, "127.0.0.1", resolve));
    const idleSockets = [];
    try {
      const idlePort = idle.address().port;
      for (let i = 0; i < 4; i++) {
        idleSockets.push(await new Promise((resolve, reject) => {
          const socket = createConnection(idlePort, "127.0.0.1", () => {
            socket.write("POST /v1/witness/slice HTTP/1.1\r\nHost: witness.test\r\n"
              + "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n");
            resolve(socket);
          });
          socket.once("error", reject);
        }));
      }
      const answer = await fetch("http://127.0.0.1:" + idlePort + "/v1/witness/slice", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
      });
      check(answer.status === 200, "four idle bodies do not hold the daemon slots");
      check(idle.requestTimeout === 200 && idle.headersTimeout === 200,
        "the listener has a short request and header deadline");
    } finally {
      for (const socket of idleSockets) socket.destroy();
      await close(idle);
    }
  } finally {
    await close(witness);
  }
} finally {
  await close(daemon.server);
}

if (problems.length) {
  for (const problem of problems) console.log("FAIL " + problem);
  console.log("FAILED: " + problems.length + " problem(s)");
  process.exit(1);
}
console.log("witness-v1: all checks passed");
