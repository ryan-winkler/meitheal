# Phase 26: UX & Resilience Polish - Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

## Phase Boundary

Post-Phase 25 hardening. This phase improves UI/UX consistency, click/interaction patterns, Astro-native alignment, memory safety, and crash protection across the existing codebase. No new features — hardening what exists.

## Implementation Decisions

### Memory & Lifecycle Safety
- Prioritize the **15 controllers not using `pageLifecycle`** — these are the highest-risk memory leak vectors
- Target controllers by risk (those adding global document/window listeners first, then element-scoped)
- For the 582 `addEventListener` calls without signal: batch by controller, not exhaustive. Focus on client-side controllers in `src/lib/` that accumulate listeners across navigations
- `setInterval` files: audit for proper cleanup on page teardown. Priority: `PomodoroTimer.astro`, `connectivity.ts`, `due-date-reminders.ts`, `layout-controller.ts`

### Fetch Resilience
- Add AbortSignal to **critical user-facing fetch paths** (task CRUD, settings save, token management) — not exhaustive for all 128 calls
- Standard timeout: **10s for mutations, 15s for reads**
- No retry logic for mutations (risk of double-submit). Read-only fetches: single retry with exponential backoff for network errors only
- Create a shared `fetchWithTimeout()` utility wrapping the existing fetch monkey-patch

### Click & Interaction Patterns
- Migrate all 10 remaining `prompt()` calls to inline inputs or modal-based input flows
- Standardize async button disabled states using `asyncButton()` pattern already in `@lib/async-button`
- Double-click protection: use `asyncButton()` consistently, not ad-hoc `btn.disabled` patterns
- Priority files: `SavedFilterPresets.astro` (prompt), `planning.astro` (prompt), `eisenhower-controller.ts` (prompt), `kanban-lanes.ts` (prompt), `settings-danger-controller.ts` (prompt)

### Style & Component Consistency
- Move **high-impact inline styles** off components that are used on multiple pages (EntitySelector, GoalsTab, SettingsLabels, etc.)
- Don't touch components with minimal/intentional inline styles (1-2 properties)
- Add scoped `<style>` blocks to the 19 unstyled components that have significant visual requirements
- Consolidate repeated inline patterns into shared CSS classes or design tokens

### Claude's Discretion
- Prioritize based on user experience impact — memory leaks and click issues before style cleanup
- Group work into 3 waves: Wave 1 (lifecycle/memory), Wave 2 (fetch/click), Wave 3 (style consistency)
- Silent `catch {}` blocks: add structured logging via `clientLog` where the swallow masks actionable errors, leave intentional ones (DB unavailable, graceful fallback) with inline comments

## Specific Ideas
- Use existing `pageLifecycle.on()` pattern as the standard — don't invent new lifecycle wrappers
- `asyncButton()` from `@lib/async-button` is the established pattern for double-click protection
- `confirmDialog()` from `@lib/confirm-dialog` is the established pattern for all confirmations (just completed)
- `showToast()` from `@lib/toast` is the established pattern for user feedback (just completed)

## Deferred Ideas
- `prompt()` → inline input migration for kanban-keyboard.ts (shortcut customization — needs full UI redesign, belongs in its own phase)
- Full design token audit (beyond scope — would need a dedicated design system phase)
- Service worker fetch interception patterns (offline domain, separate bounded context)

---

*Phase: 26-ux-resilience-polish*
*Context gathered: 2026-03-23*
