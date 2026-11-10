#!/usr/bin/env bun
// THE WIRE FORMAT IS TESTED ACROSS THE TWO REPOSITORIES, NOT TWICE AGAINST STANDS.
//
// The witness server is the real service. The SDK parser and `verifyArrivalShadow` are the modules the browser
// uses. A change to either side that drifts from the other fails here, even when each repository's own tests stay
// green. The SDK checkout is pinned by the workflow so "this commit passed" does not depend on SDK main at run time.
import assert from "node:assert/strict";
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

async function witnessFor(daemon) {
  const server = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url, healthTtlMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + server.address().port };
}

async function shadow(exact, witness) {
  return arrival.verifyArrivalShadow({
    nodes: [{ url: exact.url, operator: "A" }, { url: exact.url, operator: "B" }],
    witnessNodes: [{ url: witness.url, operator: "W", protocol: "witness-v1" }],
    address, viewSecret: VIEW, spendPub, expectedAtomic: AMOUNT, minConfirmations: 1, fromHeight: 100,
  });
}

const servers = [];
try {
  const paidDaemon = await startFakeDaemon({ host: "127.0.0.1", state: { height: 120 }, txJson: tx });
  const paidWitness = await witnessFor(paidDaemon);
  servers.push(paidDaemon, paidWitness);

  const paid = await shadow(paidDaemon, paidWitness);
  assert.equal(paid.exact.state, "arrived", show(paid.exact));
  assert.equal(paid.exact.txid, TXID);
  assert.equal(paid.exact.amountAtomic, String(AMOUNT));
  assert.equal(paid.witness.state, "seen", show(paid.witness));
  assert.equal(paid.witness.txid, TXID);
  assert.equal(paid.witness.completed, true, show(paid.witness));
  assert.deepEqual(paid.problems, []);
  assert.equal(paid.agrees, true, show(paid.problems));

  const emptyDaemon = await startFakeDaemon({ host: "127.0.0.1", state: { height: 120 }, payout: false });
  const emptyWitness = await witnessFor(emptyDaemon);
  servers.push(emptyDaemon, emptyWitness);

  const absent = await shadow(emptyDaemon, emptyWitness);
  assert.equal(absent.exact.absent, true, show(absent.exact));
  assert.equal(absent.witness.completed, true, show(absent.witness));
  assert.deepEqual(absent.problems, []);
  assert.equal(absent.agrees, true, show(absent.problems));

  // THE REAL SLICE BODY STILL PARSES THROUGH THE SDK PARSER. The shadow above uses the same server path, but this
  // pins the wire shape independently of the arrival decision.
  const response = await fetch(paidWitness.url + "/v1/witness/slice", {
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
}
