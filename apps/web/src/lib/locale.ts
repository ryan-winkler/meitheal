/**
 * @fileoverview Centralized locale management for Meitheal.
 *
 * Single source of truth for locale resolution, storage, and application.
 * Used by Settings page, Layout.astro (SSR), and I18nText component.
 *
 * Locale preference is stored in:
 *   - Cookie: `meitheal-locale` (SSR resolution)
 *   - localStorage: `meitheal-locale` (offline fallback)
 *   - Settings API: `locale` key (persistent preference)
 *
 * Mirrors the pattern established by coolock-village-forge src/lib/locale.ts.
 *
 * Bounded Context: Infrastructure (i18n)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported locales — extensible by adding new entries here + JSON files. */
export type Locale = "en" | "ga";

/** All supported locales for validation. */
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "ga"] as const;

/** Human-readable labels for each locale, in the locale's own language. */
export const LOCALE_LABELS: Record<Locale, string> = {
    en: "English",
    ga: "Gaeilge",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage/cookie key shared by toggle, settings, and Layout inline script. */
export const STORAGE_KEY = "meitheal-locale";

/** Cookie name for SSR locale resolution. */
export const COOKIE_NAME = "meitheal-locale";

/** Default locale when nothing is stored. */
export const DEFAULT_LOCALE: Locale = "en";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Check if a value is a valid locale. */
export function isValidLocale(value: unknown): value is Locale {
    return (
        typeof value === "string" &&
        SUPPORTED_LOCALES.includes(value as Locale)
    );
}

/** Read the stored locale from localStorage. Returns DEFAULT_LOCALE if not set or invalid. */
export function getStoredLocale(): Locale {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
    const stored = localStorage.getItem(STORAGE_KEY);
    return isValidLocale(stored) ? stored : DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Apply a locale to the document.
 *
 * Sets the `lang` attribute on `<html>` for:
 *  1. Accessibility — screen readers use correct pronunciation
 *  2. CSS `:lang()` selectors
 *  3. Browser spell-check language
 */
export function applyLocale(locale: Locale): void {
    const root = document.documentElement;
    root.lang = locale;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Persist a locale preference to both localStorage and cookie.
 */
export function storeLocale(locale: Locale): void {
    if (!isValidLocale(locale)) return;
    localStorage.setItem(STORAGE_KEY, locale);
    // Set cookie for SSR resolution (1 year expiry, SameSite=Lax)
    document.cookie = `${COOKIE_NAME}=${locale};path=/;max-age=31536000;SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

/**
 * Dispatch a custom event so other components can stay in sync
 * without tight coupling.
 */
export function dispatchLocaleChanged(locale: Locale): void {
    window.dispatchEvent(
        new CustomEvent("meitheal:locale-changed", { detail: { locale } }),
    );
}
