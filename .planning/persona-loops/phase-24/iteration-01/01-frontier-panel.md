# Panel 1: Frontier Experts — Phase 24, Iteration 01

**Objective:** Settings UI/UX, memory, click, and crash optimizations
**Date:** 2026-03-22

---

## Platform Architect

**Recommendation:** Add `AbortSignal` to all `addEventListener` calls in `SettingsAgentTokens`, `SettingsAgents`, and `SettingsLabels`

All three components register event listeners (`click`, `change`, `input`, `submit`) on DOM elements without passing `{ signal }`. Per AGENTS.md gotchas, listeners without signals accumulate across Astro page navigations — a confirmed memory leak vector. The settings page has 16+ unguarded listeners.

**Fix:** Wrap each component's `<script>` with `import { pageLifecycle } from "@lib/page-lifecycle"` and pass `{ signal }` from `pageLifecycle.onPageLoad()`.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 2 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Zero listeners without `{ signal }` in settings components.

---

## OSS Integrations Specialist

**Recommendation:** Replace `innerHTML` construction of scope badges in `SettingsAgentTokens.renderTokens()` with DOM API to prevent XSS

Line 329 interpolates `token.scopes` values directly into an innerHTML template string without escaping. If a scope value were manipulated, it would execute arbitrary HTML. The `token.name` IS escaped via `escapeHtml()`, but scopes are not.

**Fix:** Build scope badges using `document.createElement` + `textContent`, or escape scope values through the existing `escapeHtml()`.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 1 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** No raw string interpolation in innerHTML for user-controlled/API-returned data.

---

## Reliability Engineer

**Recommendation:** Add ingress path prefix to `SettingsLabels` and `SettingsAgentTokens` fetch calls

`SettingsLabels` uses bare `/api/labels` and `/api/labels/${id}` URLs. `SettingsAgentTokens` uses bare `/api/agent-tokens`. Behind HA ingress, `Layout.astro` monkey-patches `window.fetch` to auto-prefix, BUT the fetch wrapper per AGENTS.md is fragile. `SettingsAgents` correctly uses `(window.__ingress_path || "")` prefix. The other two components should follow the same pattern for defense-in-depth.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 1 |
| Risk | 2 |
| **Decision** | **Accept** |

**Success criterion:** All settings fetch calls use `(window.__ingress_path || "")` prefix consistently.

---

## Security Engineer

**Recommendation:** Clear plaintext token from DOM memory after "Done" is clicked in `SettingsAgentTokens`

Line 456 sets `plaintextEl.textContent = ""` when Done is clicked — good. But the plaintext token in `data.token` (line 430) may persist in JavaScript closure memory. Explicitly null the reference and call `plaintextEl.removeAttribute("data-token")` etc. Also add `autocomplete="off"` and `data-lpignore="true"` to the token name input to prevent password managers from caching.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 1 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Token name input has `autocomplete="off"`, plaintext token reference explicitly cleared.

---

## Product Architect

**Recommendation:** Add loading and error states to `SettingsLabels` and `SettingsAgentTokens` list rendering

Both components show "Loading labels..." / "No agent tokens yet" but have no error state if the API fails. `SettingsLabels.loadLabels()` silently fails with `catch { /* offline */ }`. `SettingsAgentTokens.loadTokens()` silently fails with `catch { // Silently fail }`. Users get permanent "Loading..." with no indication of failure.

**Fix:** Show a retry-able error state with a "Retry" button when fetch fails.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 2 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Failed API calls show error state with retry button, not permanent loading spinner.
