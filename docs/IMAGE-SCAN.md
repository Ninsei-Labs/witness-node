# Image scan records

The image scan is a scheduled check, not a release gate. It builds the image from the pinned base digest, records the scanned image digest, and fails when a fixable Critical or High finding exists. Findings without a Debian fix are recorded here and re-checked by the next scheduled run.

## 2026-11-25: 0.3.1

- Base image: `oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643`
- Scanned image: `witness-node:scan-49`, image ID `sha256:41a103a5aa1648afc374afec8fa422229b483d940dbd0e790adeeb760897f948`
- Scanner: Docker Scout CLI 1.28.0, clean `docker build --pull --no-cache`
- Result: 0 Critical, 3 High, 0 Medium, 0 Low

The image ID is the local build artifact from this scan. It was not pushed and is not a pullable registry reference. The scheduled workflow uses Trivy, so its first run may report a different count; the next record takes its result and image ID.

The three High findings are one package:

| Package | Version | CVE | Fixed version |
|---|---|---|---|
| `openssl` | `3.5.9-1~deb13u1` | CVE-2026-107493 | not fixed |
| `openssl` | `3.5.9-1~deb13u1` | CVE-2026-84786 | not fixed |
| `openssl` | `3.5.9-1~deb13u1` | CVE-2026-107496 | not fixed |

Triage: Debian has no fixed version for these OpenSSL findings. They are accepted for 0.3.1 and are not suppressed. The scheduled `image-scan` workflow fails on fixable Critical and High findings, so a new Debian fix or a changed base image becomes visible without a manual scan. The next scan replaces this record with the new image digest and result.

The `apt-get upgrade` layer keeps Debian security updates moving without changing the pinned base digest. It also makes the package set depend on the Debian mirror at build time, so two builds are not byte-for-byte reproducible. A future explicit package pin or snapshot can replace that layer when the release process needs stronger reproducibility.

## Running the scan

The scheduled workflow is `.github/workflows/image-scan.yml`; it can also be started with `workflow_dispatch`. To reproduce the local check:

```bash
docker build --pull --no-cache -t witness-node:scan-49 .
docker image inspect witness-node:scan-49 --format '{{.Id}}'
docker scout cves --only-severity critical,high witness-node:scan-49
```
