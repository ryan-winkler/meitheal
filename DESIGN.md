---
type: "Reference"
title: "Meitheal Design System & Appearance"
description: "Canonical Evergreen Carbon & Living Mint brand identity from meitheal.io, opaque structural elevation rules, Tabler 1.75px icon sprites, Home Assistant storefront specifications, docked workspace inspector, and local appearance behavior."
design_md_format: "spec"
aesthetic: "Calm Architectural Household Utility — opaque Evergreen Carbon surfaces, Living Mint signal, Warm Paper light mode"
surfaces:
  backdrop_filter: "none"
  elevation: "Opaque luminance steps with 1px solid var(--border) hairlines; zero backdrop-filter, zero radial glow pseudo-elements, zero decorative AI pulse badges"
colors:
  dark:
    background: "#101210"
    surface_lowest: "#0D0F0E"
    surface_low: "#171A18"
    surface_card: "#1D211F"
    surface_hover: "#252B28"
    brand_tile: "#10231B"
    accent: "#69E3B2"
    accent_hover: "#8AF0C5"
    accent_text: "#ADF8D7"
    on_accent: "#07140F"
    text_primary: "#F1EFE8"
    text_secondary: "#C2CBC3"
    text_muted: "#A9B7B0"
    border: "#344039"
    warning: "#F0B86D"
    danger: "#EF4444"
  light:
    background: "#F6F5F0"
    surface_low: "#ECEBE4"
    surface_card: "#FFFFFF"
    surface_hover: "#E2E4DE"
    accent: "#146C4E"
    accent_hover: "#0E533B"
    accent_text: "#0E533B"
    on_accent: "#FFFFFF"
    text_primary: "#10231B"
    text_secondary: "#34473F"
    text_muted: "#4A5E55"
    border: "#C9D1CB"
    warning: "#B45309"
    danger: "#DC2626"
typography:
  heading: "'Geist Variable', 'Inter Variable', -apple-system, sans-serif"
  sans: "'Geist Variable', 'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif"
  mono: "'JetBrains Mono', ui-monospace, monospace"
  body_default: "14px"
  preload: "Geist Variable Latin woff2 only"
  wordmark: "meitheal. (Geist Variable 500, -0.05em tracking) + /meh·hal/ (JetBrains Mono 400, 0.09em tracking)"
iconography:
  catalog: "Build-extracted Tabler Outline SVGs (24x24 viewBox, 1.75px stroke, vector-effect: non-scaling-stroke)"
  sprites: "Per-request <IconSpriteDefs /> streaming <symbol id='mt-icon-...'> emission"
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "16px"
  full: "9999px"
spacing:
  base_unit: "4px"
  sidebar_width: "240px"
  docked_inspector_width: "420px"
  docked_inspector_breakpoint: "1440px"
  mobile_tab_bar_height: "56px"
  coarse_pointer_target: "44px"
---

# Meitheal Design System & Appearance

## Brand Identity (`meitheal.io`)

**Meitheal** (`/meh·hal/`) comes from the Irish word for neighbors coming together to share the work none of them could carry alone. Visually and verbally, Meitheal avoids loud corporate project-management clichés and cold DevOps neon in favor of a calm, tactile household utility aesthetic: *"Keep track of the work your home needs."*

### Design Direction & Opaque Structural Elevation

- **Opaque Structural Elevation**: Surfaces separate cleanly through luminance steps and `1px solid var(--border)` hairlines with `backdrop-filter: none` (`0` `backdrop-filter` / `backdrop-blur-*` utilities across the application), solid `rgba(0, 0, 0, 0.62)` modal scrims, zero radial glow pseudo-elements, and zero decorative AI pulse badges. This eliminates GPU backdrop-sampling overhead on Raspberry Pi / Home Assistant Green WebViews and ensures crisp legibility across Home Assistant dashboards, mobile Companion WebViews, and desktop monitors.

### Canonical Mark & Wordmark Lockup

