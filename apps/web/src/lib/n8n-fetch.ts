/**
 * n8n Fetch Utilities — Shared helpers for n8n API communication
 *
 * DRYs up repeated patterns across health.ts, workflows.ts, and test-webhook.ts:
 * - TLS bypass for .internal domains in local dev
 * - Base URL extraction from webhook URLs
 * - Timeout + abort controller setup
 * - JSON response helpers
 *
 * @domain integrations
 * @bounded-context n8n
 */

/**
 * Extract the base URL (protocol + host) from a full webhook URL.
 * e.g. "https://n8n.internal/webhook/abc" → "https://n8n.internal"
 */
export function extractBaseUrl(webhookUrl: string): string {
  try {
    const parsed = new URL(webhookUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return webhookUrl
  }
}

/**
 * Create a standard JSON Response with content-type header.
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Context for managed TLS bypass — saves/restores NODE_TLS_REJECT_UNAUTHORIZED */
interface TlsContext {
  bypassed: boolean
  originalValue: string | undefined
}

/**
 * Temporarily bypass TLS certificate verification for .internal domains
 * in local development. Call `restoreTls()` after the request completes.
 *
 * This is necessary because .internal domains use self-signed certs
 * that Node.js rejects by default.
 */
export function bypassTlsIfNeeded(url: string): TlsContext {
  const isLocalDev = process.env.NODE_ENV !== "production"
  const isInternal = url.includes(".internal")

  if (isLocalDev && isInternal) {
    const originalValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    return { bypassed: true, originalValue }
  }

  return { bypassed: false, originalValue: undefined }
}

/**
 * Restore NODE_TLS_REJECT_UNAUTHORIZED to its original value.
 */
export function restoreTls(ctx: TlsContext): void {
  if (!ctx.bypassed) return
  if (ctx.originalValue === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = ctx.originalValue
  }
}

/**
 * Fetch with timeout, TLS bypass for .internal domains, and automatic cleanup.
 *
 * Wraps native fetch with:
 * - AbortController timeout (default 5s)
 * - TLS bypass for .internal domains in dev
 * - Automatic TLS restore on completion
 */
export async function n8nFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 5000, ...fetchOptions } = options
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const tlsCtx = bypassTlsIfNeeded(url)

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeout)
    restoreTls(tlsCtx)
  }
}
