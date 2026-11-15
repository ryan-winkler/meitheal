/**
 * Grocy Auto-Key API — Automatic API Key Generation
 *
 * POST /api/grocy/auto-key — attempts to create a Grocy API key automatically.
 * Used when Grocy addon is detected via HA Supervisor but no API key is configured.
 *
 * @domain grocy
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { validateGrocyBaseUrl } from "@meitheal/integration-core"
import { logApiError } from "../../../lib/api-logger"
import {
  isLegacySupervisorIngressUrl,
  resolveSupervisorGrocyAddon,
  resolveSupervisorGrocySlugForUrl,
} from "../../../lib/grocy-client"
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"
import { supervisorFetch } from "../../../lib/supervisor-fetch"

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    let body: { url?: string } = {}
    try {
      body = await request.json()
    } catch { /* empty body = auto-detect */ }

    let grocyUrl = body.url?.trim()
    let legacyIngressHint: string | undefined
    if (grocyUrl && isLegacySupervisorIngressUrl(grocyUrl)) {
      legacyIngressHint = grocyUrl
      grocyUrl = undefined
    }
    if (grocyUrl) {
      const urlCheck = validateGrocyBaseUrl(grocyUrl)
      if (!urlCheck.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: urlCheck.error }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      }
      grocyUrl = urlCheck.normalizedUrl
    }

    // Resolve matching Supervisor Grocy add-on slug only when auto-detecting or when
    // the caller-supplied URL matches a started Supervisor Grocy add-on container URL.
    let detectedSlug: string | null = null
    if (!grocyUrl) {
      const detected = legacyIngressHint
        ? await resolveSupervisorGrocyAddon(legacyIngressHint)
        : await resolveSupervisorGrocyAddon()
      if (detected) {
        grocyUrl = detected.url
        detectedSlug = detected.slug
      }
    } else {
      detectedSlug = await resolveSupervisorGrocySlugForUrl(grocyUrl)
    }

    if (!grocyUrl) {
      return new Response(
        JSON.stringify({ ok: false, error: "No Grocy URL provided and auto-detection failed" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // Attempt to create an API key via Supervisor ingress only for a matched Supervisor add-on
    let createRes: Response | null = null
    if (detectedSlug) {
      try {
        const supervisorRes = await supervisorFetch(
          `/addons/${encodeURIComponent(detectedSlug)}/proxy/api/objects/api_keys`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ key_type: "default" }),
          },
        )
        if (supervisorRes?.ok) {
          createRes = supervisorRes
        } else {
          await supervisorRes?.body?.cancel().catch(() => undefined)
        }
      } catch { /* Supervisor proxy failed — try direct */ }
    }

    // Fallback: direct API call (works if Grocy ingress session is active)
    if (!createRes) {
      try {
        const autoKeyTarget = new URL("api/objects/api_keys", `${grocyUrl.replace(/\/$/, "")}/`)
        createRes = await fetch(autoKeyTarget.href, { // nosemgrep
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ key_type: "default" }),
        })
      } catch { /* direct fetch also failed */ }
    }

    if (!createRes || !createRes.ok) {
      const failedStatus = createRes?.status
      await createRes?.body?.cancel().catch(() => undefined)
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Failed to create API key: ${failedStatus ? `HTTP ${failedStatus}` : "Connection failed"}. Create one manually in Grocy → Settings → API Keys.`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    const createData = (await createRes.json()) as Record<string, unknown>
    const apiKey = String(createData.created_object_id ?? createData.api_key ?? "")

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "API key creation succeeded but no key was returned. Create one manually in Grocy → Settings → API Keys.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    // Save the key to settings via SettingsRepository
    try {
      const { ensureSchema, getPersistenceClient, SettingsRepository } = await import("@domains/tasks")
      await ensureSchema()
      const repo = new SettingsRepository(getPersistenceClient())
      await repo.ensureSettingsTable()

      await repo.upsert("grocy_url", JSON.stringify(grocyUrl))
      await repo.upsert("grocy_api_key", JSON.stringify(apiKey))
    } catch (err) {
      logApiError("grocy-auto-key", "Failed to save settings", err)
      // Still return the key even if saving failed
    }

    return new Response(
      JSON.stringify({
        ok: true,
        apiKey: apiKey.length > 4 ? "••••" + apiKey.slice(-4) : "••••",
        url: grocyUrl,
        message: "API key created and saved automatically",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  } catch (err) {
    logApiError("grocy-auto-key", "POST failed", err)
    return new Response(
      JSON.stringify({ ok: false, error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
