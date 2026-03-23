# Panel 1: Frontier Experts — Phase 29 (UX/Memory/Crash Protection)

**Date:** 2026-03-23
**Objective:** UI/UX improvements, click/interaction improvements, Astro-native patterns, memory optimizations, crash protection

## Codebase Metrics (Pre-Phase)

| Metric | Count | Risk |
|--------|-------|------|
| `addEventListener` without signal | 368 | 🔴 Memory leak |
| `innerHTML` usage | 221 | 🟡 XSS surface |
| Inline `style=` in components | 325 | 🟡 Maintainability |
| Buttons missing `aria-label` | 260 | 🟡 Accessibility |
| `transition: all` in CSS | 5 | 🟢 Performance |
| Remaining `console.*` calls | 9 | 🟢 Hygiene |
| `managedListeners` adoption | 7 files | 🟡 Partial adoption |

---

## Platform Architect

**Recommendation:** Migrate the top 10 highest-impact controllers from raw `addEventListener` to `managedListeners()` or `pageLifecycle.on()` with `AbortSignal`, prioritizing controllers that handle user interaction (kanban, table, timeline, today, sidebar).

- **Impact:** 5 — Eliminates memory leak class across core navigation paths; prevents accumulated listeners on HMR and view transitions
- **Effort:** 3 — Each controller is ~30min; batch of 10 = ~5hrs. Pattern established in `today-controller.ts`
- **Risk:** 2 — Isolated per-controller; regressions are visible immediately as broken click handlers
- **Success Criterion:** `addEventListener` without signal count drops from 368 to <300 in the 10 targeted files.
- **Decision:** ✅ Accept

---

## OSS Integrations Specialist

**Recommendation:** Replace manual `innerHTML` DOM construction in controllers with Astro `<template>` + `cloneNode()` pattern, starting with the 5 highest-frequency innerHTML sites (kanban card rendering, table row rendering, modal body construction, search results, sidebar tree nodes).

- **Impact:** 4 — Eliminates XSS surface in the hottest render paths and enables CSP `unsafe-inline` removal
- **Effort:** 3 — Each site needs a template element in the `.astro` file and a `cloneNode` + `querySelector` fill in the controller
- **Risk:** 3 — Template structure must exactly match current innerHTML output; visual regression possible
- **Success Criterion:** innerHTML count drops from 221 to <180; no `innerHTML = userInput` remains
- **Decision:** ✅ Accept

---

## Reliability Engineer

**Recommendation:** Add a global `window.onerror` and `unhandledrejection` handler that logs to `createClientLogger('uncaught')` and shows a non-blocking toast notification instead of silently failing, plus add `try/catch` wrappers around all `pageLifecycle.onPageLoad` callbacks.

- **Impact:** 4 — Currently unhandled promise rejections (e.g. failed API calls in page-load callbacks) silently break features without any user feedback
- **Effort:** 2 — Single file global handler + grep-and-wrap existing onPageLoad callbacks
- **Risk:** 2 — Low risk; adds defensive layer without changing behavior
- **Success Criterion:** Global error handler exists; at least 5 onPageLoad callbacks wrapped in try/catch with error toast
- **Decision:** ✅ Accept

---

## Security Engineer

**Recommendation:** Audit and replace the 5 most dangerous remaining `innerHTML` assignments where the content includes any form of user/API data interpolation. Ensure all remaining `innerHTML` uses are either static HTML strings or use `textContent`/`set:html` with sanitization.

- **Impact:** 4 — Directly reduces XSS attack surface in production
- **Effort:** 2 — Targeted replacements, not a full rewrite
- **Risk:** 2 — Each replacement is isolated and testable
- **Success Criterion:** Zero `innerHTML` assignments using unsanitized external data; ESLint rule or comments justify remaining uses
- **Decision:** ✅ Accept

---

## Product Architect

**Recommendation:** Standardize click interaction feedback across all icon-only buttons by adding `aria-label` + `:active` press feedback CSS + cursor pointer to the 20 most-used unlabeled buttons (sidebar actions, card actions, toolbar buttons, modal close buttons).

- **Impact:** 3 — Material improvement to perceived quality and accessibility; icon-only buttons feel "dead" without press feedback
- **Effort:** 2 — CSS utility class + grep-and-add aria-labels
- **Risk:** 1 — Pure additive; no behavior change
- **Success Criterion:** 20 icon-only buttons gain `aria-label` + `:active` feedback; buttons-missing-aria count drops by ≥20
- **Decision:** ✅ Accept
