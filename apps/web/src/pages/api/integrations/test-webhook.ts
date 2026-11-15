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
import { assertOutboundUrl, fetchOutbound, OutboundUrlError } from "@meitheal/integration-core"
import { logApiError } from "../../../lib/api-logger"
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"

function redactUrlCredentials(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (/^https?:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (parsed.password) parsed.password = "***"
      else if (parsed.username) parsed.username = "***"
      return parsed.href
    } catch {
      // Fall through to linear authority scan for malformed HTTP(S) URLs.
    }
  }
  let authStart = 0
  const schemeColon = trimmed.indexOf(":")
  if (schemeColon > 0) {
    let validScheme = true
    for (let i = 0; i < schemeColon; i++) {
      const c = trimmed.charCodeAt(i)
      const ok =
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (i > 0 && ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46))
      if (!ok) {
        validScheme = false
        break
      }
    }
    const nextChar = trimmed.charCodeAt(schemeColon + 1)
    if (validScheme && (nextChar === 47 || nextChar === 92)) {
      authStart = schemeColon + 1
      while (authStart < trimmed.length) {
        const ch = trimmed.charCodeAt(authStart)
        if (ch !== 47 && ch !== 92) break
        authStart++
      }
    }
  }
  let authorityEnd = trimmed.length
  for (let i = authStart; i < trimmed.length; i++) {
    const ch = trimmed.charCodeAt(i)
    if (ch === 47 || ch === 92 || ch === 63 || ch === 35) {
      authorityEnd = i
      break
    }
  }
  const relAt = trimmed.slice(authStart, authorityEnd).lastIndexOf("@")
  if (relAt < 0) return trimmed
  const absAt = authStart + relAt
  const userinfo = trimmed.slice(authStart, absAt)
  const colonIdx = userinfo.indexOf(":")
  const userPart = colonIdx > 0 ? `${userinfo.slice(0, colonIdx)}:***` : "***"
  return `${trimmed.slice(0, authStart)}${userPart}${trimmed.slice(absAt)}`
}

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    const { ensureSchema, getPersistenceClient, SettingsRepository } = await import("@domains/tasks")
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    // Read the target URL from settings (n8n webhook or generic webhook)
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const targetUrlOverride = typeof body.url === "string" ? body.url : null

    let targetUrl = targetUrlOverride
    let apiKey: string | undefined
    let signingSecret: string | undefined
    let source = "override"

    // SSRF protection: ad-hoc URL overrides must pass the shared outbound policy
    // and cannot target private/loopback/IPv4-mapped addresses (except non-metadata .internal names)
    // either literally or via DNS resolution.
    let allowPrivate = true
    if (targetUrlOverride) {
      try {
        const parsed = assertOutboundUrl(targetUrlOverride)
        const lowerHost = parsed.hostname.toLowerCase()
        let end = lowerHost.length
        while (end > 0 && lowerHost.charCodeAt(end - 1) === 46) {
          end--
        }
        const trimmedHost = lowerHost.slice(0, end)
        allowPrivate = trimmedHost.endsWith(".internal")
        if (!allowPrivate) {
          assertOutboundUrl(parsed, { allowPrivate: false })
        }
        targetUrl = parsed.href
      } catch (err) {
        if (!(err instanceof OutboundUrlError)) throw err
        return new Response(JSON.stringify({
          success: false,
          error: err.message,
        }), { status: 400, headers: { "content-type": "application/json" } })
      }
    }

    if (!targetUrl) {
      // Try n8n webhook first, then generic webhook
      const n8nUrl = await repo.getByKey("n8n_webhook_url")
      const genericUrl = await repo.getByKey("webhook_endpoint")
      const n8nKey = await repo.getByKey("n8n_api_key")
      const n8nSecret = await repo.getByKey("n8n_signing_secret")
      const webhookSecret = await repo.getByKey("webhook_secret")

      if (n8nUrl?.value) {
        targetUrl = String(n8nUrl.value)
        apiKey = n8nKey?.value ? String(n8nKey.value) : undefined
        signingSecret = n8nSecret?.value ? String(n8nSecret.value) : undefined
        source = "n8n"
      } else if (genericUrl?.value) {
        targetUrl = String(genericUrl.value)
        signingSecret = webhookSecret?.value ? String(webhookSecret.value) : undefined
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

    // Send with timeout under the shared outbound policy; report 3xx redirects without following them.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const startTime = Date.now()

    const fetchOpts = {
      method: "POST",
      signal: controller.signal,
      redirect: "manual" as const,
      allowPrivate,
      headers,
      body: payloadString,
    }

    try {
      const response = await fetchOutbound(targetUrl, fetchOpts)
      await response.body?.cancel().catch(() => undefined)

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

      const redactedTargetUrl = redactUrlCredentials(targetUrl)

      return new Response(JSON.stringify({
        success: response.ok,
        source,
        target_url: redactedTargetUrl,
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
      const latencyMs = Date.now() - startTime
      const redactedTargetUrl = redactUrlCredentials(targetUrl)

      const rawError = err instanceof Error
        ? (err.name === "AbortError" ? `Timeout after 10s` : err.message)
        : "Unknown error"
      let errorMessage = rawError
      if (rawError.includes("@")) {
        errorMessage = errorMessage.replaceAll(targetUrl, redactedTargetUrl)
        try {
          errorMessage = errorMessage.replaceAll(new URL(targetUrl).href, redactedTargetUrl)
        } catch {
          // Malformed URL already scrubbed via raw targetUrl replacement.
        }
      }

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
        target_url: redactedTargetUrl,
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
