---
type: "Decision"
title: "ADR 0029: Unified Task Experience, Hierarchy Boundaries, and Scoring Normalization"
description: "Defines canonical work-item hierarchy rules, shared task editor contracts across presentation shells, code-preserving Markdown handling, RICE confidence normalization, board-scoped custom fields, and manual ordering invariants."
---

# ADR 0029: Unified Task Experience, Hierarchy Boundaries, and Scoring Normalization

- **Date:** 2026-11-22
- **Status:** Accepted
- **Deciders:** Maintainer

## Context

Task creation, viewing, editing, ordering, custom field customization, and strategic scoring previously evolved independently across modal overlays, board workspaces, Table views, Planning views, plugins, and automation APIs. That split caused diverging behavior and recurring regressions:

- Shared prominence (`is_promoted`), personal pins (`task_pins`), and legacy favorites (`is_favorite`) overlapped across card headers, menus, and API schemas.
- Hierarchy depth limits, allowed child types (`epic`, `story`, `task`), and lightweight checklist steps lacked consistent distinction in storage validation and UI labels.
- Write-time HTML sanitization corrupted raw Markdown syntax (`>`, inline code, fenced blocks), while editing offered no structured formatting/preview modes.
- Docked task inspector width (`420px`) was static without resize persistence, and card quick-action buttons could overflow narrow mobile widths or fight theme focus tokens.
- RICE scoring multiplied by confidence `0–100` instead of dividing by `100`, while custom field settings were not scoped per Board and manual table/swimlane order lacked dedicated persistence.

## Decision

1. **Canonical Work-Item Model & Hierarchy (`packages/domain-tasks/src/domain-model.ts`, `apps/web/drizzle/migrations/0018_task_experience.mjs`)**:
   - Boards (`task_boards`) own work items, Areas, Projects, Lanes, and Custom Field definitions. Work items share one `tasks` model with explicit `task_type` (`epic | story | task`) and optional same-board acyclic `parent_id` links.
   - `ALLOWED_CHILD_TYPES` enforces `epic -> [epic, story, task]`, `story -> [task]`, `task -> [task]`, bounded by `MAX_TASK_HIERARCHY_DEPTH = 4`. Cross-board/hidden ancestor probes return `404` or `400` without leaking metadata, and child-type incompatibilities block demotion.
   - Tracked **Child Items** (`parent_id`) remain distinct from lightweight inline **Checklist Steps** (`tasks.checklists`) and Markdown `- [ ]` lists inside descriptions; users can promote an individual checklist step into a tracked child item without double-counting rollups.
   - Legacy `is_favorite` is retired from active UI/API/MCP contracts and losslessly preserved in `archived_task_favorites`; shared prominence standardizes on `is_promoted` and personal bookmarking remains in `task_pins`.

2. **Shared Task Editor & Presentation Shells (`task-editor-fields.ts`, `task-editor-draft-stack.ts`, `task-description-editor.ts`)**:
   - Creation (`NewTaskModal.astro`) and inspection/editing (`TaskDetailModal.astro` + `task-modal-controller.ts`) share field helpers, stacked parent→child draft preservation, and the unified **Markdown | Visual | Preview** description editor (`enhanceDescriptionEditor`), removing duplicate legacy board inspector bundles.
   - `#task-detail-overlay` adapts cleanly across centered modal (`< 1440px`), resizable docked right sidebar (`>= 1440px` via `#td-resize-handle` setting `--task-inspector-width` clamped to `360–840px` in `localStorage["meitheal:task-sidebar-width:v1"]`), and Focus Mode (`min(100%, 72.5rem)` reading column), while `#settings-task-detail-layout` remains immediately synced in personal browser layout storage with optional server-default publishing.
   - Write-time `sanitizeMarkdownInput()` in `apps/web/src/lib/sanitize.ts` preserves code spans and fenced code blocks verbatim while stripping dangerous containers/attributes and neutralizing unsafe link schemes (`javascript:`, `vbscript:`, `data:`) outside code.

3. **RICE Percentage Normalization (`packages/domain-strategy/`)**:
   - RICE and DRICE evaluate Confidence on a `0–100` percentage scale (`confidence / 100`), align `effort.min` with fractional months (`0.01`), treat numeric `reach: 0` as score `0`, and flag unannotated legacy `0 < confidence <= 1` payloads as `legacy_ambiguous` without silent mutation.

4. **Board-Scoped Custom Fields, AI Boundaries & Persistent Ordering**:
   - Custom field definitions live per Board under `custom_fields:board:<boardId>` via `GET`/`PUT /api/custom-fields` (`apps/web/src/domains/tasks/custom-fields.ts`) and surface in `CardCustomizer.astro` (lazily fetched on open, capped at 4 visible card fields in `localStorage`).
   - Device-local AI chrome suppression (`HIDE_ASK_AI_KEY = "meitheal:hide-ask-ai:v1"`, `data-hide-ask-ai`) is decoupled from admin policy enforcement (`ai_assist_disabled` -> HTTP `403`, `code: "ai_assist_disabled"`), and internal UI Assist endpoints (`sendHAAssist`) stay excluded from MCP tools without disrupting `/api/mcp` task CRUD.
   - Manual table ordering persists in `tasks.table_position` via `/api/tasks/reorder` (`sort=manual`), `defaultTaskSortOrder()` aligns `/api/tasks` defaults per column with `due_date` empty/null values sorted last, swimlanes persist `color` and `position` across `/api/lanes`, and plugins gain `openCreateTask` and `registerTaskInspectorSection`.

## Alternatives Considered

- **Separate editor implementations for Create, Sidebar, and Focus views**: Rejected because validation, Markdown sanitization, hierarchy rules, and field labels repeatedly drifted between entry points.
- **Replacing lightweight JSON checklists with child tasks**: Rejected because simple step-by-step reminders inside one task do not warrant independent ticket keys, lanes, assignees, or board clutter.
- **Silently rescaling legacy `confidence: 1` values during migration**: Rejected because `1` may mean either `1%` or `100%`; flagging `legacy_ambiguous` prevents silent ranking distortion.

## Consequences

- **Positive**: One consistent domain language, unified editor behavior, non-destructive migrations, preserved code syntax in descriptions, persistent manual ordering and sidebar width, and strict separation of personal UI preferences from Board/server policies.
- **Negative / Risks**: Contributors adding task fields or sort keys must keep `generate-openapi.mjs`, `TASK_PUBLIC_FIELDS`, and domain validation helpers synchronized; rapid test suites sharing one rate-limited server benefit from lazy loading non-critical board metadata such as card field customization.

## Related

- [ADR 0021: Hardware Memory Constraints, Containerized Workspaces & Streaming Virtualization](0021-hardware-memory-and-ui-architecture.md)
- [ADR 0027: Ordinary Board Workspaces](0027-ordinary-board-workspaces.md)
- [Hierarchy & Terminology Glossary](../kcs/hierarchy-glossary.md)
- [Design Principles](../kcs/design-principles.md)
