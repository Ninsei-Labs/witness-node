#!/usr/bin/env bun
// THE WIRE FORMAT IS TESTED ACROSS THE TWO REPOSITORIES, NOT TWICE AGAINST STANDS.
//
// The witness server is the real service. The SDK parser and `verifyArrivalShadow` are the modules the browser
// uses. A change to either side that drifts from the other fails here, even when each repository's own tests stay
// green. The SDK checkout is pinned by the workflow so "this commit passed" does not depend on SDK main at run time.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWitnessServer } from "../src/witnessServer.mjs";
import { startFakeDaemon, TXID } from "./fake-monerod.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIR = process.env.SDK_DIR || join(ROOT, "..", "sdk");
const sdkFile = (relative) => pathToFileURL(join(SDK_DIR, relative)).href;

let parser;
let arrival;
let primitives;
let scan;
let addressModule;
try {
  parser = await import(sdkFile("src/witness-slice.mjs"));
  arrival = await import(sdkFile("src/xmr-arrival.mjs"));
  primitives = await import(sdkFile("src/primitives.mjs"));
  scan = await import(sdkFile("engine/monero/scan.js"));
  addressModule = await import(sdkFile("engine/monero/address.js"));
} catch (error) {
  throw new Error("the SDK modules are not available at " + SDK_DIR + " (set SDK_DIR): " + (error && error.message));
}

const G = primitives.ed25519.Point.BASE;
const AMOUNT = 1_000_000_000n;
const VIEW = 11n;
const SPEND = 13n;
const R = 17n;

function le8(value) {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function xorBytes(bytes, factor) {
  const out = bytes.slice();
  for (let i = 0; i < out.length && i < factor.length; i++) out[i] ^= factor[i];
  return out;
}

function factor(label, scalarLE) {
  const name = new TextEncoder().encode(label);
  const buf = new Uint8Array(name.length + scalarLE.length);
  buf.set(name, 0);
  buf.set(scalarLE, name.length);
  return primitives.keccak256(buf);
}

function fixture() {
  const spendPub = G.multiply(SPEND).toHex();
  const txPublicKey = G.multiply(R).toHex();
  const derivation = scan.keyDerivation(txPublicKey, VIEW);
  const scalar = scan.hashToScalar(derivation, scan.varint(0));
  const scalarLE = scan.scalarToBytesLE(scalar);
  const amountCipher = xorBytes(le8(AMOUNT), factor("amount", scalarLE));
  const mask = scan.hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  const outPk = scan.amountMaskCommitment(AMOUNT, mask);
  const key = scan.derivedOutputKey(derivation, 0, spendPub);
  return {
    version: 2,
    unlock_time: 0,
    extra: [1, ...scan.hexToBytes(txPublicKey)],
    vout: [{ amount: 0, target: { tagged_key: { key, view_tag: "00" } } }],
    rct_signatures: { type: 6, ecdhInfo: [{ amount: scan.bytesToHex(amountCipher) }], outPk: [outPk] },
  };
}

const spendPub = G.multiply(SPEND).toHex();
const viewPub = G.multiply(VIEW).toHex();
const address = addressModule.addressFromKeys({ network: "stagenet", kind: "primary", spendPub, viewPub },
  { keccak256: primitives.keccak256 });
const tx = fixture();

const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const show = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);

async function witnessFor(daemon, operator) {
  const server = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url, healthTtlMs: 0, operator });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + server.address().port, operator };
}

const NGINX_IMAGE = "nginx:1.31.10-alpine@sha256:7fc0fb4af7bf006aeb31aea88069976060f8f0a0a86b667126742cc17f4e31ae";
const nginxDir = mkdtempSync(join(tmpdir(), "witness-nginx-"));
const nginxNames = [];

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) throw new Error("docker is not available: " + result.error.message);
  if (result.status !== 0) throw new Error("docker " + args.join(" ") + " failed:\n" + (result.stderr || result.stdout || "").trim());
  return String(result.stdout || "").trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function nginxConfig(witnessPort) {
  // RUN THE DOCUMENTED CONFIG, NOT A SECOND COPY. The README example is the deployment surface; strip only the
  // TLS listener and certificate paths, then point its upstream at the test witness. A route that exists in the
  // test but not in the README (or the reverse) cannot pass this interop.
  const readmePath = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const fence = readme.indexOf("```nginx");
  const endFence = fence < 0 ? -1 : readme.indexOf("```", fence + 8);
  if (fence < 0 || endFence < 0) throw new Error("README has no nginx example");
  const documented = readme.slice(fence + 8, endFence)
    .replace(/^\s*server 127\.0\.0\.1:8796;\s*$/m, "    server host.docker.internal:" + witnessPort + ";")
    .replace(/^\s*http2 on;.*$/m, "")
    .replace(/^\s*ssl_[^\n]*$/gm, "")
    .replace(/^\s*listen 443 ssl;\s*$/m, "    listen 8080;");
  if (!documented.includes("host.docker.internal:" + witnessPort)) {
    throw new Error("README nginx upstream is not the expected witness address");
  }
  if (!documented.includes("listen 8080;")) throw new Error("README nginx listener was not rewritten");
  return "events {}\n" + documented;
}


