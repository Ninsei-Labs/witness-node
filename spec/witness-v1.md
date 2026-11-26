# Witness v1: fixed block slices

The witness endpoint lets a client verify a Monero payment without telling the witness which order it is checking.
It returns a fixed slice of blocks instead of an exact height.

## RPC profile

The witness is not a generic `monerod` proxy. The supported methods, dropped parameters, response reshaping and
refusal codes are in [`../docs/RPC.md`](../docs/RPC.md).

## Endpoint

```http
POST /v1/witness/slice
Content-Type: application/json
```

Request:

```json
{"version":1,"network":"stagenet","grid":20,"slice":73451}
```

Rules:

- `version` is `1`.
- `network` is `mainnet`, `stagenet` or `testnet`, and must match the server.
- `grid` is the fixed `20`; a different value is refused.
- `slice` is a non-negative integer. The slice covers `slice * 20` through `slice * 20 + 19`.
- No other fields are accepted. A height, block hash, txid or order id in the request is a refusal.

Response:

```json
{
  "version": 1,
  "network": "stagenet",
  "grid": 20,
  "slice": 73451,
  "from": 1469020,
  "to": 1469039,
  "complete": true,
  "blocks": [
    {"height":1469020,"hash":"<64 hex>","prev_hash":"<64 hex>","num_txes":1,"txids":["<64 hex>"]}
  ],
  "tip": null
}
```

A slice below the daemon tip has exactly `grid` blocks. The heights are consecutive. Each block has a 64-hex hash, the previous block's 64-hex hash, its transaction count and an array of transaction ids. The array is empty for an empty block. monerod omits `tx_hashes` when `block_header.num_txes` is 0; the witness returns `"txids": []` for that real shape. A missing `tx_hashes` with any other `num_txes` is a refusal. A missing block, a malformed hash, a missing parent hash, or a transaction count that disagrees with the txids is also a refusal. The parent hash lets a client check that the whole slice is one chain without asking for another height.

The slice that contains the daemon tip is partial. Its `to` is the top block. `complete` is `false`, and `tip` names that block with its height and hash. The client accepts `complete: false` only for the last slice of its walk. The `tip.height` must not be below the top the client read. A higher tip is a block that arrived during the walk, and it is accepted. A lower tip is refused. The walk never asks for a height above the tip, and absence is counted only up to it. The witness reads `top_block_hash` with the tip and refuses the slice with `502 bad-daemon-answer` when the last block's hash differs, so a reorg between the tip read and the block reads is not served as a consistent slice. A slice that starts above the daemon top is refused with `503 not-synchronized`: the witness is behind the caller, and the caller can retry.

## Why a slice

An exact `get_block(height)` tells the witness the order's start or payout block. A fixed slice tells it only a
20-block bucket. The client scans every block in the slice; it never asks the witness for the payout height.

The client then asks for the transactions of the whole slice, not of one block. The endpoint itself returns only
hashes and transaction ids, so the caller can choose which transaction set to read.

## CORS and access

The endpoint is read-only and has no wallet, key, order journal or maker route. A public deployment puts it behind a reverse proxy. Never publish the witness port or the Monero daemon port directly.

```text
GET  /live                liveness
GET  /health              readiness (daemon + network)
GET  /metrics             Prometheus text, loopback only by default
GET  /info                protocol and optional operator metadata
POST /json_rpc            get_info; get_block only with WITNESS_ALLOW_GET_BLOCK=1
POST /get_transaction_pool_hashes  on by default; WITNESS_ALLOW_POOL=0 turns it off
POST /get_transactions    1 to 4096 txids
POST /v1/witness/slice
```

CORS is allowed for the browser SDK. `WITNESS_ALLOW_ORIGIN` narrows the origin; `*` is the default for a public
witness.

The SDK needs the witness tip and the transaction bodies of the slice it just received. The service proxies exactly
those two reads to its daemon: `/json_rpc` accepts only `get_info` by default, and `/get_transactions` accepts 1 to 4096
txids in one bounded list. The service is stateless, so it cannot tell whether a txid came from a slice answer. Neither
route names an order, and neither turns the service into an arbitrary daemon proxy. `/get_transactions` applies the same
readiness rule from the daemon answer: `untrusted: true` is `503 not-synchronized`, `status: "BUSY"` is `503 busy`, and
any other non-OK status is `502 bad-daemon-answer`.

`WITNESS_ALLOW_GET_BLOCK=1` adds one narrow compatibility method to `/json_rpc`: `get_block` by exact height. The
block answer returns only `block_header` (`height`, `hash`, `prev_hash`, `num_txes`, `timestamp`) and `tx_hashes`,
never the daemon's `blob` or unrestricted body. It is off by default because an exact height names the order's start
or payout block; enable it only on a private witness used for recovery compatibility, not on the public slice endpoint.

`/get_transaction_pool_hashes` is a global, order-independent list and is on by default. `WITNESS_ALLOW_POOL=0` turns
it off. It is a separate switch from `get_block`, so a public witness can keep the pool route while refusing
exact-height reads.

## Operational endpoints

`GET /live` is true as soon as the process answers. It does not touch the daemon.

