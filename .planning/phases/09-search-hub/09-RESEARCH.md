# Phase 09: Search Hub — Research

**Researched:** 2026-03-15
**Domain:** Universal search, navigation, and command actions
**Confidence:** High

## Current State

1. Topbar search is a small dropdown wired to `GET /api/tasks?q=...` and only searches task title/description.
2. `Cmd/Ctrl+K` opens a separate command palette implemented elsewhere, so the visible `Cmd K` hint in the topbar is misleading.
3. Search logic is duplicated across:
   - `layout-controller.ts` topbar dropdown
   - `task-modal-controller.ts` command palette
   - settings search registry/controller
   - several task-link and parent-search affordances
4. Home Assistant service, LLM API, and MCP task search all use weaker cached/local filtering than the main app should.
5. ADR 0007 expects `docs/analysis/*`, but the canonical folder was missing.

## Key Gaps

1. No universal search contract.
2. No dedicated search bounded context.
3. No search over ticket keys, labels, custom fields, or comments.
4. No unified access to boards, saved filters, settings, or HA-aware actions.
5. Public contracts promise more search/filter behavior than the code currently supports.

## Recommended Direction

1. Introduce a single search hub launched by topbar focus and `Cmd/Ctrl+K`.
2. Add `/api/search` for universal search orchestration.
3. Keep `/api/tasks` for list views, but fix contract drift like missing `priority` filtering.
4. Reuse the existing settings registry as a search source.
5. Route Home Assistant search integrations through the upgraded task-search path for parity.
