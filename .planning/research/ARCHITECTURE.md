# Architecture Patterns: Settings Navigation Layout

**Domain:** Settings page navigation within HA add-on (Astro SSR, ingress iframe)  
**Researched:** 2026-03-17

## Reference Architecture: Zendesk Unified Navigation (GA Apr 2026)

Source: [Zendesk Unified Navigation EAP](https://support.zendesk.com/hc/en-us/articles/9562911580570)

### Layout Hierarchy

```
┌────────────────────────────────────────────────────────────┐
│ [Icon] ← Sidebar (expanded: 240px, collapsed: 48px)       │
│  bar   │  Search field (consistent, top-of-page)           │
│        │                                                    │
│  nav   │  [Tab bar / section navigation]                    │
│  icons │                                                    │
│        │  Content area                                      │
│        │                                                    │
│  ──    │                                                    │
│  [«]   │                                                    │ ← expand/collapse at bottom
└────────────────────────────────────────────────────────────┘
```

### Key Patterns from Zendesk

| Pattern | Zendesk Implementation | Meitheal Mapping |
|---------|----------------------|------------------|
| **Sidebar states** | Two states: icons-only (~48px) and expanded (~240px+labels) | Match exactly — collapsed=48px icons, expanded=240px |
| **Toggle location** | Built-in expand/collapse at bottom of nav panel | Move `.sidebar-toggle` to sidebar bottom |
| **Toggle shortcut** | `Ctrl+]` expand, `Ctrl+[` collapse | Add alongside existing `Ctrl+B` |
| **Icon tooltips** | All icons have tooltip on hover in collapsed mode | Add `title` attributes to `.nav-link` icons |
| **Search field** | Consistent top-of-page location, never covered | TopNavigation search must never be occluded |
| **Tab overflow** | Overflow options menu (⋯) for ticket tabs | Dynamic overflow for settings tabs |
| **Second-level nav** | Clicking icon shows sub-nav, not hidden in dropdowns | Settings sections already use hash nav |

### Component Boundaries

| Component | Responsibility | DOM Selector |
|-----------|---------------|-------------|
| **Sidebar** | Icon/label nav, collapse toggle | `.sidebar` |
| **TopNavigation** | Global search, action buttons | `.topbar` |
| **Tab bar** | Settings section quick-jump tabs | `#quick-jumps-surface` |
| **Overflow menu** | Hidden tabs dropdown | `.settings-overflow-dropdown` (new) |
| **Content area** | Settings sections | `.settings-shell__content` |

### Data Flow

```
User resizes viewport / toggles sidebar
  → ResizeObserver OR MutationObserver fires
    → recalculate available tab width
      → tabs[0..N] visible, tabs[N+1..] overflow
        → "More" button shows/hides
          → dropdown populates with hidden tabs
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Fixed z-index arms race
**What:** Layering z-index 100 over z-index 40 sidebar
**Why bad:** Creates unpredictable stacking, maintenance nightmare
**Instead:** Use z-index scale: sidebar=40, topbar=30, tab-bar=35, overflow=50

### Anti-Pattern 2: Sidebar slides fully off-screen
**What:** Current `transform: translateX(-100%)` hides sidebar completely
**Why bad:** Loses spatial anchor, no icon affordance for re-expansion
**Instead:** Collapse to icon-only mode (48px width), maintain icon visibility

### Anti-Pattern 3: Hover-only toggle discoverability
**What:** Toggle only appears on hover (`opacity: 0→0.7`)
**Why bad:** Touch users, keyboard users, screen reader users can't discover it
**Instead:** Persistent visible toggle at sidebar bottom (Zendesk pattern)

### Anti-Pattern 4: Hidden scrollbar for tab overflow
**What:** `scrollbar-width: none` with gradient mask
**Why bad:** Users don't know more tabs exist, features become invisible
**Instead:** Dynamic overflow with visible "More" button

## Sources

- [Zendesk Unified Navigation EAP](https://support.zendesk.com/hc/en-us/articles/9562911580570) — HIGH confidence
- User-provided screenshots (5 images) — PRIMARY reference
- Web research: sidebar patterns 2025 — MEDIUM confidence
- Web research: ResizeObserver overflow tabs — HIGH confidence
