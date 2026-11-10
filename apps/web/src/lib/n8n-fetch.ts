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
import { fetchWithDevelopmentTls } from "@meitheal/integration-core"

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

/** Fetch with a timeout and the shared development-only TLS policy. */
export async function n8nFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 5000, ...fetchOptions } = options
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetchWithDevelopmentTls(url, { ...fetchOptions, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
