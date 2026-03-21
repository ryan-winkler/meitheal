# Frontier Expert Panel — GANTT/Timeline Overhaul

**Date:** 2026-03-21
**Scope:** Replace static CSS grid timeline with production-ready interactive GANTT view
**Domain:** Task visualization, SSR + client-side charting, HA ingress compatibility

---

## Panel Results

| # | Persona | Recommendation | Impact | Effort | Risk | Decision |
|---|---------|---------------|--------|--------|------|----------|
| 1 | Platform Architect | Adopt Frappe Gantt as SVG rendering engine, wrap in Astro script block with AbortSignal lifecycle | 5 | 3 | 2 | ✅ Accept |
| 2 | OSS Integrations Specialist | Use Frappe Gantt (BSD, 6.2k stars, active maintenance) instead of hand-rolling SVG GANTT | 5 | 2 | 1 | ✅ Accept |
| 3 | Reliability Engineer | Add empty-state handling, loading skeleton, and error boundary for chart initialization failures | 4 | 2 | 1 | ✅ Accept |
| 4 | Security Engineer | Sanitize task titles before rendering in SVG text nodes to prevent XSS via crafted task names | 4 | 1 | 3 | ✅ Accept |
| 5 | Product Architect | Ensure GANTT view uses consistent DDD language: Epic→Story→Task hierarchy visible as grouped rows with dependency arrows | 5 | 3 | 2 | ✅ Accept |

---

## Detailed Recommendations

### 1. Platform Architect — Frappe Gantt with Astro Lifecycle

**Recommendation:** Replace the hand-rolled CSS grid timeline with Frappe Gantt as the SVG rendering engine. Initialize it in a `<script>` block using `pageLifecycle.onPageLoad()` with `AbortSignal` for cleanup. Feed task data as a JSON blob serialized in frontmatter.

**Success criterion:** Timeline view renders an SVG GANTT chart with draggable bars, zoom control (Day/Week/Month), and dependency arrows. Chart initializes in <500ms and cleans up properly on navigation.

**Ingress consideration:** Frappe Gantt operates entirely client-side with no external requests. SVG rendering is ingress-safe. The `scroll_to: 'today'` option works with hashes, not URL changes.

### 2. OSS Integrations Specialist — Don't Reinvent the GANTT Wheel

**Recommendation:** Use Frappe Gantt (`frappe-gantt` npm package, BSD license) rather than building custom SVG rendering. Features: dependency arrows, drag-and-drop, Day/Week/Month/Year zoom, progress bars, custom popups, holidays, localization.

**Success criterion:** `pnpm add frappe-gantt` in `apps/web/`, all core GANTT features functional without custom SVG code.

**License check:** BSD — fully compatible with Meitheal's AGPL-3.0 + Commercial dual licensing.

### 3. Reliability Engineer — Graceful Degradation

**Recommendation:** Add three reliability layers: (1) loading skeleton while chart initializes, (2) empty-state message when no tasks have date ranges, (3) try-catch around Gantt initialization with fallback message.

**Success criterion:** Timeline never shows a blank white area. Zero unhandled errors in console on empty DB.

### 4. Security Engineer — SVG XSS Prevention

**Recommendation:** Sanitize task `title` and `description` before passing to Frappe Gantt. The library renders names as SVG `<text>` elements.

**Success criterion:** Task title containing `<script>` renders as escaped text, not executable markup.

### 5. Product Architect — DDD Hierarchy in Visual Form

**Recommendation:** Render GANTT with visual hierarchy: Epics as group header bars, Stories indented, Tasks indented further. Use `blocked_by` field for dependency arrows.

**Success criterion:** Users can identify Epic→Story→Task hierarchy by visual grouping. Dependency arrows connect tasks where `blocked_by` is set.
