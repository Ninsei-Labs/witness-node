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
let daemonDelayMs = 0;

const daemon = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push(body);
      if (body.method === "get_info") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { height: 120, synchronized: true, nettype: "stagenet" } }));
      }
      if (body.method !== "get_block" && !Array.isArray(body.txs_hashes)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "unexpected method" } }));
      }
      if (Array.isArray(body.txs_hashes)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ txs: [{ tx_hash: TXID, block_height: 105 }], txs_as_json: ['{"version":2}'] }));
      }
      const height = Number(body.params.height);
      if (height < 100 || height > 119) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "wrong height" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      const answer = JSON.stringify({
        result: { block_header: { hash: hash(height) }, tx_hashes: height === 105 ? [TXID] : [] },
      });
      if (daemonDelayMs) return setTimeout(() => res.end(answer), daemonDelayMs);
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
  check(slice.blocks[0].height === 100 && slice.blocks[19].height === 119, "the slice starts and ends on the grid");
  check(slice.blocks[5].txids.length === 1 && slice.blocks[5].txids[0] === TXID, "a block keeps its transactions");
  check(calls.length === 20 && calls.every((call) => call.method === "get_block"), "the daemon is asked for blocks only");
  check(calls.map((call) => call.params.height).join(",") === Array.from({ length: 20 }, (_, i) => 100 + i).join(","),
    "the daemon sees the whole slice, not one order height");
  assertWitnessSliceShape(slice, { network: "stagenet" });

  await rejects(() => assertWitnessSliceShape({ ...slice, blocks: slice.blocks.slice(0, 19) }, { network: "stagenet" }),
    "bad-daemon-answer", "a partial slice is refused");
  const wrongHash = { ...slice, blocks: slice.blocks.map((block, i) => i === 0 ? { ...block, hash: "not-hex" } : block) };
  await rejects(() => assertWitnessSliceShape(wrongHash, { network: "stagenet" }), "bad-daemon-answer",
    "a bad block hash is refused");
  const wrongHeight = { ...slice, blocks: slice.blocks.map((block, i) => i === 0 ? { ...block, height: 101 } : block) };
  await rejects(() => assertWitnessSliceShape(wrongHeight, { network: "stagenet" }), "bad-daemon-answer",
    "a non-consecutive block height is refused");

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

    const txs = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: [TXID], decode_as_json: true }),
    });
    const txsBody = await txs.json();
    check(txs.status === 200 && Array.isArray(txsBody.txs_as_json) && txsBody.txs_as_json.length === 1,
      "the witness proxies the slice's transactions");

    const notProxied = await fetch(base + "/json_rpc", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height: 105 } }),
    });
    check(notProxied.status === 400, "a JSON-RPC method other than get_info is refused");

    const badTxids = await fetch(base + "/get_transactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs_hashes: ["not-a-txid"], decode_as_json: true }),
    });
    check(badTxids.status === 400, "a malformed txid list is refused");

    const answer = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
    });
    check(answer.status === 200, "the route serves a valid slice");
    check(answer.headers.get("access-control-allow-origin") === "*", "the route carries CORS for the browser");
    const body = await answer.json();
    check(body.blocks.length === 20 && body.blocks[0].height === 100, "the route returns the requested slice");

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
      body: JSON.stringify({ version: 1, network: "stagenet", grid: 20, slice: 5, pad: "x".repeat(2048) }),
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
      check(wrongHealth.status === 503 && wrongBody.checks.network === "mismatch",
        "readiness refuses a daemon on another network");
      const wrongMetrics = await fetch(wrongBase + "/metrics");
      check((await wrongMetrics.text()).includes("ninsei_witness_health_up 0"),
        "metrics report a failed readiness probe");
    } finally {
      await close(wrongNetwork);
    }

    daemonDelayMs = 25;
    const limited = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url, maxInflight: 1 });
    await new Promise((resolve) => limited.listen(0, "127.0.0.1", resolve));
    try {
      const limitedBase = "http://127.0.0.1:" + limited.address().port;
      const firstRequest = fetch(limitedBase + "/v1/witness/slice", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await fetch(limitedBase + "/v1/witness/slice", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
      });
      const secondBody = await second.json();
      const first = await firstRequest;
      check(first.status === 200 && second.status === 503 && secondBody.code === "busy",
        "the in-flight ceiling refuses work instead of amplifying the daemon");
    } finally {
      daemonDelayMs = 0;
      await close(limited);
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
