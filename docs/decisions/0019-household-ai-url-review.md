---
type: "Decision"
title: "Review custom AI URLs before household sharing"
description: "Requires explicit administrator approval before household members can read a custom AI destination."
---

# Review custom AI URLs before household sharing

Date: 2026-11-11
Status: Accepted

A custom AI URL may have been saved while system settings were administrator-only. Its path or query can contain a credential. An upgrade must preserve that privacy until an administrator reviews the destination.

Verified Home Assistant household sessions may read the selected provider. A custom destination additionally requires `ai-custom-url-approved` to equal the exact current `ai-custom-url`. Both values are read in one repository query. Missing approval leaves all existing URLs private, without a schema migration. Standalone system reads, agent-token authority, bulk maps and all system-setting writes retain their existing restrictions.

The administrator reviews the URL and explicitly selects household sharing in Settings. Approval can be written only for the current valid HTTP(S) URL. Editing the field clears the sharing checkbox; changing the saved URL cannot reuse an approval for a different URL. Saving without sharing revokes approval. Administrators must keep secrets out of shared URLs.

Members receive an actionable review-required response until approval. Approved destinations use a native link gesture with `noopener noreferrer`. Built-in providers and the HA-only policy do not require custom URL approval.

The regressions cover legacy privacy, administrator approval, invalid and unauthorized approval attempts, changed URLs, revocation, standalone peer rejection and browser handoff. See the [operations runbook](../kcs/operations-runbook.md).
