# Witness v1: fixed block slices

The witness endpoint lets a client verify a Monero payment without telling the witness which order it is checking.
It returns a fixed slice of blocks instead of an exact height.

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
  "blocks": [
    {"height":1469020,"hash":"<64 hex>","txids":["<64 hex>"]}
  ]
}
```

The response has exactly `grid` blocks, consecutive heights, a 64-hex block hash for each, and an array of
transaction ids (empty for an empty block). A partial slice, a missing block or a malformed hash is a refusal.

## Why a slice

An exact `get_block(height)` tells the witness the order's start or payout block. A fixed slice tells it only a
20-block bucket. The client scans every block in the slice; it never asks the witness for the payout height.

The client then asks for the transactions of the whole slice, not of one block. The endpoint itself returns only
hashes and transaction ids, so the caller can choose which transaction set to read.

## CORS and access

The endpoint is read-only and has no wallet, key, order journal or maker route. It is safe to expose as a public
service.

```text
GET  /live                liveness
GET  /health              readiness (daemon + network)
GET  /metrics             Prometheus text, loopback only by default
GET  /info                protocol and optional operator metadata
POST /json_rpc            get_info only
POST /get_transactions    the slice's txids
POST /v1/witness/slice
```

CORS is allowed for the browser SDK. `RFQ_WITNESS_ALLOW_ORIGIN` narrows the origin; `*` is the default for a public
witness.

The SDK needs the witness tip and the transaction bodies of the slice it just received. The service proxies exactly
those two reads to its daemon: `/json_rpc` accepts only `get_info`, and `/get_transactions` accepts the txids the
slice answer disclosed. Neither route names an order, and neither turns the service into an arbitrary daemon proxy.

## Operational endpoints

`GET /live` is true as soon as the process answers. It does not touch the daemon.

`GET /health` is readiness. It probes the daemon's `get_info`, requires `synchronized` and a matching `nettype`, and
returns `200` with `checks: {daemon, network}` when ready, or `503` when the daemon is unavailable, busy, or on
another network. The answer never contains the daemon URL. The probe is cached for `RFQ_WITNESS_HEALTH_TTL_MS`
(default `5000`) so a scrape loop cannot turn into a daemon request loop.

`GET /metrics` uses the Prometheus text format. It exposes the process state, the last readiness result, the
protocol/network/operator identity and request counts by route and status. It does not expose order data, block
heights, txids or the daemon URL. It is loopback-only unless `RFQ_WITNESS_METRICS_PUBLISH` is `1`, `true`, `yes` or
`on`; a public proxy must not forward this route.

`GET /info` returns the service name, protocol version, network, grid, uptime and the optional public
`RFQ_WITNESS_OPERATOR` and `RFQ_WITNESS_CONTACT` values. It never returns private keys, wallet data, the daemon URL or
the caller's address. The operator and contact are optional because naming an operator is a publication decision.

A container healthcheck should use `/live`; an orchestrator readiness check should use `/health`.

## Run

The service is `witness-server.mjs` in this tree.

```bash
RFQ_XMR_DAEMON=http://127.0.0.1:38081 \
RFQ_WITNESS_NETWORK=stagenet \
RFQ_WITNESS_HOST=127.0.0.1 \
RFQ_WITNESS_PORT=8796 \
bun witness-server.mjs
```

Optional settings:

| Variable | Default | Meaning |
|---|---|---|
| `RFQ_WITNESS_NETWORK` | `stagenet` | network named in every answer |
| `RFQ_WITNESS_HOST` | `127.0.0.1` | listen address; a public deployment uses a proxy or `0.0.0.0` |
| `RFQ_WITNESS_PORT` | `8796` | listen port; 8795 is the documented screen-hook example |
| `RFQ_WITNESS_ALLOW_ORIGIN` | `*` | CORS allow origin |
| `RFQ_WITNESS_TIMEOUT_MS` | `8000` | per-daemon request deadline |
| `RFQ_WITNESS_OPERATOR` | unset | optional public operator name in `/info` and metrics |
| `RFQ_WITNESS_CONTACT` | unset | optional public contact in `/info` |
| `RFQ_WITNESS_METRICS_PUBLISH` | unset | `1` exposes `/metrics` beyond loopback |
| `RFQ_WITNESS_HEALTH_TTL_MS` | `5000` | readiness probe cache |
| `RFQ_WITNESS_MAX_INFLIGHT` | `4` | concurrent daemon-backed requests; excess requests get `503 busy` |

The service refuses to start without `RFQ_XMR_DAEMON`.

## Refusals

| Code | HTTP | Meaning |
|---|---|---|
| `bad-request` | 400 | malformed JSON, extra field, body too large |
| `bad-version` | 400 | `version` is not 1 |
| `wrong-network` | 400 | the request names another network |
| `bad-grid` | 400 | `grid` is not 20 |
| `bad-slice` | 400 | `slice` is not a safe non-negative integer |
| `daemon-unavailable` | 503 | the Monero daemon did not answer |
| `busy` | 503 | the in-flight daemon-work ceiling is full |
| `bad-daemon-answer` | 502 | the daemon returned a partial, malformed or inconsistent slice |

## What this protocol does not hide

The witness still sees the caller's IP and the 20-block bucket. It does not see the exact order start, the payout
block, the txid or an order id. Hiding the bucket or the IP requires a different design (cover traffic, a proxy or
a private transport) and is outside this endpoint.

## Independence

The endpoint must be operated by a separate operator from Ninsei and from the deal's maker. Two URLs on one
operator are one opinion. A client that needs an arrival quorum expects the same observation from two independent
operators, not from two instances of this service.
