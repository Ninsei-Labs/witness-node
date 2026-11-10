#!/usr/bin/env bun
// START THE WITNESS-V1 ENDPOINT. Reads only: a Monero daemon, a network name and a listen address.
//
// Required:
//   RFQ_XMR_DAEMON      the Monero daemon, for example http://127.0.0.1:38081
//
// Optional:
//   RFQ_WITNESS_NETWORK          mainnet | stagenet | testnet (default: stagenet)
//   RFQ_WITNESS_HOST             127.0.0.1 (default) or 0.0.0.0 when placed behind the public proxy
//   RFQ_WITNESS_PORT             8796 (default; 8795 is the documented screen-hook example)
//   RFQ_WITNESS_ALLOW_ORIGIN     CORS origin for the browser SDK (default: *)
//   RFQ_WITNESS_TIMEOUT_MS       per-daemon request deadline (default: 8000)
//   RFQ_WITNESS_OPERATOR         optional public operator name for /info
//   RFQ_WITNESS_CONTACT          optional public contact for /info
//   RFQ_WITNESS_METRICS_PUBLISH  1/true/yes/on exposes /metrics beyond loopback
//   RFQ_WITNESS_HEALTH_TTL_MS    readiness probe cache (default: 5000)
//   RFQ_WITNESS_MAX_INFLIGHT     concurrent daemon-backed requests (default: 4)
//   RFQ_WITNESS_REQUEST_TIMEOUT_MS  request and header deadline (default: 10000)
import { createWitnessServer, envBoolean, envText, listenHostFromEnv, listenPortFromEnv } from "./src/witnessServer.mjs";
import { WITNESS_SLICE_BLOCKS, WITNESS_VERSION } from "./src/witnessSlice.mjs";

const daemonUrl = String(process.env.RFQ_XMR_DAEMON || "").trim();
if (!daemonUrl) {
  console.error("witness: RFQ_XMR_DAEMON is required");
  process.exit(1);
}
const network = String(process.env.RFQ_WITNESS_NETWORK || "stagenet").trim();
if (!["mainnet", "stagenet", "testnet"].includes(network)) {
  console.error("witness: RFQ_WITNESS_NETWORK must be mainnet, stagenet or testnet");
  process.exit(1);
}
const host = listenHostFromEnv();
const port = listenPortFromEnv();
const allowOrigin = String(process.env.RFQ_WITNESS_ALLOW_ORIGIN || "*").trim();
const timeoutMs = Number(process.env.RFQ_WITNESS_TIMEOUT_MS || 8000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("witness: RFQ_WITNESS_TIMEOUT_MS must be a positive number");
  process.exit(1);
}
const healthTtlMs = Number(process.env.RFQ_WITNESS_HEALTH_TTL_MS || 5000);
if (!Number.isFinite(healthTtlMs) || healthTtlMs < 0) {
  console.error("witness: RFQ_WITNESS_HEALTH_TTL_MS must be a non-negative number");
  process.exit(1);
}
const maxInflight = Number(process.env.RFQ_WITNESS_MAX_INFLIGHT || 4);
if (!Number.isInteger(maxInflight) || maxInflight < 1) {
  console.error("witness: RFQ_WITNESS_MAX_INFLIGHT must be a positive integer");
  process.exit(1);
}
const requestTimeoutMs = Number(process.env.RFQ_WITNESS_REQUEST_TIMEOUT_MS || 10000);
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
  console.error("witness: RFQ_WITNESS_REQUEST_TIMEOUT_MS must be a positive integer");
  process.exit(1);
}
const operator = envText(process.env.RFQ_WITNESS_OPERATOR, 80);
const contact = envText(process.env.RFQ_WITNESS_CONTACT, 200);
const metricsPublished = envBoolean(process.env.RFQ_WITNESS_METRICS_PUBLISH);

const server = createWitnessServer({
  network, daemonUrl, allowOrigin, operator, contact, metricsPublished, healthTtlMs, maxInflight, timeoutMs,
  requestTimeoutMs, headersTimeoutMs: requestTimeoutMs,
});
server.on("error", (error) => {
  console.error(JSON.stringify({ event: "witness_listener_failed", why: String((error && error.message) || error) }));
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: "witness_serving", service: "Ninsei-Witness", version: WITNESS_VERSION, network,
    grid: WITNESS_SLICE_BLOCKS, host, port, operator: operator || null,
    paths: ["/live", "/health", "/metrics", "/info", "/json_rpc", "/get_transactions", "/v1/witness/slice"],
  }));
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
