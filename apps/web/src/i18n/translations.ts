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

import en from "./en.json" with { type: "json" };
import ga from "./ga.json" with { type: "json" };
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

// Merge fallback strings on the server, never by bundling both catalogs in browser JS.
function mergeCatalogs(base: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...base }
    for (const [key, value] of Object.entries(target)) {
        merged[key] = value && typeof value === "object" && !Array.isArray(value)
            ? mergeCatalogs((base[key] as Record<string, unknown>) ?? {}, value as Record<string, unknown>)
            : value
    }
    return merged
}

function clientCatalog(locale: Locale) {
    const merged = mergeCatalogs(en, translations[locale])
    // Legacy locale-wrapped settings must obey the same precedence as t().
    for (const catalog of [en.en, translations[locale][locale]]) {
        if (!catalog || typeof catalog !== "object") continue
        for (const key of Object.keys(catalog)) {
            if (!key.startsWith("settings.")) continue
            const value = getNestedValue(merged, key)
            const current = value === key ? getNestedValue(merged[locale], key) : value
            const resolved = t(key, locale)
            if (current !== resolved) merged[key] = resolved
        }
    }
    return merged
}

export const clientTranslationJson = {
    en: serializeForScript(clientCatalog("en")),
    ga: serializeForScript(clientCatalog("ga")),
}

// These programmatic messages can request a locale different from the SSR cookie
// (for example, after another tab changes localStorage). Keep their alternate
// locale available without sending a second complete catalog.
const programmaticKeys = [
    ...Object.keys(en.pins).map(key => `pins.${key}`),
    ...Object.keys(en.inactivity).map(key => `inactivity.${key}`),
    ...Object.keys(en.task_status).map(key => `task_status.${key}`),
    "deferral.title", "triage.details", "triage.range",
]
export const alternateClientTranslationJson = {
    en: serializeForScript(Object.fromEntries(programmaticKeys.map(key => [key, t(key, "ga")]))),
    ga: serializeForScript(Object.fromEntries(programmaticKeys.map(key => [key, t(key, "en")]))),
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
    const lookup = (language: Locale): string => {
        const catalog = translations[language]
        const value = getNestedValue(catalog, key)
        // Integration copy from older catalogs was grouped under a locale key.
        if (value === key && key.startsWith("settings.")) {
            return getNestedValue(catalog[language], key)
        }
        return value
    }
    let value = lookup(loc);

    // Fallback to English if key missing in target locale
    if (value === key && loc !== "en") {
        value = lookup("en");
    }

    // Interpolate {param} placeholders
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            value = value.replaceAll(`{${k}}`, v);
        }
    }

    return value;
}
