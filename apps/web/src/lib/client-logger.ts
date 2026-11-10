/**
 * Client Logger — Structured console logging for browser-side code
 *
 * Provides domain-aware, prefixed logging to replace raw console.* calls.
 * In production, debug logs are suppressed. All other levels output to
 * console with a structured `[Meitheal][domain] message` prefix.
 *
 * Bounded Context: Infrastructure (observability)
 * @kcs Replaces ad-hoc console.log/warn/error with consistent, filterable output
 */

export type ClientLogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVEL_VALUE: Record<ClientLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const IS_DEV = typeof window !== "undefined"
  && (window.location?.hostname === "localhost" || window.location?.hostname === "127.0.0.1")

/** Minimum log level — debug only in dev, info+ in production */
const MIN_LEVEL: ClientLogLevel = IS_DEV ? "debug" : "info"

export interface ClientLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * Create a domain-scoped client logger.
 *
 * @param domain — Bounded context, e.g. "kanban", "settings", "offline"
 * @param component — Optional sub-component, e.g. "drag", "sync-engine"
 *
 * @example
 * ```ts
 * const log = createClientLogger("kanban", "drag")
 * log.warn("Duplicate task failed", { taskId })
 * log.error("Unexpected state", err)
 * ```
 */
/**
 * Global logger bridge for is:inline scripts.
 *
 * is:inline scripts cannot use ESM imports, so they access the logger
 * via window.__mLog(domain, component?). This function is registered
 * on the window object by Layout.astro's module script.
 *
 * @example (in is:inline script)
 * ```js
 * const log = window.__mLog("settings", "general")
 * log.error("Save failed", err)
 * ```
 */
export function registerGlobalLogger(): void {
  if (typeof window !== "undefined") {
    window.__mLog = createClientLogger
  }
}

export function createClientLogger(domain: string, component?: string): ClientLogger {
  const prefix = component
    ? `[Meitheal][${domain}/${component}]`
    : `[Meitheal][${domain}]`

  function shouldLog(level: ClientLogLevel): boolean {
    return LOG_LEVEL_VALUE[level] >= LOG_LEVEL_VALUE[MIN_LEVEL]
  }

  return {
    debug(message: string, ...args: unknown[]) {
      if (shouldLog("debug")) console.debug(prefix, message, ...args)
    },
    info(message: string, ...args: unknown[]) {
      if (shouldLog("info")) console.info(prefix, message, ...args)
    },
    warn(message: string, ...args: unknown[]) {
      if (shouldLog("warn")) console.warn(prefix, message, ...args)
    },
    error(message: string, ...args: unknown[]) {
      if (shouldLog("error")) console.error(prefix, message, ...args)
    },
  }
}
