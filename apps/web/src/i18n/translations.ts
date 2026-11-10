/**
 * i18n Translation System — Lightweight type-safe translations for Meitheal
 *
 * Uses SSR locale resolution via cookie, with client-side switching via
 * localStorage and custom events.
 *
 * No external i18n library — ~200 strings don't need i18next overhead.
 * No URL-prefix routing — locale is a user preference, not a URL segment.
 *
 * Bounded Context: Infrastructure (i18n)
 */

import en from "./en.json";
import ga from "./ga.json";
import { DEFAULT_LOCALE, getStoredLocale } from "../lib/locale";
import type { Locale } from "../lib/locale";
import { serializeForScript } from "../lib/safe-html"

// =============================================================================
// Types
// =============================================================================

export type { Locale };
export type TranslationKeys = typeof en;

// =============================================================================
// Translation Data
// =============================================================================

const translations: Record<Locale, TranslationKeys> = {
    en,
    ga: ga as unknown as TranslationKeys,
};

// Static dictionaries can be serialized once per server process.
export const clientTranslationJson = {
    en: serializeForScript(en),
    ga: serializeForScript(ga),
}

// =============================================================================
// Locale Detection
// =============================================================================

/**
 * Detect the current locale from localStorage (client-side).
 * Falls back to DEFAULT_LOCALE if not set or invalid.
 */
export function getClientLocale(): Locale {
    return getStoredLocale();
}

// =============================================================================
// Translation Function
// =============================================================================

/**
 * Get a nested value from an object using dot notation.
 */
function getNestedValue(obj: unknown, key: string): string {
    // Try flat key first (e.g. "parent_page.tasks_hub" as a literal key)
    if (obj && typeof obj === "object" && key in (obj as Record<string, unknown>)) {
        const direct = (obj as Record<string, unknown>)[key]
        if (typeof direct === "string") return direct
    }
    // Fall back to nested traversal (e.g. "pillars.new_pillar" → obj.pillars.new_pillar)
    const result = key.split(".").reduce<unknown>(
        (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
        obj,
    );
    return typeof result === "string" ? result : key;
}

/**
 * Translate a key to the target locale.
 *
 * @param key - Dot-notation key, e.g. "nav.dashboard"
 * @param locale - Target locale (defaults to DEFAULT_LOCALE for SSR safety)
 * @param params - Interpolation params, e.g. { count: "5" }
 */
export function t(
    key: string,
    locale?: Locale,
    params?: Record<string, string>,
): string {
    const loc = locale ?? DEFAULT_LOCALE;
    let value = getNestedValue(translations[loc], key);

    // Fallback to English if key missing in target locale
    if (value === key && loc !== "en") {
        value = getNestedValue(translations.en, key);
    }

    // Interpolate {param} placeholders
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            value = value.replaceAll(`{${k}}`, v);
        }
    }

    return value;
}
