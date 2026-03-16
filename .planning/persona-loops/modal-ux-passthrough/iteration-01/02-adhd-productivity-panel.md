# Panel 2: ADHD/Productivity — Modal UI/UX Passthrough

> Scope: F8 (overlay standardization), F10 (mobile sidebar disclosure), F11 (description edit UX)
> Iteration: 01 · Date: 2026-03-16

---

## Workflow Coach

**Recommendation:** The stale `.animate-slide-in` reference at `_modal.css:244` (`#task-detail-overlay .animate-slide-in`) targets a class that was removed in F1 of the original research. Remove this dead CSS rule to prevent confusion for future maintainers.

- **Impact:** 2 — Dead code cleanup, reduces cognitive load when reading CSS.
- **Effort:** 1 — Delete 3 lines.
- **Risk:** 1 — Dead code, zero functional impact.
- **Decision:** ✅ Accept

---

## Execution Coach

**Recommendation:** Add a `Cmd/Ctrl+S` keyboard shortcut in the description edit mode that triggers Save, matching common editor muscle memory. Currently the only way to save is clicking the Save button.

- **Impact:** 4 — Power users (like Ryan) expect keyboard shortcuts in text edit areas.
- **Effort:** 2 — Add keydown listener to `#td-description` textarea.
- **Risk:** 1 — Isolated to description editing context.
- **Decision:** ✅ Accept

---

## Knowledge Coach

**Recommendation:** The mobile sidebar toggle says "Properties" but the sidebar contains more than properties — it has Mark as Done, Strategic Evaluation, Context fields, and Timing. Rename the toggle label to "Details" to be more accurate and self-describing.

- **Impact:** 2 — Clearer domain language for mobile users.
- **Effort:** 1 — Single text change.
- **Risk:** 1 — Cosmetic only.
- **Decision:** ✅ Accept

---

## Focus Optimizer

**Recommendation:** When opening the task detail on mobile, the mobile sidebar toggle starts collapsed. If the task is marked as "active" status, auto-expand the sidebar to show the "Mark as Done" button prominently — it's the most likely next action for active tasks.

- **Impact:** 3 — Reduces taps for the most common mobile action.
- **Effort:** 3 — Need to read task status after data loads, then conditionally expand sidebar.
- **Risk:** 2 — Touches openTaskDetail flow, needs testing.
- **Decision:** ⏸️ Defer — Good idea but effort/risk exceeds scope of this cleanup pass. Track for future sprint.

---

## Automation Coach

**Recommendation:** The `#td-desc-preview-container` click handler that enters edit mode conflicts with clicking links inside rendered markdown. Add an `event.target` check to only enter edit mode when clicking the container background, not rendered links/code/images.

- **Impact:** 4 — Prevents frustrating UX bug where clicking a link inside a description opens edit mode instead of following the link.
- **Effort:** 2 — Add `event.target` check in the click handler.
- **Risk:** 2 — Touches event propagation, needs careful testing.
- **Decision:** ✅ Accept
