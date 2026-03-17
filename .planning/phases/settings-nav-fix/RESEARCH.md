# Research: Settings Nav Fix

**Phase Goal:** Fix sticky tab bar layout, responsive overflow, and sidebar toggle UX

## Research Sources

| Source | Key Finding |
|--------|-------------|
| 50-persona audit (01-50-persona-audit.md) | 7/7 Critical on I1+I2+I3, 4/6 Medium on I4 |
| Web research: overflow tabs patterns | Dynamic measurement + "More" dropdown is de facto standard (Atlassian, Chrome DevTools, iOS) |
| Web research: sidebar collapse | Zendesk/Linear/GitLab use persistent chevron arrow, not hover-reveal |
| Codebase audit | `initStickyTabBar()` in `settings-shell-controller.ts` lines 408-494 |

## Problem Decomposition

### Problem 1: Tab bar position (I1 + I2)

**Root Cause:** `position: fixed; top: 0; left: 0; z-index: 100` places tab bar in viewport coordinates, ignoring sidebar (fixed, z-40, 240px) and topbar (sticky top-0, z-30).

**Fix:** Already partially implemented — `applyFixedPosition()` now measures topbar height and sidebar width. The fix was committed but needs verification. Verified the logic:
- `left: sidebarOffset` ✅ (from `getSidebarOffset()`)
- `top: topbar.getBoundingClientRect().bottom` ✅ (from topbar measurement)
- `z-index: 100` → Should be lower; z-35 between topbar(30) and sidebar(40)

**Remaining:** Lower z-index to 35 (below sidebar-40, above content).

### Problem 2: Tab overflow (I3) — "Danger Zone falls off"

**Root Cause:** 7 tabs in a `display:flex; overflow-x:auto` container with hidden scrollbar. No visual affordance, no collapse. Tabs simply scroll off the right edge.

**User Request:** "When I cover 'Danger Zone' it should go into a dropdown dynamically and come out when it can be visually on the screen." This is the **dynamic overflow** pattern.

**Algorithm (from research + best practice):**
1. On mount + resize + sidebar toggle: measure the tab container's available width
2. Measure each tab button's width (including gap)
3. Determine how many fit; the rest go into an overflow dropdown
4. Show a "⋯ More" button only when tabs overflow
5. When viewport widens, tabs re-emerge from dropdown into the visible bar
6. Active tab should always be visible (swap with last visible if needed)

**Implementation approach:**
- New function `initOverflowTabs()` in `settings-shell-controller.ts`
- "More" button renders as last item in flex container
- Dropdown uses `position: absolute; right: 0` relative to tab surface
- ARIA: `aria-expanded`, `aria-controls`, `role="menu"` with `role="menuitem"` children
- Keyboard: Enter/Space opens, Escape closes, arrow keys navigate

### Problem 3: Sidebar toggle (I4) — Zendesk-style

**Root Cause:** Current `.sidebar-toggle` is a 24×48px pill that only appears on hover (`opacity: 0` → `0.7`). Touch users, keyboard users, and anyone not hovering near the edge never sees it.

**User Request:** "Look at Zendesk's menu expand/minimize. The little arrow is all we need there."

**Fix:**
- Make toggle always visible (remove `opacity: 0` default)
- Reduce size to a small `«` / `»` chevron 
- Position at the sidebar edge (bottom-center or mid-height)
- On collapsed: show `»` flush left; on expanded: show `«` at sidebar edge
- Always-visible opacity (0.5 default, 1.0 on hover)
- Keyboard accessible (already focusable as a button)

## Implementation Order

1. **Fix z-index** — trivial, change z-100 to z-35 in `applyFixedPosition()`
2. **Dynamic overflow tabs** — the main work, ~100 lines of JS
3. **Sidebar toggle** — CSS changes + minor JS for icon swap

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Tab overflow calculation wrong at boundary | Add 16px buffer for safety margin |
| Active tab in overflow menu | Swap active tab to last visible position |
| Ingress iframe breaks getBoundingClientRect | Already tested via IntersectionObserver pattern — same API |
| ResizeObserver not available | Use `window.resize` event (already in use) |
| "More" dropdown covers content | Use z-index higher than tab bar, position absolute |
