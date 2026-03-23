# Panel 2: ADHD/Productivity Specialists — Phase 29

**Date:** 2026-03-23
**Objective:** UI/UX improvements, click/interaction improvements, Astro-native patterns, memory optimizations, crash protection

---

## Workflow Coach

**Recommendation:** Create a `btn-icon` utility class + `btn-press` CSS pattern that provides `:active` scale-down, `cursor: pointer`, and `focus-visible` outline — apply to all icon-only buttons app-wide so every interactive element gives immediate tactile feedback.

- **Impact:** 4 — ADHD users rely on immediate visual feedback to confirm an action registered. Dead-feeling buttons cause re-clicking and confusion.
- **Effort:** 2 — One CSS class definition + batch `grep -rn` and add class to existing icon buttons
- **Risk:** 1 — Pure additive CSS, no JS change
- **Success Criterion:** `btn-icon` class exists; applied to ≥30 icon-only buttons across layout, task, and modal components
- **Decision:** ✅ Accept

---

## Execution Coach

**Recommendation:** Add ESLint rule `no-restricted-syntax` targeting `addEventListener` calls that don't include `{ signal: }` in the options object, scoped to `lib/` and `components/` directories. This enforces memory-safe listener patterns at CI time.

- **Impact:** 4 — Prevents future memory leaks by failing the build if a listener is added without cleanup signal. Enforcement over documentation.
- **Effort:** 2 — ESLint config addition + fix the 5 easiest violations
- **Risk:** 2 — May flag legitimate cases that need `// eslint-disable` inline comments
- **Success Criterion:** ESLint rule active; CI catches new unsignaled listeners; <10 existing violations documented with eslint-disable
- **Decision:** ✅ Accept

---

## Knowledge Coach

**Recommendation:** Create `docs/kcs/memory-safety-patterns.md` documenting the 3 canonical patterns for event listener management in Meitheal: `managedListeners()`, `pageLifecycle.on(signal)`, and `AbortController` with `{ signal }`. Include when to use each, migration examples, and common mistakes.

- **Impact:** 3 — Reduces onboarding friction for future contributors; prevents re-introduction of memory leaks via clear prescriptive guidance
- **Effort:** 1 — Documentation-only; patterns already established in codebase
- **Risk:** 1 — No code change
- **Success Criterion:** KCS article exists with 3 patterns, 3 examples, and 3 anti-patterns
- **Decision:** ✅ Accept

---

## Focus Optimizer

**Recommendation:** Limit this iteration to the top 5 controllers by listener count (kanban, table, sidebar, today, timeline) and scope memory migration to those files only. The remaining 363 violations are deferred to a dedicated Phase 30 sweep.

- **Impact:** 3 — Prevents scope creep while delivering the highest-value cleanup. The top 5 controllers handle 80%+ of user interactions.
- **Effort:** 1 — Scoping decision, not implementation
- **Risk:** 1 — Reduces risk by narrowing blast radius
- **Success Criterion:** Phase 29 scope document limits memory migration to 5 named controllers; remaining work tracked as Phase 30
- **Decision:** ✅ Accept

---

## Automation Coach

**Recommendation:** Add a `precommit` or `prebuild` script that counts `addEventListener` without signal and `innerHTML` with interpolation, outputting a health summary. Not a gate — just visibility.

- **Impact:** 3 — Creates a feedback loop: devs see the count trending down, which motivates continued cleanup. ADHD thrives on visible progress.
- **Effort:** 2 — Simple grep-count script in `scripts/` + package.json hookup
- **Risk:** 1 — Non-blocking; information-only
- **Success Criterion:** `scripts/health-check.mjs` exists; outputs listener/innerHTML counts; runs in <2s
- **Decision:** ✅ Accept
