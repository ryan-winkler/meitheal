# Truthful Settings, agent workflows and HA integration verification

Verified 10 November 2026 on the remediation branch. This records the bounded
acceptance performed for the false-success and unsupported-behavior findings;
it is not a whole-repository security or accessibility certification.

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

## Validation performed

- Pinned workspace `pnpm check` passed. Direct Astro check covered439 files:
  zero errors, zero warnings and183 nonblocking hints.
- Focused Playwright batches passed:31 framework/transport/logging cases,
  21 HA identity/security/transport cases,28 Settings/lifecycle cases,
  nine overdue/filter/cold-start cases and ten logger/Loki cases. Counts
  overlap and must not be summed. Twenty Python adapter tests also passed.
- Actual temporary Chromium WebMCP registration/search/disable/reenable/HMR
  acceptance passed, alongside two browser contract cases.
- Actual amd64 HA devcontainer: one source-built Canary installed, updated,
  stopped/restarted and healthy. Real ingress verified owner persistence and
  a single toast, household/spoof rejection with retained edits after1.5 seconds
  and zero document reloads, native MCP search/calendar/approval permissions,
  replay refusal, real HA component services/tools/voice/NFC, and logger/Loki
  delivery. A natural five-minute overdue tick delivered one HA event and one
  HTTP event, triggered the actual device automation, and remained deduplicated
  after restart with reminders disabled.
- Two consecutive fresh EGM rounds were clean of unsettled Major/Blocker
  findings following the approved review extension and supported fixes.
- The console guard was independently verified by maintenance: all guest getty
  masks applied before init;65.23 seconds of stable desktop observation,
  unchanged GUI process IDs and zero display-manager restarts. The commit/PR
  step performs no HA container recreation.

## Environment and limits

Current Supervisor forced pulling a local FROM tag, so the test-only local
Canary used an exact exported source-built runtime filesystem, preserving its
entrypoint, environment, workdir, labels and healthcheck, then underwent native
Supervisor build/install/update. No image was pushed or production deployed.
Failed and probe-invalidated evidence was retained separately, never counted
as passing acceptance. Synthetic test data and credentials stayed local.

Production/Tier3, ARM execution, phone hardware, screen readers, full browser
zoom and comprehensive contrast/performance acceptance are not claimed.
Remaining UI typography/Irish-copy/palette nits are documented. Adjacent
pre-existing Task.kanban_position response-schema numeric/null drift remains a
nonblocking known gap; corrected MCP input discovery is unaffected.

Raw logs, screenshots, source hashes and runtime receipts remain in the owner's
private dated local evidence archive, outside source control.
