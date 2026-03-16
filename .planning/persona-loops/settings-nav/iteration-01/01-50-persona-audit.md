# 50-Persona Audit — Settings Navigation Overhaul

**Objective:** Audit the removal of the sidebar directory, introduction of sticky horizontal tab bar, go-to-top FAB, and full-width content layout.

**Scope:** `settings.astro`, `SettingsSummaryCard.astro`, `settings-shell-controller.ts`

---

## Panel 1: Frontier Experts (5 personas)

### 1. Platform Architect
**Recommendation:** The empty `<section id="personal-settings">` anchor in `settings.astro` is misleading — it has no content of its own; `SettingsSystem.astro` renders the actual personal-settings section. Either remove the duplicate anchor or merge them so scroll-margin targets the correct DOM node.
- Impact: 4 | Effort: 2 | Risk: 3
- **Decision: ACCEPT** — Duplicate anchors break IntersectionObserver tracking

### 2. OSS Integrations Specialist
**Recommendation:** The go-to-top FAB uses `window.scrollY` which works in standard browsers but may behave differently inside HA ingress iframe where the scrolling container isn't `window`. Verify that scroll events fire correctly inside the HA Companion WebView and ingress iframe.
- Impact: 5 | Effort: 2 | Risk: 4
- **Decision: ACCEPT** — Critical for HA ingress compatibility

### 3. Reliability Engineer
**Recommendation:** `initGoToTop()` uses `pageLifecycle.on(window, "scroll", ...)` without debouncing/throttling. On long settings pages, this fires hundreds of times per scroll gesture. Use `requestAnimationFrame` or `IntersectionObserver` for the threshold check instead.
- Impact: 3 | Effort: 2 | Risk: 2
- **Decision: ACCEPT** — `passive: true` helps, but RAF is better practice

### 4. Security Engineer
**Recommendation:** No new attack surface introduced. The FAB uses `history.replaceState` with same-origin path only. Tab links are all hash-based (`#section-id`). No XSS vectors. Pass.
- Impact: 1 | Effort: 0 | Risk: 1
- **Decision: REJECT** — No action needed

### 5. Product Architect
**Recommendation:** The tab bar labels use `section.label` which is the full section name (e.g. "Workflow & Task Defaults"). On narrow viewports, these truncate awkwardly. Add `section.shortLabel` or use icon-only mode below 640px.
- Impact: 4 | Effort: 3 | Risk: 2
- **Decision: ACCEPT** — Critical for mobile HA Companion

---

## Panel 2: ADHD/Productivity Specialists (5 personas)

### 6. Workflow Coach
**Recommendation:** Users arriving at `/settings` with no hash see the tab bar but no section is highlighted. Set a default active tab (e.g. `personal-settings`) so new visitors have clear orientation.
- Impact: 5 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — First-visit orientation is critical for ADHD users

### 7. Execution Coach
**Recommendation:** The `Home` key shortcut for go-to-top is non-obvious. Add it to the keyboard shortcuts section in `SettingsSystem.astro` so it's discoverable.
- Impact: 3 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — KCS: document as you go

### 8. Knowledge Coach
**Recommendation:** The go-to-top button tooltip says "Back to top (Home key)" which is good self-documentation. Also add `aria-keyshortcuts="Home"` for screen readers.
- Impact: 3 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Accessibility best practice

### 9. Focus Optimizer
**Recommendation:** The tab bar scrolls horizontally on mobile but has no visual scroll affordance (gradient fade, arrow, or scrollbar hint). Users may not realize there are more tabs off-screen.
- Impact: 4 | Effort: 2 | Risk: 1
- **Decision: ACCEPT** — Discoverability is key

### 10. Automation Coach
**Recommendation:** The `syncSummaryStatuses` function runs on page load but not on hashchange. When a user clicks a tab, the status chips should update immediately, not require a refresh.
- Impact: 3 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Already handled by existing code flow

---

## Panel 3: UX/Design Specialists (10 personas)

### 11. Mobile UX Designer
**Recommendation:** On 320px viewport, the tab bar pills are too wide (18px padding + icon + label). Switch to icon-only mode below 480px with label as tooltip.
- Impact: 4 | Effort: 3 | Risk: 2
- **Decision: ACCEPT** — HA Companion on phone is a primary use case

### 12. Interaction Designer
**Recommendation:** Active tab needs stronger visual differentiation. Current accent border-bottom is subtle. Add a filled background with `color-mix(in srgb, var(--accent) 15%, var(--bg-card))` for the active state.
- Impact: 4 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — User explicitly requested tabs look "highlighted/pressed"

### 13. Motion Designer
**Recommendation:** The go-to-top FAB entrance animation (translateY + opacity) is good. Add `will-change: transform, opacity` for GPU acceleration on low-end devices.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Trivial, improves Android perf

