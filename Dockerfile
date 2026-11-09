# WITNESS-NODE IMAGE.
#
# The service is read-only: no keys, no journal, no wallet and no write paths. The runtime is the Debian-based Bun
# slim image, the same version the tests run under. The image user is an image contract (10001:10001), matching the
# rest of the Ninsei services.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 witness \
  && useradd --uid 10001 --gid witness --no-create-home --shell /usr/sbin/nologin witness

WORKDIR /app

# No dependencies and no lockfile: the service is the Bun runtime plus its own sources.
COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 LICENSE ./
COPY --chown=10001:10001 witness-server.mjs ./
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 spec ./spec

ENV TZ=UTC \
    RFQ_WITNESS_HOST=0.0.0.0 \
    RFQ_WITNESS_PORT=8796

USER 10001:10001

EXPOSE 8796

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e 'fetch("http://127.0.0.1:8796/live").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

ENTRYPOINT ["bun", "witness-server.mjs"]