- **App Mark (`64×64` geometry)**: Rounded evergreen tile (`#10231B`, `rx="13"`), warm off-white continuous double-arch `m` (`#EDF5EF`, `stroke-width="5"`, `stroke-linecap="round"`), and a living mint completion dot (`#75E9BE`, `cx="52" cy="40" r="3.5"`).
- **Wordmark**: Lowercase `meitheal.` in `Geist Variable` (`font-weight: 500`, `letter-spacing: -0.05em`) paired with `/meh·hal/` in `JetBrains Mono` (`letter-spacing: 0.09em`).
- **Home Assistant Storefront Assets**:
  - `icon.png`: `256×256` 8-bit RGBA PNG with transparent outer corners around the `#10231B` rounded-square mark (Canary adds a crisp `#F0B86D` warm amber corner pip).
  - `logo.png`: `500×200` (2.5:1 Retina) 8-bit RGBA PNG rendered as a self-contained `#10231B` rounded architectural badge (`#344039` border, transparent exterior) so the lockup maintains >12:1 contrast on both Home Assistant Light and Dark themes without white bars or checkerboard artifacts.

### Color & Contrast Architecture

- **Dark Mode (Default — Evergreen Carbon + Living Mint)**:
  - Surfaces step cleanly by luminance: `--bg-input: #0D0F0E` → `--bg-primary: #101210` → `--bg-secondary: #171A18` → `--bg-card: #1D211F` → `#252B28` (hover), framed by `--border: #344039` hairline borders.
  - Primary Brand Accent `--accent: #69E3B2` pairs with deep forest ink `--palette-on-accent: #07140F` (11.9:1 contrast) on filled buttons and badges, and `--accent-text: #ADF8D7` on dark surfaces; Warning `#F0B86D`, Danger `#EF4444`.
- **Light Mode (Warm Architectural Paper + Forest Emerald)**:
  - Warm paper canvas `--bg-primary: #F6F5F0` with `--bg-secondary: #ECEBE4` chrome, crisp `--bg-card: #FFFFFF` cards, and `--border: #C9D1CB` borders.
  - Deep Forest Emerald `--accent: #146C4E` and `--accent-hover` / `--accent-text: #0E533B` pair with `--palette-on-accent: #FFFFFF` (6.4:1–8.9:1 contrast) so every text link, badge, and filled primary action passes WCAG AA 4.5:1; Warning `#B45309`, Danger `#DC2626`.
- **Personal Accent CSS Binding**: Dynamic accent chrome binds directly to `var(--accent)` / `var(--accent-hover)` and `var(--personal-accent-foreground, var(--palette-on-accent))` rather than static RGB utility classes or legacy `#6366f1` / `#7c3aed` fallbacks.

### Typography

- **Operational Type**: Headings and UI Body render in self-hosted `Geist Variable` (with `Inter Variable` fallback; `14px` operational body default). Tickets, timestamps, RICE scores, and IPA use `JetBrains Mono` (`font-variant-numeric: tabular-nums`).
- **Lazy Appearance Fonts & Ingress Safety**: `Layout.astro` preloads only `Geist Variable` Latin `woff2`; optional `Outfit` and `Comic Neue` appearance presets load lazily via CSS `@font-face` only when selected in Appearance settings. All `@fontsource` assets resolve via relative `./` paths to satisfy strict `font-src 'self'` Content Security Policy behind Home Assistant Ingress.

### Iconography & 5-Bucket Emoji Safety Policy

