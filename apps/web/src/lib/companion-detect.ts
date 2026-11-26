/**
 * Companion App Detection — Detects when running inside HA Companion app
 *
 * The HA Companion app wraps the HA frontend in a WebView with specific
 * characteristics. When detected, IDB can be conditionally disabled since
 * the Companion handles its own caching and offline behavior.
 *
 * Detection signals:
 * 1. User-agent contains "HomeAssistant" (iOS/Android companion)
 * 2. window.externalApp is set (Android companion)
 * 3. window.webkit?.messageHandlers?.getExternalAuth (iOS companion)
 * 4. X-Ingress-Path header present (running inside HA iframe)
 *
 * @domain ha
 * @bounded-context integration
 * @kcs Companion app injects native bridges; IDB conflicts with Companion
 *      cache management — conditionally disable IDB in Companion context.
 */

import { createClientLogger } from "@lib/client-logger"

const log = createClientLogger("ha", "companion-detect")

// Cache the detection result — can't change mid-session
let cachedResult: boolean | null = null

/**
 * Detect if running inside the HA Companion app.
 * Returns true if any companion signal is found.
 */
export function isCompanionApp(): boolean {
  if (cachedResult !== null) return cachedResult

  if (typeof window === "undefined") {
    cachedResult = false
    return false
  }

  const signals: string[] = []

  // Signal 1: User-agent
  const ua = navigator.userAgent
  if (/HomeAssistant/i.test(ua)) {
    signals.push("user-agent")
  }

  // Signal 2: Android companion bridge
  if ("externalApp" in window) {
    signals.push("externalApp")
  }

  // Signal 3: iOS companion bridge
  const w = window as unknown as Record<string, unknown>
  const webkit = w.webkit as { messageHandlers?: { getExternalAuth?: unknown } } | undefined
  if (webkit?.messageHandlers?.getExternalAuth) {
    signals.push("webkit-bridge")
  }

  // Signal 4: Running inside HA ingress iframe (not strictly companion, but embedded)
  if (window.self !== window.top) {
    signals.push("iframe")
  }

  cachedResult = signals.length > 0

  if (cachedResult) {
    log.info("companion-detected", {
      signals: signals.join(", "),
      message: `HA Companion detected via: ${signals.join(", ")}`,
    })
  }

  return cachedResult
}

function storedIDBOverride(): string | null {
  try {
    return localStorage.getItem("meitheal_force_idb")
  } catch {
    return null
  }
}

/**
 * Check if IDB should be enabled for offline cache and sync.
 * The Companion app handles its own caching unless storage was explicitly enabled.
 */
export function shouldEnableIDB(): boolean {
  const override = storedIDBOverride()
  if (override === "true") return true
  if (override === "false") return false

  // Disable IDB in companion context
  if (isCompanionApp()) {
    log.info("idb-disabled", {
      message: "IDB disabled — running inside HA Companion app",
    })
    return false
  }

  return true
}

/** Attachments use local browser storage independently of the offline cache. */
export function shouldEnableAttachmentIDB(): boolean {
  if (storedIDBOverride() === "false") return false
  try {
    return typeof indexedDB !== "undefined"
  } catch {
    return false
  }
}

/** Reset the cached detection result (testing only) */
export function resetCompanionDetection(): void {
  cachedResult = null
}
