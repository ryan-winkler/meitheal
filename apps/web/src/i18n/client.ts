/** Browser translations use the SSR catalog and its small alternate message scope. */
import { getStoredLocale } from "../lib/locale"
import type { Locale } from "../lib/locale"

export type { Locale }
export function getClientLocale(): Locale {
  return getStoredLocale()
}

export function t(key: string, locale: Locale = "en", params?: Record<string, string>): string {
  let value = window.mI18n?.get(key, locale) ?? key
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, replacement)
    }
  }
  return value
}
