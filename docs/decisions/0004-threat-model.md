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
- Send webhook, n8n, and CalDAV integration traffic through `fetchOutbound` (`packages/integration-core/src/outbound-fetch.ts`): it refuses embedded URL credentials, cloud metadata, link-local, unspecified, IPv4-compatible, tunneling, multicast and reserved addresses and the Supervisor API (by hostname, alias and resolved IP), checks them again on every DNS answer at connect time, enforces TLS certificate verification, and never follows a redirect implicitly. Saved webhook and n8n endpoints may reach loopback and private LAN hosts; CalDAV rejects literal loopback/private IP URLs while allowing named local hosts verified at connect time; ad-hoc webhook test URL overrides additionally reject loopback and private addresses (except non-metadata `.internal` names) at both URL and connect time.
- Keep CalDAV credentials on the configured origin: server hrefs and redirects to another origin are refused.
- Encrypt stored CalDAV passwords with a key from `SUPERVISOR_TOKEN`/`HA_TOKEN`, or a random per-install key file (mode 0600, atomically published) beside the database, migrating legacy fallback ciphertexts in-place on first read.
- Redact sensitive patterns before log emission.
- Use idempotency keys and bounded retries for sync mutations.
