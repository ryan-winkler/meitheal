---
type: Decision
title: Shared Board workspace and recoverable removal
description: "Use one Kanban presentation and preserve Board records through deletion and restoration."
---

# Shared Board workspace and recoverable removal

Date 2026-11-18

Status Accepted

## Context

Household tasks used the canonical Tasks workspace while named Boards rendered separate columns and editing forms. The sidebar placed Household outside the Boards branch. Area and Group named the same planning concept. Neither Board type exposed a complete removal and recovery journey.

Household is the legacy shared scope. Its tasks and planning records use null ownership, its public ticket sequence uses MTH, and Home Assistant integrations target it. Changing the Board's visible state must preserve these identities and account for background work.

## Decision

Household and named Boards use the same TaskWorkspace component for Kanban presentation. Each scope keeps its authorized data loader and mutation contract. Named ticket edits include current Board session proof and task version. Unsupported actions are omitted through the scope's capabilities. The existing modal shell contains the named inspector, which clears with its private workspace.

Boards is one sidebar parent with Household and named Board children. Areas and their Projects nest below their owning Board. Area and Areas are the canonical display terms. Persisted alias keys, feature identifiers and older routes remain compatible.

Delete Board transitions it to the existing retired state. The operation preserves its work and makes Restore available to an eligible human from Deleted Boards. Named Board removal requires an owner with applicable deletion rights. Household removal requires a verified Home Assistant administrator. Agents cannot perform Board lifecycle changes.

Deleting Household pauses its shared capture, Routine generation and inbound Home Assistant work until restoration. It creates no replacement and transfers no records. Active named Boards remain available. Legacy task and planning projections exclude retired Household work, while the shared Goal projection continues serving authorized work from active named Boards.

The lifecycle transition checks the expected Board revision and current authority inside the writer transaction. It advances the existing Board access marker. Storage guards reject writes to retired Household records, including a request admitted before deletion. The API distinguishes stale revisions, denied operations, unavailable storage and a committed state whose access-marker publication remains pending.

## Recovery and validation

Schema 25 preserves the retired Household state during startup. Restore reactivates its original records and ticket sequence. An upgrade fixture must retain a populated schema 24 database and demonstrate exact-source App backup restoration with integrity checks.

Browser verification covers the common Kanban, Area filtering, keyboard navigation, phone layout, named ticket restrictions, revocation and both lifecycle entry points. Release verification also checks the packaged Home Assistant Supervisor and the installed Green image and discovery manifest. The existing Home Assistant App backup procedure provides the complete recovery archive.

## Alternatives considered

Retaining two renderers would require parallel card, keyboard and error-state fixes. A unified task repository could remove more duplication, but would also migrate legacy Household integrations and references. Shared presentation with authorized scope adapters addresses the current journey with a smaller persistence change.

A separate deletion archive would introduce additional relationship recovery and access-marker rules. Reusing the retired state preserves identity directly. Automatically creating a replacement Household would require transferring integration destinations and audience; pausing shared work until restoration retains the existing destination.
