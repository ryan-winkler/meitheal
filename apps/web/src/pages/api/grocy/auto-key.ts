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
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"
import { logApiError } from "../../../lib/api-logger"
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

    // If no URL provided, try to detect Grocy addon via Supervisor
    if (!grocyUrl) {
      try {
        const addonsRes = await supervisorFetch("/addons")
        if (addonsRes?.ok) {
          const addonsData = (await addonsRes.json()) as {
            data?: { addons?: { slug: string; ingress_url?: string; state?: string }[] }
          }
          const grocy = addonsData.data?.addons?.find(
            (a) => a.slug.includes("grocy") && a.state === "started"
          )
          if (grocy?.ingress_url) {
            grocyUrl = `http://supervisor${grocy.ingress_url}`
          }
        }
      } catch { /* auto-detect failed — need manual URL */ }
    }

    if (!grocyUrl) {
      return new Response(
        JSON.stringify({ ok: false, error: "No Grocy URL provided and auto-detection failed" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // Attempt to create an API key via Supervisor ingress (authenticated by HA session)
    // Direct fetch won't work — Grocy requires auth for API key creation
    let createRes: Response | null = null
    try {
      // Try Supervisor-proxied request first (works for HA addon installs)
      const supervisorRes = await supervisorFetch(
        `/addons/a0d7b954_grocy/proxy/api/objects/api_keys`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ key_type: "default" }),
        }
      )
      if (supervisorRes?.ok) {
        createRes = supervisorRes
      }
    } catch { /* Supervisor proxy failed — try direct */ }

    // Fallback: direct API call (works if Grocy ingress session is active)
    if (!createRes) {
      try {
        createRes = await fetch(`${grocyUrl.replace(/\/$/, "")}/api/objects/api_keys`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ key_type: "default" }),
        })
      } catch { /* direct fetch also failed */ }
    }

    if (!createRes || !createRes.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Failed to create API key: ${createRes ? `HTTP ${createRes.status}` : "Connection failed"}. Create one manually in Grocy → Settings → API Keys.`,
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
      const { ensureSchema, getPersistenceClient } = await import("@domains/tasks/persistence/store")
      const { SettingsRepository } = await import("@domains/tasks/persistence/settings-repository")
      await ensureSchema()
      const repo = new SettingsRepository(getPersistenceClient())
      await repo.ensureSettingsTable()

      await repo.upsert("grocy_url", grocyUrl)
      await repo.upsert("grocy_api_key", apiKey)
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
