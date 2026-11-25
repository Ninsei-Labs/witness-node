#!/usr/bin/env bun
// START THE WITNESS-V1 ENDPOINT. Reads only: a Monero daemon, a network name and a listen address.
//
// Required:
//   WITNESS_XMR_DAEMON      the Monero daemon, for example http://127.0.0.1:38081
//
// Optional:
//   WITNESS_NETWORK          mainnet | stagenet | testnet (default: stagenet)
//   WITNESS_DEFAULT_HOST     127.0.0.1 (default) or 0.0.0.0 when placed behind the public proxy
//   WITNESS_DEFAULT_PORT     8796 (default; 8795 is the documented screen-hook example)
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
//   WITNESS_SLICE_DEADLINE_MS   total slice deadline (default: 55000)
//
import { ROUTES, createWitnessServer, envBoolean, envText, listenHostFromEnv, listenPortFromEnv } from "./src/witnessServer.mjs";
import { WITNESS_SLICE_BLOCKS, WITNESS_VERSION } from "./src/witnessSlice.mjs";

function envValue(name) {
  return process.env[name];
}

const daemonUrl = String(envValue("WITNESS_XMR_DAEMON") || "").trim();
if (!daemonUrl) {
  console.error("witness: WITNESS_XMR_DAEMON is required");
  process.exit(1);
}
const network = String(envValue("WITNESS_NETWORK") || "stagenet").trim();
if (!["mainnet", "stagenet", "testnet"].includes(network)) {
  console.error("witness: WITNESS_NETWORK must be mainnet, stagenet or testnet");
  process.exit(1);
}
const host = listenHostFromEnv();
const port = listenPortFromEnv();
const allowOrigin = String(envValue("WITNESS_ALLOW_ORIGIN") || "*").trim();
const timeoutMs = Number(envValue("WITNESS_TIMEOUT_MS") || 8000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("witness: WITNESS_TIMEOUT_MS must be a positive number");
  process.exit(1);
}
const healthTtlMs = Number(envValue("WITNESS_HEALTH_TTL_MS") || 5000);
if (!Number.isFinite(healthTtlMs) || healthTtlMs < 0) {
  console.error("witness: WITNESS_HEALTH_TTL_MS must be a non-negative number");
  process.exit(1);
}
const maxInflight = Number(envValue("WITNESS_MAX_INFLIGHT") || 4);
if (!Number.isInteger(maxInflight) || maxInflight <= 0) {
  console.error("witness: WITNESS_MAX_INFLIGHT must be a positive integer");
  process.exit(1);
}
const requestTimeoutMs = Number(envValue("WITNESS_REQUEST_TIMEOUT_MS") || 10000);
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
  console.error("witness: WITNESS_REQUEST_TIMEOUT_MS must be a positive integer");
  process.exit(1);
}
const rawSliceDeadline = envValue("WITNESS_SLICE_DEADLINE_MS");
const sliceDeadlineMs = rawSliceDeadline === undefined ? 55000 : Number(rawSliceDeadline);
if (!Number.isInteger(sliceDeadlineMs) || sliceDeadlineMs <= 0) {
  console.error("witness: WITNESS_SLICE_DEADLINE_MS must be a positive integer");
  process.exit(1);
}
const operator = envText(envValue("WITNESS_OPERATOR"), 80);
const contact = envText(envValue("WITNESS_CONTACT"), 200);
function boolEnv(name, fallback) {
  try {
    return envBoolean(name, envValue(name)) ?? fallback;
  } catch (error) {
    console.error("witness: " + String((error && error.message) || error));
    process.exit(1);
  }
}
const metricsPublished = boolEnv("WITNESS_METRICS_PUBLISH", false);
const allowGetBlock = boolEnv("WITNESS_ALLOW_GET_BLOCK", false);
const allowPool = boolEnv("WITNESS_ALLOW_POOL", true);

const server = createWitnessServer({
  network, daemonUrl, allowOrigin, operator, contact, metricsPublished, healthTtlMs, maxInflight, timeoutMs,
  requestTimeoutMs, headersTimeoutMs: requestTimeoutMs, allowGetBlock, allowPool, sliceDeadlineMs,
});
server.on("error", (error) => {
  console.error(JSON.stringify({ event: "witness_listener_failed", why: String((error && error.message) || error) }));
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: "witness_serving", service: "Ninsei-Witness", version: WITNESS_VERSION, network,
    grid: WITNESS_SLICE_BLOCKS, host, port, operator: operator || null,
    features: { getBlock: allowGetBlock, pool: allowPool },
    paths: [...ROUTES],
  }));
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
