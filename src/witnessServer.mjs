// THE WITNESS-V1 HTTP SURFACE. One read-only service: fixed block slices, plus the two daemon reads the SDK needs.
//
// This server is deliberately separate from the maker API: it has no token, no wallet, no order journal and no
// maker routes. It can run beside any Monero daemon, including the Ninsei stagenet node. A public deployment puts it
// behind a read-only reverse proxy; the listener itself stays private.
//
// CORS is required because the SDK runs in a page. The route accepts no cookies and no credentials; the allow
// origin is a deployment setting (`*` on a public witness, a site origin when the operator wants to narrow it).
//
// THE STANDARD SURFACE: `/live` is liveness, `/health` is readiness, `/metrics` is Prometheus text and `/info` names
// the protocol and optional operator metadata. `/metrics` is loopback-only unless the operator explicitly publishes
// it. `/health` probes the daemon but never prints its URL.
import { createServer } from "node:http";
import {
  WITNESS_SLICE_BLOCKS, WITNESS_VERSION, WitnessSliceError,
  daemonDirect, parseWitnessSliceRequest, readDaemonTip, readWitnessSlice,
} from "./witnessSlice.mjs";

const SERVICE = "Ninsei-Witness";
const PROTOCOL = "witness-v1";
const MAX_BODY_BYTES = 1024;
const MAX_PROXY_BODY_BYTES = 512 * 1024;
const MAX_TXIDS = 4096;
const HEX64 = /^[0-9a-f]{64}$/i;
const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

const STATUS = new Map([
  ["bad-request", 400], ["bad-version", 400], ["wrong-network", 400], ["bad-grid", 400], ["bad-slice", 400],
  ["daemon-unavailable", 503], ["not-synchronized", 503], ["busy", 503], ["bad-daemon-answer", 502],
]);

const ROUTES = ["/live", "/health", "/metrics", "/info", "/json_rpc", "/get_transactions", "/v1/witness/slice"];

export function isLoopbackAddress(address) {
  return LOOPBACK.test(String(address || ""));
}

function escapeLabel(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function routeKey(url) {
  return ROUTES.includes(url) ? url : "other";
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      // Stop pulling a body that is already over the limit. The caller answers 400 and closes the socket
      // after the response; without the pause a streaming client can hold the connection open.
      req.pause();
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new WitnessSliceError("bad-request", { why: "body-too-large" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => fail(new WitnessSliceError("bad-request", { why: "body-read" })));
  });
}

function refusal(error) {
  const code = error && error.code ? String(error.code) : "bad-request";
  const status = STATUS.get(code) || 500;
  const params = error && error.params ? error.params : undefined;
  return { status, body: { ok: false, code, error: code.replace(/-/g, " "), params,
    ...(params && params.retryAfterSec ? { retryAfterSec: params.retryAfterSec } : {}) } };
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw); }
  catch { throw new WitnessSliceError("bad-request", { why: "bad-json" }); }
}

/**
 * CREATE, DO NOT START. The caller owns the port and can close the server in a check.
 * @param {{network: string, daemonUrl: string, allowOrigin?: string, operator?: string|null,
 *   contact?: string|null, metricsPublished?: boolean, healthTtlMs?: number, maxInflight?: number,
 *   fetchImpl?: Function, timeoutMs?: number, maxBodyBytes?: number}} config
 */