- **Tabler `1.75px` Outline Catalog**: UI chrome and task-type icons use build-extracted `@tabler/icons` Outline SVGs (`24×24` `viewBox`, `stroke-width="1.75"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `vector-effect="non-scaling-stroke"`), deduplicated per SSR response via `<IconSpriteDefs />` (`<symbol id="mt-icon-...">`).
- **5-Bucket Emoji Governance**:
  1. **Bucket 1 (Sync & Cleanup Parsers — Untouched)**: Bidirectional calendar attribution markers and corrupt-title cleanup parsers remain intact.
  2. **Bucket 2 (User Entities, Pickers, Reactions & Native `<option>` Text — Untouched)**: User-authored area/project/lane emoji icons, `IconPicker`, comment reactions, `I18nText` swap attributes, and native `<select><option>` plain-text labels remain intact.
  3. **Bucket 3 (Component Defaults — Tabler)**: `EmptyState` (`clipboard-list`) and `TaskTypeIcon` (`bolt` / `book` / `bug` / `checkbox`) default to Tabler outline icons while rendering user-authored Bucket 2 emoji strings when passed.
  4. **Bucket 4 & 5 (Static Chrome & Non-`<option>` Locale Strings — Tabler)**: Decorative emojis in static UI chrome, Settings headings/buttons, `SearchHub`, and toasts are replaced by `1.75px` Tabler `<Icon />` elements.

### Layout, Touch & Motion

- **Spatial Grid & Adaptive Containers**: `4px` base spacing grid, single-scroll `body`, and CSS `@container` component queries (`container-name: task-inspector`) so panels adapt to their own inline width rather than viewport breakpoints.
- **Docked Workspace Inspector (`>= 1440px`)**: At `>= 1440px` desktop widths, opening a task docks `#task-detail-panel` as a `420px` non-modal right rail (`body.has-docked-inspector`, `role="region"`, `aria-modal="false"`, unlocked `body` scroll, active `SearchHub` and single-key navigation outside panel inputs); below `1440px`, the same live DOM node presents as a `role="dialog"` (`aria-modal="true"`) modal without losing unsaved drafts.
- **Coarse-Pointer Hit Targets**: Interactive controls enforce `@media (pointer: coarse)` `44px × 44px` minimum hit targets for Home Assistant Companion touch screens and wall tablets.
- **Keyboard Speed & GPU-Composited Motion**: High-frequency surfaces such as `SearchHub` (`Ctrl+K` / `/`) open instantaneously with zero artificial entrance delay. Tactile press feedback (`transform: scale(0.97)`), sheets/drawers (`--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`), and disclosures use `transform`/`opacity` transitions (`<= 160ms`, `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`) with zero mount fade loops or floating icon animations, and disable cleanly under `prefers-reduced-motion: reduce`.

---

## Meitheal appearance

Meitheal uses the existing Astro layout, native Settings forms, shared CSS tokens and Home Assistant ingress paths. Appearance customization changes presentation without changing household data or automation authority.

The Customize appearance panel exposes ten preferences: navigation, navigation tone, font, neutral palette, radius, content width, header behavior, navigation edges, panel style and sidebar behavior. All choices are validated against `appearance-preferences.ts`. Save applies a complete local preference draft only after browser storage accepts it. Reset stages defaults for the next save. Unknown stored fields survive a save. The existing theme, accent, custom CSS, language and regional controls keep their contracts.

Defaults preserve the current interface. Desktop users may select a vertical sidebar or a horizontal navigation bar; destination links remain native and a single More disclosure holds overflow from both destination lists when space is limited. The current route remains visible when it fits. Crowded Tasks view links use the same primitive and preserve their route semantics. The controller moves existing link nodes, retaining IDs, hrefs and listeners; it restores focus during reflow and uses keyboard arrows, Home/End and Escape within the disclosure. ResizeObserver only schedules width changes into a later animation frame. Areas uses its existing native disclosure in either layout. Phones keep their existing mobile navigation. Hover expansion also responds to keyboard focus and leaves the main content in place.

Fonts are self-hosted, including Comic Neue. Neutral palettes update both CSS variables and RGB utility tokens for light and dark modes. Accent navigation uses a dark tint so labels remain readable with pale accent choices. Filled primary actions use the deeper palette accent by default. A custom accent pairs with black or white text using measured luminance, separately for its normal and shaded hover surface; the same helper runs before paint and when Settings changes it. Native form widgets follow the effective app color scheme, including Auto with Home Assistant. Focus does not fade placeholder guidance. Shared radius tokens apply to existing controls and cards. Floating panel rules affect existing non-docked task, search and day-drawer surfaces without replacing their controllers.

See [Settings troubleshooting](docs/kcs/settings-troubleshooting.md) for save/reset behavior and local preference recovery. Domain boundaries, ingress handling, lifecycle cleanup and accessible focus behavior remain part of the implementation contract.