### 14. Dark Mode Specialist
**Recommendation:** The go-to-top FAB box-shadow uses `rgba(0,0,0,0.2)` which disappears on dark backgrounds. Use a combination of dark shadow + subtle accent glow for dark mode visibility.
- Impact: 3 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Default theme is dark

### 15. Responsive Design Lead
**Recommendation:** Tab bar `overflow-x: auto` shows a native scrollbar on some browsers (Firefox, Windows Chrome). Add `scrollbar-width: none` and `-webkit-scrollbar { display: none }` for a cleaner look.
- Impact: 3 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Already standard practice

### 16. Touch Input Specialist
**Recommendation:** Tab bar items need minimum 44px touch target height per WCAG 2.5.8. Current compact pills may be < 36px. Ensure `min-height: 44px` or add padding to meet target.
- Impact: 4 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Accessibility requirement

### 17. Color System Designer
**Recommendation:** Active tab uses `var(--accent)` directly for border but the contrast ratio against `var(--bg-card)` may be insufficient for WCAG AA. Test with color contrast tools.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: DEFER** — Audit in next pass

### 18. Typography Specialist
**Recommendation:** Tab labels use 12px font-size which is at the minimum readable threshold. On high-DPI displays this is fine, but consider 13px for better legibility across devices.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Low effort, high polish

### 19. Loading State Designer
**Recommendation:** When the page loads, the tab bar appears but status chips show stale data until JS hydrates. Add a brief `opacity: 0` → `opacity: 1` transition on the status chips to mask the flash.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: DEFER** — Minor polish

### 20. Whitespace/Layout Specialist
**Recommendation:** Content sections now span full width, which on large monitors (1440px+) creates very wide text lines. Cap content at `max-width: 1200px` with `margin: 0 auto` for optimal reading experience.
- Impact: 5 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Critical readability improvement

---

## Panel 4: Accessibility & Inclusion (5 personas)

### 21. Screen Reader QA
**Recommendation:** Tab bar should use `role="tablist"` and each tab should use `role="tab"` + `aria-selected` + `aria-controls` for proper ARIA tab pattern. Currently they're plain `<a>` links.
- Impact: 5 | Effort: 3 | Risk: 2
- **Decision: ACCEPT** — Accessibility pattern required

### 22. Keyboard Navigation QA
**Recommendation:** ARIA tab pattern requires arrow-key navigation between tabs (`ArrowLeft`/`ArrowRight`). Current implementation only supports click and hash navigation.
- Impact: 4 | Effort: 3 | Risk: 2
- **Decision: DEFER** — Significant scope, do in follow-up

### 23. Low Vision QA
**Recommendation:** go-to-top FAB at 42x42px with 18px font is borderline for low-vision users. The `↑` character is small. Use a proper SVG arrow icon for better scaling.
- Impact: 3 | Effort: 2 | Risk: 1
- **Decision: DEFER** — Icon system enhancement, not blocking

### 24. Motor Impairment QA
**Recommendation:** Tab bar horizontal scroll requires fine motor control on touch devices. Add large previous/next navigation arrows at edges for users who can't swipe precisely.
- Impact: 3 | Effort: 4 | Risk: 2
- **Decision: REJECT** — Effort too high for impact

### 25. Cognitive Load QA
**Recommendation:** 7 tabs is at the upper limit of Miller's Law (7±2). Current count is good. Ensure no future additions push beyond 9 without grouping.
- Impact: 2 | Effort: 0 | Risk: 1
- **Decision: ACCEPT** — Document as constraint in settings-registry

---

## Panel 5: HA Integration Specialists (5 personas)

### 26. HA Ingress Specialist
**Recommendation:** Verify that `window.scrollTo()` in the go-to-top handler actually scrolls the correct container behind ingress. HA embeds the addon in an iframe — `window.scrollTo` scrolls the iframe's document, not the parent. This should work correctly since the settings page IS the iframe document.
- Impact: 5 | Effort: 1 | Risk: 3
- **Decision: ACCEPT** — Must verify in Tier 2

### 27. HA Companion App Specialist
**Recommendation:** Companion app on iOS uses WKWebView which has different scroll behavior. The `scroll-behavior: smooth` CSS property works but `window.scrollTo({ behavior: "smooth" })` may not. Add fallback with `scrollTop = 0` for unsupported browsers.
- Impact: 3 | Effort: 1 | Risk: 2
- **Decision: ACCEPT** — Good defensive coding

