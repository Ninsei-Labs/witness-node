# WITNESS-NODE IMAGE.
#
# The service is read-only: no keys, no journal, no wallet and no write paths. The runtime is the Debian-based Bun
# slim image, the same version the tests run under. The image user is an image contract (10001:10001), matching the
# rest of the Ninsei services.
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643

# THE LABELS NAME THIS SERVICE, NOT THE BUN BASE IMAGE. Docker inherits the base labels unless every product
# label is overridden; without these the image reports Bun's version, commit and build date.
ARG VERSION=dev
ARG BUILD_COMMIT=
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="witness-node" \
      org.opencontainers.image.description="Read-only fixed-slice Monero witness for the Ninsei arrival protocol" \
      org.opencontainers.image.source="https://github.com/Ninsei-Labs/witness-node" \
      org.opencontainers.image.url="https://github.com/Ninsei-Labs/witness-node" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# THE BASE DIGEST IS PINNED; DEBIAN SECURITY UPDATES STILL MOVE. Apply them in the image, then clean the lists.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates tzdata \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
  && apt-get clean \
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
    WITNESS_DEFAULT_HOST=0.0.0.0 \
    WITNESS_DEFAULT_PORT=8796

USER 10001:10001

EXPOSE 8796

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e 'fetch("http://127.0.0.1:" + (process.env.WITNESS_DEFAULT_PORT || 8796) + "/live").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

ENTRYPOINT ["bun", "witness-server.mjs"]
