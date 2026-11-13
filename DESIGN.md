---
type: "Reference"
title: "Meitheal Design System & Appearance"
description: "Canonical Evergreen & Mint brand identity from meitheal.io, CSS design tokens, Home Assistant storefront specifications, and local appearance customization behavior."
design_md_format: "spec"
aesthetic: "Calm Architectural Household Utility — warm forest carbon, living mint signal, cream paper typography"
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
    danger: "#FF7D7D"
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
  wordmark: "meitheal. (Geist Variable 500, -0.05em tracking) + /meh·hal/ (JetBrains Mono 400, 0.1em tracking)"
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "16px"
  full: "9999px"
spacing:
  base_unit: "4px"
  sidebar_width: "240px"
  mobile_tab_bar_height: "56px"
---

# Meitheal Design System & Appearance

## Brand Identity (`meitheal.io`)

**Meitheal** (`/meh·hal/`) comes from the Irish word for neighbors coming together to share the work none of them could carry alone. Visually and verbally, Meitheal avoids loud corporate project-management clichés and cold DevOps neon in favor of a calm, tactile household utility aesthetic: *"Keep track of the work your home needs."*

### Canonical Mark & Wordmark Lockup

- **App Mark (`64×64` geometry)**: Rounded evergreen tile (`#10231B`, `rx="13"`), warm off-white continuous double-arch `m` (`#EDF5EF`, `stroke-width="5"`, `stroke-linecap="round"`), and a living mint completion dot (`#75E9BE`, `cx="52" cy="40" r="3.5"`).
- **Wordmark**: Lowercase `meitheal.` in `Geist Variable` (`font-weight: 500`, `letter-spacing: -0.05em`) paired with `/meh·hal/` in `JetBrains Mono` (`letter-spacing: 0.1em`).
- **Home Assistant Storefront Assets**:
  - `icon.png`: `256×256` 8-bit RGBA PNG with transparent outer corners around the `#10231B` rounded-square mark (Canary adds a crisp `#F0B86D` warm amber corner pip).
  - `logo.png`: `500×200` (2.5:1 Retina) 8-bit RGBA PNG rendered as a self-contained `#10231B` rounded architectural badge (`#344039` border, transparent exterior) so the lockup maintains >12:1 contrast on both Home Assistant Light and Dark themes without white bars or checkerboard artifacts.

### Color & Contrast Architecture

- **Dark Mode (Default — Evergreen Carbon + Living Mint)**:
  - Surfaces step cleanly by luminance: `#0D0F0E` (inputs) → `#101210` (canvas) → `#171A18` (sidebar/chrome) → `#1D211F` (cards) → `#252B28` (hover), framed by `#344039` hairline borders.
  - Primary accent `#69E3B2` (`--palette-accent`) pairs with deep forest ink `#07140F` (`--palette-on-accent`, 11.9:1 contrast) on filled buttons and badges, and `#ADF8D7` (`--accent-text`) on dark surfaces.
- **Light Mode (Warm Architectural Paper + Forest Emerald)**:
  - Warm paper canvas `#F6F5F0` with crisp `#FFFFFF` cards and `#ECEBE4` chrome.
  - Deep Forest Emerald `#146C4E` (`--palette-accent`) and `#0E533B` (`--palette-accent-hover` / `--accent-text`) pair with `#FFFFFF` (`--palette-on-accent`, 6.4:1–8.9:1 contrast) so every text link, badge, and filled primary action passes WCAG AA 4.5:1 without washed-out mint-on-white text.

### Motion & Interaction Principles

- **Tactile Press Feedback**: Interactive buttons scale subtly on press (`transform: scale(0.97)`) using fast `160ms` transitions.
- **Natural Easing Curves**: Entrances and disclosures use custom strong ease-out curves (`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`), sheets/drawers use `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`, and dropdowns anchor `transform-origin` to their trigger corner (`top left` / `top right`).
- **Keyboard Speed First**: High-frequency surfaces such as `SearchHub` (`Ctrl+K` / `/`) open instantaneously with zero artificial entrance delay, and all motion honors `prefers-reduced-motion: reduce`.
- **Self-Hosted Fonts Only**: All `@font-face` assets (`Geist Variable`, `Inter Variable`, `Outfit`, `JetBrains Mono`, `Comic Neue`) load from local `@fontsource` bundles to satisfy strict `font-src 'self'` Content Security Policy behind Home Assistant Ingress.

---

## Meitheal appearance

Meitheal uses the existing Astro layout, native Settings forms, shared CSS tokens and Home Assistant ingress paths. Appearance customization changes presentation without changing household data or automation authority.

The Customize appearance panel exposes ten preferences: navigation, navigation tone, font, neutral palette, radius, content width, header behavior, navigation edges, panel style and sidebar behavior. All choices are validated against `appearance-preferences.ts`. Save applies a complete local preference draft only after browser storage accepts it. Reset stages defaults for the next save. Unknown stored fields survive a save. The existing theme, accent, custom CSS, language and regional controls keep their contracts.

Defaults preserve the current interface. Desktop users may select a vertical sidebar or a horizontal navigation bar; destination links remain native and a single More disclosure holds overflow from both destination lists when space is limited. The current route remains visible when it fits. Crowded Tasks view links use the same primitive and preserve their route semantics. The controller moves existing link nodes, retaining IDs, hrefs and listeners; it restores focus during reflow and uses keyboard arrows, Home/End and Escape within the disclosure. ResizeObserver only schedules width changes into a later animation frame. Areas uses its existing native disclosure in either layout. Phones keep their existing mobile navigation. Hover expansion also responds to keyboard focus and leaves the main content in place.

Fonts are self-hosted, including Comic Neue. Neutral palettes update both CSS variables and RGB utility tokens for light and dark modes. Accent navigation uses a dark tint so labels remain readable with pale accent choices. Filled primary actions use the deeper palette accent by default. A custom accent pairs with black or white text using measured luminance, separately for its normal and shaded hover surface; the same helper runs before paint and when Settings changes it. Native form widgets follow the effective app color scheme, including Auto with Home Assistant. Focus does not fade placeholder guidance. Shared radius tokens apply to existing controls and cards. Floating panel rules affect existing task, search and day-drawer surfaces without replacing their controllers.

See [Settings troubleshooting](docs/kcs/settings-troubleshooting.md) for save/reset behavior and local preference recovery. Domain boundaries, ingress handling, lifecycle cleanup and accessible focus behavior remain part of the implementation contract.