async function exposeThroughNginx(witness) {
  const port = await freePort();
  const name = "witness-nginx-" + process.pid + "-" + nginxNames.length;
  const config = join(nginxDir, name + ".conf");
  writeFileSync(config, nginxConfig(witness.server.address().port));
  docker(["run", "-d", "--name", name, "--add-host", "host.docker.internal:host-gateway",
    "-p", "127.0.0.1:" + port + ":8080",
    "-v", config.replace(/\\/g, "/") + ":/etc/nginx/nginx.conf:ro",
    NGINX_IMAGE]);
  nginxNames.push(name);
  const url = "http://127.0.0.1:" + port;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(url + "/live");
      if (response.ok) return url;
    } catch { /* nginx is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("nginx did not start for " + witness.operator);
}

async function shadow(exact, witnesses) {
  return arrival.verifyArrivalShadow({
    nodes: [{ url: exact.url, operator: "A" }, { url: exact.url, operator: "B" }],
    witnessNodes: witnesses.map((witness) => ({ url: witness.url, operator: witness.operator, protocol: "witness-v1" })),
    address, viewSecret: VIEW, spendPub, expectedAtomic: AMOUNT, minConfirmations: 1, fromHeight: 100,
  });
}

const servers = [];
try {
  const paidDaemon = await startFakeDaemon({ host: "127.0.0.1", state: { height: 120 }, txJson: tx });
  const paidWitnesses = [await witnessFor(paidDaemon, "W1"), await witnessFor(paidDaemon, "W2")];
  paidWitnesses[0].url = await exposeThroughNginx(paidWitnesses[0]);
  servers.push(paidDaemon, ...paidWitnesses);

  const paid = await shadow(paidDaemon, paidWitnesses);
  assert.equal(paid.exact.state, "arrived", show(paid.exact));
  assert.equal(paid.exact.txid, TXID);
  assert.equal(paid.exact.amountAtomic, String(AMOUNT));
  assert.equal(paid.witness.state, "seen", show(paid.witness));
  assert.equal(paid.witness.txid, TXID);
  assert.equal(paid.witness.completed, true, show(paid.witness));
  assert.deepEqual(paid.problems, []);
  assert.equal(paid.agrees, true, show(paid.problems));

  const emptyDaemon = await startFakeDaemon({ host: "127.0.0.1", state: { height: 120 }, payout: false });
  const emptyWitnesses = [await witnessFor(emptyDaemon, "W1"), await witnessFor(emptyDaemon, "W2")];
  emptyWitnesses[0].url = await exposeThroughNginx(emptyWitnesses[0]);
  servers.push(emptyDaemon, ...emptyWitnesses);

  const absent = await shadow(emptyDaemon, emptyWitnesses);
  assert.equal(absent.exact.absent, true, show(absent.exact));
  assert.equal(absent.witness.completed, true, show(absent.witness));
  assert.deepEqual(absent.problems, []);
  assert.equal(absent.agrees, true, show(absent.problems));

  // THE POOL IS A SEPARATE WIRE READ. A transaction that is only in the mempool must be named by the SDK, while
  // the block walk still reports no arrival. This covers the non-empty pool side of the pool-aware SDK pin.
  const poolDaemon = await startFakeDaemon({
    host: "127.0.0.1", state: { height: 120, poolHashes: [TXID] }, payout: false, txJson: tx,
  });
  const poolWitnesses = [await witnessFor(poolDaemon, "W1"), await witnessFor(poolDaemon, "W2")];
  poolWitnesses[0].url = await exposeThroughNginx(poolWitnesses[0]);
  servers.push(poolDaemon, ...poolWitnesses);

  const pooled = await shadow(poolDaemon, poolWitnesses);
  assert.equal(pooled.exact.state, "pool", show(pooled.exact));
  assert.equal(pooled.exact.txid, TXID, show(pooled.exact));
  assert.equal(pooled.exact.confirmations, 0, show(pooled.exact));
  assert.ok(poolDaemon.calls.some((call) => call.path === "/get_transaction_pool_hashes"),
    "the SDK read the pool route before it could report the mempool transaction");

  // BOTH POOL SHAPES ARE EXPLICIT. The fake daemon omits tx_hashes for an empty pool, like monerod, and returns
  // the txid for a non-empty one. The witness must answer both through its public route.
  const emptyPoolAnswer = await fetch(paidWitnesses[0].url + "/get_transaction_pool_hashes", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(emptyPoolAnswer.status, 200);
  assert.deepEqual((await emptyPoolAnswer.json()).tx_hashes, [], "the empty pool is an explicit empty list");
  const filledPoolAnswer = await fetch(poolWitnesses[0].url + "/get_transaction_pool_hashes", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(filledPoolAnswer.status, 200);
  assert.deepEqual((await filledPoolAnswer.json()).tx_hashes, [TXID], "the non-empty pool is the daemon's list");
  const unknownThroughNginx = await fetch(paidWitnesses[0].url + "/unknown", { method: "POST" });
  assert.equal(unknownThroughNginx.status, 404, "the documented nginx catch-all keeps unknown paths away from the witness");

  // THE REAL SLICE BODY STILL PARSES THROUGH THE SDK PARSER. The shadow above uses the same server path, but this
  // pins the wire shape independently of the arrival decision.
  const response = await fetch(paidWitnesses[0].url + "/v1/witness/slice", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, network: "stagenet", grid: 20, slice: 5 }),
  });
  assert.equal(response.status, 200);
  const slice = parser.parseWitnessSliceBody(await response.json(), { network: "stagenet", index: 5, tipHeight: 119 });
  assert.equal(slice.complete, true);
  assert.equal(slice.blocks.length, 20);
  assert.equal(slice.tip, null);

  console.log("sdk/witness interop: the real server drives the SDK arrival shadow");
} finally {
  for (const server of servers.reverse()) await close(server.server);
  for (const name of nginxNames) {
    try { spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" }); } catch { /* best effort */ }
  }
  rmSync(nginxDir, { recursive: true, force: true });
}
