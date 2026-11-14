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
- Integration SSRF (webhooks, n8n, CalDAV) and credential forwarding through redirects.
- Secret leakage in logs.
- Replay/duplication in offline sync queues.

## Controls

- Validate ingress headers and token presence.
- Deny local/private host targets for unfurl.
- Send integration traffic through `fetchOutbound` (`packages/integration-core/src/outbound-fetch.ts`): it refuses metadata, link-local, unspecified, multicast and reserved addresses and the Supervisor host, checks them again on every DNS answer at connect time, and never follows a redirect implicitly. Loopback and private LAN stay reachable because self-hosted n8n, CalDAV and add-ons live there.
- Keep CalDAV credentials on the configured origin: server hrefs and redirects to another origin are refused.
- Encrypt stored CalDAV passwords with a key from `SUPERVISOR_TOKEN`/`HA_TOKEN`, or a random per-install key file (mode 0600) beside the database; there is no built-in fallback key.
- Redact sensitive patterns before log emission.
- Use idempotency keys and bounded retries for sync mutations.
