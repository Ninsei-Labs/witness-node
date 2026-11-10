#!/usr/bin/env node
// THE PROXY ROUTES ARE LOAD-BEARING.
//
// The SDK reads the witness tip and the slice's transaction bodies from the same origin as the slice. A server
// that serves only `/v1/witness/slice` looks complete in a route list but fails on the first real call. These
// mutations remove each proxy route and prove the interop route is what keeps the client working.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "rfq-witness-teeth-"));
const problems = [];
const check = (condition, message) => { if (condition) console.log("  ok    " + message); else problems.push(message); };
const TXID = "ab".repeat(32);
const hash = (height) => String(height).padStart(64, "0");
let daemonUntrusted = false;

const daemon = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/json_rpc" && body.method === "get_info") {
        return res.end(JSON.stringify({ result: { height: 120, synchronized: true, status: "OK", nettype: "stagenet" } }));
      }
      if (req.url === "/get_transactions") {
        return res.end(JSON.stringify({ txs: [{ tx_hash: TXID, block_height: 105 }], txs_as_json: ['{"version":2}'],
          status: "OK", untrusted: daemonUntrusted }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unexpected" }));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, url: "http://127.0.0.1:" + server.address().port }));
});

async function mutated(name, from, to) {
  const source = readFileSync(join(ROOT, "src", "witnessServer.mjs"), "utf8").replace(/\r\n/g, "\n");
  const at = source.indexOf(from);
  if (at < 0) throw new Error("the mutation did not apply: " + name);
  const changed = source.slice(0, at) + to + source.slice(at + from.length);
  const rewritten = changed.replace('from "./witnessSlice.mjs"',
    'from "' + pathToFileURL(join(ROOT, "src", "witnessSlice.mjs")).href + '"');
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return import(pathToFileURL(file).href + "?v=" + name);
}

async function serve(module) {
  const server = module.createWitnessServer({ network: "stagenet", daemonUrl: daemon.url });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + server.address().port };
}

async function call(base, path, body) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

try {
  const real = await import(pathToFileURL(join(ROOT, "src", "witnessServer.mjs")).href);
  const actual = await serve(real);
  try {
    const info = await call(actual.url, "/json_rpc", { jsonrpc: "2.0", id: "i", method: "get_info" });
    check(info.status === 200, "the shipped server answers get_info");
    const txs = await call(actual.url, "/get_transactions", { txs_hashes: [TXID], decode_as_json: true });
    check(txs.status === 200, "the shipped server answers get_transactions");
  } finally { await close(actual.server); }

  const noReadiness = await mutated("no-untrusted-guard",
    "if (answer && answer.untrusted === true) {", "if (false) {");
  const noReadinessServer = await serve(noReadiness);
  try {
    daemonUntrusted = true;
    const answer = await call(noReadinessServer.url, "/get_transactions", { txs_hashes: [TXID], decode_as_json: true });
    check(answer.status === 200, "removing the untrusted guard lets an untrusted daemon relay transactions");
  } finally {
    daemonUntrusted = false;
    await close(noReadinessServer.server);
  }

  const noInfo = await mutated("no-info", 'if (req.method === "POST" && req.url === "/json_rpc") {', "if (false) {");
  const noInfoServer = await serve(noInfo);
  try {
    const answer = await call(noInfoServer.url, "/json_rpc", { jsonrpc: "2.0", id: "i", method: "get_info" });
    check(answer.status === 404, "removing the get_info route makes the tip call fail");
  } finally { await close(noInfoServer.server); }

  const noTxs = await mutated("no-txs", 'if (req.method === "POST" && req.url === "/get_transactions") {', "if (false) {");
  const noTxsServer = await serve(noTxs);
  try {
    const answer = await call(noTxsServer.url, "/get_transactions", { txs_hashes: [TXID], decode_as_json: true });
    check(answer.status === 404, "removing the get_transactions route makes the slice bodies unavailable");
  } finally { await close(noTxsServer.server); }
} finally {
  await close(daemon.server);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (problems.length) {
  for (const problem of problems) console.log("FAIL " + problem);
  console.log("FAILED: " + problems.length + " problem(s)");
  process.exit(1);
}
console.log("witness teeth: 5 checks passed");
