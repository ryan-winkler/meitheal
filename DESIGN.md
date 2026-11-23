# DESIGN.md — Meitheal Design Engineering Constitution & Taste Ledger

This file is the canonical design-engineering specification and `learn-taste` ledger for Meitheal. Every UI change must obey these rules before merging.

## 1. Visual System & Tabler Craft

- **Tabler First**: Use official Tabler patterns, tokens, and icons (`apps/web/src/generated/icon-registry.ts`, `https://preview.tabler.io/`). Prefer Tabler `form-imagecheck` visual vector tiles (`96×64` inline `<svg>` driven by live CSS custom properties) and `form-colorinput` rounded-square swatches over generic `<select>` dropdowns for visual preferences.
- **Self-Hosted Local Typefaces**: Render all typography locally (`Geist Variable`, `Outfit`, `JetBrains Mono`, `Comic Neue`, and local serif stack) with zero external font network calls. Form controls (`button`, `input`, `select`, `textarea`) must inherit the active typeface.
- **Theme-Aware Identity & Contrast**: Never hardcode static accent or avatar colors. The default profile avatar tracks `var(--accent)` dynamically and adapts on colored (`navTone="accent"`) and dark surfaces. Every personal accent computes WCAG AA (`>= 4.8:1`) dark and light foreground/text tokens (`--accent-text`, `--border-focus`).
- **Home Assistant Native**: Keep Home Assistant theme matching (`matchHaTheme`), HA ingress prefix safety, and local-first speed as primary constraints.

## 2. Gestalt Principles (Non-Negotiable)

- **Law of Common Region & Hierarchy**: Peer setting domains (such as *Theme & Accent*, *Navigation Layout & Hover Behavior*, and *Typography & Surface Style*) must sit at the **same top-level card hierarchy** (`SettingsPanelCard`). Never nest a peer top-level capability inside a secondary disclosure box under another card.
- **Law of Proximity & Unified Rhythm**: Maintain intentional, consistent spacing across all sections:
  - `20px` vertical gap between top-level cards (`look-feel-stack` / `settings-grid`).
  - `20px` internal padding on `SettingsPanelCard` bodies and `20px` vertical rhythm between field groups.
  - Never let adjacent bordered containers touch edge-to-edge (`0px` gap).
- **Law of Similarity**: Peer actions in the same header or toolbar (for example, *Customize menu* and *Shortcuts & links*) must share the same button weight and visual treatment (`.btn.btn-secondary.btn-sm` with Tabler icons), never one styled button paired with bare text.
- **Law of Figure-Ground**: Floating popovers, docked menu editors, and sub-view dropdowns (`#nav-utility-popover`, `#tasks-nav-submenu`, docked Top Nav edit sheet) must sit on elevated `var(--bg-card)` surfaces with crisp `1px solid var(--border)` separation and high `z-index` (`240–260`) so they never clip behind sticky bars or page headers.

## 3. Nielsen's 10 Usability Heuristics

1. **Visibility of System Status**: Appearance changes preview live with an explicit unsaved-changes bar (`#appearance-dirty-bar`); async saves show loading state and clear confirmation toasts.
2. **Match Between System & Real World**: Use household-friendly labels (*Navigation*, *Quick add*, *Task form*) rather than implementation jargon (*sidebar* when in top navigation mode).
3. **User Control & Freedom**: Users can hide or show any navigation item — including *Settings* — because *Settings* remains permanently reachable in the global Keyboard utility menu (`#nav-utility-popover`). Every preview supports Discard and Reset.
4. **Consistency & Standards**: One trigger, one mental model. Clicking the Profile card directly opens *Edit Profile*; clicking the Keyboard utility button on the right opens *Navigation, Shortcuts & Settings*. Never duplicate the same menu across two adjacent triggers.
5. **Error Prevention**: Validate URLs (`https://`, `http://`, or `/`), colors, and profile inputs cleanly before saving. Guard mobile drawers and hover sidebars against accidental collapse while Menu Edit Mode is active.
6. **Recognition Rather Than Recall**: Use visual SVG layout tiles, `Aa` font previews, inline shortcut keycaps (`?`), and contextual `?` help popups instead of abstract option names.
7. **Flexibility & Efficiency of Use**: Support customizable keyboard shortcuts, live Menu Edit Mode across every navigation mode (Sidebar Expanded/Folded/Hover, Top Nav `nav-overflow`, and Mobile), and direct Task sub-view pinning (`Calendar`, `Kanban`, `Timeline`, `Table`) in both Sidebar and Top Navigation.
8. **Aesthetic & Minimalist Design**: Keep controls purposeful and free of duplicate popovers, telemetry clutter, or unused chrome.
9. **Help Users Recognize, Diagnose, and Recover from Errors**: Inline `role="alert"` validation messages with actionable next steps; zero raw stack traces or silent failures.
10. **Help & Documentation**: Contextual `?` buttons on complex settings and direct links to KCS guides (including the Plugin Development Guide).

