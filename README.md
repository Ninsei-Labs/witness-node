# witness-node

A read-only, fixed-slice Monero witness for the Ninsei arrival protocol. It has no wallet, no signing key, no
order journal and no maker routes. It reads blocks from one Monero daemon and serves a fixed 20-block slice to a
client that must not learn the order's exact start or payout height.

## Protocol

See [`spec/witness-v1.md`](spec/witness-v1.md).

Routes:

```text
GET  /live
GET  /health
GET  /metrics          loopback only unless RFQ_WITNESS_METRICS_PUBLISH=1
GET  /info
POST /json_rpc          get_info only
POST /get_transactions  the slice's txids
POST /v1/witness/slice  {version, network, grid, slice}
```

The SDK reads the tip and the transaction bodies from the same witness. The slice request contains no order height,
block, txid or order id.

`/live` is liveness, `/health` is readiness against the daemon and network, `/metrics` is Prometheus text, and
`/info` names the protocol and optional operator metadata. The health probe never prints the daemon URL. Metrics
carry no order data, heights, txids or daemon URL.

`/metrics` answers loopback callers by default. In a container the published port arrives through the bridge, so a
scraper must either share the container network namespace or set `RFQ_WITNESS_METRICS_PUBLISH=1` while keeping the
port private. Do not forward `/metrics` from the public proxy.

One slice costs 20 daemon calls. The slice and proxy work shares a bounded in-flight ceiling
(`RFQ_WITNESS_MAX_INFLIGHT`, default 4); above it the service answers `503 busy` instead of amplifying load on the
operator's monerod. The public reverse proxy still needs its own per-client rate limit.

## Run with Bun

```bash
RFQ_XMR_DAEMON=http://127.0.0.1:38081 \
RFQ_WITNESS_NETWORK=stagenet \
RFQ_WITNESS_HOST=127.0.0.1 \
RFQ_WITNESS_PORT=8796 \
bun witness-server.mjs
```

Settings are in [`witness.env.example`](witness.env.example). `RFQ_XMR_DAEMON` is required.

`8796` is the default port. `8795` is used by the documented screen-hook example, so it is not the witness default.

## Container

```bash
docker build -t witness-node .
docker run --rm -p 127.0.0.1:8796:8796 \
  -e RFQ_XMR_DAEMON=http://host.docker.internal:38081 \
  -e RFQ_WITNESS_NETWORK=stagenet \
  -e RFQ_WITNESS_ALLOW_ORIGIN=https://swap.example \
  witness-node
```

The image runs as UID/GID `10001`, uses a read-only root filesystem in the example compose file, drops capabilities
and has no write paths. The image is published to GHCR from tags only:

```text
ghcr.io/ninsei-labs/witness-node:<tag>
```

A private repository produces a private package. An independent operator needs access to the package before it can
pull it.

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
- keep `RFQ_WITNESS_METRICS_PUBLISH` unset and do not proxy `/metrics` to the public;
- set `RFQ_WITNESS_ALLOW_ORIGIN` to the exact site origin, not `*`;
- keep `RFQ_WITNESS_MAX_INFLIGHT` small (the default is `4`; one slice costs 20 daemon calls);
- put `witness.env` outside the repository with mode `0600`; it contains the daemon URL and is not committed.

An example nginx configuration:

```nginx
http {
    server_tokens off;

    # Per-IP limits. A slice is expensive; tune after measuring the daemon.
    limit_req_zone  $binary_remote_addr zone=witness_rps:10m  rate=2r/s;
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
        ssl_session_tickets off;
        ssl_stapling on;
        ssl_stapling_verify on;

        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        add_header Referrer-Policy no-referrer always;
        add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;

        client_max_body_size 4k;
        client_body_timeout 10s;
        client_header_timeout 10s;

        limit_req zone=witness_rps burst=10 nodelay;
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

        # The SDK does not need these internal endpoints.
        location = /health {
            allow 127.0.0.1;
            allow ::1;
            deny all;
            proxy_pass http://witness;
        }

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
- The `/metrics` and `/health` locations are intentionally loopback-only. If nginx and the witness are separate
  containers, the witness sees nginx's container address, not loopback; put them on a private network and expose the
  metrics only on that network, or set `RFQ_WITNESS_METRICS_PUBLISH=1` for a private, non-public listener. Do not
  forward either route through the public server block.
- `limit_req_zone` keys on the client address. Behind a CDN or load balancer, configure `real_ip` with that provider's
  trusted ranges; do not trust a client-supplied `X-Forwarded-For` blindly.
- `proxy_read_timeout 60s` is a starting point. A slice is up to 20 sequential daemon reads; if the daemon is slow,
  raise the timeout deliberately rather than removing it.
- Not caching the slice is intentional: the tip and the block set change, and a cached witness answer must not be
  reused for another caller's range.
- Keep a separate, non-public monitoring path for `/health` and `/metrics`. Public liveness via `/live` is enough for
  an external uptime checker.
- If the site is behind Cloudflare or another proxy, use the provider's documented `real_ip` ranges and keep the
  origin reachable only from that provider.

## Tests

```bash
bun run check
```

- `check:slice` drives the reader and HTTP route, including the proxy routes, fixed-grid bounds and malformed
  answers.
- `check:teeth` removes the `get_info` and `get_transactions` proxy routes and proves the SDK's first call fails.

## Security boundary

- No private key, seed, wallet or order state is stored or accepted.
- The service only reads a Monero daemon. It does not sign or send transactions.
- `/json_rpc` is restricted to `get_info`. `/get_transactions` accepts only a bounded list of 64-hex txids.
- CORS is configurable with `RFQ_WITNESS_ALLOW_ORIGIN`; a public test witness may use `*`, a site should name its
  origin.
- The witness still sees the caller's IP and the 20-block bucket. It does not see the exact order start, payout block,
  txid or order id.

## Independence

Two instances under one operator are one opinion. A production arrival quorum needs separately operated witnesses;
the local-stand setup with three containers and one daemon is a protocol fixture, not an independence proof.

## License

MIT. See [`LICENSE`](LICENSE).
