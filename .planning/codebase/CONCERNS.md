# Codebase Concerns

> Last mapped: 2026-03-15 — 50-persona audit + design token migration

## ~~Critical: Script Monolith~~ → Medium: Script Size

**File:** `apps/web/src/pages/kanban.astro` (3,303 lines)
- ~1,800 lines of inline `<script>` — now unified with shared `_qa` popover utility
- Quick actions refactored: shared close/toast/open, single consolidated click/keydown listener
- **Remaining:** Extract to `apps/web/src/lib/kanban-quick-actions.ts` for tree-shaking

## ~~Critical: Design Token Violations~~ → Resolved ✅

**Migrated to `_tokens.css` design tokens:**
- `--type-epic`, `--type-story`, `--type-task` (dark + light + auto)
- `--prio-critical`, `--prio-high`, `--prio-medium`, `--prio-low`, `--prio-none`
- `.priority-dot.*`, `.type-dot-*`, `.type-badge-*` all use `var()` references
- `color-mix(in srgb)` for type badge backgrounds with alpha

## ~~High: Accessibility Gaps~~ → Resolved ✅

**Addressed in user's `_qa` refactor:**
- `role="dialog"` + `aria-label` on popovers
- Arrow key navigation (ArrowUp/Down) within popover items
- `role="menuitem"` on assign items
- `role="radiogroup"` + `aria-checked` on color swatches
- Focus management (first interactive element on open)

## ~~High: Performance — Document Listeners~~ → Resolved ✅

- Single consolidated `_qa` click/keydown listener replaces 3 per-popover listeners
- `astro:before-swap` cleanup for Astro navigation

## ~~Medium: UX Gaps~~ → Resolved ✅

- Child task always `"pending"` (not inheriting parent status)
- Active color indicator (`swatch-active` class + checkmark `::after`)
- Loading skeleton for assign popover
- Optimistic updates for assign + color
- Popover exit animation (`popover-exiting`)
- Scroll restore after child task creation

## Medium: Other Monoliths

| File | Lines | Concern |
|------|-------|---------|
| `settings-controller.ts` | 3,202 | Largest file in codebase |
| `task-modal-controller.ts` | 2,348 | Complex modal logic |
| `Layout.astro` | 1,484 | Large layout with inline logic |
| `table-controller.ts` | 1,337 | Growing table logic (summary rows + sub-grouping added) |
