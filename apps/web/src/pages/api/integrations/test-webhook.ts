/**
 * Test Webhook API — POST /api/integrations/test-webhook
 *
 * Sends a test payload to the configured n8n/generic webhook URL
 * so users can verify standalone webhook delivery works.
 *
 * Mirrors test-event.ts (which tests the HA event bus) but for
 * the HTTP webhook path used in standalone mode.
 *
 * @domain integrations
 * @bounded-context event-dispatch
 */
import type { APIRoute } from "astro"
import { logApiError } from "../../../lib/api-logger"
import { bypassTlsIfNeeded, restoreTls } from "../../../lib/n8n-fetch"

export const POST: APIRoute = async ({ request }) => {
  try {
    const { ensureSchema, getPersistenceClient } = await import("@domains/tasks/persistence/store")
    const { SettingsRepository } = await import("@domains/tasks/persistence/settings-repository")
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    // Read the target URL from settings (n8n webhook or generic webhook)
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const targetUrlOverride = typeof body.url === "string" ? body.url : null

    let targetUrl = targetUrlOverride
    let apiKey = ""
    let signingSecret = ""
    let source = "override"

    if (!targetUrl) {
      // Try n8n webhook first, then generic webhook
      const n8nUrl = await repo.getByKey("n8n_webhook_url")
      const genericUrl = await repo.getByKey("webhook_endpoint")
      const n8nKey = await repo.getByKey("n8n_api_key")
      const n8nSecret = await repo.getByKey("n8n_signing_secret")
      const webhookSecret = await repo.getByKey("webhook_secret")

      if (n8nUrl?.value) {
        targetUrl = String(n8nUrl.value)
        apiKey = n8nKey?.value ? String(n8nKey.value) : ""
        signingSecret = n8nSecret?.value ? String(n8nSecret.value) : ""
        source = "n8n"
      } else if (genericUrl?.value) {
        targetUrl = String(genericUrl.value)
        signingSecret = webhookSecret?.value ? String(webhookSecret.value) : ""
        source = "generic"
      }
    }

    if (!targetUrl) {
      return new Response(JSON.stringify({
        success: false,
        error: "No webhook URL configured",
        hint: "Enter a webhook URL in Settings → Integrations → n8n or Webhooks, then try again.",
      }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })
    }

    // Build test payload
    const testPayload = {
      eventId: crypto.randomUUID(),
      eventType: "webhook.test",
      occurredAt: new Date().toISOString(),
      requestId: crypto.randomUUID(),
      payload: {
        task_id: "test-webhook",
        title: "Meitheal Webhook Test",
        status: "test",
        description: "This is a test event to verify webhook delivery is working.",
        ticket_key: "MTH-TEST",
        task_type: "test",
      },
    }

    // Build headers
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-meitheal-event": "webhook.test",
      "x-meitheal-delivery-id": testPayload.eventId,
    }

    if (apiKey) {
      headers["authorization"] = `Bearer ${apiKey}`
    }

    const payloadString = JSON.stringify(testPayload)

    if (signingSecret) {
      const { createHmac } = await import("node:crypto")
      const signature = createHmac("sha256", signingSecret).update(payloadString).digest("hex")
      headers["x-meitheal-signature"] = `sha256=${signature}`
    }

    // Send with timeout + TLS bypass
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const startTime = Date.now()
    const tlsCtx = bypassTlsIfNeeded(targetUrl)

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: payloadString,
      })

      restoreTls(tlsCtx)
      const latencyMs = Date.now() - startTime

      // Persist delivery result for UI display (same key as webhook-dispatcher)
      const deliveryResult = {
        success: response.ok,
        status: response.status,
        timestamp: new Date().toISOString(),
        latency_ms: latencyMs,
        error: response.ok ? null : `HTTP ${response.status}`,
      }

      try {
        await repo.upsert("n8n_last_delivery", JSON.stringify(deliveryResult))
      } catch { /* non-critical */ }

      return new Response(JSON.stringify({
        success: response.ok,
        source,
        target_url: targetUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@"),
        status_code: response.status,
        latency_ms: latencyMs,
        timestamp: deliveryResult.timestamp,
        hint: response.ok
          ? `✅ Webhook delivered (${response.status}) in ${latencyMs}ms — check your n8n/webhook receiver for the test payload`
          : `⚠ Webhook returned ${response.status} — the endpoint may not be ready or configured to accept POST requests`,
      }), {
        status: response.ok ? 200 : 502,
        headers: { "content-type": "application/json" },
      })
    } catch (err) {
      restoreTls(tlsCtx)
      const latencyMs = Date.now() - startTime

      const errorMessage = err instanceof Error
        ? (err.name === "AbortError" ? `Timeout after 10s` : err.message)
        : "Unknown error"

      // Persist failure for UI display
      try {
        await repo.upsert("n8n_last_delivery", JSON.stringify({
          success: false,
          status: null,
          timestamp: new Date().toISOString(),
          latency_ms: latencyMs,
          error: errorMessage,
        }))
      } catch { /* non-critical */ }

      return new Response(JSON.stringify({
        success: false,
        source,
        target_url: targetUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@"),
        status_code: null,
        latency_ms: latencyMs,
        error: errorMessage,
        timestamp: new Date().toISOString(),
        hint: `❌ Failed to reach webhook endpoint — ${errorMessage}`,
      }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    logApiError("test-webhook", "Failed to send test webhook", err)
    return new Response(JSON.stringify({
      success: false,
      error: "Internal error sending test webhook",
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }
}
