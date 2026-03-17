# Domain Pitfalls: Settings Navigation

**Domain:** Settings page navigation in HA add-on (ingress iframe)  
**Researched:** 2026-03-17

## Critical Pitfalls

### Pitfall 1: position:fixed ignores CSS layout flow
**What goes wrong:** Fixed elements use viewport coordinates, not parent. Tab bar at `left:0` covers sidebar.
**Why it happens:** Developers forget fixed positioning bypasses document flow.
**Consequences:** Sidebar logo/nav occluded, search bar covered.
**Prevention:** Always offset fixed elements by sidebar width and topbar height. Use CSS custom properties.
**Detection:** Visual testing at multiple viewport widths with sidebar expanded/collapsed.

### Pitfall 2: z-index escalation without a scale
**What goes wrong:** z-index 100 on tab bar > z-index 40 on sidebar, covering everything.
**Why it happens:** Ad-hoc z-index values without a defined scale.
**Consequences:** Stacking context fights, unpredictable layering.
**Prevention:** Define scale: `--z-topbar: 30, --z-tab-bar: 35, --z-sidebar: 40, --z-overflow: 50, --z-modal: 1000`.
**Detection:** Code review — any z-index not from the scale is a bug.

### Pitfall 3: Tab overflow invisible on narrow viewports
**What goes wrong:** Tabs that don't fit silently scroll off with hidden scrollbar. Users never discover them.
**Why it happens:** `scrollbar-width: none` hides affordance. Gradient mask provides minimal hint.
**Consequences:** Features like "Danger Zone" become undiscoverable. Support tickets increase.
**Prevention:** Implement dynamic overflow with visible "More" button.
**Detection:** Viewport width testing at 768px, 1024px — all tabs must be reachable.

## Moderate Pitfalls

### Pitfall 4: HA ingress breaks CSS position:sticky
**What goes wrong:** CSS `position: sticky` doesn't work reliably inside HA ingress iframe.
**Prevention:** Use IntersectionObserver + position:fixed fallback (already implemented).

### Pitfall 5: Sidebar collapse removes spatial anchor
**What goes wrong:** Fully hiding sidebar (`translateX(-100%)`) disorients users — they lose the nav landmark.
**Prevention:** Collapse to icon-only (48px) instead of fully off-screen. Zendesk pattern.

### Pitfall 6: ResizeObserver measurement timing
**What goes wrong:** Measuring tab widths during CSS transitions gives wrong values.
**Prevention:** Debounce measurement by 100ms or use `requestAnimationFrame`. Measure after transition completes.

## Minor Pitfalls

### Pitfall 7: RTL layout breaks fixed left offset
**What goes wrong:** `left: sidebarWidth` assumes LTR layout.
**Prevention:** Use `inset-inline-start` instead of `left` for RTL support (future consideration).

### Pitfall 8: Dropdown dismiss on scroll
**What goes wrong:** User scrolls while overflow dropdown is open — dropdown stays fixed while content moves.
**Prevention:** Close dropdown on scroll event. Add scroll listener when dropdown opens.

## Phase-Specific Warnings

| Phase | Likely Pitfall | Mitigation |
|-------|---------------|------------|
| Tab position fix | Fixed elements ignore layout | Offset by sidebar + topbar |
| Overflow tabs | Measurement during transitions | Debounce + rAF |
| Sidebar icon-only | Mobile breakpoint conflicts | Test at 768px boundary |
| Dropdown ARIA | Focus management | Auto-focus first item, escape to close |

## Sources

- Codebase audit (settings-shell-controller.ts, _layout.css)
- 50-persona panel audit
- Web research: CSS position:fixed gotchas
- Zendesk unified navigation patterns
