import type { DomainEvent, IntegrationPlugin } from "./index"
import { signPayload, type WebhookSubscriberConfig } from "./webhook-config"

// --- Types ---

export type WebhookDeliveryStatus = "delivered" | "failed" | "pending_retry"

export interface WebhookDeliveryResult {
  ok: boolean
  deliveryId: string
  subscriberId: string
  eventType: string
  statusCode: number | null
  attempts: number
  finalError?: string | undefined
}

export interface WebhookDeliveryRecord {
  deliveryId: string
  subscriberId: string
  eventType: string
  payload: string
  signature: string
  status: WebhookDeliveryStatus
  statusCode: number | null
  attempts: number
  lastError: string | null
  createdAt: string
  deliveredAt: string | null
}

// --- Retry Configuration ---

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000]
const DELIVERY_TIMEOUT_MS = 10_000

function classifyWebhookError(status: number): { retryable: boolean } {
  if (status === 429 || status >= 500) return { retryable: true }
  return { retryable: false }
}

// --- Core Emitter ---

export async function emitWebhook(
  event: DomainEvent,
  subscriber: WebhookSubscriberConfig
): Promise<WebhookDeliveryResult> {
  const deliveryId = crypto.randomUUID()
  const payload = JSON.stringify(event)
  const signature = signPayload(subscriber.secret, payload)

  let lastStatusCode: number | null = null
  let lastError: string | undefined

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)

    try {
      const isLocalDev = process.env.NODE_ENV !== "production"
      const isInternal = subscriber.url.includes(".internal")
      const originalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED

      if (isLocalDev && isInternal) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0" // lgtm[js/disabling-certificate-pinning] — intentional: dev-only TLS bypass for .internal self-signed certs
      }

      const response = await fetch(subscriber.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-meitheal-signature": `sha256=${signature}`,
          "x-meitheal-event": event.eventType,
          "x-meitheal-delivery-id": deliveryId,
          ...(subscriber.headers ?? {}),
        },
        body: payload,
      })

      if (isLocalDev && isInternal) {
        if (originalTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTls
      }

      lastStatusCode = response.status

      if (response.ok) {
        return {
          ok: true,
          deliveryId,
          subscriberId: subscriber.id,
          eventType: event.eventType,
          statusCode: response.status,
          attempts: attempt + 1,
        }
      }

      const { retryable } = classifyWebhookError(response.status)
      if (!retryable) {
        lastError = `HTTP ${response.status}`
        break
      }

      lastError = `HTTP ${response.status} (attempt ${attempt + 1})`
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = `Timeout after ${DELIVERY_TIMEOUT_MS}ms (attempt ${attempt + 1})`
        lastStatusCode = null
      } else {
        lastError = error instanceof Error ? error.message : "Unknown error"
        break // Network errors are not retryable
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    ok: false,
    deliveryId,
    subscriberId: subscriber.id,
    eventType: event.eventType,
    statusCode: lastStatusCode,
    attempts: RETRY_DELAYS_MS.length + 1,
    finalError: lastError,
  }
}

// --- Webhook Integration Plugin ---

export interface WebhookDispatchDeps {
  subscribers: WebhookSubscriberConfig[]
  onDeliveryResult?: (result: WebhookDeliveryResult, record: WebhookDeliveryRecord) => Promise<void>
}

export function createWebhookPlugin(deps: WebhookDispatchDeps): IntegrationPlugin {
  return {
    key: "webhook-emitter",
    async handle(event: DomainEvent): Promise<void> {
      const matching = deps.subscribers.filter(
        (s) => s.enabled && (s.events.includes("*") || s.events.includes(event.eventType))
      )

      const results = await Promise.allSettled(
        matching.map((subscriber) => emitWebhook(event, subscriber))
      )

      for (const result of results) {
        if (result.status === "fulfilled") {
          const delivery = result.value
          const record: WebhookDeliveryRecord = {
            deliveryId: delivery.deliveryId,
            subscriberId: delivery.subscriberId,
            eventType: delivery.eventType,
            payload: JSON.stringify(event),
            signature: signPayload(
              deps.subscribers.find((s) => s.id === delivery.subscriberId)!.secret,
              JSON.stringify(event)
            ),
            status: delivery.ok ? "delivered" : "failed",
            statusCode: delivery.statusCode,
            attempts: delivery.attempts,
            lastError: delivery.finalError ?? null,
            createdAt: new Date().toISOString(),
            deliveredAt: delivery.ok ? new Date().toISOString() : null,
          }
          await deps.onDeliveryResult?.(delivery, record)
        }
      }
    },
  }
}