## 4. Interaction Engineering (`emil-design-eng`)

- **Animation Decision Framework**: Animate only when motion clarifies spatial cause-and-effect (popover entry, sidebar expand/collapse, active press feedback). High-frequency repeated actions (typing, toggling checkboxes, switching dense views) stay instant or sub-160ms.
- **Custom Easing & Tactile Press States**:
  - Use crisp ease-out curves (`cubic-bezier(0.23, 1, 0.32, 1)`) for entrances and transitions — never sluggish `ease-in` or bouncy `scale(0)` pops.
  - Interactive cards and icon triggers use subtle tactile press feedback (`transform: scale(0.97–0.98)` on `:active`).
  - Popovers animate from their actual anchor origin (`transform-origin: top right` below top-nav triggers, `bottom left` beside sidebar triggers) starting from `scale(0.96)` + subtle `4px` offset over `140ms`.
- **Reduced Motion**: Every animated rule must have a `@media (prefers-reduced-motion: reduce)` override disabling transitions and transforms.
- **Before / After / Why Reviews**: Record significant UI design changes in terms of *Before*, *After*, and *Why* so taste compounds over time.

## 5. User Mastery (`Badass: Making Users Awesome` — Kathy Sierra)

- Optimize for making the user awesome at running their household, not for showing off app settings.
- Put high-frequency workflows (*New task opens: Quick add vs Task form*) directly under *Tasks & Boards* where users expect them, not buried only in one-time setup.
- Reduce cognitive friction on first interaction: visual tiles show what a layout does before clicking; pinning `Kanban` or `Calendar` takes one click in both Sidebar and Top Nav.

## 6. `learn-taste` Ledger (Distilled Session Corrections)