`GET /health` is readiness. It probes the daemon's `get_info` and requires `synchronized: true`, `busy_syncing: false`,
`untrusted: false`, `status: "OK"` and a matching `nettype`. It returns `200` with `checks: {daemon, network}` when
ready, or `503` when any of those checks fails. The answer never contains the daemon URL. The probe is cached for
`WITNESS_HEALTH_TTL_MS` (default `5000`) so a scrape loop cannot turn into a daemon request loop.

A deployment may publish `/health` through the public proxy so a client can avoid a syncing witness. It is a cached
readiness hint, not proof: a client that needs data must still verify the slice it receives. `/metrics` remains
non-public.

`POST /json_rpc` accepts `get_info`. It applies the same daemon check, then returns only `height`, `synchronized`,
`nettype` and `status`. It does not relay the daemon's version, peers, disk space or bootstrap address. A daemon that
is not ready is refused with `503 not-synchronized`. With `WITNESS_ALLOW_GET_BLOCK=1`, it also accepts
`get_block` for one exact height and returns the reduced compatibility shape described above; the height above the tip
is refused as `not-synchronized`.

`GET /metrics` uses the Prometheus text format. It exposes the process state, the last readiness result, the
protocol/network/operator identity and request counts by route and status. It does not expose order data, block
heights, txids or the daemon URL. It is loopback-only unless `WITNESS_METRICS_PUBLISH` is `1`, `true`, `yes` or
`on`; a public proxy must not forward this route.

`GET /info` returns the service name, protocol version, network, grid, uptime and the optional public
`WITNESS_OPERATOR` and `WITNESS_CONTACT` values. It never returns private keys, wallet data, the daemon URL or
the caller's address. The operator and contact are optional because naming an operator is a publication decision.

A container healthcheck uses `/live`; an orchestrator readiness check uses `/health`.

## Run

The service is `witness-server.mjs` in this tree.

```bash
WITNESS_XMR_DAEMON=http://127.0.0.1:38081 \
WITNESS_NETWORK=stagenet \
bun witness-server.mjs
```

Optional settings:

| Variable | Default | Meaning |
|---|---|---|
| `WITNESS_NETWORK` | `stagenet` | network named in every answer |
| `WITNESS_DEFAULT_HOST` | `127.0.0.1` | listen address; the image default is `0.0.0.0` |
| `WITNESS_DEFAULT_PORT` | `8796` | listen port; 8795 is the documented screen-hook example |
| `WITNESS_ALLOW_ORIGIN` | `*` | CORS allow origin |
| `WITNESS_TIMEOUT_MS` | `8000` | per-daemon request deadline |
| `WITNESS_OPERATOR` | unset | optional public operator name in `/info` and metrics |
| `WITNESS_CONTACT` | unset | optional public contact in `/info` |
| `WITNESS_METRICS_PUBLISH` | unset | `1` exposes `/metrics` beyond loopback |
| `WITNESS_ALLOW_GET_BLOCK` | unset | `1` adds the narrow exact-height `get_block` compatibility method |
| `WITNESS_ALLOW_POOL` | `1` | `0` turns off the global pool-hashes route |
| `WITNESS_HEALTH_TTL_MS` | `5000` | readiness probe cache |
| `WITNESS_MAX_INFLIGHT` | `4` | concurrent daemon-backed requests; excess requests get `503 busy` |
| `WITNESS_REQUEST_TIMEOUT_MS` | `10000` | request and header deadline in milliseconds |
| `WITNESS_SLICE_DEADLINE_MS` | `55000` | total slice deadline; below the documented 60 s proxy read timeout |

The service refuses to start without `WITNESS_XMR_DAEMON`. Only `WITNESS_*` names are read; the old `RFQ_*` names
do nothing. Boolean values are only `1/true/yes/on` and `0/false/no/off`; any other value is a startup error.

## Refusals

| Code | HTTP | Meaning |
|---|---|---|
| `bad-request` | 400 | malformed JSON, extra field, body too large |
| `bad-version` | 400 | `version` is not 1 |
| `wrong-network` | 400 | the request names another network |
| `bad-grid` | 400 | `grid` is not 20 |
| `bad-slice` | 400 | `slice` is not a safe non-negative integer |
| `daemon-unavailable` | 503 | the Monero daemon did not answer |
| `not-synchronized` | 503 | the daemon is behind, busy, untrusted, not OK or on another network; also a requested slice that starts above the daemon tip |
| `busy` | 503 | the in-flight daemon-work ceiling is full |
| `bad-daemon-answer` | 502 | the daemon returned a malformed or inconsistent slice |

## What this protocol does not hide

The witness still sees the caller's IP and the 20-block bucket. It does not see the exact order start, the payout
block, the txid or an order id.

At launch volume, one 40-minute birth bucket can hold about one escrow. An observer who sees the caller's IP and the
bucket can link that IP to that escrow, even though the exact height stays hidden. Hiding the bucket or the IP
requires a different design (cover traffic, a proxy or a private transport) and is outside this endpoint.

## Independence

The endpoint must be operated by a separate operator from Ninsei and from the deal's maker. Two URLs on one
operator are one opinion. A client that needs an arrival quorum expects the same observation from two independent
operators, not from two instances of this service.
