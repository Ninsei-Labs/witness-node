#!/usr/bin/env bun
// THE WIRE FORMAT IS TESTED ACROSS THE TWO REPOSITORIES, NOT TWICE AGAINST STANDS.
//
// The witness server is the real service. The parser is the SDK module the browser uses. A change to either side
// that drifts from the other fails here, even when each repository's own tests stay green.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createWitnessServer } from "../src/witnessServer.mjs";
import { startFakeDaemon } from "./fake-monerod.mjs";

const ROOT = join(import.meta.dir, "..");
const SDK_DIR = process.env.SDK_DIR || join(ROOT, "..", "sdk");
let parser;
try {
  parser = await import(pathToFileURL(join(SDK_DIR, "src", "witness-slice.mjs")).href);
} catch (error) {
  throw new Error("the SDK parser is not available at " + SDK_DIR + " (set SDK_DIR): " + (error && error.message));
}

const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

let daemon;
let witness;
try {
  daemon = await startFakeDaemon({ host: "127.0.0.1", state: { height: 116 } });
  witness = createWitnessServer({ network: "stagenet", daemonUrl: daemon.url, healthTtlMs: 0 });
  await new Promise((resolve) => witness.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + witness.address().port;

  const call = async () => {
    const response = await fetch(base + "/v1/witness/slice", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, network: "stagenet", grid: 20, slice: 5 }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const partial = parser.parseWitnessSliceBody(await call(), { network: "stagenet", index: 5, tipHeight: 115 });
  assert.equal(partial.complete, false);
  assert.equal(partial.to, 115);
  assert.equal(partial.blocks.length, 16);
  assert.deepEqual(partial.tip, { height: 115, hash: partial.blocks[15].hash });

  daemon.state.height = 120;
  const full = parser.parseWitnessSliceBody(await call(), { network: "stagenet", index: 5, tipHeight: 119 });
  assert.equal(full.complete, true);
  assert.equal(full.to, 119);
  assert.equal(full.blocks.length, 20);
  assert.equal(full.tip, null);

  console.log("sdk/witness interop: the real server answer parses in the SDK");
} finally {
  if (witness) await close(witness);
  if (daemon) await daemon.close();
}
