# Phase 17C: Shared Icon & Color Picker Components - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract and unify the icon picker and color picker components that currently exist as duplicated, non-shared implementations in SidebarHierarchyTree and PillarFormModal. This sub-phase delivers:

1. **Shared IconPicker component** — emoji grid with category tabs + custom SVG/PNG upload capability
2. **Shared ColorPicker component** — theme-default swatches + custom color input, properly positioned (no top-left fly-away)
3. **i18n externalization** — all PillarFormModal strings into en.json/ga.json
4. **Light/dark theme compatibility** — verified CSS custom properties for both modes
5. **Integration readiness** — MCP/A2A/AI/HA-ready API surface for pillar CRUD

</domain>

<decisions>
## Implementation Decisions

### Component Extraction (LOCKED)

- Extract emoji picker from `SidebarHierarchyTree.astro` template into a shared `IconPicker.astro` component in `components/ui/`
- Extract swatch color picker from `SidebarHierarchyTree.astro` template into a shared `ColorPicker.astro` component in `components/ui/`
- Both PillarFormModal and SidebarHierarchyTree MUST consume the new shared components
- Sidebar's `tmpl-color-icon` template pattern becomes the reference implementation

### Icon Picker (LOCKED)

- Keep emoji grid with category tabs from `EMOJI_CATEGORIES` (existing `emoji-picker-data.ts`)
- Add custom upload capability for SVG and PNG only (strict boundaries)
- Upload must validate: file type (SVG/PNG), max file size (64KB), max dimensions (128×128px for raster)
- SVGs get sanitized (no embedded scripts)
- Uploaded icons stored as data URIs in the same `icon` column — not separate files
- Selected icon preview always visible (matching sidebar pattern)

### Color Picker (LOCKED)

- **No native `<input type="color">`** — replace with swatch grid from `COLOR_SWATCHES` in `design-tokens.ts`
- Add hex input field for custom colors (validated: must be valid hex)
- Save custom colors to user settings (reusable across entities)
- Picker must open **anchored to the trigger element**, not top-left corner
- `position: fixed` with calculated coordinates from trigger rect

### i18n (LOCKED)

- All hardcoded strings in PillarFormModal externalized to `en.json`/`ga.json` via `t()` function
- Include: field labels, placeholder text, hints, button text, validation messages
- Namespace: `pillars.*` in the translation files

### Theme Compatibility (LOCKED)

- All new components use CSS custom properties (`--bg-surface`, `--border`, `--text-*`, `--accent`)
- Verify visually on both light and dark theme
- No hardcoded color values in CSS

### Claude's Discretion

- Internal DOM structure of the picker components
- Animation/transition choices for picker open/close
- Maximum number of saved custom colors (suggest 10)
- Whether upload uses a modal sub-panel or inline expansion

</decisions>

<specifics>
## Specific Ideas

- SidebarHierarchyTree already has a working emoji-grid + swatch pattern — this is the gold standard
- `COLOR_SWATCHES` from `design-tokens.ts` as the default palette
- Data URIs for uploaded icons keeps the architecture simple (no separate file storage, works in SQLite)
- Custom colors saved in the existing settings store (`/api/settings`)

</specifics>

<deferred>
## Deferred Ideas

- Icon search by name (requires emoji-to-name mapping library)
- Icon pack marketplace (Material Icons, Font Awesome, etc.)
- Color palette generator (complementary, analogous)
- Drag-and-drop icon reordering
- Color blindness accessibility presets

</deferred>

---

*Phase: 17C-shared-pickers*
*Context gathered: 2026-03-21*
