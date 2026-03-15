# Search Parity Spec

**Updated:** 2026-03-15
**Owner:** Search / navigation experience

## Goal

Ship a single, modular search hub that makes Meitheal feel competitive with Teamhood-class work search while remaining Astro-first and Home Assistant-native.

## Required Behavior

1. `Cmd/Ctrl+K` and the topbar search launcher open the same search surface.
2. The search surface supports these scopes:
   - `All`
   - `Tasks`
   - `Views`
   - `Settings`
   - `Actions`
3. Task search supports these searchable fields:
   - Task ID / ticket key
   - Title
   - Description
   - Labels
   - Custom fields
   - Comments
4. Task search supports:
   - `include completed`
   - `include archived`
   - `sort by relevance`
   - `sort by recently updated`
5. Search returns more than tasks:
   - Boards
   - Saved filters
   - Settings anchors
   - Quick actions and navigation destinations
6. Search result selection can:
   - Open task detail
   - Navigate to ingress-safe routes
   - Open Home Assistant assist/action entry points already exposed by Meitheal

## Architecture Constraints

1. Universal search must use a dedicated `/api/search` endpoint.
2. Search orchestration belongs in a dedicated in-app domain, not inline in `Layout.astro`.
3. Topbar search, overlay UI, and result rendering must be modularized into shared components/controllers.
4. Existing settings search registry should be reused rather than redefined.
5. Home Assistant custom component search contracts must call the same upgraded task-search behavior instead of maintaining a weaker local-only filter path.

## Acceptance

1. Search opens and works behind Home Assistant ingress.
2. The visible launcher hint and actual keyboard shortcut behavior match.
3. Global search is no longer implemented as a title/description-only dropdown.
4. At least one browser test covers hub launch + result navigation.
5. Public docs and `.planning/` artifacts reflect the new search contract.