| Area | Before (Mistake) | After (Rule) | Why |
|------|------------------|--------------|-----|
| Navigation footer menus | Profile card had a 3-dot popover duplicating Edit Menu & Look & Feel next to a separate Keyboard menu on its left. | Profile card opens Edit Profile directly (zero 3-dots); Keyboard utility button sits on the **right** and owns Edit Menu, Add Link, Shortcuts, Settings, Look & Feel, and Tour. | Eliminates redundant menus (Nielsen #4/#8) and establishes one clear trigger per intent. |
| Settings visibility safety | Locking Settings permanently in the nav bar or hiding it without a fallback. | Allow hiding/showing *Settings* in Edit Mode & Settings while keeping *Settings* always present in the Keyboard utility popover. | User freedom without lockout risk (Nielsen #3/#5). |
| Look & Feel card hierarchy | *Navigation Layout* and *Customize Appearance* were nested disclosures touching each other with `0px` gap inside *Theme & Accent*. | Three equal peer `SettingsPanelCard` sections separated by unified `20px` spacing. | Gestalt Law of Common Region & Proximity; equal capabilities deserve equal hierarchy. |
| Visual preference controls | `<select>` dropdowns or hand-drawn CSS boxes for layout and radius options. | Tabler `ThemeSettings.astro` `96×64` vector SVG tiles + rounded-square color swatches + local `Aa` font cards. | Recognition over recall (Nielsen #6) and authentic Tabler craft. |
| Top Nav sub-views | `Tasks ▾` submenu used `position: absolute` inside the top bar, clipping or failing to pin `Kanban`/`Calendar` cleanly. | Fixed viewport-anchored popover (`z-index: 260`) + full inline editing of task views in Top Nav Edit Mode. | Parity across Sidebar, Top Nav (`nav-overflow`), and Mobile. |
| Task capture mode discoverability | *New task opens (Quick add vs Task form)* existed only inside `/setup` Advanced Setup. | Exposed in *Settings -> Tasks & Boards* backed by the same `workspace-preferences` store (DRY). | Settings belong in their DDD domain section so users can tune workflows anytime. |
| Perf budget discipline | Adding component CSS to bundled `<style>` bloated `Layout.*.css` past `commonClientBytesMax`. | Keep component-specific BEM styles in `<style is:inline>` where appropriate and verify `pnpm --filter @meitheal/web perf:budget`. | Keeps client JS/CSS payload fast on low-power Home Assistant hardware. |
| Modal portal stacking & input focus | Portaling `#sidebar-profile-modal` inside sticky `.layout-navigation` trapped it behind Tabler's `z-index: 10000` `.modal-backdrop`, and `_modal.css` stripped unfocused input borders. | Always portal `.tabler-surface` modals onto `document.body` (`--modal-zindex: 10001`), focus `[data-tabler-initial-focus]` on open, and keep explicit input borders on modal forms. | Guarantees immediate keyboard focus and unmistakable field affordances (Nielsen #4/#6). |
| Tinted nav form contrast | Accent/Dark nav tones overrode `--text-primary` to white without overriding `--bg-input`, creating white-on-white invisible inputs in Add Custom Link. | Always pair `--bg-input` (`rgba(15, 23, 42, 0.36)`) with dark/accent nav tone overrides and provide a visual 16-icon Tabler picker. | Preserves WCAG AA legibility across every theme and navigation color (Gestalt Figure-Ground). |
| Server vs Per-user menu UX | Settings Sidebar Configuration used confusing per-row `<select>` dropdowns and inline inputs without clarifying server vs personal scope. | Unify Settings Sidebar Configuration with the Task Detail Layout Editor (`td-layout-editor`), explicitly badge **Server-wide default (`All users`)** vs **Per-user (`Only you · This browser`)**, and support Add/Delete custom sections in both places. | Consistent mental model across layout editors with zero accidental household-wide overwrites (Nielsen #4/#5). |
| Tinted nav shortcut & tree contrast | Accent/Dark nav tones overrode `--text-secondary` to white without overriding `--bg-surface`, `--bg-primary-rgb`, or `--border-rgb`, turning shortcut `<kbd>` badges into white-on-cream pills and Boards trees into washed-out pale panels. | Always override `--bg-surface`, `--bg-primary-rgb`, and `--border-rgb` on dark/accent nav tones, give `.shortcut-badge` explicit high-contrast dark-slate pills on tinted navs, and remove redundant Settings status dots. | Guarantees WCAG AA/AAA readability across every theme, accent color, and nav tone (Gestalt Figure-Ground, Nielsen #8). |
| `transition:persist` portals & submenus | Moving `#nav-utility-popover` and `#sidebar-profile-modal` permanently to `document.body` caused Astro ClientRouter body swaps to destroy them while keeping the persisted `#sidebar`, silently breaking both triggers; uncoordinated `focusout` (`relatedTarget === null`) and `window.focus` clears broke submenus. | Dock closed portals inside `#sidebar` (portaling to `document.body` only while open and redocking on close/`abort`), coordinate all nav submenus via `meitheal:nav-submenu-open`, guard `focusout` with `relatedTarget instanceof Node`, and refresh Boards without wiping DOM on focus. | Keeps every navigation trigger, submenu, and modal 100% responsive across all page transitions and focus changes (Nielsen #3/#4). |

