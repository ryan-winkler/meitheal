# Verify truthful Settings and household integrations

Use this runbook after changes to Settings, agent transports or HA integration.
Keep dated execution receipts, audit histories, screenshots and credentials in
private local evidence, outside source control.

## User-visible contracts

- Failed Settings writes show errors, retain edits and allow retry. Atomic rule
  replacement preserves unrelated rules and rolls back a rejected insert.
  Navigation/export drain pending edits; a failed flush retains the editor.
  Custom frameworks restore only after a checked404 lookup; failed reads do not
  authorize creation. Cross-resource imports report partial outcomes explicitly.
- Explicit agent tokens retain their scopes in ingress. Official Supervisor
  identity/groups govern household administrator actions. Proposal acceptance
  is human-only, content-bound, expiring and replay-protected.
- A2A/MCP/WebMCP gates describe implemented operations. Discovery inputs match
  native task mutation, search, pagination and calendar sync contracts.
- HA adapters preserve creation fields, page beyond100 tasks, handle204 deletes,
  resolve unique titles, reorder lists and expose actual optional statistics.
  Calendar failure, empty and partial results are distinct.
- Overdue observation is durable, bounded and independent of reminder opt-out.
  An explicitly empty event selection delivers nothing on that channel.
- Logging honors configured level/category/audit options. Known credential
  patterns and sensitive metadata are redacted before stdout/Loki. The optional
  native sink is bounded and best-effort; it does not promise durable delivery.

## Local automated checks

Use the declared Node version and the frozen pnpm lockfile. Run:

```sh
pnpm install --frozen-lockfile
pnpm audit
pnpm check
pnpm --filter @meitheal/tests test
pnpm --filter @meitheal/web perf:budget
```

Build before running the performance check. Do not raise budgets or suppress
audit severities to make a failing check pass. License tests generate ephemeral
Ed25519 issuers; the production signing key is never required by CI.

Live API/browser specs require an explicit disposable `E2E_BASE_URL` and skip at
collection before browser fixture setup when it is absent. Run the relevant
Settings, framework, transport, task-handoff, completion-feedback and canonical
status browser cases against a local Astro server with an isolated database.
The development-only worst-content harness supports responsive and failure
checks, and must return404 in a production build.

Check rapid edits, concurrent saves, immediate navigation/export, rejected
writes, missing-framework restore and denied lookup responses. A failed save
must retain input, restore retry and emit no success feedback; repeated page
setup must not multiply listeners or task mutations.

## Home Assistant acceptance

Use the checked-in guarded development environment. Keep the pre-init console
mask in Compose and any startup override. Follow the devcontainer workflow; do
not recreate a container to obtain a passing test while maintenance is active.
Use one Canary entry and preserve its existing HA config entry.

Verify real ingress owner/member identity, conflicting legacy headers, scoped
agent permissions, same-site proposal decisions/replay refusal and generated MCP
inputs. An app JSON permission denial must preserve edits beyond any session
recovery delay. Check real calendar success, empty and provider-failure outcomes,
NFC retry/ambiguity, pagination and todo reorder through the loaded HA adapter.

For overdue routing, disable reminder notifications, select a future deadline,
observe one HA event and one configured HTTP delivery, then verify no duplicate
after restart. An explicitly empty event selection must remain silent. Treat
ledger observation as distinct from successful downstream delivery.

For logging, use a synthetic receiver and dummy credentials. Verify configured
level/category/audit behavior, identical redacted stdout/remote lines, static
labels, bounded queue/batches and failure/timeout behavior.

Backup hooks have their own [checkpoint and native-caller contract](backup-hooks.md).
Test their checked busy/failure outcomes and actual wrapper provenance; forwarded
client headers do not establish a trusted native caller.

## Evidence boundaries

Source checks, local fixtures, actual HA runtime and production acceptance are
separate gates. Record the exact source/build and environment for each result.
Do not promote older framework/runtime receipts to a rebuilt-version claim.
A development amd64 pass does not establish ARM or production/Tier3 acceptance.

Full browser zoom, phone hardware, screen readers, contrast and runtime
performance require their own checks. Known adjacent response-schema nullability
and UI typography/translation/palette work should remain explicit rather than
being hidden behind a broad certification claim.
