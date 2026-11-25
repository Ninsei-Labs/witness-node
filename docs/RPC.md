# Monero RPC profile

The witness is not a generic `monerod` proxy. It exposes a small, read-only allowlist, drops parameters it does not support and reshapes some answers. A client that talks to this service must use the shapes below instead of assuming generic Monero daemon behavior.

The fixed-slice protocol itself is in [`../spec/witness-v1.md`](../spec/witness-v1.md).

## Surface

| Route | HTTP method | Daemon reads |
|---|---|---|
| `/json_rpc` | `POST` | `get_info`; `get_block` only when `WITNESS_ALLOW_GET_BLOCK=1` |
| `/get_transaction_pool_hashes` | `POST` | `get_info`, then the pool route |
| `/get_transactions` | `POST` | `get_transactions` |
| `/v1/witness/slice` | `POST` | `get_info`, then one `get_block` per height |

The daemon calls use `POST` with a JSON body. The witness never forwards an arbitrary method, path or parameter.

## `/json_rpc`

The request is a JSON object with a `method`. The witness reads `method`, `params` and `id`.

- `jsonrpc` in the request is not checked. The answer always uses `"jsonrpc": "2.0"`.
- `get_info` accepts and ignores `params`. It does not return the daemon's version, peers, disk space, bootstrap address or other fields.
- `get_block` is available only with `WITNESS_ALLOW_GET_BLOCK=1`. Its `params` must be exactly `{"height": <non-negative safe integer>}`. Any other parameter or field is refused.
- An omitted `id` becomes `"witness"`. A `null` id stays `null`. Any other id is echoed unchanged.
- A method outside this allowlist is refused before any daemon call. This is not an arbitrary `monerod` proxy.

`get_info` performs the readiness check first. The daemon answer must have a safe integer `height`, a valid `top_block_hash` when the height is above zero, `synchronized: true`, `busy` and `busy_syncing` false, `untrusted` false, `status: "OK"` and a `nettype` matching `WITNESS_NETWORK`. A failure is a witness refusal, not a relayed daemon answer.

The successful `get_info` result is reduced to:

```json
{"height": 3400000, "synchronized": true, "nettype": "mainnet", "status": "OK"}
```

`get_block` returns only the fields a recovery reader checks:

```json
{
  "block_header": {
    "height": 3400000,
    "hash": "<64 hex>",
    "prev_hash": "<64 hex>",
    "num_txes": 1,
    "timestamp": 1700000000
  },
  "tx_hashes": ["<64 hex>"]
}
```

The `blob` is never returned. The `tx_hashes` values are lowercased and stripped of a leading `0x`. A height above the daemon top is `503 not-synchronized`.

## `/get_transactions`

The request body contains `txs_hashes`:

```json
{"txs_hashes": ["<64 hex>", "<64 hex>"]}
```

- The list must contain 1 to 4096 entries.
- Each entry must be 64 hexadecimal characters. A single lowercase leading `0x` is accepted and removed before forwarding; an uppercase `0X` is not.
- Other request fields are ignored and not forwarded. In particular, `decode_as_json`, `prune` and `split` are not passed through.
- `decode_as_json: true` is always sent to the daemon. A caller that does not want decoded JSON cannot turn it off.
- The daemon's transaction answer is returned unchanged after the status checks. The witness does not rebuild `txs`, `txs_as_json` or the other daemon fields.
- The answer is refused when the daemon says `untrusted: true` (`503 not-synchronized`), `status: "BUSY"` (`503 busy`) or any other non-`OK` status (`502 bad-daemon-answer`).

## `/get_transaction_pool_hashes`

The request body must be exactly `{}`. Any field is refused.

- The route is on by default. `WITNESS_ALLOW_POOL=0` makes it a `400 bad-request`.
- The witness reads the daemon tip first and applies the same readiness rule as the slice.
- A real `monerod` omits `tx_hashes` when the pool is empty. The witness turns that shape into `"tx_hashes": []`; it does not treat it as an error.
- A non-empty list is validated as 64-hex values, with an optional lowercase leading `0x`, and is returned in the daemon's order. The values are not rewritten; an empty pool is the only shape the witness changes.
- `untrusted: true` or a non-`OK` status is `502 bad-daemon-answer`. Unlike `/get_transactions`, an untrusted pool is not reported as `not-synchronized`.

## `/v1/witness/slice`

The request and response are defined in [`../spec/witness-v1.md`](../spec/witness-v1.md). The route accepts only `version`, `network`, `grid` and `slice`; a height, block hash, txid or order id is a refusal. The witness reads the tip and then one `get_block` per height in the fixed grid. It does not forward the caller's request to the daemon.

## Request and daemon response limits

| Item | Limit |
|---|---|
| `/json_rpc`, `/get_transaction_pool_hashes`, `/v1/witness/slice` request body | 1 KiB |
| `/get_transactions` request body | 512 KiB |
| `txs_hashes` entries | 4096 |
| daemon JSON, including `get_info` and `get_block` | 8 MiB |
| daemon pool answer | 8 MiB |
| daemon transactions answer | 64 MiB |

The witness checks a declared `Content-Length` before reading and also counts the bytes of a chunked answer. A daemon answer above its cap is `502 bad-daemon-answer` with `why: "response-too-large"`; the daemon slot is released.

## Refusals

The witness uses its own error shape, not a JSON-RPC `error` object:

```json
{"ok": false, "code": "bad-request", "error": "bad request", "params": {"why": "method-not-proxied"}}
```

| Code | HTTP | Meaning |
|---|---|---|
| `bad-request` | 400 | malformed JSON, body too large, unsupported method, bad parameters or a bad txid list |
| `method-not-allowed` | 405 | a known route received the wrong HTTP method; the answer carries `Allow` |
| `unknown path` | 404 | the route is not in the registry; the answer carries `known` |
| `daemon-unavailable` | 503 | the daemon did not answer or answered with a non-2xx HTTP status |
| `not-synchronized` | 503 | the daemon is behind, busy, untrusted, not `OK` or on another network; also a slice or block above the tip |
| `busy` | 503 | the bounded in-flight work ceiling is full |
| `bad-daemon-answer` | 502 | malformed, inconsistent or oversized daemon answer, a daemon RPC error, or a non-`OK` pool status |

`OPTIONS` answers `204` and is handled before the route registry. The CORS and health/metrics rules are in [`../README.md`](../README.md) and [`../spec/witness-v1.md`](../spec/witness-v1.md); they are not RPC methods.
