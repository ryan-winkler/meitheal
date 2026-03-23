# Phase 27: Accessibility, Logging Hygiene & Style Adoption — Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

## Phase Boundary

Phase 27 addresses three cross-cutting quality gaps identified by codebase scan after Phase 26 completion:

1. **Accessibility**: 10 components with interactive elements (buttons, inputs, selects) missing `aria-label` or `aria-labelledby` attributes
2. **Console.log hygiene**: 25 raw `console.*` calls in TypeScript/Astro modules that bypass the structured `createClientLogger` system
3. **Settings style adoption**: 144 inline styles remaining across 4 settings components that can now adopt the `settings-utilities.css` classes created in Phase 26

## Implementation Decisions

### Accessibility
- Add `aria-label` to all interactive elements in flagged components
- Focus on buttons, inputs, selects — not decorative elements
- Follow existing patterns in SettingsGeneral.astro which already has good coverage

### Console.log Migration
- Replace `console.log/warn/error/debug` with `createClientLogger` calls
- Preserve `is:inline` script console calls (they can't import modules)
- Follow existing pattern: `const log = createClientLogger("domain", "component")`

### Settings Style Adoption
- Apply `settings-utilities.css` classes to remaining 4 components
- Same approach as SettingsGeneral.astro: replace template-side inline styles
- Leave `is:inline` JS `makeEl()` calls as-is (can't use CSS classes from import)

### Claude's Discretion
- Order of wave execution (all three are independent)
- Specific aria-label text choices
- Which console calls to keep vs. migrate in edge cases

## Deferred Ideas

- Error boundary components (needs design discussion)
- Loading skeleton system (needs design system tokens)
- i18n expansion (separate track)

---

*Phase: 27-accessibility-logging-style-adoption*
*Context gathered: 2026-03-23*
