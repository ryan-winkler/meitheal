# Panel Round 1 — Frontier Experts

**Phase:** 25 — Client-Side Resilience & UX Hardening
**Iteration:** 01
**Objective:** Harden client-side code for memory safety, click reliability, crash protection, and Astro-native lifecycle compliance

---

## 1. Platform Architect

**Recommendation:** Consolidate the duplicate health-check interval (`layout-controller.ts` line 47 and `SidebarFooter.astro` line 69) into a single shared `health-monitor.ts` service that fires once every 30s and emits a custom event. Both consumers subscribe to the event instead of running independent intervals.

**Success Criterion:** `rg 'setInterval.*checkHealth' src/` returns exactly 1 result (in the shared service). Both sidebar footer and layout controller react to the same health event.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 2 |
| Risk | 2 |

**Decision:** ✅ Accept — impact(4) >= effort(2), concrete, testable, eliminates resource duplication.

---

## 2. OSS Integrations Specialist

**Recommendation:** Replace all 9 empty `catch {}` blocks with structured logging via `console.warn('component:context', error)` at minimum, or use the domain-observability logger where available. Each catch should log the component name and operation so debugging in production is possible without reproduction.

**Success Criterion:** `rg 'catch\s*\{\s*\}' src/ -g '*.astro' -g '*.ts'` returns 0 results.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 2 |
| Risk | 1 |

**Decision:** ✅ Accept — impact(4) >= effort(2), concrete, trivially testable via grep.

---

## 3. Reliability Engineer

**Recommendation:** Migrate `GoalsTab.astro`'s 6 raw `addEventListener` calls to use `pageLifecycle.on()` with the Astro page lifecycle signal. This is the last Settings-adjacent component with unmanaged listeners that can accumulate across Astro soft navigations.

**Success Criterion:** `rg 'addEventListener' src/components/progress/GoalsTab.astro` returns 0 results. All listeners use `pageLifecycle.on()`.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 2 |
| Risk | 2 |

**Decision:** ✅ Accept — impact(4) >= effort(2), directly prevents memory leaks on the Progress page.

---

## 4. Security Engineer

**Recommendation:** Audit the top 3 `innerHTML` hotspot files (`task-modal-controller.ts` at 39 uses, `settings-integrations-n8n-controller.ts` at 21, `StrategicEvaluator.astro` at 12) and convert any that render user-provided strings (task titles, custom field values, label names) to use `textContent` or DOM API calls with proper escaping. Add a `sanitizeHTML()` utility for cases where HTML rendering is required (e.g., markdown in descriptions).

**Success Criterion:** No `innerHTML` assignment contains unescaped user input. User-provided strings use `textContent`, `createTextNode()`, or pass through `sanitizeHTML()`.

| Metric | Score |
|--------|-------|
| Impact | 5 |
| Effort | 3 |
| Risk | 3 |

**Decision:** ✅ Accept — impact(5) >= effort(3), critical XSS prevention for production release.

---

## 5. Product Architect

**Recommendation:** Add loading/disabled states to all async action buttons (create task, save settings, sync, delete) by extracting a `withAsyncButton(btn, asyncFn)` wrapper that: (1) sets `disabled` and shows spinner on click, (2) restores on completion/error, (3) prevents double-click via the standard AbortController pattern from `docs/kcs/client-side-patterns.md`.

**Success Criterion:** Every button that triggers an API call has a visual loading state. No button can be clicked twice during an inflight request.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 3 |
| Risk | 2 |

**Decision:** ✅ Accept — impact(4) >= effort(3), directly improves user trust and prevents double-submission across the app.

---

## Summary

| # | Persona | Decision | Impact | Effort | Risk |
|---|---------|----------|--------|--------|------|
| 1 | Platform Architect | ✅ Accept | 4 | 2 | 2 |
| 2 | OSS Integrations | ✅ Accept | 4 | 2 | 1 |
| 3 | Reliability Engineer | ✅ Accept | 4 | 2 | 2 |
| 4 | Security Engineer | ✅ Accept | 5 | 3 | 3 |
| 5 | Product Architect | ✅ Accept | 4 | 3 | 2 |

**All 5 accepted.**
