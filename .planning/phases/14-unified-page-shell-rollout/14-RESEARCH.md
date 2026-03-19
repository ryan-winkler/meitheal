# Phase 14: Unified Page Shell Rollout — Research

**Researched:** 2026-03-19  
**Scope:** Dashboard-first rollout of the mature Settings shell language, with habits and remaining pages mapped as follow-up targets  
**Confidence:** High

## Current State

1. Settings already proves the desired interaction model: `UnifiedBar`, hash-based section links, SearchHub launcher, sticky Home Assistant-safe header behavior, and `pageLifecycle`-aware controllers.
2. The dashboard still uses the legacy `TopNavigation` slot path in `Layout.astro`, so it does not share the same sectioned shell, title switcher, or top-level navigation affordances.
3. `dashboard-controller.ts` is already extracted from the page, which makes the dashboard the lowest-risk first page for a shell migration.
4. The habits page is a larger migration because it still owns a long inline script, raw event listeners, and manual DOM rendering; it should follow after the dashboard shell pattern is proven.
5. `UnifiedBar.astro` is visually reusable, but the rollout needs reusable controller behavior and page-safe DOM contracts so other pages do not depend on Settings naming.

## Key Gaps

1. Cross-page reuse gap: Settings has mature shell behavior, but much of the orchestration still lives in a settings-specific controller.
2. Dashboard IA gap: the dashboard content is valuable, but its sections are not currently expressed as deep-linkable page jobs.
3. Lifecycle gap: the dashboard controller still uses direct `addEventListener()` registration patterns that should be normalized around `pageLifecycle`.
4. Habits readiness gap: habits shares the need for a mature shell, but it first needs controller extraction and lifecycle cleanup.

## Recommended Direction

1. Introduce a dashboard section registry and a dashboard-specific shell using `UnifiedBar` plus hash-linked sections.
2. Factor reusable bar behaviors where the Settings implementation has already proven the interaction, especially title switching, SearchHub launch, new-task launch, and tab overflow.
3. Keep the dashboard migration focused on IA, shell, and lifecycle cleanup. Do not expand dashboard domain behavior in the same slice.
4. Capture habits as the next shell target with a concrete blocker list: inline script extraction, event cleanup, and ingress-safe fetch normalization.
5. Add Tier 1 verification for section deep links and preserve existing dashboard actions (quick add, open task detail, open modal).
