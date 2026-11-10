// A SMALL STAND-IN MONEROD FOR THE CONTAINER SMOKE.
//
// It is deliberately deterministic: block 100..119 have hashes derived from their heights, so the smoke can pin
// exact hashes and catch a witness that returns the wrong range or a partial slice. It is not a real chain and it
// must never be used as an integration stand.
import { createServer } from "node:http";

export const TXID = "ab".repeat(32);
export const SLICE_FIRST = 100;
export const SLICE_LAST = 119;

export function blockHash(height) {
  return String(height).padStart(64, "0");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("bad-json")); }
    });
    req.on("error", reject);
  });
}

export function startFakeDaemon({ host = "0.0.0.0", port = 0, network = "stagenet", state = {} } = {}) {
  const info = () => ({
    height: 120, synchronized: true, nettype: network, busy: false, busy_syncing: false, untrusted: false,
    status: "OK", ...state,
  });
  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      res.setHeader("content-type", "application/json");
      if (req.url === "/json_rpc") {
        if (body.method === "get_info") {
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: info() }));
        }
        if (body.method === "get_block") {
          const height = Number(body.params && body.params.height);
          if (!Number.isInteger(height) || height < SLICE_FIRST || height > SLICE_LAST) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: { message: "height outside fixture" } }));
          }
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
            block_header: { height, hash: blockHash(height) },
            tx_hashes: height === 105 ? [TXID] : [],
          } }));
        }
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: "method not proxied" } }));
      }
      if (req.url === "/get_transactions") {
        const txids = Array.isArray(body.txs_hashes) ? body.txs_hashes : [];
        return res.end(JSON.stringify({ txs_as_json: txids.map((txid) => JSON.stringify({ txid })), txs: [],
          status: state.status || "OK", untrusted: state.untrusted === true }));
      }
      res.statusCode = 404;
      res.end("{}");
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        url: "http://127.0.0.1:" + actualPort,
        state,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
      });
    });
  });
}
