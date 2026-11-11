---
type: "Decision"
title: "Review custom AI URLs before household sharing"
description: "Requires explicit administrator approval before household members can read a custom AI destination."
---

# Review custom AI URLs before household sharing

Date: 2026-11-11
Status: Accepted

A custom AI URL may have been saved while system settings were administrator-only. Its path or query can contain a credential. An upgrade must preserve that privacy until an administrator reviews the destination.

The handoff view checks current membership in Home Assistant and reads the provider, destination and approval in one query. The local standalone operator retains access. A household member can use a custom destination after a current administrator approves the exact URL. An existing URL stays private until approval.

The administrator reviews the URL and selects household sharing in Settings. The provider, valid HTTP(S) destination and approval commit together. Every provider save from the editor requires the previous values, so concurrent changes and an incomplete Settings load cannot overwrite a saved choice. Editing the URL clears the sharing checkbox. A legacy API write that changes the URL also revokes approval. A portable Settings import that includes the provider or URL requires fresh approval on that installation. Administrators must keep secrets out of shared URLs.

Members receive a review-required response until approval. The handoff asks before opening an external provider, and its native link uses `noopener noreferrer`. Home Assistant-only mode uses Assist for current administrators and explains the role requirement to members.

The regressions cover legacy privacy, current administrator and member access, concurrent saves, URL replacement and restore, and browser handoff. [Operations runbook](../kcs/settings-configuration-recovery.md)
