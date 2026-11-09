#!/usr/bin/env bun
// RUN THE IMAGE, NOT JUST ITS UNIT TESTS.
//
// The Bun checks already drive the server against a stand-in daemon. This check adds the container contract:
// the image starts, runs as UID 10001 with a read-only root, reaches the daemon, turns healthy, serves the
// standard endpoints, and returns the exact pinned 20-block slice.
//
// The stand-in daemon is deterministic and is not a real chain. The real-chain integration belongs in a separate,
// optional workflow so a public node cannot make every PR flaky.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { TXID, startFakeDaemon } from "./fake-monerod.mjs";

const IMAGE = process.env.WITNESS_IMAGE || "witness-node:ci";
const NAME = "witness-smoke-" + process.pid + "-" + Date.now();
const fixture = JSON.parse(await readFile(new URL("./fixtures/stagenet-slice-5.json", import.meta.url), "utf8"));

function docker(args, { check = true } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) throw new Error("docker is not available: " + result.error.message);
  if (check && result.status !== 0) {
    throw new Error("docker " + args.join(" ") + " failed:\n" + (result.stderr || result.stdout || "").trim());
  }
  return String(result.stdout || "").trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url, expectedStatus, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url);
      if (response.status === expectedStatus) return response;
    } catch { /* the listener is still starting */ }
    await sleep(250);
  }
  throw new Error("timed out waiting for " + url + " to answer " + expectedStatus);
}

async function json(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error("non-JSON answer from " + url + ": " + text.slice(0, 200)); }
  return { response, body };
}

let container = "";
let daemon;
let failure;
try {
  daemon = await startFakeDaemon({ host: "0.0.0.0" });
  const hostPort = await freePort();
  const base = "http://127.0.0.1:" + hostPort;

  container = docker([
    "run", "-d", "--name", NAME,
    "--read-only",
    "--tmpfs", "/tmp",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--add-host", "host.docker.internal:host-gateway",
    "-p", "127.0.0.1:" + hostPort + ":8796",
    "-e", "RFQ_XMR_DAEMON=http://host.docker.internal:" + daemon.port,
    "-e", "RFQ_WITNESS_NETWORK=stagenet",
    "-e", "RFQ_WITNESS_ALLOW_ORIGIN=https://swap.example",
    "-e", "RFQ_WITNESS_OPERATOR=CI smoke",
    "-e", "RFQ_WITNESS_METRICS_PUBLISH=1",
    IMAGE,
  ]);
  assert.ok(container, "docker run returned a container id");

  await waitFor(base + "/live", 200);
  const health = await json(base + "/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ready");
  assert.equal(health.body.checks.daemon, "ok");
  assert.equal(health.body.checks.network, "ok");

  const live = await json(base + "/live");
  assert.ok(live.body.routes.includes("/v1/witness/slice"));

  const info = await json(base + "/info");
  assert.equal(info.body.protocol, "witness-v1");
  assert.equal(info.body.operator, "CI smoke");

  const metrics = await fetch(base + "/metrics");
  const metricsText = await metrics.text();
  assert.equal(metrics.status, 200);
  assert.match(metricsText, /ninsei_witness_up 1/);
  assert.match(metricsText, /ninsei_witness_health_up 1/);
  assert.ok(!metricsText.includes("host.docker.internal"), "metrics must not leak the daemon URL");

  const tip = await json(base + "/json_rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "smoke", method: "get_info", params: {} }),
  });
  assert.equal(tip.response.status, 200);
  assert.equal(tip.body.result.height, 120);

  const transactions = await json(base + "/get_transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txs_hashes: [TXID], decode_as_json: true }),
  });
  assert.equal(transactions.response.status, 200);
  assert.equal(transactions.body.txs_as_json.length, 1);

  const slice = await json(base + "/v1/witness/slice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, network: fixture.network, grid: fixture.grid, slice: fixture.slice }),
  });
  assert.equal(slice.response.status, 200);
  assert.equal(slice.body.from, fixture.from);
  assert.equal(slice.body.to, fixture.to);
  assert.equal(slice.body.blocks.length, 20);
  assert.deepEqual(slice.body.blocks.map((block) => block.height), Array.from({ length: 20 }, (_, i) => fixture.from + i));
  assert.deepEqual(slice.body.blocks.map((block) => block.hash), fixture.hashes);

  const user = docker(["inspect", "--format", "{{.Config.User}}", NAME]);
  assert.equal(user, "10001:10001", "the container runs as the contract UID/GID");
  assert.equal(docker(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", NAME]), "true");
  assert.equal(docker(["inspect", "--format", "{{.HostConfig.CapDrop}}", NAME]), "[ALL]");

  let dockerHealth = "";
  for (let i = 0; i < 60; i++) {
    dockerHealth = docker(["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", NAME]);
    if (dockerHealth === "healthy") break;
    await sleep(1000);
  }
  assert.equal(dockerHealth, "healthy", "the image healthcheck turns healthy");

  console.log("witness container smoke: passed");
} catch (error) {
  failure = error;
  if (container) {
    try { console.error(docker(["logs", container], { check: false })); } catch { /* best effort */ }
  }
} finally {
  if (container) {
    try { docker(["rm", "-f", container], { check: false }); } catch { /* best effort */ }
  }
  if (daemon) await daemon.close();
}

if (failure) {
  console.error("FAILED: " + (failure && failure.message ? failure.message : failure));
  process.exit(1);
}
