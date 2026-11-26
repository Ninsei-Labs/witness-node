# witness-node

A read-only, fixed-slice Monero witness for the Ninsei arrival protocol. It has no wallet, no signing key, no
order journal and no maker routes. It reads blocks from one Monero daemon. It serves a fixed 20-block slice to a
client that must not learn the order's exact start or payout height.

## Protocol

See [`spec/witness-v1.md`](spec/witness-v1.md) for the slice protocol and [`docs/RPC.md`](docs/RPC.md) for the
Monero RPC allowlist, parameter reshaping and refusal profile. This service is not a generic `monerod` proxy.

Routes:

```text
GET  /live             liveness; safe for public uptime checks
GET  /health           readiness; may be public and is cached for WITNESS_HEALTH_TTL_MS
GET  /metrics          loopback only unless WITNESS_METRICS_PUBLISH=1
GET  /info
POST /json_rpc          get_info; get_block only with WITNESS_ALLOW_GET_BLOCK=1
POST /get_transaction_pool_hashes  on by default; WITNESS_ALLOW_POOL=0 turns it off
POST /get_transactions  1 to 4096 txids
POST /v1/witness/slice  {version, network, grid, slice}
```

The SDK reads the tip and the transaction bodies from the same witness. The slice request contains no order height,
block, txid or order id. The slice below the tip is complete; the slice that contains the tip ends at the top block,
sets `complete: false`, and names that block in `tip`. Each slice block carries `prev_hash` and `num_txes` as well as
`hash` and `txids`, so a client can check the chain and the transaction count without an exact-height read.
`/get_transactions` refuses an untrusted daemon with `503 not-synchronized`, a busy daemon with `503 busy`, and any
other non-OK status with `502 bad-daemon-answer`.

`WITNESS_ALLOW_GET_BLOCK=1` is off by default. It adds a narrow exact-height `get_block` compatibility method. The
block answer carries only `block_header` and `tx_hashes`, never the daemon `blob`. Do not enable it on the public slice
endpoint: an exact height names the order's start or payout block.

`/get_transaction_pool_hashes` is a global, order-independent pool list and is **on by default**. Set
`WITNESS_ALLOW_POOL=0` to turn it off. It is a separate switch from exact-height `get_block`; a public operator can
keep the pool route while leaving exact-height reads disabled.

`/live` is liveness and does not read the daemon. `/health` is readiness against the daemon and network, `/metrics`
is Prometheus text, and `/info` names the protocol and optional operator metadata. The health probe never prints the
daemon URL. Metrics carry no order data, heights, txids or daemon URL.

`/health` may be published through the public proxy so a client can avoid a witness whose daemon is still syncing.
Its answer is cached for `WITNESS_HEALTH_TTL_MS` and is shared by every caller; it is a hint, not proof. A client that
needs data must still verify the slice it receives. Keep `/metrics` private.

`/metrics` answers loopback callers by default. In a container the published port arrives through the bridge. A
scraper must either share the container network namespace or set `WITNESS_METRICS_PUBLISH=1` while keeping the
port private. Do not forward `/metrics` from the public proxy.

One slice costs up to 20 block reads plus one tip read. The slice and proxy work shares a bounded in-flight ceiling
(`WITNESS_MAX_INFLIGHT`, default 4); above it the service answers `503 busy` instead of amplifying load on the
operator's monerod. The public reverse proxy still needs its own per-client rate limit.

## Run with Bun

```bash
WITNESS_XMR_DAEMON=http://127.0.0.1:38081 \
WITNESS_NETWORK=stagenet \
bun witness-server.mjs
```

Settings are in [`witness.env.example`](witness.env.example). `WITNESS_XMR_DAEMON` is required. Only `WITNESS_*`
names are read; the old `RFQ_*` names do nothing. The bind is `WITNESS_DEFAULT_HOST`/`WITNESS_DEFAULT_PORT`:
a local run defaults to `127.0.0.1:8796`, the image to `0.0.0.0:8796`.

`8796` is the default port. `8795` is used by the documented screen-hook example, so it is not the witness default.

## Container

```bash
docker build -t witness-node .
docker run --rm -p 127.0.0.1:8796:8796 \
  -e WITNESS_XMR_DAEMON=http://host.docker.internal:38081 \
  -e WITNESS_NETWORK=stagenet \
  -e WITNESS_ALLOW_ORIGIN=https://swap.example \
  witness-node
```

