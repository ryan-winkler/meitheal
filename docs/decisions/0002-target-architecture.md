---
type: "Decision"
title: "ADR 0002: Target Architecture"
description: "Describes runtime, domain, persistence, and integration boundaries."
---

# ADR 0002: Target Architecture

## Status
Accepted

## Date
2026-02-28

## Context
Meitheal must run efficiently on Home Assistant Green. It must prioritize Astro-native delivery, DDD modularity, and ecosystem integrations.

## Decision

### Runtime Topology

- HA runtime:
  - Astro SSR (Node adapter)
  - SQLite via Drizzle
  - Home Assistant ingress auth
- Cloud runtime:
  - D1 via Drizzle dialect

### DDD Context Map

- Auth: Villager identity, passkeys, ingress trust bridge.
- Tasks: Task lifecycle, Endeavors, scheduling.
- Strategy: Framework scoring (RICE/DRICE/HEART/KCS overlays).
- Integrations: Grocy, calendars, webhooks, Node-RED/n8n.
- Observability: typed logs, audit events, SLO telemetry.

### Event Model

Canonical events:
- `task.created`
- `task.updated`
- `framework.score.applied`
- `integration.sync.requested`
- `integration.sync.completed`
- `calendar.confirmation.received`

All events require `event_id`, `request_id`, `occurred_at`, and idempotency support.

### Logging/Observability Strategy

Pipeline:
- app JSON logs -> HA journal -> Alloy -> Loki -> Grafana

Rules:
- Low-cardinality labels only.
- High-cardinality fields remain in log body.
- Redact secrets/PII by default.
- Modular log category toggles in add-on options.

### Extensibility Contract

- Frameworks defined in YAML and parsed by schemas.
- Integrations implement a common plugin interface from `packages/integration-core`.
- Domain packages are infra-agnostic.

### HA Interop Baseline

- Add-on and custom component paths are both maintained.

## Consequences
- Enables HA-first deployment without sacrificing cloud path.
- Reduces coupling and improves maintainability.
- Improves observability and operational support quality.