export function createWitnessServer({
  network, daemonUrl, allowOrigin = "*", operator = null, contact = null, metricsPublished = false,
  healthTtlMs = 5000, maxInflight = 4, fetchImpl = globalThis.fetch, timeoutMs = 8000,
  maxBodyBytes = MAX_BODY_BYTES, requestTimeoutMs = 10000, headersTimeoutMs = 10000,
} = {}) {
  if (!network) throw new Error("witness server: network is required");
  if (!daemonUrl) throw new Error("witness server: daemon URL is required");
  if (!Number.isInteger(maxInflight) || maxInflight < 1) throw new Error("witness server: maxInflight must be a positive integer");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("witness server: requestTimeoutMs must be a positive integer");
  if (!Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 1) throw new Error("witness server: headersTimeoutMs must be a positive integer");
  const cors = String(allowOrigin || "*");
  const startedAt = Date.now();
  const requests = new Map();
  let inflight = 0;
  let health = { at: 0, ok: false, daemon: "not-probed", network: "not-probed" };

  const note = (route, status) => {
    const key = route + "|" + status;
    requests.set(key, (requests.get(key) || 0) + 1);
  };

  async function checkHealth() {
    if (Date.now() - health.at < healthTtlMs) return health;
    try {
      const tip = await readDaemonTip({ daemonUrl, network, fetchImpl, timeoutMs });
      health = { at: Date.now(), ok: true, daemon: "ok", network: "ok", height: tip.height };
    } catch (error) {
      const why = error && error.params && error.params.why;
      const networkMismatch = why === "wrong-network";
      health = { at: Date.now(), ok: false,
        daemon: error && error.code === "daemon-unavailable" ? "unavailable" : (networkMismatch ? "ok" : "not-ready"),
        network: networkMismatch ? "mismatch" : "unknown" };
    }
    return health;
  }

  function metricsText(currentHealth) {
    const lines = [
      "# HELP ninsei_witness_up Process is answering (1: yes)",
      "# TYPE ninsei_witness_up gauge",
      "ninsei_witness_up 1",
      "# HELP ninsei_witness_info Witness identity and protocol",
      "# TYPE ninsei_witness_info gauge",
      'ninsei_witness_info{network="' + escapeLabel(network) + '",operator="' + escapeLabel(operator || "")
        + '",protocol="' + PROTOCOL + '",grid="' + WITNESS_SLICE_BLOCKS + '"} 1',
      "# HELP ninsei_witness_uptime_seconds Process uptime",
      "# TYPE ninsei_witness_uptime_seconds counter",
      "ninsei_witness_uptime_seconds " + Math.round((Date.now() - startedAt) / 1000),
      "# HELP ninsei_witness_inflight_requests Requests currently holding a daemon slot",
      "# TYPE ninsei_witness_inflight_requests gauge",
      "ninsei_witness_inflight_requests " + inflight,
      "# HELP ninsei_witness_max_inflight_requests Configured daemon concurrency ceiling",
      "# TYPE ninsei_witness_max_inflight_requests gauge",
      "ninsei_witness_max_inflight_requests " + maxInflight,
      "# HELP ninsei_witness_health_up Last readiness probe (1: ready, 0: not ready)",
      "# TYPE ninsei_witness_health_up gauge",
      "ninsei_witness_health_up " + (currentHealth.ok ? 1 : 0),
      "# HELP ninsei_witness_health_last_probe_timestamp_seconds Time of the last readiness probe, unix seconds",
      "# TYPE ninsei_witness_health_last_probe_timestamp_seconds gauge",
      "ninsei_witness_health_last_probe_timestamp_seconds " + (currentHealth.at ? Math.floor(currentHealth.at / 1000) : 0),
      "# HELP ninsei_witness_requests_total Requests handled, by route and status",
      "# TYPE ninsei_witness_requests_total counter",
      ...[...requests.entries()].sort().map(([key, count]) => {
        const [route, status] = key.split("|");
        return 'ninsei_witness_requests_total{route="' + escapeLabel(route) + '",status="' + escapeLabel(status) + '"} ' + count;
      }),
      "",
    ];
    return lines.join("\n");
  }

  const server = createServer(async (req, res) => {
    const route = routeKey(req.url);
    const send = (code, body, contentType, corsHeaders = true) => {
      note(route, code);
      res.writeHead(code, {
        "content-type": contentType || "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(corsHeaders ? {
          "access-control-allow-origin": cors,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        } : {}),
        "x-service": SERVICE,
      });
      res.end(contentType ? String(body) : JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      return res.end();
    }

    if (req.method === "GET" && req.url === "/live") {
      return send(200, { ok: true, service: SERVICE, version: WITNESS_VERSION, network, grid: WITNESS_SLICE_BLOCKS,
        routes: ROUTES });
    }

    if (req.method === "GET" && req.url === "/health") {
      const current = await checkHealth();
      return send(current.ok ? 200 : 503, {
        ok: current.ok, service: SERVICE, status: current.ok ? "ready" : "not-ready", network,
        checks: { daemon: current.daemon, network: current.network },
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    if (req.method === "GET" && req.url === "/info") {
      return send(200, {
        ok: true, service: SERVICE, protocol: PROTOCOL, version: WITNESS_VERSION, network,
        grid: WITNESS_SLICE_BLOCKS, operator: operator || null, contact: contact || null,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000), startedAt: new Date(startedAt).toISOString(),
      });
    }

    if (req.method === "GET" && req.url === "/metrics") {
      if (!metricsPublished && !isLoopbackAddress(req.socket.remoteAddress)) {
        return send(403, { ok: false, code: "metrics-loopback-only",
          error: "metrics answer loopback callers only; set RFQ_WITNESS_METRICS_PUBLISH=1 to publish them" });
      }
      const current = await checkHealth();
      return send(200, metricsText(current), "text/plain; version=0.0.4; charset=utf-8");
    }

    // ONE SLICE COSTS UP TO 20 BLOCK READS PLUS A TIP READ. Cap the number of work requests in flight so a public
    // caller cannot turn one witness into an unbounded amplifier against the operator's monerod. The reverse proxy
    // still needs its own per-client rate limit; this is the last line of defense for the daemon.
    //
    // THE SLOT IS TAKEN AFTER THE BODY IS READ. A caller that sends headers and no body holds no daemon slot;
    // otherwise four idle sockets stop the service for the whole request timeout.
    let slot = false;
    const takeSlot = () => {
      if (inflight >= maxInflight) throw new WitnessSliceError("busy", { retryAfterSec: 1 });
      inflight += 1;
      slot = true;
    };

    try {
      // The SDK must ask the same witness for its tip and for the slice's transactions. `get_info` names no
      // order; `get_transactions` is asked for the whole slice's txids, which the slice answer already disclosed.
      if (req.method === "POST" && req.url === "/json_rpc") {
        const body = await readJson(req, maxBodyBytes);
        if (!body || typeof body !== "object" || body.method !== "get_info") {
          throw new WitnessSliceError("bad-request", { why: "method-not-proxied" });
        }
        takeSlot();
        const tip = await readDaemonTip({ daemonUrl, network, fetchImpl, timeoutMs });
        // ONLY THE FIELDS THE CLIENT CHECKS. The daemon's version, peers, disk space and bootstrap address are
        // not the witness's to publish.
        const result = { height: tip.height, synchronized: true, nettype: tip.nettype, status: "OK" };
        return send(200, { jsonrpc: "2.0", id: body.id === undefined ? "witness" : body.id, result });
      }
      if (req.method === "POST" && req.url === "/get_transactions") {
        const body = await readJson(req, MAX_PROXY_BODY_BYTES);
        const txids = body && Array.isArray(body.txs_hashes) ? body.txs_hashes : null;
        if (!txids || txids.length === 0 || txids.length > MAX_TXIDS
          || txids.some((txid) => !HEX64.test(String(txid || "").replace(/^0x/, "")))) {
          throw new WitnessSliceError("bad-request", { why: "bad-txids" });
        }
        takeSlot();
        const answer = await daemonDirect(daemonUrl, "/get_transactions",
          { txs_hashes: txids.map((txid) => String(txid).replace(/^0x/, "")), decode_as_json: true }, fetchImpl, timeoutMs);
        // THE SAME READINESS RULE AS THE SLICE. `/get_transactions` is the second daemon-backed route the SDK
        // needs, and its answer carries `status` and `untrusted`; a bootstrap or restricted daemon must not relay
        // transaction bodies with 200. No extra get_info call is needed.
        const answerStatus = String((answer && answer.status) || "");
        if (answer && answer.untrusted === true) {
          throw new WitnessSliceError("not-synchronized", { why: "untrusted" });
        }
        if (answerStatus === "BUSY") throw new WitnessSliceError("busy", { retryAfterSec: 1 });
        if (answerStatus !== "OK") throw new WitnessSliceError("bad-daemon-answer", { why: "status" });
        return send(200, answer);
      }
      if (req.method !== "POST" || req.url !== "/v1/witness/slice") {
        return send(404, { ok: false, error: "unknown path", known: ROUTES });
      }
      const body = await readJson(req, maxBodyBytes);
      const sliceRequest = parseWitnessSliceRequest(body, { network, grid: WITNESS_SLICE_BLOCKS });
      takeSlot();
      const tip = await readDaemonTip({ daemonUrl, network, fetchImpl, timeoutMs });
      const slice = await readWitnessSlice({ daemonUrl, network, ...sliceRequest, top: tip.top,
        topHash: tip.topBlockHash, fetchImpl, timeoutMs });
      return send(200, slice);
    } catch (error) {
      const answer = refusal(error);
      if (error && error.params && error.params.why === "body-too-large") {
        // The request body is paused; answer first, then close instead of draining an unbounded stream.
        res.once("finish", () => req.destroy());
      }
      return send(answer.status, answer.body);
    } finally {
      if (slot) inflight -= 1;
    }
  });
  // A REQUEST THAT NEVER FINISHES IS NOT A CUSTOMER. Node's default is 300 s; four idle sockets would hold every
  // daemon slot for that long. The body is small, so a request that needs longer is not a witness request.
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  return server;
}

export function listenHostFromEnv(env = process.env) {
  return String(env.RFQ_WITNESS_HOST || "127.0.0.1").trim();
}

export function listenPortFromEnv(env = process.env) {
  const raw = String(env.RFQ_WITNESS_PORT || "8796").trim();
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("RFQ_WITNESS_PORT is not a port: " + JSON.stringify(raw));
  return port;
}

export function envBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function envText(value, max) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text ? text.slice(0, max) : null;
}
