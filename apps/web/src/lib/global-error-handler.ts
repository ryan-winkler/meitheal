/**
 * Global Error Handler — Crash protection for uncaught errors
 *
 * Catches unhandled errors and promise rejections, logs them via
 * createClientLogger, and shows a non-blocking toast so the user
 * knows something went wrong instead of silent failure.
 *
 * Bounded Context: Infrastructure (observability)
 * @kcs Phase 29 T5 — crash protection
 */

import { attemptStaleChunkReload, isStaleChunkError } from "@lib/chunk-recovery"
import { createClientLogger } from "@lib/client-logger"
import { showToast } from "@lib/toast"

const log = createClientLogger("uncaught")

/** Window-scoped guard prevents re-registration on HMR */
const GUARD_KEY = "__meitheal_error_handler_registered"

export function initGlobalErrorHandler(): void {
  if (typeof window === "undefined") return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window guard flag
  const w = window as any
  if (w[GUARD_KEY]) return
  w[GUARD_KEY] = true

  const recoverStaleChunk = (): boolean =>
    attemptStaleChunkReload(window.sessionStorage, Date.now(), () => window.location.reload())

  // A failed dynamic import still rejects so a caller's fallback can run.
  // Only an unhandled stale-chunk rejection below reloads the page.

  window.addEventListener("error", (event) => {
    // Match the layout logger: the browser defers these resize notifications without an application failure.
    if (event.message?.includes("ResizeObserver loop")) return
    // Ignore errors from cross-origin scripts (browser security)
    if (!event.filename || event.filename === "") return

    log.error("Uncaught error", {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      col: event.colno,
    })

    showToast("Something went wrong. Check console for details.", "error")
  })

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason

    if (isStaleChunkError(reason)) {
      event.preventDefault()
      if (recoverStaleChunk()) return
    }

    // Extract useful error info
    const message = reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "Unknown promise rejection"

    log.error("Unhandled promise rejection", { message, reason })

    // Don't toast for AbortError — these are intentional cancellations
    if (reason instanceof DOMException && reason.name === "AbortError") return

    showToast("An operation failed unexpectedly.", "error")
  })
}
