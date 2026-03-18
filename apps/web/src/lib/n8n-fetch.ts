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

/**
 * Check if a URL targets an .internal domain in local development,
 * where self-signed TLS certs are expected.
 */
function needsTlsBypass(url: string): boolean {
  const isLocalDev = process.env.NODE_ENV !== "production"
  const isInternal = url.includes(".internal")
  return isLocalDev && isInternal
}

/**
 * Fetch with timeout and scoped TLS bypass for .internal domains in dev.
 *
 * Instead of mutating the global `process.env.NODE_TLS_REJECT_UNAUTHORIZED`,
 * uses Node.js `undici.Agent` with `{ connect: { rejectUnauthorized: false } }`
 * scoped only to this request. Falls back to env-var approach if undici is unavailable.
 *
 * @domain integrations
 * @kcs TLS bypass is scoped per-request and only active in non-production for .internal domains
 */
export async function n8nFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 5000, ...fetchOptions } = options
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      ...fetchOptions,
      signal: controller.signal,
    }

    if (needsTlsBypass(url)) {
      try {
        // Use undici Agent for scoped TLS bypass (available in Node 18+)
        const { Agent } = await import("undici")
        fetchOpts.dispatcher = new Agent({
          connect: { rejectUnauthorized: false },
        })
      } catch {
        // undici not available — no TLS bypass (safer default)
      }
    }

    const response = await fetch(url, fetchOpts as RequestInit)
    return response
  } finally {
    clearTimeout(timeout)
  }
}
