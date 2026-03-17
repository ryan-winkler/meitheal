# Research Synthesis — Settings Page v0.2.26

## Key Findings

1. **Pill toggle pattern already exists** in `SettingsRules.astro` (L94-110). Reuse for Strategic Lenses to unify UX.
2. **IntersectionObserver** is already used for section tracking (`initIntersectionTracking`). Extend for go-to-top sentinel.
3. **CSS architecture is healthy**: `:global()` scoping, CSS variables, `color-mix()` used consistently.
4. **No accessibility regressions** from tab bar implementation — but ARIA tablist pattern is missing (critical gap).
5. **Mobile optimization** is the biggest gap — no icon-only tabs, no safe-area handling.

## Risk Assessment

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Pill toggle JS breaks lens persistence | Medium | Test with `settings-store.ts` save/load cycle |
| ARIA tablist changes break scrollspy | Low | Test `aria-selected` updates with IntersectionObserver |
| `env(safe-area-inset-bottom)` unsupported | Low | Fallback `0px` already in calc |
| Icon-only tabs lose context | Medium | Tooltip with label, test with HA Companion |

## Recommended Execution Order

1. **Wave 1** (CSS-only) — Zero JS risk, pure visual Polish
2. **Wave 2** (Accessibility + IntersectionObserver) — Core behavior improvements
3. **Wave 3** (Strategic Lenses pill toggles) — Largest change, needs careful testing
4. **Wave 4** (Mobile/responsive) — Final optimization pass

## Success Criteria

- [ ] All CSS-only fixes applied with `prefers-reduced-motion` gates
- [ ] FAB uses IntersectionObserver, no scroll listener
- [ ] Tab bar has `role="tablist"` with arrow key navigation
- [ ] Strategic Lenses uses pill toggles matching Rules & Lenses
- [ ] Icon-only tabs at ≤480px
- [ ] Build passes, Tier 1 visual verification passes
