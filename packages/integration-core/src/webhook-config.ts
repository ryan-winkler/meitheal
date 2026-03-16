import { createHmac } from "node:crypto"

// --- URL Validation (reused by SSRF guard and webhook config) ---

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fd/,
  /^fe80:/,
  /^localhost$/i,
]

export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some((re) => re.test(hostname))
}

export function isPrivateUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString)
    return isPrivateHost(parsed.hostname)
  } catch {
    return true // invalid URLs are treated as private (rejected)
  }
}

// --- Webhook Subscriber Config (Zod-style validation) ---

export interface WebhookSubscriberConfig {
  id: string
  url: string
  secret: string
  events: string[]
  enabled: boolean
  /** Optional custom headers to include in outbound webhook requests (e.g. Authorization) */
  headers?: Record<string, string>
}

export type WebhookConfigParseResult =
  | {
      ok: true
      subscribers: WebhookSubscriberConfig[]
    }
  | {
      ok: false
      errors: string[]
    }

export function parseWebhookConfig(raw: unknown): WebhookConfigParseResult {
  const errors: string[] = []

  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).webhooks)) {
    return { ok: false, errors: ["webhooks must be an array"] }
  }

  const entries = (raw as { webhooks: unknown[] }).webhooks
  const subscribers: WebhookSubscriberConfig[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Record<string, unknown>
    const prefix = `webhooks[${i}]`

    if (typeof entry.id !== "string" || !entry.id) {
      errors.push(`${prefix}.id is required`)
    }
    if (typeof entry.url !== "string" || !entry.url) {
      errors.push(`${prefix}.url is required`)
    } else if (isPrivateUrl(entry.url as string)) {
      errors.push(`${prefix}.url targets a private/local address — not allowed`)
    }
    if (typeof entry.secret !== "string" || !entry.secret) {
      errors.push(`${prefix}.secret is required`)
    }
    if (!Array.isArray(entry.events) || entry.events.length === 0) {
      errors.push(`${prefix}.events must be a non-empty array of event types`)
    }

    if (errors.length === 0) {
      subscribers.push({
        id: entry.id as string,
        url: entry.url as string,
        secret: entry.secret as string,
        events: entry.events as string[],
        enabled: entry.enabled !== false,
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, subscribers }
}

// --- HMAC Signing ---

export function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex")
}

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = signPayload(secret, payload)
  if (expected.length !== signature.length) return false
  // Constant-time comparison
  let result = 0
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return result === 0
}
