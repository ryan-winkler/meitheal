---
type: "Decision"
title: "ADR-0012: Docker Hub Publishing for HA Add-on Distribution"
status: "superseded"
description: "Records the earlier decision to publish Home Assistant App images to Docker Hub."
---

# ADR-0012: Docker Hub Publishing for HA Add-on Distribution

## Status

**Superseded** — Docker Hub publishing was retired; Stable images now publish to GitHub Container Registry (`ghcr.io/ryan-winkler/meitheal-{arch}`) and Canary images publish to `ghcr.io/coolock-village/meitheal-canary-{arch}`, with manifests distributed via `ryan-winkler/meitheal-ha-addon` (see the [Release Runbook](../kcs/releasing.md)). Originally **Accepted** — 2026-03-01.

## Context

Meitheal Hub is packaged as a Home Assistant add-on. For users to install it on their HA instance, the container images must be pushed to a registry that HA can pull from without authentication.

Options considered:
1. **GHCR only** — Already configured. Requires the GitHub repo to have public packages, which is fine but less familiar to HA community.
2. **Docker Hub only** — The de-facto registry for HA community add-ons. No auth required. Aligned with HA builder docs.
3. **Both GHCR + Docker Hub** — Belt-and-suspenders. GHCR for CI/internal, Docker Hub for end-user consumption.

## Decision

**Dual-push to both GHCR and Docker Hub.**

- `config.yaml` `image` field points to Docker Hub (`coolockvillage/meitheal-{arch}`) since that's what HA Supervisor pulls.
- CI workflow pushes to both registries on every tag and `workflow_dispatch`.
- Docker Hub account: `coolockvillage` (org account with PAT for CI).

## Consequences

- HA users get fast installs from Docker Hub without GHCR auth complexity.
- GHCR images remain available for internal testing and GitHub ecosystem integration.
- Two registries to maintain — mitigated by single CI workflow handling both.
- Docker Hub PAT stored as GitHub repo secret (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`).
