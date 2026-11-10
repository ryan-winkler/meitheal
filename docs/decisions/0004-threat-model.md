---
type: "Decision"
title: "ADR 0004: Threat Model Baseline"
description: "Records the threat model and release security baseline."
---

# ADR 0004: Threat Model Baseline

## Status
Accepted

## Date
2026-02-28

## Risks

- Ingress trust boundary abuse.
- Unfurl endpoint SSRF.
- Secret leakage in logs.
- Replay/duplication in offline sync queues.

## Controls

- Validate ingress headers and token presence.
- Deny local/private host targets for unfurl.
- Redact sensitive patterns before log emission.
- Use idempotency keys and bounded retries for sync mutations.
