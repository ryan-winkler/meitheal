---
type: Guide
title: "Settings icons and help controls"
description: "Use Settings navigation, disclosures and integration help with keyboard or touch."
---

# Settings icons and help controls

Settings section links use local outline icons alongside their text labels. Choose a section with Enter to move to its heading. On a phone, open **Sections** first. The directory keeps the same section links used by Settings search.

Integration rows have separate controls: the heading expands the configuration, while the labeled information button opens an explanation. Escape closes that explanation and returns focus to the information button. The icon is decorative; the accessible name remains on the button.

Disclosure summaries show their description once. Their touch target is at least 44 pixels high, and cards use the shared Settings inset. Theme choices remain **Auto (System)**, **Light**, **Dark** and **Custom**.

Local feedback remains under **Settings → App & PWA** when opened through verified Home Assistant ingress. Its form, administrator queue, retry receipts and reviewed exports use the existing implementation. The underlined security reporting link remains available below the card. See [Feedback and support](feedback-and-support.md) for the permission and privacy boundaries.

The selected Tabler outline paths retain their MIT notice in `apps/web/scripts/generate-icons.mjs`, the committed `apps/web/src/generated/icon-registry.ts` catalog, `apps/web/src/components/ui/Icon.astro`, and `apps/web/public/licenses/tabler-icons.txt`. They do not require an external icon service.

## Build-Extracted 64-Icon Catalog, Sprites, and 5-Bucket Emoji Policy

`apps/web/scripts/generate-icons.mjs` extracts inner SVG geometry for 64 canonical Tabler outline icons (`24x24` `viewBox`, `stroke-width="1.75"`, `vector-effect="non-scaling-stroke"`) plus 17 legacy `Icon.astro` aliases from `@tabler/icons` (`devDependency`) into `apps/web/src/generated/icon-registry.ts` during `generate:codegen`. Repeated `<Icon sprite={true} />` and `<TaskTypeIcon />` elements register icon names on `Astro.locals.usedIcons` and reference `<symbol id="mt-icon-...">` definitions emitted once per SSR response by `<IconSpriteDefs />` before `</body>` in `Layout.astro`.

UI emoji handling follows five explicit buckets:
1. **Bucket 1 (Untouched)**: Bidirectional Home Assistant calendar/todo attribution markers (`calendar-bridge.ts`) and corrupt-title cleanup parsers (`cleanup-corrupt-titles.ts`).
2. **Bucket 2 (Untouched)**: User-selected Area, Project, and Kanban lane icons, emoji/reaction pickers, SQLite defaults, client translation swap mechanics, and native HTML `<select><option>` text (`settings.cal_sync_bidirectional`, `FrameworkWizard.astro` badge colors, priority/category options).
3. **Bucket 3 (Replaced)**: Component default fallback props (`EmptyState.astro`, `TaskTypeIcon.astro`) default to typed Tabler `IconName` values while rendering a text span when passed user-authored Bucket 2 strings.
4. **Bucket 4 (Replaced)**: Static Astro/TS UI chrome badges, buttons, and toasts use `<Icon>` or `renderIconSvg()`.
5. **Bucket 5 (Replaced)**: Non-`<option>` chrome strings in `en.json` and `ga.json` pair clean text with adjacent `<Icon aria-hidden="true" />` elements.

## Verification

Run `tabler-settings-recovery.spec.ts` against a disposable local Astro dev server to check section navigation, outline rendering, keyboard help, icon and security-link contrast in Light and Dark, mobile navigation, disclosure text and shared card spacing. Verified feedback capture and queue operations retain their separate `feedback-ingress.spec.ts` fixture checks; standalone mode intentionally does not expose those controls.
