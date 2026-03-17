# Feature Landscape: Settings Navigation

**Domain:** Settings page navigation in HA add-on  
**Researched:** 2026-03-17

## Table Stakes

Features users expect. Missing = product feels broken.

| Feature | Why Expected | Complexity | Status |
|---------|--------------|------------|--------|
| Tab bar doesn't cover sidebar | Basic spatial integrity | Low | 🔴 Broken |
| Tab bar doesn't cover search | Global chrome never occluded | Low | 🔴 Broken |
| All tabs reachable | Discoverability — users need to find features | Medium | 🔴 Broken |
| Sidebar toggle discoverable | Users must be able to collapse/expand | Low | 🟡 Poor UX |
| Keyboard tab navigation | WCAG compliance, power user efficiency | Low | ✅ Done |

## Differentiators

Features that elevate UX beyond basic expectations.

| Feature | Value Proposition | Complexity | Priority |
|---------|-------------------|------------|----------|
| Dynamic overflow "More" menu | Tabs flow in/out of dropdown as viewport resizes | Medium | P0 |
| Icon-only sidebar collapse | Zendesk pattern — keeps nav visible at 48px | Medium | P1 |
| Sidebar tooltip on collapsed | Icons get tooltip labels when text hidden | Low | P1 |
| Active tab always visible | Active tab swaps to visible area if in overflow | Medium | P0 |
| Overflow keyboard navigation | Arrow keys in dropdown, Escape to close | Low | P0 |
| Persist sidebar state | localStorage saves expanded/collapsed preference | Low | P1 |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Horizontal scroll with hidden scrollbar | Invisible features, no affordance | Dynamic overflow dropdown |
| Full off-screen sidebar slide | Loses spatial context, no icon anchor | Icon-only collapse (48px) |
| Hover-only toggle visibility | Inaccessible on touch/keyboard | Persistent visible toggle |
| Tab wrapping (multi-row) | Eats vertical space, looks broken | Single-row with overflow |

## Feature Dependencies

```
Icon-only sidebar → requires tooltip on collapsed icons
Dynamic overflow → requires ResizeObserver + tab width measurement
Active tab visible → requires overflow tab swap logic
Persist sidebar → requires localStorage read on init
```

## MVP Recommendation

**P0 (this fix):**
1. Tab bar position offsets (sidebar left, topbar top) — already partially done
2. Dynamic overflow tabs with "More" dropdown
3. Lower z-index to proper scale (35, not 100)

**P1 (follow-up):**
4. Icon-only sidebar collapse (Zendesk pattern)
5. Persistent sidebar toggle at bottom
6. Sidebar state persistence (localStorage)

## Sources

- Zendesk Unified Navigation EAP article (2026)
- 50-persona panel audit
- User screenshots and feedback
