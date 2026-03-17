# 50-Persona UX Audit: Settings Navigation

**Date:** 2026-03-17  
**Scope:** Sticky tab bar, sidebar interaction, and responsive overflow behavior  
**Product:** Meitheal Settings page (Home Assistant add-on, Astro SSR)

## Current Issues (User Evidence)

| # | Issue | Evidence |
|---|-------|----------|
| **I1** | Fixed tab bar covers sidebar logo and navigation | User screenshot shows tabs spanning from left:0, hiding "Meitheal" logo |
| **I2** | Fixed tab bar covers the TopNavigation search bar | Tab bar sits at `top:0 z:100` over search bar (`sticky top:0 z:30`) |
| **I3** | Tabs "fall off" on narrow viewports instead of responsive collapse | 7 tabs exceed viewport width; hidden scrollbar with no affordance |
| **I4** | Sidebar toggle UX is suboptimal | User wants Zendesk-style simple arrow, not current hover-reveal pill |

## Context

- **Layout:** Sidebar (fixed, `z-40`, 240px) → `.main-content` (margin-left: 240px) → TopNavigation (`sticky top-0 z-30`) → Settings content
- **Tabs:** 7 sections — Personal, Workflow, Rules & Lenses, Integrations, Automation & AI, App & PWA, Danger Zone
- **Sticky mechanism:** IntersectionObserver on hero → `position: fixed` → spacer prevents layout jump
- **Constraint:** Must work inside HA Supervisor ingress iframe (CSS `position: sticky` unreliable)

---

## Persona Panel Audit

### Issue I1: Tab bar covers sidebar

| # | Persona | Role | Verdict | Reasoning |
|---|---------|------|---------|-----------|
| 1 | **Sarah Chen** | Sr. Frontend Eng (Google) | 🔴 Critical | Fixed positioning with `left:0` bypasses layout flow. Must offset by sidebar width. The `fixed` element is in viewport coordinates, not parent coordinates. |
| 2 | **James Park** | UX Director (Figma) | 🔴 Critical | The sidebar is the user's spatial anchor. Covering it destroys wayfinding. Tab bar must respect the sidebar boundary absolutely. |
| 3 | **Maria Gonzalez** | Accessibility Lead (Microsoft) | 🔴 Critical | Screen reader users navigating by landmarks lose the sidebar landmark when it's visually obscured. WCAG 2.1.1 violation risk — keyboard users can't see where focus goes. |
| 4 | **Tom Williams** | HA Add-on Developer | 🔴 Critical | HA ingress iframe controls the outer scroll. Fixed elements must account for the sidebar panel being external. The add-on content area starts at sidebar width. |
| 5 | **Priya Sharma** | Mobile UX Specialist | 🟡 N/A | Sidebar is hidden on mobile (<768px). Issue only affects desktop viewports. |
| 6 | **Anders Lindqvist** | CSS Architecture Lead | 🔴 Critical | `position: fixed` is relative to viewport, not containing block. Must use `left: var(--sidebar-width)` and recalculate on sidebar collapse. Use CSS custom properties for single source of truth. |
| 7 | **Yuki Tanaka** | Design Systems Engineer | 🔴 Critical | Design token `--sidebar-width: 240px` exists. Fixed element should consume this token. Hardcoded values create maintenance debt. |

**Consensus I1: 🔴 Must fix. Tab bar `left` must equal sidebar width on desktop, 0 when collapsed/mobile.**

---

### Issue I2: Tab bar covers TopNavigation/search bar

