---
okf_version: "0.2"
---

# Creating a Custom Theme

Use this guide to build a custom CSS theme for Meitheal or contribute a built-in preset theme. All Meitheal themes use CSS custom properties (design tokens) with WCAG AA contrast guarantees and work completely offline inside Home Assistant ingress and standalone installations.

## Quick Start: Upload a Custom CSS File

1. Open **Settings → Look & Feel** (`#look-and-feel-settings`).
2. Select **Custom CSS Theme** below the preset theme grid.
3. Click **Import .css** and choose your `.css` file.
4. Preview changes immediately across cards, inputs, and badges, then click **Save** to persist.

> **Security note**: Only workspace administrators can upload custom CSS. Avoid external `@import url(...)` or remote font URLs — Meitheal is local-first and enforces a strict Content Security Policy (CSP).

## Core Theme Token Contract

Custom themes layer on top of Meitheal's dark base (`[data-theme="dark"]`). Override tokens on `:root` (or `[data-theme="dark"]`). Define both the **solid color** and its space-separated **`-rgb` channel tuple** so Tailwind opacity utilities and `color-mix()` surfaces compute accurately.

```css
/* Example: Midnight Slate Custom Theme */
:root {
  color-scheme: dark;

  /* Surface hierarchy (darkest to lightest) */
  --bg-primary-rgb: 15 19 26;
  --bg-secondary-rgb: 22 28 38;
  --bg-card-rgb: 29 37 50;
  --bg-hover-rgb: 40 50 67;
  --bg-input-rgb: 12 16 22;

  --bg-primary: rgb(var(--bg-primary-rgb));
  --bg-secondary: rgb(var(--bg-secondary-rgb));
  --bg-card: rgb(var(--bg-card-rgb));
  --bg-hover: rgb(var(--bg-hover-rgb));
  --bg-input: rgb(var(--bg-input-rgb));

  /* Text hierarchy (target >= 4.5:1 against --bg-card and --bg-primary) */
  --text-primary-rgb: 241 245 249;
  --text-secondary-rgb: 203 213 225;
  --text-muted-rgb: 148 163 184;

  --text-primary: rgb(var(--text-primary-rgb));
  --text-secondary: rgb(var(--text-secondary-rgb));
  --text-muted: rgb(var(--text-muted-rgb));

  /* Borders and interactive focus rings */
  --border-rgb: 51 65 85;
  --border-focus-rgb: 56 189 248;
  --border: rgb(var(--border-rgb));
  --border-focus: rgb(var(--border-focus-rgb));
  --control-border: #475569;

  /* Brand accent (respects personal accent overrides when present) */
  --accent-rgb: var(--personal-accent-rgb, 56 189 248);
  --accent-hover-rgb: 125 211 252;
  --palette-accent: #38BDF8;
  --palette-accent-hover: rgb(var(--accent-hover-rgb));
  --palette-accent-light: rgb(var(--accent-rgb) / 0.16);
  --palette-on-accent: #082F49;
  --accent-text: var(--personal-accent-text-dark, #7DD3FC);

  /* Semantic feedback tokens */
  --success: #4ADE80;
  --success-rgb: 74 222 128;
  --warning: #FBBF24;
  --warning-rgb: 251 191 36;
  --danger: #F87171;
  --danger-rgb: 248 113 113;
  --info: #38BDF8;
  --info-rgb: 56 189 248;
}
```

## Building a Light Custom Theme

Set `color-scheme: light;` and use dark ink values for `--text-primary`, `--text-secondary`, and `--text-muted`. Override `--accent-text` using `--personal-accent-text-light` so user-selected accent colors automatically choose high-contrast dark ink on light backgrounds:

```css
:root {
  color-scheme: light;
  --bg-primary: #F8F7F4;
  --bg-secondary: #EFECE6;
  --bg-card: #FFFFFF;
  --bg-hover: #E6E2D9;
  --bg-input: #FFFFFF;
  --text-primary: #1B201E;
  --text-secondary: #3B4440;
  --text-muted: #55615C;
  --border: #D5D0C5;
  --palette-accent: #1D6E52;
  --palette-on-accent: #FFFFFF;
  --accent-text: var(--personal-accent-text-light, #14523D);
}
```

## Optional Surface Effects

- **Subtle background textures** (like *Plainspace*): Apply lightweight CSS gradients on `body` rather than external image URLs.
- **Translucent glass cards** (like *Liquid Glass*): Use semi-transparent `rgba(...)` values for `--bg-card` / `--bg-secondary` with `backdrop-filter: blur(18px) saturate(155%)` on `.card`, `.settings-panel-card`, `.modal-content`, `.sidebar`, and `.unified-bar`. Always verify text contrast remains at least **4.5:1** over any background gradient.
- **Reduced motion**: Wrap any decorative transitions or animations in `@media (prefers-reduced-motion: reduce)` fallbacks.

## Verification Checklist (WCAG AA & Gestalt)

Before sharing or contributing a theme, verify:

1. **Contrast**: Body text (`--text-primary`), muted hints (`--text-muted`), and button labels (`--palette-on-accent` on `--palette-accent`) achieve at least **4.5:1** contrast (3:1 for large headings and UI borders).
2. **Kanban & Cards**: Check `/boards/household` — verify card fills, priority badges, due-date warnings, and drag-and-drop drop indicators stay legible.
3. **Forms & Modals**: Open New Task, Date Picker, and Task Details — verify input borders (`--control-border`), focus rings (`--border-focus`), and disabled controls are clearly distinguishable.
4. **High-Contrast Mode**: Test with OS high-contrast mode (`prefers-contrast: more`) enabled.

## Contributing a Built-In Theme

To promote a theme into Meitheal's built-in 6×2 theme picker:

1. Register the slug in `apps/web/src/lib/theme-mode.ts` (`LIGHT_THEME_MODES` or `DARK_NAMED_THEME_MODES`, plus `THEME_META_COLORS`).
2. Add its `[data-theme="<slug>"]` token block to `apps/web/src/styles/_tokens.css`.
3. Add a `96×64` vector preview tile in `apps/web/src/components/settings/SettingsLookAndFeel.astro`.
4. Add unit coverage in `apps/web/src/lib/theme-mode.test.ts` and keep the preset grid symmetrical.
