# Panel 1: Frontier Experts — Modal UI/UX Passthrough

> Scope: F8 (overlay standardization), F10 (mobile sidebar disclosure), F11 (description edit UX)
> Iteration: 01 · Date: 2026-03-16

---

## Platform Architect

**Recommendation:** Remove the stale `.modal-overlay.open .modal-content` reference at `_modal.css:113` inside the `prefers-reduced-motion` block. F8 cleaned `.open` from visibility selectors but missed this one inside the motion-reduce override.

- **Impact:** 3 — Dead CSS that contradicts the standardization work. Won't cause visible bugs but defeats the purpose of F8 if `.open` lingers anywhere.
- **Effort:** 1 — Single line deletion.
- **Risk:** 1 — Purely dead code removal.
- **Decision:** ✅ Accept

---

## OSS Integrations Specialist

**Recommendation:** Replace the `style="display:none"` on `#td-loaded-content` (TaskDetailModal.astro:78) with a CSS class toggle (e.g., `.hidden`). Inline styles are harder to override and don't follow the pattern established by the rest of the modal where visibility is class-driven.

- **Impact:** 3 — Consistency gain, aligns with existing pattern.
- **Effort:** 1 — Change one attribute + add class toggle in controller.
- **Risk:** 1 — Isolated, no behavior change.
- **Decision:** ✅ Accept

---

## Reliability Engineer

**Recommendation:** The mobile sidebar toggle (`#td-sidebar-toggle`) has no fallback if the `td-sidebar-props` element is missing or JS fails to load. On mobile, the properties content would remain permanently hidden. Add a `<noscript>` fallback or CSS-only open state.

- **Impact:** 3 — Affects non-JS edge case (rare in HA context, but good practice).
- **Effort:** 2 — Small CSS noscript block.
- **Risk:** 1 — Additive only.
- **Decision:** ✅ Accept

---

## Security Engineer

**Recommendation:** The `#td-desc-saved` indicator uses `style="display:none"` which is then toggled by JS via `.style.display`. This is fine, but the `setTimeout` in the controller that hides it after 1.5s has no cleanup — if the modal is closed and reopened quickly, the old timeout can still fire. Guard the timeout with the modal abort signal.

- **Impact:** 2 — Minor cosmetic glitch, no security concern.
- **Effort:** 1 — Pass `_modalAbortController.signal` and wrap with `AbortSignal.timeout`.
- **Risk:** 1 — Defensive only.
- **Decision:** ✅ Accept

---

## Product Architect

**Recommendation:** The checklist "Add Item" button still uses an emoji (`➕`) while all other buttons were converted to SVG icons in F7. Replace `➕ Add Item` with an SVG `+` icon for consistency.

- **Impact:** 3 — Visual consistency with F7 work.
- **Effort:** 1 — Replace emoji with inline SVG.
- **Risk:** 1 — Cosmetic only.
- **Decision:** ✅ Accept
