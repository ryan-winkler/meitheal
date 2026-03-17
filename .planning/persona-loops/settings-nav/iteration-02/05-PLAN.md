# Execution Plan — Settings Page v0.2.26 Hardening

## Wave 1: CSS-Only Fixes (Zero JS Risk)

### 1.1 FAB Dark Mode Glow
- File: `settings.astro` — `.settings-go-top` box-shadow
- Add accent glow ring + darker shadow

### 1.2 FAB `will-change` + safe area
- File: `settings.astro` — `.settings-go-top`
- Add `will-change: transform, opacity`
- Change `bottom: 28px` to `bottom: calc(28px + env(safe-area-inset-bottom, 0px))`

### 1.3 Tab Hover Micro-Animation
- File: `settings.astro` — `:global(.settings-tab:hover)`
- Add `transform: translateY(-1px)` with reduced-motion gate

### 1.4 CLS Prevention — Status Chips
- File: `settings.astro` — `:global(.settings-tab__status)`
- Add `min-width: 40px`

### 1.5 Spacing Normalization
- File: `settings.astro` — grid minmax fix `min(360px, 100%)`
- File: Various cards — normalize internal padding

### 1.6 Color-Mix CSS Custom Properties
- File: `settings.astro` — extract repeated `color-mix()` into `--accent-12`, `--accent-50-border`

## Wave 2: Accessibility + IntersectionObserver

### 2.1 ARIA Tablist Pattern
- File: `SettingsSummaryCard.astro` — add `role="tab"`, `aria-selected`
- File: `settings.astro` — add `role="tablist"` on container
- File: `settings-shell-controller.ts` — arrow key handler

### 2.2 IntersectionObserver for Go-to-Top
- File: `settings-shell-controller.ts` — replace scroll listener with sentinel IO

### 2.3 Active Tab Scroll Into View
- File: `settings-shell-controller.ts` — `scrollIntoView({ inline: "center" })` on init

### 2.4 Search → Tab Sync
- File: `settings-shell-controller.ts` — call `updateActiveSectionState()` after search navigation

### 2.5 Deep-Link Landing Flash
- File: `settings-shell-controller.ts` — add temporary highlight on target section

## Wave 3: Strategic Lenses Pill Toggles (Deferred)
- This is the largest change and should be a separate atomic commit
- Replace `<select multiple>` with pill-toggle buttons matching `SettingsRules.astro`
- Update JS to read `data-selected` / `aria-pressed` instead of `.selectedOptions`

## Wave 4: Mobile/Responsive (Deferred)
- Icon-only tabs at ≤480px
- Tablet breakpoint testing

## Execution Rules
- Each wave is an atomic commit
- Build must pass after each wave
- Visual verification after Wave 1 and Wave 2
- Wave 3-4 deferred if time-constrained
