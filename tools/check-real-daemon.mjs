#!/usr/bin/env bun
// A REAL MONERO DAEMON, NOT A FIXTURE. This is the wire-shape gate the fake daemon cannot provide: regtest
// mining, a real wallet transaction, the pool before and after confirmation, and the witness routes over the
// same daemon. Docker is already required by the container smoke; the two images are pinned by digest here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createWitnessServer } from "../src/witnessServer.mjs";

const MONEROD_IMAGE = process.env.MONEROD_IMAGE || "sethsimmons/simple-monerod:v0.18.3.4@sha256:45811e099ad2d4170e6d661c87923d32f275e39fa933996a191bfd91fbbc90c8";
const WALLET_IMAGE = process.env.WALLET_IMAGE || "sethsimmons/simple-monero-wallet-rpc:v0.18.3.4@sha256:d0c2c1dd9620a566c3fce95dd2b9a29dd2839b2a493e91dcafe3d142becb1a90";
const NAME = "witness-regtest-" + process.pid + "-" + Date.now();
const moneroName = NAME + "-node";
const walletName = NAME + "-wallet";

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

async function rpc(url, method, params = {}, timeoutMs = 120_000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "witness-real-daemon", method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(method + " failed: " + JSON.stringify(body.error || body));
  return body.result;
}

async function waitFor(url, check, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* the listener or the other container is still starting */ }
    await sleep(500);
  }
  throw new Error("timed out waiting for " + label);
}

async function json(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error("non-JSON answer from " + url + ": " + text.slice(0, 200)); }
  return { response, body };
}

const witness = { server: null };
try {
  const moneroPort = await freePort();
  const walletPort = await freePort();
  docker(["run", "-d", "--name", moneroName,
    "-p", "127.0.0.1:" + moneroPort + ":18081",
    MONEROD_IMAGE,
    "--regtest", "--offline", "--fixed-difficulty=1",
    "--rpc-bind-ip=0.0.0.0", "--confirm-external-bind", "--rpc-bind-port=18081",
    "--p2p-bind-port=18080", "--no-igd", "--log-level=1"]);
  const moneroRpc = "http://127.0.0.1:" + moneroPort + "/json_rpc";
  await waitFor(moneroRpc, async () => (await rpc(moneroRpc, "get_info")).height >= 0, "monerod RPC");

  docker(["run", "-d", "--name", walletName,
    "--add-host", "host.docker.internal:host-gateway",
    "-p", "127.0.0.1:" + walletPort + ":18083",
    "--entrypoint", "sh",
    WALLET_IMAGE,
    "-c", "exec monero-wallet-rpc --non-interactive --rpc-bind-ip=0.0.0.0 --confirm-external-bind "
      + "--daemon-address=http://host.docker.internal:" + moneroPort
      + " --allow-mismatched-daemon-version --rpc-bind-port=18083 --wallet-dir=/tmp/wallet --disable-rpc-login --log-level=1"]);
  const walletRpc = "http://127.0.0.1:" + walletPort + "/json_rpc";
  await waitFor(walletRpc, async () => Boolean((await rpc(walletRpc, "get_version")).version), "wallet RPC");

  await rpc(walletRpc, "create_wallet", { filename: "real", password: "", language: "English" });
  const address = (await rpc(walletRpc, "get_address", { account_index: 0 })).address;
  assert.match(address, /^[0-9A-Za-z]{90,110}$/, "the wallet returned a testnet/regtest address");

  witness.server = createWitnessServer({
    network: "fakechain", daemonUrl: "http://127.0.0.1:" + moneroPort, allowGetBlock: true,
  });
  await new Promise((resolve) => witness.server.listen(0, "127.0.0.1", resolve));
  const witnessBase = "http://127.0.0.1:" + witness.server.address().port;

  const emptyPool = await json(witnessBase + "/get_transaction_pool_hashes", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(emptyPool.response.status, 200);
  assert.deepEqual(emptyPool.body.tx_hashes, [], "a fresh regtest pool is an empty list");

  const mine = (amount, nonce) => rpc(moneroRpc, "generateblocks",
    { amount_of_blocks: amount, wallet_address: address, starting_nonce: nonce });
  await mine(180, 0);
  const emptySlice = await json(witnessBase + "/v1/witness/slice", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, network: "fakechain", grid: 20, slice: 5 }),
  });
  assert.equal(emptySlice.response.status, 200);
  assert.equal(emptySlice.body.blocks.length, 20);
  assert.ok(emptySlice.body.blocks.every((block) => block.num_txes === 0),
    "the mined coinbase-only blocks are empty blocks");

  await rpc(walletRpc, "refresh");
  let balance = await rpc(walletRpc, "get_balance", { account_index: 0 });
  if (balance.unlocked_balance === 0) {
    await mine(60, 180);
    await rpc(walletRpc, "refresh");
    balance = await rpc(walletRpc, "get_balance", { account_index: 0 });
  }
  assert.ok(balance.unlocked_balance > 1_000_000_000_000, "the mined wallet has an unlocked balance");

  const transfer = await rpc(walletRpc, "transfer", {
    destinations: [{ amount: 1_000_000_000_000, address }], account_index: 0, priority: 0,
  }, 180_000);
  const txid = transfer.tx_hash;
  assert.match(txid, /^[0-9a-f]{64}$/i, "the wallet returned a txid");

  const pendingPool = await json(witnessBase + "/get_transaction_pool_hashes", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(pendingPool.response.status, 200);
  assert.ok(pendingPool.body.tx_hashes.includes(txid), "the witness sees the unconfirmed pool transaction");

  await mine(1, 240);
  await rpc(walletRpc, "refresh");
  const emptyAgain = await json(witnessBase + "/get_transaction_pool_hashes", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(emptyAgain.response.status, 200);
  assert.ok(!emptyAgain.body.tx_hashes.includes(txid), "a mined transaction leaves the pool");

  const info = await rpc(moneroRpc, "get_info");
  const sliceIndex = Math.max(0, Math.floor((info.height - 1) / 20));
  const confirmedSlice = await json(witnessBase + "/v1/witness/slice", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, network: "fakechain", grid: 20, slice: sliceIndex }),
  });
  assert.equal(confirmedSlice.response.status, 200);
  const withTx = confirmedSlice.body.blocks.find((block) => block.txids.includes(txid));
  assert.ok(withTx, "the confirmed transaction appears in a non-empty block");
  assert.ok(withTx.num_txes >= 1, "the non-empty block reports its transaction count");

  const transactions = await json(witnessBase + "/get_transactions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ txs_hashes: [txid], decode_as_json: true }),
  });
  assert.equal(transactions.response.status, 200);
  assert.equal(transactions.body.txs.length, 1);
  assert.equal(transactions.body.txs[0].tx_hash, txid);

  const compatibility = await json(witnessBase + "/json_rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "real", method: "get_block", params: { height: withTx.height } }),
  });
  assert.equal(compatibility.response.status, 200);
  assert.equal(compatibility.body.result.block_header.height, withTx.height);

  console.log("real monerod regtest: pool, blocks, transaction, slice and transactions passed");
} finally {
  if (witness.server) await new Promise((resolve) => { witness.server.closeAllConnections?.(); witness.server.close(resolve); });
  for (const name of [walletName, moneroName]) {
    try { docker(["rm", "-f", name], { check: false }); } catch { /* best effort */ }
  }
}
