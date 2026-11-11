---
type: "Reference"
title: "Meitheal appearance"
description: "Appearance controls, local preference storage and responsive layout behavior."
---

# Meitheal appearance

Meitheal uses the existing Astro layout, native Settings forms, shared CSS tokens and Home Assistant ingress paths. Appearance customization changes presentation without changing household data or automation authority.

The Customize appearance panel exposes ten preferences: navigation, navigation tone, font, neutral palette, radius, content width, header behavior, navigation edges, panel style and sidebar behavior. All choices are validated against `appearance-preferences.ts`. Save applies a complete local preference draft only after browser storage accepts it. Reset stages defaults for the next save. Unknown stored fields survive a save. The existing theme, accent, custom CSS, language and regional controls keep their contracts.

Defaults preserve the current interface. Desktop users may select a vertical sidebar or a horizontal navigation bar; destination links remain native and a single More disclosure holds overflow from both destination lists when space is limited. The current route remains visible when it fits. Crowded Tasks view links use the same primitive and preserve their route semantics. The controller moves existing link nodes, retaining IDs, hrefs and listeners; it restores focus during reflow and uses keyboard arrows, Home/End and Escape within the disclosure. ResizeObserver only schedules width changes into a later animation frame. Areas uses its existing native disclosure in either layout. Phones keep their existing mobile navigation. Hover expansion also responds to keyboard focus and leaves the main content in place.

Fonts are self-hosted, including Comic Neue. Neutral palettes update both CSS variables and RGB utility tokens for light and dark modes. Accent navigation uses a dark tint so labels remain readable with pale accent choices. Filled primary actions use the deeper palette accent by default. A custom accent pairs with black or white text using measured luminance, separately for its normal and shaded hover surface; the same helper runs before paint and when Settings changes it. Native form widgets follow the effective app color scheme, including Auto with Home Assistant. Focus does not fade placeholder guidance. Shared radius tokens apply to existing controls and cards. Floating panel rules affect existing task, search and day-drawer surfaces without replacing their controllers.

See [Settings troubleshooting](docs/kcs/settings-troubleshooting.md) for save/reset behavior and local preference recovery. Domain boundaries, ingress handling, lifecycle cleanup and accessible focus behavior remain part of the implementation contract.
