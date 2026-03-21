# ADHD/Productivity Panel — GANTT/Timeline Overhaul

**Date:** 2026-03-21
**Scope:** Cognitive load, workflow efficiency, and ADHD-friendly patterns for GANTT view
**Domain:** Task visualization, focus management, reduced switching costs

---

## Panel Results

| # | Persona | Recommendation | Impact | Effort | Risk | Decision |
|---|---------|---------------|--------|--------|------|----------|
| 1 | Workflow Coach | Add "Today" button that instantly scrolls/centers the chart on current date — reduce orientation time from >5s to <1s | 5 | 1 | 1 | ✅ Accept |
| 2 | Execution Coach | Wire `on_date_change` and `on_progress_change` events to PATCH `/api/tasks/{id}` — inline editing eliminates modal round-trips | 5 | 3 | 2 | ✅ Accept |
| 3 | Knowledge Coach | Show a tooltip popup on click with task title, dates, progress, status, and quick-link to task detail — no separate memory load | 4 | 2 | 1 | ✅ Accept |
| 4 | Focus Optimizer | Default view mode to "Week" not "Day" — Week view reduces visual noise from 35 columns to 5, keeps the big picture visible | 4 | 1 | 1 | ✅ Accept |
| 5 | Automation Coach | Persist last-used zoom level in localStorage so returning to timeline doesn't reset mental model | 3 | 1 | 1 | ✅ Accept |

---

## Detailed Recommendations

### 1. Workflow Coach — "Today" Anchor Button

**Problem:** Current timeline shows a 5-week rolling window. If the user scrolls away, there's no fast way back. ADHD users lose spatial context quickly.

**Recommendation:** Frappe Gantt has `today_button: true` and `scroll_to: 'today'` built in. Enable both. Add a high-contrast "Today" pill in the view controls area.

**Success criterion:** Single click returns chart to today's column, highlighted. Works behind HA ingress (no URL changes).

### 2. Execution Coach — Inline Date/Progress Editing

**Problem:** To change a task's dates or progress, users must open a modal, edit fields, save, and return. Four context switches.

**Recommendation:** Wire Frappe Gantt's `on_date_change(task, start, end)` and `on_progress_change(task, progress)` callbacks to `PATCH /api/tasks/{id}`. Updates happen inline by dragging bar edges or progress handle.

**Success criterion:** Drag a task bar to a new date range → API call fires → task `start_date`/`end_date` updates in DB without page reload.

### 3. Knowledge Coach — Click-to-Detail Popup

**Problem:** The current timeline shows only task title on the bar. Users must remember or navigate elsewhere to see dates, status, progress.

**Recommendation:** Use Frappe Gantt's `popup` callback to render a custom popup showing: title, MTH-N ticket, dates, progress bar, status badge, and a "View Details" link to the task modal.

**Success criterion:** Clicking any task bar shows a popup with actionable info. "View Details" opens the task edit modal.

### 4. Focus Optimizer — Week View Default

**Problem:** Day view shows 35+ narrow columns. The cognitive load of scanning individual days overwhelms ADHD users. Most planning happens at the week level.

**Recommendation:** Set `view_mode: 'Week'` as default. Store preference in localStorage. Offer Day/Week/Month/Year as zoom options via Frappe Gantt's built-in `view_mode_select`.

**Success criterion:** First load shows Week view. Zoom buttons visible and functional.

### 5. Automation Coach — Persist Zoom Preference

**Problem:** Every time the user returns to timeline, it resets to default zoom. Mental model of "where things are" gets disrupted.

**Recommendation:** On `on_view_change`, write the selected view mode to localStorage key `meitheal-timeline-zoom`. On init, read and apply.

**Success criterion:** Set zoom to Month → navigate away → return → still in Month view.
