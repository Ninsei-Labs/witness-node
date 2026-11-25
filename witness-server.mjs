#!/usr/bin/env bun
// START THE WITNESS-V1 ENDPOINT. Reads only: a Monero daemon, a network name and a listen address.
//
// Required:
//   WITNESS_XMR_DAEMON      the Monero daemon, for example http://127.0.0.1:38081
//
// Optional:
//   WITNESS_NETWORK          mainnet | stagenet | testnet (default: stagenet)
//   WITNESS_HOST             127.0.0.1 (default) or 0.0.0.0 when placed behind the public proxy
//   WITNESS_PORT             8796 (default; 8795 is the documented screen-hook example)
//   WITNESS_ALLOW_ORIGIN     CORS origin for the browser SDK (default: *)
//   WITNESS_TIMEOUT_MS       per-daemon request deadline (default: 8000)
//   WITNESS_OPERATOR         optional public operator name for /info
//   WITNESS_CONTACT          optional public contact for /info
//   WITNESS_METRICS_PUBLISH  1/true/yes/on exposes /metrics beyond loopback
//   WITNESS_ALLOW_GET_BLOCK  1/true/yes/on adds the narrow exact-height get_block compatibility method
//   WITNESS_ALLOW_POOL       0 turns off the global pool-hashes route (default: on)
//   WITNESS_HEALTH_TTL_MS    readiness probe cache (default: 5000)
//   WITNESS_MAX_INFLIGHT     concurrent daemon-backed requests (default: 4)
//   WITNESS_REQUEST_TIMEOUT_MS  request and header deadline (default: 10000)
//
// The RFQ_-prefixed names are read as deprecated aliases until 1.0.0.
import { createWitnessServer, envBoolean, envText, listenHostFromEnv, listenPortFromEnv } from "./src/witnessServer.mjs";
import { WITNESS_SLICE_BLOCKS, WITNESS_VERSION } from "./src/witnessSlice.mjs";

const legacyNames = [];
function envValue(name, legacy) {
  if (process.env[name] !== undefined) return process.env[name];
  if (legacy && process.env[legacy] !== undefined) {
    legacyNames.push(legacy);
    return process.env[legacy];
  }
  return undefined;
}

const daemonUrl = String(envValue("WITNESS_XMR_DAEMON", "RFQ_XMR_DAEMON") || "").trim();
if (!daemonUrl) {
  console.error("witness: WITNESS_XMR_DAEMON is required");
  process.exit(1);
}
const network = String(envValue("WITNESS_NETWORK", "RFQ_WITNESS_NETWORK") || "stagenet").trim();
if (!["mainnet", "stagenet", "testnet"].includes(network)) {
  console.error("witness: WITNESS_NETWORK must be mainnet, stagenet or testnet");
  process.exit(1);
}
const host = listenHostFromEnv();
const port = listenPortFromEnv();
// THE LISTEN NAMES HAVE THEIR OWN ALIASES AND THEIR OWN DEPRECATION LINE. envValue covers the settings below, but
// the host and port are read by the listen helpers, so name them here when only the old name is set.
if (process.env.WITNESS_HOST === undefined && process.env.RFQ_WITNESS_HOST !== undefined) legacyNames.push("RFQ_WITNESS_HOST");
if (process.env.WITNESS_PORT === undefined && process.env.RFQ_WITNESS_PORT !== undefined) legacyNames.push("RFQ_WITNESS_PORT");
const allowOrigin = String(envValue("WITNESS_ALLOW_ORIGIN", "RFQ_WITNESS_ALLOW_ORIGIN") || "*").trim();
const timeoutMs = Number(envValue("WITNESS_TIMEOUT_MS", "RFQ_WITNESS_TIMEOUT_MS") || 8000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("witness: WITNESS_TIMEOUT_MS must be a positive number");
  process.exit(1);
}
const healthTtlMs = Number(envValue("WITNESS_HEALTH_TTL_MS", "RFQ_WITNESS_HEALTH_TTL_MS") || 5000);
if (!Number.isFinite(healthTtlMs) || healthTtlMs < 0) {
  console.error("witness: WITNESS_HEALTH_TTL_MS must be a non-negative number");
  process.exit(1);
}
const maxInflight = Number(envValue("WITNESS_MAX_INFLIGHT", "RFQ_WITNESS_MAX_INFLIGHT") || 4);
if (!Number.isInteger(maxInflight) || maxInflight <= 0) {
  console.error("witness: WITNESS_MAX_INFLIGHT must be a positive integer");
  process.exit(1);
}
const requestTimeoutMs = Number(envValue("WITNESS_REQUEST_TIMEOUT_MS", "RFQ_WITNESS_REQUEST_TIMEOUT_MS") || 10000);
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
  console.error("witness: WITNESS_REQUEST_TIMEOUT_MS must be a positive integer");
  process.exit(1);
}
const operator = envText(envValue("WITNESS_OPERATOR", "RFQ_WITNESS_OPERATOR"), 80);
const contact = envText(envValue("WITNESS_CONTACT", "RFQ_WITNESS_CONTACT"), 200);
const metricsPublished = envBoolean(envValue("WITNESS_METRICS_PUBLISH", "RFQ_WITNESS_METRICS_PUBLISH"));
const allowGetBlock = envBoolean(envValue("WITNESS_ALLOW_GET_BLOCK", "RFQ_WITNESS_ALLOW_GET_BLOCK"));
const rawAllowPool = envValue("WITNESS_ALLOW_POOL", "RFQ_WITNESS_ALLOW_POOL");
const allowPool = rawAllowPool === undefined ? true : envBoolean(rawAllowPool);

const server = createWitnessServer({
  network, daemonUrl, allowOrigin, operator, contact, metricsPublished, healthTtlMs, maxInflight, timeoutMs,
  requestTimeoutMs, headersTimeoutMs: requestTimeoutMs, allowGetBlock, allowPool,
});
if (legacyNames.length > 0) {
  console.warn(JSON.stringify({ event: "witness_env_deprecated", names: legacyNames, use: "WITNESS_*" }));
}
server.on("error", (error) => {
  console.error(JSON.stringify({ event: "witness_listener_failed", why: String((error && error.message) || error) }));
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: "witness_serving", service: "Ninsei-Witness", version: WITNESS_VERSION, network,
    grid: WITNESS_SLICE_BLOCKS, host, port, operator: operator || null,
    features: { getBlock: allowGetBlock, pool: allowPool },
    paths: ["/live", "/health", "/metrics", "/info", "/json_rpc", "/get_transactions", "/v1/witness/slice"],
  }));
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