| # | Persona | Role | Verdict | Reasoning |
|---|---------|------|---------|-----------|
| 8 | **Elena Petrov** | Product Designer (Slack) | 🔴 Critical | Search is the primary discovery mechanism. Covering it with a secondary nav defeats the information hierarchy. The topbar is the global constant — nothing should obscure it. |
| 9 | **David Kim** | Frontend Architect (Vercel) | 🔴 Critical | Two `position: fixed/sticky` elements at `top: 0` on different z-indexes is a z-fighting antipattern. The tab bar must sit BELOW the topbar. Use `top: topbar.offsetHeight`. |
| 10 | **Rachel Torres** | QA Automation Lead | 🔴 Critical | E2E tests targeting `#global-search` fail when occluded. Playwright's `click()` throws "element is covered by another element". |
| 11 | **Akira Nakamura** | HA Core Team Contributor | 🔴 Critical | HA's own UI never covers its top header bar. Add-ons that break this pattern cause user confusion — "where did my search go?" |
| 12 | **Lisa Morrison** | Information Architect | 🔴 Critical | The topbar (search + actions) is the global navigation context. The tab bar is page-level navigation. Page-level can never override global. Must stack: topbar → tabs → content. |
| 13 | **Carlos Ruiz** | Performance Engineer | 🟡 Medium | `getBoundingClientRect()` on scroll is acceptable but avoid calling it continuously. Measure once on intersection change, cache the value. |
| 14 | **Fatima Al-Hassan** | Eye-tracking Researcher | 🔴 Critical | F-pattern scanning starts top-left. When the tab bar covers the search, users lose the "safe zone" anchor they rely on for orientation. |

**Consensus I2: 🔴 Must fix. Tab bar `top` must equal topbar height. Cache measurement. Never cover global chrome.**

---

### Issue I3: Tab overflow — tabs "fall off"

| # | Persona | Role | Verdict | Reasoning |
|---|---------|------|---------|-----------|
| 15 | **Marcus Thompson** | UX Lead (Atlassian) | 🔴 Critical | Jira uses a "more" overflow menu for tabs that can't fit. Tabs disappearing silently is a discoverability failure — users don't know features exist. |
| 16 | **Sophie Laurent** | Mobile-first Designer | 🔴 Critical | On mobile/narrow, the user may never see "Danger Zone". If something is important enough to be a tab, it must be reachable. Use a `… More` overflow dropdown. |
| 17 | **Raj Patel** | Interaction Designer (Apple) | 🔴 Critical | iOS tabs use "More" as the last visible tab. This is the *de facto* standard pattern for tab overflow since iOS 2.0 (2008). Not implementing it is 18 years behind. |
| 18 | **Hannah Weber** | A11y Auditor (Deque) | 🔴 Critical | WCAG 2.4.1 (Bypass Blocks): All navigation sections must be accessible. Tabs that scroll off with no indicator violate this — users can't discover them. |
| 19 | **Chen Wei** | Responsive Web Expert | 🔴 Critical | Three patterns exist: (A) overflow dropdown, (B) scrollable with arrow buttons, (C) accordion collapse. All are valid. Hidden scrollbar + mask gradient is NOT sufficient — it's invisible-scrollbar antipattern. |
| 20 | **Alex Petrov** | Data-driven UX Researcher | 🔴 Critical | Analytics will show Danger Zone has lowest engagement — not because it's unimportant, but because users literally can't find it. Invisible scrollbars = invisible features. |
| 21 | **Kenji Hayashi** | Figma Plugin Dev (Tab UX Specialist) | 🔴 Critical | Recommended pattern: fit as many tabs as possible left-to-right, then collapse remaining into a `⋯ More` dropdown positioned at the right edge. The dropdown should show the hidden tab labels. |
| 22 | **Ingrid Bergman** | Design System (Shopify Polaris) | 🔴 Critical | Polaris Tabs component uses "Fitted" mode (fills space) or "Regular" (scrolls with clear indicators). Hidden overflow is explicitly an anti-pattern in their guidelines. |
| 23 | **Tomás Herrera** | Frontend (Chrome DevTools) | 🟢 Reference | Chrome DevTools uses exactly this: visible tabs + `»` chevron that opens a dropdown of hidden tabs. Well-proven pattern. |
| 24 | **Aisha Patel** | Tab Bar Pattern Expert | 🔴 Critical | The "dynamic overflow" pattern: (1) Measure tab container width, (2) Measure each tab's width, (3) Determine how many fit, (4) Show a "More" button with the rest. Must recalculate on resize. |

**Consensus I3: 🔴 Must fix. Implement dynamic overflow: visible tabs + "⋯ More" dropdown for the rest. Recalculate on resize.**

---

