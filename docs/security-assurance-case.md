---
type: "Reference"
title: "Security assurance case"
description: "What Meitheal protects, its trust boundaries, and the evidence that its security requirements are met."
---

# Security assurance case

This page explains what you can and cannot expect from Meitheal's security, and why we believe the expectations hold. It covers the Home Assistant App (`meitheal-hub`), the web application in `apps/web`, the domain packages in `packages`, and the optional Home Assistant integration in `integrations/home-assistant`. Report a weakness through the [security policy](../SECURITY.md).

## Security requirements

### What you can expect

1. **Only people Home Assistant has signed in can use Meitheal through Ingress.** In App mode, every page and API request must arrive through the Home Assistant Supervisor Ingress proxy, come from the App's own loopback address, or carry a valid Meitheal agent token. Other requests receive 401 or 403.
2. **Identity comes only from the trusted route.** Meitheal reads the Home Assistant user ID and admin group from forwarded headers only when the request came through the Supervisor, and it validates their format. Task attribution uses that verified identity.
3. **Agent tokens grant only their scopes.** Tokens for automations and AI agents are random 256-bit values with an `mth_` prefix. Meitheal stores only their SHA-256 hash, shows the plaintext once, and checks the required scope on every request. Tokens can be revoked.
4. **Household data stays local.** Tasks and settings live in SQLite on the App's data volume and are included in Home Assistant backups. Meitheal sends data elsewhere only to destinations an administrator configured, such as webhooks, calendars, Grocy, or a Loki endpoint.
5. **Browsers are protected from common web attacks.** Responses carry a Content Security Policy without `data:` scripts, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `X-Content-Type-Options: nosniff`, a strict referrer policy, and a permissions policy that denies camera, microphone and location. Outside Ingress, browser state-changing API calls normally require same-origin proof; in App mode, middleware skips this CSRF check for authenticated loopback callers and requests carrying valid agent tokens.
6. **Logs do not reveal secrets.** The structured logger redacts sensitive field names and values matching its configured patterns for tokens, passwords, API keys, bearer and Supervisor credentials, and email addresses; unlabeled secrets embedded in free-text messages may remain, so logs should not be assumed safe to share unreviewed.
7. **Releases can be traced to source.** Stable images after version `0.0.1` are built by GitHub Actions from pushes to the `release` branch or matching `v*` tags, smoke-tested, and published with a signed build provenance attestation that records the exact source commit and workflow ref; version `0.0.1` and earlier predate attestations and are verified by image digest. See [verify a release image](../SECURITY.md#verify-a-release-image).

### What Meitheal does not protect against

- **A compromised Home Assistant.** Meitheal trusts Home Assistant's authentication and the Supervisor. Anyone who controls Home Assistant or its host controls Meitheal and its data.
- **Household members with access.** Every signed-in Home Assistant user can see household tasks. Meitheal separates administrators from other users for settings and credentials, but it is not designed to keep secrets between members of one household.
- **Running outside Home Assistant on an untrusted network.** The standalone and development modes are for local testing. They do not add a login of their own.
- **Data you send to third parties.** Once a webhook, calendar, AI assistant, or other integration receives data, its own security applies.
- **Physical access and backups.** The SQLite database and Home Assistant backups are not encrypted by Meitheal. Protect the host and the backup location.

## Threat model

The assets are household task data, people's identities and activity, integration credentials (Home Assistant, Grocy, webhook secrets, agent tokens), and the integrity of published images.

| Threat actor | Example goal | Main controls |
| --- | --- | --- |
| Someone on the local network without a Home Assistant login | Read or change tasks by calling the App directly | Ingress-only access in App mode, token authentication, rate limits |
| A malicious web page visited by a household member | Make the browser change tasks (CSRF) or run script in Meitheal's origin (XSS) | Same-origin checks, CSP, output escaping, `frame-ancestors` policy |
| A leaked or over-scoped automation token | Do more than the automation needs | Hashed tokens, per-route scope checks, assigned-only scopes, revocation, bot rate limit |
| An attacker controlling an integration response or imported file | Inject markup, exhaust memory, or reach internal services | Input validation, bounded request bodies, import size limits, private-address checks on `parseWebhookConfig` and ad-hoc integration test URLs |
| Someone reading logs or diagnostics | Collect credentials or personal data | Log redaction, private log mode, no secrets in diagnostics |
| A supply-chain attacker | Ship modified code or dependencies | Pinned actions, frozen lockfile, Dependabot, dependency review, CodeQL, signed provenance |

[ADR 0004](decisions/0004-threat-model.md) records the original threat model baseline.

## Trust boundaries

1. **Browser to Supervisor Ingress.** Home Assistant authenticates the person. Meitheal does not see their password.
2. **Supervisor to the App.** The App accepts identity headers only from the Supervisor's address and only in the expected format (`apps/web/src/domains/auth/ingress.ts`, `apps/web/scripts/ingress-transport.mjs`).
3. **Automations and agents to the App.** Callers outside Ingress must present an agent token (`apps/web/src/lib/agent-token-guard.ts`, `packages/domain-auth/src/agent-tokens.ts`).
4. **The App to Home Assistant Core and the Supervisor.** The App uses the Supervisor token that Home Assistant provides. It never exposes that token to the browser.
5. **The App to external services.** Webhooks, calendars, Grocy, and other integrations cross this boundary. Outbound requests verify TLS certificates by default; webhook payloads are signed with HMAC-SHA256.
6. **The custom integration inside Home Assistant Core.** It talks to the App with a scoped token. Its Home Assistant LLM API is read-only, and an active administrator must enable it for a conversation agent.

## Secure design principles applied

| Principle | How Meitheal applies it |
| --- | --- |
| Economy of mechanism | Authentication is delegated to Home Assistant instead of adding another login. One middleware applies access, rate limits and headers to every route. |
| Fail-safe defaults | Requests without verified transport or a valid token are refused. Invalid URLs are treated as private and rejected. Unknown token scopes are dropped, and scopes kept from earlier releases authorize no routes. |
| Complete mediation | The middleware checks every page and API request, including agent discovery paths. Routes check scopes again for sensitive actions. |
| Open design | The source, security policy, and this assurance case are public. Security does not depend on hiding the design. |
| Separation of privilege | Administrator-only settings and credentials are separate from everyday task actions. Write scopes are separate from read scopes. |
| Least privilege | Workflows declare minimal `permissions`. The App runs under an AppArmor profile. Agent tokens carry only the scopes chosen for them. |
| Least common mechanism | Each agent gets its own token, and logs and activity record which token acted. |
| Psychological acceptability | Security is mostly invisible: people sign in to Home Assistant once, and tokens are created from Settings with plain descriptions of each scope. |
| Limited attack surface | The App listens only for Ingress. It exposes no other ports by default. |
| Input validation with allowlists | Identity headers, IDs, enum values, URLs, and file uploads are validated against expected formats and sizes. |

## Common weaknesses and how they are countered

| Weakness (OWASP Top 10 / CWE) | Countermeasure |
| --- | --- |
| Broken access control (CWE-284, CWE-862) | Middleware enforces Ingress or token access; scope checks per route; Playwright specs cover denied cases. |
| Cryptographic failures (CWE-327, CWE-330) | Node's `crypto` module only: `randomBytes` and `randomUUID` for tokens and IDs, SHA-256 for token hashes, HMAC-SHA256 for webhook signatures, Ed25519 for license keys. No home-made cryptography. |
| Injection (CWE-89, CWE-79) | SQL uses parameterized statements with bound arguments through the database client. Astro escapes output by default; client code uses an `escape-html` helper where it builds markup. CSP limits script sources. |
| Insecure design | Decision records document trust choices; this assurance case is reviewed with each release. |
| Security misconfiguration | Security headers are set centrally (`apps/web/src/domains/auth/ingress-policy.ts`). Development-only TLS exceptions apply only to `.internal` hosts in development mode. |
| Vulnerable components (CWE-1104) | Frozen lockfile, Dependabot for npm, pip, Docker and Actions, `pnpm audit` in CI, dependency review on pull requests, and overrides for known-vulnerable transitive packages. |
| Identification and authentication failures (CWE-287) | No local passwords. Home Assistant authenticates people; tokens are random, hashed, and revocable. |
| Software and data integrity failures (CWE-494) | Actions pinned to commit SHAs, signed build provenance, image digests verified with an anonymous pull before App Store promotion. |
| Logging and monitoring failures (CWE-532) | Structured, redacted JSON logs; audit events for changes; optional Loki and Grafana dashboards. |
| Server-side request forgery (CWE-918) | `parseWebhookConfig` (`isPrivateUrl` / `isPrivateHost`) and `validateGrocyBaseUrl` share `classifyNetworkHost` to enforce `http:`/`https:` schemes and block loopback, private/shared-carrier (`100.64.0.0/10`), link-local, unique-local, special-purpose, IPv4-mapped/SIIT/NAT64/6to4/Teredo/ISATAP, zone-ID, cloud-metadata, and Home Assistant Supervisor targets; `POST /api/grocy/test` disables implicit HTTP redirects (`redirect: "manual"`), and Supervisor-detected Grocy add-ons resolve to their direct internal container hostname rather than `http://supervisor/*`. Saved task webhooks dispatched from administrator settings (`dispatchTaskEvent` / `emitWebhook`) deliver directly so homelab automations can reach configured local receivers. |
| Resource exhaustion (CWE-400) | Per-IP rate limits, a stricter limit for agent mutation endpoints, bounded request bodies, import size limits, and capped in-memory maps. |

## Evidence

- **Automated tests.** More than 200 Playwright specs (end-to-end, unit, and governance) and pytest suites run on every push and pull request in [CI](../.github/workflows/ci.yml). They include ingress header validation, agent scope policy, webhook signing, the private-address guard, and CSP checks.
- **Static analysis.** CodeQL code scanning covers JavaScript, TypeScript, Python, and GitHub Actions. Codacy runs its analysis tools on every push and pull request and uploads the results to GitHub code scanning. OpenSSF Scorecard checks supply-chain practices weekly and on every push to `dev`.
- **Dependency monitoring.** Dependabot, dependency review on pull requests, and `pnpm audit` in CI.
- **Accessibility and behavior checks.** axe-core checks run inside the Playwright suite.
- **Review.** Every change goes through the [code review standard](../CONTRIBUTING.md#code-review-standard), including the security checklist item.

## Keeping this current

Update this page in the same pull request as any change to authentication, authorization, token handling, outbound requests, logging, or release signing. The maintainer reviews it with each Stable release.