The image runs as UID/GID `10001`, uses a read-only root filesystem in the example compose file, drops capabilities
and has no write paths. The image is published to GHCR from tags only for `linux/amd64`:

```text
ghcr.io/ninsei-labs/witness-node:<tag>
```

The package is published separately from the repository. A public package can be pulled without credentials. A
private package needs a GitHub token with `read:packages`.

## Production reverse proxy

The production shape is one private witness process, one private `monerod`, and a public nginx that exposes only the
witness routes. Never publish the witness port or the Monero daemon port directly.

```text
client -> nginx :443 -> witness 127.0.0.1:8796 -> monerod loopback/private network
```

Requirements before exposing it:

- bind `monerod` RPC to `127.0.0.1` or a private Docker network and firewall the RPC port;
- run the container with `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, and its built-in UID
  `10001`;
- keep `WITNESS_METRICS_PUBLISH` unset and do not proxy `/metrics` to the public;
- set `WITNESS_ALLOW_ORIGIN` to the exact site origin when the site is known; `*` is the default for an independent witness;
- keep `WITNESS_MAX_INFLIGHT` small (the default is `4`; one slice costs up to 20 block reads plus one tip read);
- put `witness.env` outside the repository with mode `0600`; it contains the daemon URL and is not committed.

An example nginx configuration:

```nginx
http {
    server_tokens off;

    # Per-IP limits. A slice is expensive; tune after measuring the daemon.
    limit_req_zone  $binary_remote_addr zone=witness_rps:10m  rate=3r/s;
    limit_conn_zone $binary_remote_addr zone=witness_conn:10m;

    upstream witness {
        server 127.0.0.1:8796;
        keepalive 16;
    }

    server {
        listen 80;
        server_name witness.example.org;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        http2 on;                 # nginx >= 1.25; older: listen 443 ssl http2;
        server_name witness.example.org;

        ssl_certificate     /etc/letsencrypt/live/witness.example.org/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/witness.example.org/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 1d;
        # 0-RTT needs a TLS 1.3 ticket, and early data is replayable. Witness routes are expensive POSTs, so
        # tickets stay off; TLS 1.2 session IDs still resume through the shared cache.
        ssl_session_tickets off;
        # Hybrid post-quantum key exchange when the OpenSSL build provides ML-KEM. Older clients fall back to X25519.
        ssl_ecdh_curve      X25519MLKEM768:X25519:prime256v1:secp384r1;
        ssl_stapling on;
        ssl_stapling_verify on;

        # THE BUCKET IS A PRIVACY SIGNAL. An access log records the caller's IP and the slice index, which is the
        # link this endpoint exists to avoid. Keep it off for these routes.
        access_log off;

        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        add_header Referrer-Policy no-referrer always;
        add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;

        client_max_body_size 4k;
        client_body_timeout 10s;
        client_header_timeout 10s;

        limit_req zone=witness_rps burst=5 nodelay;
        limit_conn witness_conn 2;
        limit_req_status 429;
        limit_conn_status 429;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # Readiness for clients that must avoid a syncing daemon. The probe is cached and contains no daemon URL.
        location = /health {
            limit_except GET OPTIONS { deny all; }
            proxy_pass http://witness;
        }

        # Operational metrics stay private.
        location = /metrics {
            allow 127.0.0.1;
            allow ::1;
            deny all;
            proxy_pass http://witness;
        }

        location = /live {
            limit_except GET OPTIONS { deny all; }
            proxy_pass http://witness;
        }

        location = /info {
            limit_except GET OPTIONS { deny all; }
            proxy_pass http://witness;
        }

        location = /json_rpc {
            limit_except POST OPTIONS { deny all; }
            client_max_body_size 4k;
            proxy_pass http://witness;
        }

        location = /get_transactions {
            limit_except POST OPTIONS { deny all; }
            client_max_body_size 1m;  # the server caps the list at 4096 txids
            proxy_pass http://witness;
        }

        location = /get_transaction_pool_hashes {
            limit_except POST OPTIONS { deny all; }
            client_max_body_size 4k;
            proxy_pass http://witness;
        }

        location = /v1/witness/slice {
            limit_except POST OPTIONS { deny all; }
            client_max_body_size 4k;
            proxy_pass http://witness;
        }

        # No catch-all proxy: an unknown path must not reach the daemon.
        location / {
            return 404;
        }
    }
}
```

Notes:

- CORS is answered by the witness. Do not add a second `Access-Control-Allow-Origin` in nginx, or browsers will see
  duplicate headers. `OPTIONS` is allowed so the application can answer the preflight.
- `X25519MLKEM768` is a hybrid key exchange, not a post-quantum certificate. It needs an OpenSSL build with ML-KEM;
  clients without it negotiate X25519. Keep TLS 1.3 0-RTT off: early data is replayable and the witness routes are POSTs.
- `/health` may be public: it is a cached readiness hint, not proof of the data. `/metrics` stays loopback-only. If
  nginx and the witness are separate containers, the witness sees nginx's container address, not loopback.
- Expose metrics only on a private network, or set `WITNESS_METRICS_PUBLISH=1` for a private, non-public listener.
  Do not forward `/metrics` through the public server block.
- `limit_req_zone` keys on the client address. Behind a CDN or load balancer, configure `real_ip` with that provider's
  trusted ranges; do not trust a client-supplied `X-Forwarded-For` blindly.
- `proxy_read_timeout 60s` is a starting point. A slice is up to 20 sequential daemon reads; if the daemon is slow,
  raise the timeout deliberately rather than removing it.
- Not caching the slice is intentional: the tip and the block set change, and a cached witness answer must not be
  reused for another caller's range.
- Keep `/metrics` on a non-public path. `/live` is the public uptime signal; `/health` gives clients a cached readiness
  hint and does not replace checking the returned slice.
- If the site is behind Cloudflare or another proxy, use the provider's documented `real_ip` ranges and keep the
  origin reachable only from that provider.

## Tests

```bash
bun run check
SDK_DIR=../sdk bun run check:interop
docker build -t witness-node:ci .
bun run check:container
bun run check:regtest
```

- `check:slice` drives the reader and HTTP route, including the proxy routes, fixed-grid bounds, malformed
  answers, the partial tip slice, daemon readiness and idle-body timeouts.
- `check:teeth` removes the `get_info` and `get_transactions` proxy routes and the pool guards, and proves each
  mutation changes the route answer or fails the HTTP call.
- `check:workflows` checks the ready-for-review gate, the publish ancestry, CI, environment and pre-release gates,
  the CodeQL pull-request trigger and the scheduled image scan.
- `check:interop` fetches a real witness answer and parses it with the SDK's `src/witness-slice.mjs`. It also runs
  one witness through the documented nginx route for the empty and non-empty pool, so Docker is required. Set
  `SDK_DIR` to the SDK checkout; CI checks out `Ninsei-Labs/sdk` at the pinned pool-aware commit
  `c0b58ac1d96c5ee18f2be7d3ca79e545acf5b005`.
- `check:regtest` starts pinned `monerod` and `wallet-rpc` containers, mines 180 blocks, creates a real transaction,
  and checks the pool before and after confirmation, the non-empty block, slice, transactions and compatibility
  `get_block`. It requires Docker and does not use a public network.
- `check:container` runs the built image against a deterministic stand-in daemon. It verifies the process runs as
  UID/GID `10001` and the root filesystem is read-only. It also checks that `/health` becomes ready, that `/metrics`
  and `/info` answer, and that the two proxy reads work. The response must contain the exact 20 pinned hashes from
  `tools/fixtures/stagenet-slice-5.json`. The fixture is synthetic: its hashes come from the stand-in daemon's
  height formula, not from a recorded stagenet chain. It requires Docker and does not use a real chain.

## Security boundary

- No private key, seed, wallet or order state is stored or accepted.
- The service only reads a Monero daemon. It does not sign or send transactions.
- The RPC surface is an explicit allowlist, documented in [`docs/RPC.md`](docs/RPC.md), not a generic daemon proxy.
- `/json_rpc` is restricted to `get_info` by default. `/get_transactions` accepts 1 to 4096 64-hex txids.
  `WITNESS_ALLOW_GET_BLOCK=1` adds exact-height `get_block` for a private recovery witness; do not enable it on the
  public slice endpoint. The global pool-hashes route is on by default and `WITNESS_ALLOW_POOL=0` turns it off.
- CORS is configurable with `WITNESS_ALLOW_ORIGIN`. A public test witness can use `*`; a site can name its
  origin.
- The witness still sees the caller's IP and the 20-block bucket. It does not see the exact order start, payout block,
  txid or order id. At launch volume a 40-minute bucket can hold about one escrow, so the IP and that escrow are
  linkable; the exact height is not.

## Independence

Two instances under one operator are one opinion. A production arrival quorum needs separately operated witnesses.
A local test setup with three containers and one daemon is a protocol fixture, not an independence proof.

## Changelog

### 0.3.1 (2026-11-26)

The package version and the compose pin are both `0.3.1`.

- A client disconnect cancels the in-flight daemon reads and releases the in-flight slot; one slice-wide deadline prevents abandoned work from holding a slot.
- `/health` and `/metrics` share one in-flight `get_info` probe; only a completed result enters the TTL cache.
- Daemon answers are read through a byte cap: JSON and pool 8 MiB, transactions 64 MiB; an oversized answer is `502 bad-daemon-answer` with `response-too-large`.
- Boolean settings accept only `1/true/yes/on` or `0/false/no/off`; an empty or unknown value stops startup with the variable name.
- One route registry drives dispatch, `/live`, the 404 `known` list, startup paths and metric labels; the pool route is part of it, and a wrong method answers `405` with `Allow`.
- The `image-scan` workflow fails on fixable Critical/High findings and on a stale pinned base digest. The 0.3.1 scan has 0 Critical and 3 High OpenSSL findings without a Debian fix. The image applies Debian security upgrades after the pinned base digest; the scan record and reproducibility tradeoff are in [`docs/IMAGE-SCAN.md`](docs/IMAGE-SCAN.md).
- The RPC profile document lists the allowlist, dropped parameters, response reshaping and refusal codes; this service is not a generic `monerod` proxy.
- The CI SDK checkout is pinned to the current SDK main commit that reads the pool route. Interop covers empty and non-empty pools through the documented nginx example, and a real monerod regtest job covers empty and non-empty blocks, a confirmed transaction, slice, transactions and pool.
- CodeQL runs on pull requests as well as push and schedule; the analyze job is skipped for draft PRs.

### 0.3.0 (2026-11-25)

The package version and the compose pin are both `0.3.0`.

- Removed the deprecated `RFQ_XMR_DAEMON` and `RFQ_WITNESS_*` aliases. Only `WITNESS_*` settings are read; the old names do nothing.
- Removed the separate `WITNESS_HOST` and `WITNESS_PORT` settings. The bind comes from `WITNESS_DEFAULT_HOST` and `WITNESS_DEFAULT_PORT`; a local run defaults to `127.0.0.1:8796`, the image to `0.0.0.0:8796`.
- An empty daemon pool still answers `200` with an empty list.

### 0.2.1 (2026-11-25)

The package version and the compose pin are both `0.2.1`.

- An empty daemon pool answers `200` with an empty list. A real monerod omits `tx_hashes` when the pool is empty; a non-OK, untrusted or malformed answer is still a refusal.
- The image no longer sets `WITNESS_HOST` and `WITNESS_PORT` as explicit values. The deprecated `RFQ_WITNESS_HOST` and `RFQ_WITNESS_PORT` names work in the image, and the healthcheck follows the selected port.

### 0.2.0 (2026-11-25)

The package version and the compose pin are both `0.2.0`.

- Slice blocks now carry `prev_hash` and `num_txes`, so a client can verify the chain and the transaction count without an exact-height request.
- `WITNESS_ALLOW_GET_BLOCK=1` adds a narrow exact-height `get_block` method for a private recovery witness; it is off by default. The global pool-hashes route is on by default and `WITNESS_ALLOW_POOL=0` turns it off.
- Settings use `WITNESS_*` names. The old `RFQ_XMR_DAEMON` and `RFQ_WITNESS_*` names are deprecated aliases until 1.0.0.
- The slice reader refuses a missing parent, a bad transaction count, a chain break and malformed fields.

### 0.1.3 (2026-11-21)

The package version and the compose pin are both `0.1.3`.

- The service runs on Bun 1.4.5, with the slim base image pinned to its multi-platform digest.
- The slice checks cover tip equality and hold the in-flight ceiling behind an explicit gate instead of a timing race.
- The fake daemon answers an empty transaction pool, keeping the SDK interop fixture current.

### 0.1.2 (2026-11-12)

The package version and the compose pin are both `0.1.2`.

- A version gate now compares `package.json`, the compose image tag and the release tag before any image build.
- The gate runs in the check workflow and in the publish workflow, so a mismatch stops before `docker build`.

### 0.1.0 (2026-11-10)

First release. The image is published as `ghcr.io/ninsei-labs/witness-node:v0.1.0`.

- The fixed-slice endpoint serves a partial tip slice and names its top block.
- Readiness gates the daemon state on health, tip and slice routes.
- The publish job requires main ancestry, a passed check and provenance.

## License

MIT. See [`LICENSE`](LICENSE).
