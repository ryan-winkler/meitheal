# Settings Navigation — Phase Research

**Produced by:** GSD Phase Researcher
**Domain:** Settings Navigation Overhaul
**Date:** 2026-03-16

---

## Research Question

How should we implement the 29 accepted recommendations from the 50-persona audit while maintaining Astro-first, HA-native architecture and ingress compatibility?

---

## Stack Analysis

### Current Implementation
- **Tab bar**: `settings.astro` renders `SettingsSummaryCard` tabs in a horizontal scrollable strip
- **Content**: Full-width sections below the tab bar, each with `data-settings-shell-section`
- **Controller**: `settings-shell-controller.ts` manages hash-based navigation, IntersectionObserver tracking
- **Go-to-top**: FAB with `position: fixed`, controlled by scroll listener

### Patterns Used
- Astro scoped CSS with `:global()` for child component styling
- `pageLifecycle` for memory-safe event listeners
- Hash-based routing for ingress compatibility
- IntersectionObserver for section tracking

---

## P0 Findings & Approach

### 1. Duplicate `personal-settings` anchor (#1)
**Finding:** `settings.astro` has an empty `<section id="personal-settings">` and `SettingsSystem.astro` has the actual section with that same ID. When the browser resolves `#personal-settings`, it finds the first (empty) one.
**Approach:** Remove the empty section from `settings.astro`. The `SettingsSystem.astro` section will be the sole anchor.

### 2. Ingress scroll compatibility (#2, #26)
**Finding:** HA ingress embeds the add-on in an `<iframe>`. `window.scrollTo()` inside the iframe scrolls the iframe's document, which is correct behavior. The FAB's scroll listener (`window.scrollY`) also reads the iframe's scroll position. This should work correctly without changes.
**Approach:** Verify in Tier 2 devcontainer. No code changes expected.

### 3. Default active tab (#6)
**Finding:** When no hash is present, `syncActiveSectionFromHash()` produces no active state. The first tab should be highlighted by default.
**Approach:** In `initSettingsShell()`, when no hash is present, call `updateActiveSectionState("personal-settings")` to highlight the first tab. Also add a subtle scroll to top as reinforcement.

### 4. E2E test updates (#48)
**Finding:** Need to check `settings.spec.ts` for selectors referencing removed elements.
**Approach:** Grep for sidebar/mobile-nav selectors and update to target `.settings-tab` or `.settings-shell__summary` classes.

### 5. Content max-width (#20)
**Finding:** On wide screens (1440px+), text lines exceed comfortable reading width.
**Approach:** Add `max-width: 1200px; margin: 0 auto;` to `.settings-shell__content`.

---

## P1 Findings & Approach

### 6. Active tab visual (#12)
**Finding:** User explicitly requested "highlighted/pressed" feel for active tabs.
**Approach:** Enhance `:global(.settings-tab.is-active)` with a filled accent background, bolder border, and optional inset shadow.

### 7. Tab scrollbar hidden (#15, #36)
**Finding:** Firefox shows a visible horizontal scrollbar.
**Approach:** Add `scrollbar-width: none` and `::-webkit-scrollbar { display: none }` to `.settings-shell__summary`.

### 8. Touch targets (#16)
**Finding:** WCAG 2.5.8 minimum touch target is 44x44px.
**Approach:** Ensure `.settings-tab` has `min-height: 40px` (with padding, total will exceed 44px).

### 9. Scroll affordance (#9)
**Finding:** Users on mobile may not know the tab bar scrolls.
**Approach:** Add a gradient fade-out on the right edge of the tab bar when scrollable.

### 10. Keyboard shortcut docs (#7, #8)
**Finding:** Home key shortcut not documented, missing `aria-keyshortcuts`.
**Approach:** Add `aria-keyshortcuts="Home"` to FAB button. Add "Home" shortcut row to keyboard shortcuts grid.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| IntersectionObserver conflicts with sticky tab bar | `scroll-margin-top: 64px` already accounts for tab height |
| Tab bar `overflow-x: auto` clips sticky children | Tab bar parent uses `overflow: visible`, no clip |
| `color-mix()` not supported in older browsers | HA min browser versions support it (Chrome 111+, Firefox 113+) |
| Hash routing race conditions on page load | Existing `requestAnimationFrame` + `setTimeout(200)` handles race |

---

## RESEARCH COMPLETE

**Recommendation:** Proceed to GSD Planner to create executable PLAN.md from these findings.