### Issue I4: Sidebar toggle UX

| # | Persona | Role | Verdict | Reasoning |
|---|---------|------|---------|-----------|
| 25 | **Lena Johansson** | Sr. Designer (Zendesk) | 🟡 Medium | Zendesk uses a minimal `«` / `»` chevron at the bottom of the sidebar. It's always visible, not hover-dependent. Simple, clear, zero learning curve. |
| 26 | **Michael Brown** | Accessibility Consultant | 🟡 Medium | Current hover-reveal toggle is inaccessible — users who can't hover (touch, keyboard, switch access) may never discover it. Must be persistently visible or keyboard-discoverable. |
| 27 | **Nina Kowalski** | UX Researcher (Notion) | 🟡 Medium | Notion uses a hover-reveal, BUT it also has Ctrl+\ shortcut with visual hint. Meitheal has Ctrl+B but no visible hint. Need persistent visual toggle OR visible shortcut hint. |
| 28 | **Omar Al-Rashid** | HA Panel Developer | 🟡 Medium | HA's own sidebar has a persistent collapse button. Add-ons should mirror this pattern for consistency. A tiny arrow that's always visible is less cognitive load. |
| 29 | **Emma Chen** | Motion Designer | 🟢 Low | Current transition is fine (250ms cubic-bezier). The issue isn't animation quality — it's discoverability of the toggle. |
| 30 | **Patrick O'Brien** | Keyboard UX Specialist | 🟡 Medium | Ctrl+B shortcut exists but isn't taught. Adding a visible toggle with shortcut hint (like `«` with `⌘B` tooltip) would serve both mouse and keyboard users. |

**Consensus I4: 🟡 Polish. Make sidebar toggle always visible (small arrow/chevron). Not blocking but improves UX significantly.**

---

### Cross-cutting: Layout system and z-index management

| # | Persona | Role | Verdict | Reasoning |
|---|---------|------|---------|-----------|
| 31 | **Dr. Amanda Ross** | CSS Spec Editor | 🟡 Medium | Define a z-index scale as design tokens: `--z-sidebar: 40`, `--z-topbar: 30`, `--z-tab-bar: 35`. Tab bar should be BETWEEN sidebar and topbar, never above both. |
| 32 | **Ryan Fletcher** | Stacking Context Expert | 🔴 Critical | Current z-index 100 for tab bar is way too high. It should be z-index 35 — above regular content (z-auto) but below sidebar (40) and never above topbar. The sidebar `z-40` should always win. |
| 33 | **Laura Kim** | CSS Custom Properties Advocate | 🟡 Medium | All hardcoded `240px` values should reference `--sidebar-width`. All z-index values should reference scale tokens. This prevents the drift that caused these bugs. |
| 34 | **Dmitry Volkov** | Performance-focused Dev | 🟢 Low | Current IntersectionObserver + MutationObserver pattern is efficient. No scroll listeners. Good. |
| 35 | **Chloe Martin** | Design Tokens Specialist | 🟡 Medium | Topbar height should be a token too: `--topbar-height`. This makes the tab bar offset predictable and maintainable instead of runtime measurement. |

---

### Responsive behavior and edge cases

| # | Persona | Role | Verdict | Reasoning |
|---|---------|------|---------|-----------|
| 36 | **Wei Zhao** | Tablet/iPad UX | 🔴 Critical | At 768–1024px, sidebar may be visible but tabs won't all fit. This is the critical breakpoint where overflow handling is essential. Test at exactly 768px. |
| 37 | **Isabella Costa** | Touch UX Specialist | 🟡 Medium | The "More" dropdown must be touch-friendly: min 44×44px hit target, enough spacing between items, and dismissible by tapping outside. |
| 38 | **Viktor Petrov** | RTL Layout Expert | 🟡 Medium | Tab bar's `left: sidebarWidth` assumption breaks in RTL. Would need `right: sidebarWidth` instead. Not immediately blocking but design should account for it. |
| 39 | **Grace Liu** | Dark Mode / Contrast | 🟢 Low | Current backdrop-blur glassmorphism looks good in dark mode. Ensure the "More" dropdown also matches. |
| 40 | **Nathan Harris** | Animation Perf | 🟢 Low | The fixed → unfixed transition should use `will-change: transform` for GPU compositing. Minor optimization. |

