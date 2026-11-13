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

The selected Tabler outline paths (`apps/web/src/lib/tabler-svg.ts`, consumed by `Icon.astro` and DOM controllers) retain their MIT notice in the source module and in `apps/web/public/licenses/tabler-icons.txt`. They do not require an external icon service, and UI chrome icons across navigation, toolbars, modals, achievements, and Settings use that shared stroke-outline set (`stroke-width="1.75"`) without raw string HTML injection.

The desktop sidebar keeps a single circular edge collapse control (`#sidebar-edge-toggle`, with directional chevron flip and hover/ARIA state), while expandable navigation submenus (`Tasks`, `Areas`, and individual areas) use square disclosure buttons with dynamic `aria-expanded`, `aria-label`, and hover titles.

## Verification

Run `tabler-settings-recovery.spec.ts` against a disposable local Astro dev server to check section navigation, outline rendering, keyboard help, icon and security-link contrast in Light and Dark, mobile navigation, disclosure text and shared card spacing. Verified feedback capture and queue operations retain their separate `feedback-ingress.spec.ts` fixture checks; standalone mode intentionally does not expose those controls.
