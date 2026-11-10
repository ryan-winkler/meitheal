/**
 * i18n Barrel Export — @lib/i18n path alias for components
 *
 * @domain infrastructure
 * @bounded-context i18n
 *
 * Components use @lib/i18n for cleaner DDD imports.
 * This barrel re-exports from ../i18n/translations + provides
 * a getLocale() helper for Astro components.
 *
 * @kcs Components should import { t, getLocale } from "@lib/i18n"
 * Pages that already use "../i18n/translations" can keep that pattern.
 */

import type { AstroGlobal } from "astro"

export { t, getClientLocale } from "../i18n/translations"
export type { Locale } from "../i18n/translations"

/**
 * Resolve locale from Astro SSR context (cookie-based).
 * Falls back to "en" if not set.
 *
 * Usage in .astro frontmatter:
 *   const locale = getLocale(Astro)
 */
export function getLocale(astro: AstroGlobal): "en" | "ga" {
  const cookie = astro.cookies.get("meitheal-locale")?.value
  return cookie === "ga" ? "ga" : "en"
}