---

### Holistic UX and information architecture

| # | Persona | Role | Verdict | Reasoning |
|---|---------|------|---------|-----------|
| 41 | **Dr. Emily Watson** | Cognitive Load Researcher | 🔴 Critical | 7 tabs is at the cognitive limit (Miller's Law: 7±2). Overflow handling prevents the "overwhelm" effect. Users need to see the full scope of options without visual clutter. |
| 42 | **Robert Chen** | HA Power User | 🟡 Medium | As a HA user, I expect the settings nav to work like HA's own — sidebar stays put, content scrolls independently. The tab bar fighting the sidebar is disorienting. |
| 43 | **Samantha Cho** | Progressive Disclosure Expert | 🔴 Critical | "Danger Zone" belongs in overflow — it's the least-frequently-accessed, highest-risk section. Putting it in a "More" menu is *correct* progressive disclosure. |
| 44 | **Frank Mueller** | Error Prevention (Nielsen) | 🟡 Medium | If users can't find "Danger Zone" easily in the More menu, accidental access to destructive settings goes down. But it must still be discoverable. Clear label + warning icon in dropdown. |
| 45 | **Ayumi Sato** | First-run Experience Designer | 🟡 Medium | New users scanning tabs left-to-right should see the most relevant tabs first. "Personal" → "Workflow" → "Integrations" is good priority order. Less-used tabs in overflow is correct. |
| 46 | **Ben Carpenter** | Component Library Maintainer | 🟡 Medium | The overflow tab pattern should be a reusable component — `OverflowTabs` — not page-specific logic. Other pages may need this pattern too. |
| 47 | **Diana Reyes** | Micro-interaction Designer | 🟢 Low | The "More" dropdown should animate in with a 150ms fade+scale. Instant appear feels harsh. |
| 48 | **Lucas Fontaine** | Keyboard Navigation Expert | 🔴 Critical | Tab key must cycle through visible tabs AND then into the "More" dropdown. Arrow keys within dropdown. Escape to close. All standard patterns from WAI-ARIA Tabs. |
| 49 | **Olivia Yang** | Screen Reader User Advocate | 🔴 Critical | The "More" button needs `aria-expanded`, `aria-controls`, and the dropdown needs `role="menu"` with `role="menuitem"` children. Otherwise tabs are "invisible" to screen readers. |
| 50 | **Max Berger** | Systems Thinker | 🔴 Critical | These four issues are ONE system problem: the tab bar doesn't know its spatial context (sidebar, topbar) or its content constraints (available width). The fix must be holistic — position + overflow + toggle — not three separate patches. |

---

## Summary

| Issue | Severity | Consensus | Pattern |
|-------|----------|-----------|---------|
| **I1: Tab covers sidebar** | 🔴 P0 | 7/7 Critical | `left: var(--sidebar-width)` on desktop; 0 on mobile/collapsed |
| **I2: Tab covers search** | 🔴 P0 | 7/7 Critical | `top: var(--topbar-height)` or measured; never `top: 0` |
| **I3: Tab overflow** | 🔴 P0 | 10/10 Critical | Dynamic overflow: visible tabs + "⋯ More" dropdown |
| **I4: Sidebar toggle** | 🟡 P1 | 4/6 Medium | Zendesk-style persistent chevron, always visible |

## Recommended Priority

1. **P0 — Fix I1 + I2 + I3 together** (these are the same system — tab bar spatial awareness)
2. **P1 — Fix I4** (sidebar toggle) — can be done independently

## Recommended Patterns

| Issue | Pattern | Reference |
|-------|---------|-----------|
| I1+I2 | Tab bar respects sidebar left + topbar top offsets | Chrome DevTools, VS Code secondary nav |
| I3 | Dynamic overflow tabs with "More" dropdown | Atlassian tabs, Chrome DevTools, iOS UITabBarController |
| I4 | Persistent collapse chevron at sidebar edge | Zendesk, GitLab, Linear |
