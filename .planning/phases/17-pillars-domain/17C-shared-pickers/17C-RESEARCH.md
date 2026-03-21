# Phase 17C: Shared Icon & Color Picker - Research

**Researched:** 2026-03-21
**Domain:** Astro UI Components / Shared Picker Extraction
**Confidence:** HIGH

## Summary

The codebase already contains mature implementations of both an emoji picker and a swatch color picker, embedded within `SidebarHierarchyTree.astro` as `<template>` elements. The primary work is extraction and generalization — not greenfield development.

**Primary recommendation:** Extract the sidebar's `tmpl-color-icon` template into two standalone Astro components (`IconPicker.astro`, `ColorPicker.astro`), add SVG/PNG upload to the icon picker, add hex input to the color picker, and refactor both consumers (SidebarHierarchyTree and PillarFormModal) to use the shared components.

## Standard Stack

### Core (Already In Codebase)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Astro | 5.x | Component framework | Project standard |
| `DropdownController` | Custom | Fixed positioning + dismissal | `apps/web/src/lib/dropdown-controller.ts` — already handles getBoundingClientRect, viewport clamping, outside-click, escape key |
| `emoji-picker-data.ts` | Custom | Curated emoji grid data | `apps/web/src/lib/emoji-picker-data.ts` — 5 categories, ~130 emoji |
| `design-tokens.ts` | Custom | `COLOR_SWATCHES` palette | `apps/web/src/lib/design-tokens.ts` — 10 curated hex colors |
| i18n `t()` | Custom | Translation function | `apps/web/src/lib/i18n.ts` + `en.json`/`ga.json` |

### Supporting (No New Dependencies)
No new npm packages needed. All functionality can be built with native browser APIs (FileReader, canvas for image validation, DOMParser for SVG sanitization).

## Architecture Patterns

### Existing Pattern: Template Materialization
The sidebar uses `<template>` elements cloned to `document.body` via `materialize()`:
```typescript
// SidebarHierarchyTree.astro line 1029
function materialize(tmplId: string): HTMLElement | null {
  const tmpl = document.getElementById(tmplId) as HTMLTemplateElement | null
  if (!tmpl) return null
  const clone = tmpl.content.firstElementChild?.cloneNode(true) as HTMLElement
  clone.hidden = true
  document.body.appendChild(clone)
  return clone
}
```

### Recommended: Direct Component Pattern
Instead of templates, use Astro components that render directly into the page. Consumers instantiate them declaratively, and a small controller handles showing/hiding via `DropdownController.show()`.

```astro
<!-- Consumer usage -->
<IconPicker id="pillar-icon-picker" value={currentIcon} />
```

```typescript
// Controller usage
import { DropdownController } from "@lib/dropdown-controller"
const ctrl = new DropdownController()
const picker = document.getElementById("pillar-icon-picker")
ctrl.show(picker, triggerButton)
```

### Anti-Patterns to Avoid
- **Template duplication** — the current pattern where each consumer has its own template markup
- **Native `<input type="color">`** — unreliable positioning, OS-dependent look
- **Body-level innerHTML** — security risk; use DOM APIs or `<template>` cloning

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SVG sanitization | Custom regex cleaner | DOMParser + whitelist attributes | Regex can't handle nested/escaped structures |
| Color validation | Manual hex parsing | CSS `Color` constructor / regex `^#[0-9a-fA-F]{6}$` | Simple enough for regex, but handle shorthand |
| Image dimension check | Server-side processing | Client-side `Image()` constructor | Already know target is data URI, no server round-trip |

## Common Pitfalls

### Pitfall 1: Popover Position Inside Modal
**What goes wrong:** Icon/color picker inside PillarFormModal opens behind the modal overlay
**Why it happens:** Modal has `z-index`, popover also uses `z-index` but stacking contexts conflict
**How to avoid:** Picker uses `position: fixed` with z-index higher than modal (modal is z-200, picker should be z-300)

### Pitfall 2: File Upload Data URIs Bloating SQLite
**What goes wrong:** Large SVG/PNG uploads stored as data URIs make queries slow
**Why it happens:** No size limit enforcement
**How to avoid:** Enforce 64KB max file size and 128×128px max dimensions for raster. SVGs get minified.

### Pitfall 3: Event Listener Cleanup on Astro Page Transition
**What goes wrong:** Picker event listeners leak across Astro view transitions
**Why it happens:** No cleanup on `astro:before-swap`
**How to avoid:** Use existing `createListenerManager()` pattern from `lib/managed-listeners.ts`

## Key Files to Modify

### New Files
- `apps/web/src/components/ui/IconPicker.astro` — Shared emoji grid + upload component
- `apps/web/src/components/ui/ColorPicker.astro` — Shared swatch grid + hex input component
- `apps/web/src/lib/controllers/icon-picker-controller.ts` — Icon picker interaction logic
- `apps/web/src/lib/controllers/color-picker-controller.ts` — Color picker interaction logic

### Modified Files
- `apps/web/src/components/pillars/PillarFormModal.astro` — Replace bare inputs with shared pickers
- `apps/web/src/components/layout/SidebarHierarchyTree.astro` — Replace inline template with shared picker imports
- `apps/web/src/i18n/en.json` — Add `pillars.*` keys + `picker.*` keys
- `apps/web/src/i18n/ga.json` — Add Irish translations for same
- `apps/web/src/lib/design-tokens.ts` — Add `DEFAULT_PILLAR_ICON` constant

## Sources

### Primary (HIGH confidence)
- `apps/web/src/lib/dropdown-controller.ts` — Full positioning/dismissal API
- `apps/web/src/components/layout/SidebarHierarchyTree.astro` lines 260-293 — Existing picker markup
- `apps/web/src/lib/emoji-picker-data.ts` — Emoji categories data
- `apps/web/src/lib/design-tokens.ts` — COLOR_SWATCHES palette

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, all patterns exist
- Architecture: HIGH — DropdownController already solves positioning
- Pitfalls: MEDIUM — modal z-index stacking needs careful testing

**Research date:** 2026-03-21
**Valid until:** 2026-04-21
