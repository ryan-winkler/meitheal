---
type: "Decision"
title: "ADR 0013: Dual-Licensing Strategy (AGPLv3 + Commercial)"
description: "Records the earlier decision to document separate licensing scopes."
status: deprecated
---

# ADR 0013: Dual-Licensing Strategy (AGPLv3 + Commercial)

## Status

Historical decision from 2 March 2026. See [LICENSE](../../LICENSE), [Commercial licensing](../../COMMERCIAL.md), and the [licensing runbook](../kcs/licensing.md) for the terms and workflow that apply.

## Context

The project needed to describe its source terms, a separate commercial option, and the license of each integration. It also needed a way to record the rights contributors grant the maintainer.

## Decision

- Record the terms for the core application in the source license. Handle separate agreements only for code Meitheal can license.
- Record contributor permissions through the [contributor agreement](../../.github/CLA.md).
- Keep the existing license on the compatibility component and keep it outside any separate commercial grant.
- Keep the separate license files for integration code. Integrations call Meitheal through its network API.
- Document the terms for published images in the public add-on repository.

## Consequence

Check the applicable grant for the exact source, integration, or image you distribute. The original decision followed the [initial licensing decision](0001-legal-and-naming-strategy.md).
