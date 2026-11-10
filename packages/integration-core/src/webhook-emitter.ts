import { fetchWithDevelopmentTls } from "./development-fetch"
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

  // Pre-compute span ID for traceparent propagation (avoid per-attempt string ops)
  const deliverySpanId = deliveryId.replace(/-/g, "").slice(0, 16)

  let lastStatusCode: number | null = null
  let lastError: string | undefined

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)

    try {
      const fetchOpts = {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          // ── Meitheal signature headers ──
          "x-meitheal-signature": `sha256=${signature}`,
          "x-meitheal-event": event.eventType,
          "x-meitheal-delivery-id": deliveryId,
          // ── CNCF CloudEvents 1.0 (binary content mode) ──
          "ce-specversion": "1.0",
          "ce-id": event.eventId ?? deliveryId,
          "ce-type": `io.meitheal.${event.eventType}`,
          "ce-source": event.source ?? "/meitheal",
          "ce-time": event.occurredAt ?? new Date().toISOString(),
          ...(event.payload && typeof event.payload === "object" && "id" in event.payload
            ? { "ce-subject": String((event.payload as Record<string, unknown>).id) }
            : {}),
          // ── W3C Traceparent propagation ──
          ...(event.traceId
            ? { traceparent: `00-${event.traceId}-${deliverySpanId}-01` }
            : {}),
          ...(subscriber.headers ?? {}),
        },
        body: payload,
      }

      const response = await fetchWithDevelopmentTls(subscriber.url, fetchOpts)
      await response.body?.cancel().catch(() => undefined)

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