### 28. HA Sidebar Panel Specialist
**Recommendation:** Settings is accessible both via the HA sidebar panel and via ingress. The tab bar `position: sticky` needs to account for both contexts — sidebar panels have different top offsets than ingress iframes.
- Impact: 4 | Effort: 2 | Risk: 3
- **Decision: ACCEPT** — Critical for dual-context navigation

### 29. HA WebSocket Specialist
**Recommendation:** No WebSocket changes in this PR. The HA connection status chip in the tab bar still works via the existing `syncSummaryStatuses` flow. Pass.
- Impact: 1 | Effort: 0 | Risk: 1
- **Decision: REJECT** — No action needed

### 30. HA Add-on Lifecycle Specialist
**Recommendation:** No add-on lifecycle changes. Settings page renders client-side only. Pass.
- Impact: 1 | Effort: 0 | Risk: 1
- **Decision: REJECT** — No action needed

---

## Panel 6: Performance & Runtime (5 personas)

### 31. Bundle Size Analyst
**Recommendation:** Removing `SettingsShellNav` and `SettingsCallout` imports from `settings.astro` reduces the component tree. Verify that unused components are tree-shaken from the bundle.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Verify with build output

### 32. First Paint Optimizer
**Recommendation:** The sticky tab bar is above the fold and renders server-side. Good. The go-to-top FAB is hidden by default. No LCP impact.
- Impact: 1 | Effort: 0 | Risk: 1
- **Decision: REJECT** — No action needed

