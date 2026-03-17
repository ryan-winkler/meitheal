# Phase Research — Settings Page v0.2.26 Hardening

## Stack Analysis

### Framework
- **Astro SSR** with `@astrojs/node` adapter
- **Scoped CSS** via Astro `<style>` blocks with `:global()` for cross-component overrides
- **Client scripts** imported via `@lib/` path alias, bootstrapped through `settings-page.ts` → `pageLifecycle`
- **No frontend framework** — vanilla DOM manipulation with `pageLifecycle.on()` for cleanup

### Existing Patterns

| Pattern | Usage | Location |
|---------|-------|----------|
| Pill toggle buttons | Framework assignment in Rules & Lenses | `SettingsRules.astro` L94-110 |
| `pageLifecycle.on()` | All event listeners, auto-cleanup on page unload | `settings-shell-controller.ts` |
| `SettingsPanelCard` | Card wrapper with title/subtitle/actions | Shared component |
| `SettingsDisclosure` | `<details>/<summary>` progressive disclosure | AI Scope, Framework Config |
| Tab bar with `:global(.settings-tab)` | Summary/nav tabs | `settings.astro` L368-436 |
| `IntersectionObserver` | Section tracking for active tab | `settings-shell-controller.ts` |
| `scrollToAnchor()` | Hash navigation with smooth scroll | `settings-shell-controller.ts` L18 |
| Toast system | Success/error feedback | `@lib/toast` |

### Key Constraints
1. **HA Ingress**: Hash-only navigation, no `apiUrl()` wrapping for fetch (monkey-patched), `position: sticky` works because page IS the iframe document
2. **`pageLifecycle`**: All DOM listeners MUST use this for cleanup — no raw `addEventListener`
3. **No semicolons, double quotes, 2-space indent**: Coding conventions
4. **Named exports only**: No default exports
5. **44px touch targets**: WCAG 2.5.8 minimum

### Codebase Stats
| File | Lines | Notes |
|------|-------|-------|
| `settings.astro` | 678 | Page shell, CSS, Go-to-top FAB |
| `SettingsGeneral.astro` | 1594 | Largest component, mixed domains |
| `SettingsRules.astro` | 513 | Rules + Framework config, pill toggles |
| `settings-shell-controller.ts` | 495 | Tab logic, search, scroll, FAB |
| `settings-registry.ts` | 386 | Sections, fields, search index |

## Pitfalls

1. **`<select multiple>` → pill toggle migration**: Strategic Lenses JS reads `.selectedOptions` from native selects. Pill toggles use `aria-pressed` buttons. Need to update all JS that reads/writes lens selections.
2. **Inline styles in SettingsGeneral.astro**: ~100+ inline `style=""` attrs. Cannot be extracted in one go without breaking layout. Extract _only_ the Strategic Lenses popup styles this iteration.
3. **IntersectionObserver rootMargin**: Current `rootMargin: "-20% 0px -75% 0px"` in controller may not correctly highlight sections when tab bar height changes with wrap.
4. **Safe area insets**: Need `viewport-fit=cover` in `<meta>` tag AND `env(safe-area-inset-bottom)` on FAB. Verify meta tag exists in Layout.astro.
5. **ARIA tablist**: Changing `<a>` to `role="tab"` requires keyboard handler, focus management, and `aria-selected` state. Must be atomic to avoid partial a11y regression.

## Implementation Strategy

### Wave 1: CSS-only fixes (no JS changes)
- FAB dark mode glow
- `will-change` on FAB
- Tab hover micro-animation
- CLS prevention (min-width status chips)
- `env(safe-area-inset-bottom)` on FAB
- Grid minmax responsive fix
- Hero visual weight reduction
- Spacing/padding normalization

### Wave 2: JS + Accessibility
- IntersectionObserver for go-to-top (replaces scroll listener)
- ARIA tablist + tab roles
- Arrow key navigation
- Active tab scroll into view
- Search → tab sync
- Deep-link landing flash
- Popup auto-close on hash change

### Wave 3: Strategic Lenses UX
- Replace `<select multiple>` with pill toggles (match Rules pattern)
- Update JS to read `aria-pressed` instead of `.selectedOptions`
- Touch target sizing on Manage Frameworks link

### Wave 4: Mobile + Cross-browser
- Icon-only tabs at ≤480px
- Status chip contrast check
- Color-mix CSS custom properties
- Reduced motion gates on new animations
