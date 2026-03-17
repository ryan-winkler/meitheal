---
phase: settings-nav-fix
plan: 01
type: implementation
autonomous: true
wave: 1
---

# Settings Nav — Zendesk-Style Redesign

## Objective

Replace the broken overflow tab bar with a Zendesk-inspired navigation pattern:
1. **Section switcher dropdown** — always visible, shows current section + icon dropdown of all sections (like Zendesk's "Support ∨" nav)
2. **Expandable inline search** — 🔍 icon in the nav bar that expands into a search input (like Zendesk's top-right search)
3. **Visible tabs** that fit in available space, with remaining sections accessible via the section switcher
4. **Section reordering** — Personal Settings first in the content flow
5. **Card relocation** — Help & Support card moved from App & PWA to be the 3rd visible card (in Personal section)

## Context

- @apps/web/src/pages/settings.astro — Page structure: hero, tab bar, content sections
- @apps/web/src/lib/settings-shell-controller.ts — Tab overflow, search, sticky bar, section navigation
- @apps/web/src/lib/settings-registry.ts — Section definitions array (controls tab/section order)
- @apps/web/src/components/settings/SettingsSummaryCard.astro — Tab `<a>` elements
- @apps/web/src/components/settings/SettingsSystem.astro — Personal, App & PWA, Danger Zone sections

Current bugs:
- "More" dropdown click delegates to `originalTab.click()` which scrolls to wrong section or doesn't open
- Tab overflow measurement loop causes layout instability

Zendesk reference (from user screenshots):
- Top bar: `[Support ∨]` dropdown always visible | visible tabs | `[🔍]` expandable search
- The dropdown shows ALL sections with icons in a clean flyout menu
- Search expands from icon → full input field, with filters and recent items

## Tasks

### Task 1: Reorder SETTINGS_SECTIONS in registry
type="auto"

**What:** Move `personal-settings` to index 0 in the `SETTINGS_SECTIONS` array in `settings-registry.ts`. This controls all downstream tab/section rendering order.

**Done when:** `SETTINGS_SECTIONS[0].id === "personal-settings"` and build passes.

### Task 2: Reorder content sections in settings.astro
type="auto"

**What:**
- In `settings.astro`, move the `<SettingsSystem>` component BEFORE the workflow-settings section so Personal Settings appears first in the content flow
- The section order in `.settings-shell__content` should be: Personal → Workflow → Rules & Lenses → Integrations → Automation & AI → App & PWA → Danger Zone

**Done when:** The section DOM order matches the tab order from Task 1 and build passes.

### Task 3: Move Help & Support card to Personal section
type="auto"

**What:** In `SettingsSystem.astro`, extract the "Help & Support" `<SettingsPanelCard>` from the `app-pwa-settings` section and place it as the 3rd card in the `personal-settings` section (after Language & Appearance, after Keyboard Shortcuts).

**Done when:** Help & Support card renders inside `#personal-settings` section, not `#app-pwa-settings`, and build passes.

### Task 4: Replace tab bar with Zendesk-style nav
type="auto"

**What:** Redesign `settings-shell__summary` from a row of tab cards to a Zendesk-style nav bar:

**Left side:** Active section dropdown trigger — `[🎨 Personal ∨]`
- Click → flyout dropdown showing ALL sections with icon + label + status badge
- Clicking a section navigates to it (calls `scrollToAnchor`)
- Active section highlighted in dropdown

**Right side:** Expandable search icon — `[🔍]`
- Click → search input expands (slides left) with animated transition
- Input uses the same `searchSettingsRegistry` logic
- Results dropdown appears below the input
- Click outside or Esc collapses back to icon
- Keyboard shortcut `/` opens search

**Middle:** Visible tab pills for sections that fit (space-adaptive, same as before but without the broken "More" button)

**Implementation:**
1. Remove `initOverflowTabs()` entirely — replace with the new Zendesk-style components
2. Update `settings-shell__summary` HTML: section switcher (left) + visible tabs (middle, flex-grow) + search trigger (right)
3. New `initSectionSwitcher()` function — handles the section dropdown
4. New `initNavSearch()` function — handles expandable search in the nav bar
5. Move search from hero section to the nav bar
6. Keep `initStickyTabBar()` — it still makes the nav bar fixed when scrolling

**Done when:** Section switcher dropdown opens/closes correctly, clicking items navigates to sections, search expands/collapses, search results work, keyboard nav works, and build passes.

### Task 5: Update hero section (remove search, simplify)
type="auto"

**What:** Remove the search input from the hero section since it's now in the nav bar. Simplify the hero to just title + description.

**Done when:** Hero section has no search input, hero is visually clean, and build passes.

### Task 6: CSS polish and responsive behavior
type="auto"

**What:**
- Section switcher dropdown: glassmorphic backdrop, smooth animation, proper z-index
- Expandable search: smooth width transition, focus ring, proper dropdown positioning
- On mobile (<480px): hide middle tabs, show only section switcher + search icon
- On tablet: show 3-4 tabs + switcher + search
- `prefers-reduced-motion`: disable transitions
- Ensure nav bar works correctly behind HA ingress (no position:sticky — use JS fixed positioning)

**Done when:** Responsive at all breakpoints, motion-safe, ingress-compatible, and build passes.

### Task 7: Verify and commit
type="auto"

**What:**
- `pnpm --filter @meitheal/web build` — must pass
- `pnpm check` — must pass
- Visual verification via dev server at localhost:4321/settings
- Commit with proper message

**Done when:** Build passes, typecheck passes, committed.

## Verification

- `pnpm --filter @meitheal/web build`
- `pnpm check`
- Visual: section switcher opens and navigates correctly
- Visual: search expands and collapses
- Visual: Personal section is first
- Visual: Help & Support card is 3rd card in Personal
- Keyboard: `/` opens search, `Esc` closes, Arrow keys navigate dropdown

## Success Criteria

- No "More" overflow bugs — the section switcher handles all sections cleanly
- Search is integrated into the persistent nav bar (not buried in the hero)
- Section order: Personal → Workflow → Rules → Integrations → Automation → App/PWA → Danger Zone
- Help & Support is visible early (3rd card in Personal)
- Works behind HA ingress (no position:sticky, JS fixed positioning preserved)