### 33. Scroll Performance Engineer
**Recommendation:** `initGoToTop` adds a scroll listener to `window`. While marked `passive: true`, it still fires at 60fps on scroll. Use `IntersectionObserver` on a sentinel element at 400px instead.
- Impact: 3 | Effort: 2 | Risk: 1
- **Decision: ACCEPT** — Better practice (echoes #3)

### 34. Memory Leak Hunter
**Recommendation:** `pageLifecycle.on()` is used consistently for all event listeners, which provides automatic cleanup. No leak risk. Pass.
- Impact: 1 | Effort: 0 | Risk: 1
- **Decision: REJECT** — No action needed

### 35. CSS Paint Optimizer
**Recommendation:** `color-mix()` in CSS is recalculated on every repaint. For static elements like the FAB, this is fine. For hover states on rapidly-scrolled elements, consider pre-computed values.
- Impact: 1 | Effort: 2 | Risk: 1
- **Decision: REJECT** — Impact too low

---

## Panel 7: Cross-Browser & Device (5 personas)

### 36. Firefox QA
**Recommendation:** Firefox renders a visible scrollbar for `overflow-x: auto`. Add `scrollbar-width: none` to `.settings-shell__summary`.
- Impact: 3 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Same as #15

### 37. Safari/WebKit QA
**Recommendation:** Safari position:sticky inside overflow containers has known bugs. The tab bar uses `position: sticky; top: 0` which should work since the parent is the main scroll container, not a nested overflow.
- Impact: 3 | Effort: 1 | Risk: 2
- **Decision: ACCEPT** — Verify visually in Safari

### 38. Chrome Android QA
**Recommendation:** Chrome on Android hides the address bar on scroll, changing `100vh`. The go-to-top FAB uses `position: fixed; bottom: 28px` which is relative to the viewport — this is correct and handles address bar hide/show automatically.
- Impact: 1 | Effort: 0 | Risk: 1
- **Decision: REJECT** — No action needed

### 39. PWA Standalone QA
**Recommendation:** In PWA standalone mode, there's no address bar. The FAB's `bottom: 28px` is correct. Verify the tab bar sticky top works without a browser chrome offset.
- Impact: 2 | Effort: 1 | Risk: 2
- **Decision: ACCEPT** — Quick visual check

### 40. Screen Size Edge Case QA
**Recommendation:** At exactly 768px breakpoint, the media query switches `settings-grid` to single column. Test that the tab bar doesn't overflow or compress at this exact width.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Standard breakpoint testing

---

## Panel 8: Information Architecture (5 personas)

### 41. Navigation Pattern Expert
**Recommendation:** The tab bar is a horizontal nav but the page is a vertical scroll. This is a "scrollspy" pattern, not true tabs. Consider adding visual feedback as the user scrolls — highlight the tab corresponding to the visible section.
- Impact: 5 | Effort: 3 | Risk: 2
- **Decision: ACCEPT** — Already partially implemented via `initIntersectionTracking()`

### 42. URL Strategy Expert
**Recommendation:** Hash-based URLs (`#personal-settings`) are ingress-safe and bookmark-friendly. The go-to-top clearing the hash via `history.replaceState` is correct — it prevents back-button issues.
- Impact: 1 | Effort: 0 | Risk: 1
- **Decision: REJECT** — Already correct

### 43. Search Integration Expert
**Recommendation:** Settings search results should scroll to and highlight the matching section. With the new layout, verify that `scrollToAnchor()` accounts for the new sticky tab bar height (smaller than before).
- Impact: 4 | Effort: 1 | Risk: 2
- **Decision: ACCEPT** — `scroll-margin-top: 64px` is set, verify it's enough

### 44. Content Hierarchy Expert
**Recommendation:** Each section has a `SettingsSectionIntro` with the section name, but the tab already shows the same name. This is double labeling. Consider making section intros more descriptive or smaller, since the tab bar already provides wayfinding.
- Impact: 3 | Effort: 2 | Risk: 2
- **Decision: DEFER** — Content audit for next iteration

### 45. Deep Link Expert
**Recommendation:** Companion handoff links use `data-companion-link` + `data-companion-xcallback` attributes. These still work since the section IDs haven't changed. Verify x-callback URLs still resolve correctly.
- Impact: 3 | Effort: 1 | Risk: 2
- **Decision: ACCEPT** — Quick verification

---

## Panel 9: Code Quality (3 personas)

### 46. TypeScript Strictness Reviewer
**Recommendation:** `initGoToTop()` casts `event as KeyboardEvent` manually. Use a typed event listener: `pageLifecycle.on<KeyboardEvent>(document, "keydown", ...)` if the API supports generics.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: DEFER** — Low priority, existing pattern

### 47. CSS Architecture Reviewer
**Recommendation:** The new `.settings-go-top` styles are in `settings.astro` scoped style block, which is correct. However, the `is-visible` class toggle pattern should be consistent with other FAB patterns in the app.
- Impact: 2 | Effort: 1 | Risk: 1
- **Decision: ACCEPT** — Check for consistency

### 48. Test Coverage Reviewer
**Recommendation:** E2E test `settings.spec.ts` likely tests for sidebar navigation elements that no longer exist. Update selectors to target the new tab bar.
- Impact: 5 | Effort: 2 | Risk: 3
- **Decision: ACCEPT** — Critical: broken tests block CI

---

## Panel 10: Domain-Specific (2 personas)

### 49. Settings UX Benchmarker
**Recommendation:** Compare against VS Code Settings, Firefox `about:preferences`, and Chrome `chrome://settings`. All three use a sidebar for persistent navigation on wide screens. Without a sidebar, Meitheal's navigation relies entirely on the tab bar + scroll. This is fine for 7 sections but degraded for discovery — consider adding subsection anchors within each section.
- Impact: 3 | Effort: 3 | Risk: 2
- **Decision: DEFER** — Good for next iteration

### 50. Ryan Winkler (User Proxy)
**Recommendation:** "I want this to feel like a premium, polished app that works flawlessly inside HA. The tab bar must be clearly highlighted when active, scrolling must be smooth, and the go-to-top button should be subtle but always accessible. No janky scrollbars, no wonky breakpoints."
- Impact: 5 | Effort: 2 | Risk: 1
- **Decision: ACCEPT** — Core user requirement

---

## Summary

| Category | Accept | Defer | Reject |
|----------|--------|-------|--------|
| Frontier Experts | 3 | 0 | 1 |
| ADHD/Productivity | 5 | 0 | 0 |
| UX/Design | 7 | 2 | 0 |
| Accessibility | 2 | 2 | 1 |
| HA Integration | 3 | 0 | 2 |
| Performance | 2 | 0 | 3 |
| Cross-Browser | 3 | 0 | 2 |
| Info Architecture | 2 | 1 | 1 |
| Code Quality | 1 | 2 | 0 |
| Domain-Specific | 1 | 1 | 0 |
| **Total** | **29** | **8** | **10** |

## Priority Actions (Accept, grouped by urgency)

### P0 — Must fix before merge
1. **#1** Remove duplicate `personal-settings` anchor from `settings.astro` (already in `SettingsSystem.astro`)
2. **#2** Verify go-to-top works inside HA ingress iframe (#26)
3. **#6** Set default active tab on first visit
4. **#48** Update E2E test selectors for new tab bar
5. **#20** Add `max-width: 1200px` to content for readability

### P1 — Important polish
6. **#12** Stronger active tab visual (filled background)
7. **#15/#36** Hide scrollbar on tab bar (`scrollbar-width: none`)
8. **#16** Ensure 44px touch targets on tabs
9. **#9** Add scroll affordance indicator for tab overflow
10. **#7** Add Home key to keyboard shortcuts docs

### P2 — Follow-up iteration
11. **#5** Short labels / icon-only mode on narrow viewports
12. **#11** Icon-only tabs at 480px
13. **#21** ARIA tablist pattern
14. **#41** Scrollspy highlighting on intersection
15. **#27** Smooth scroll fallback for WKWebView
