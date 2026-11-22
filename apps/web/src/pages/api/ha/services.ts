import type { APIRoute } from "astro"
import { getHAConnection } from "@domains/ha/ha-connection"
import {
  loadWebserverSnapshotView,
  type HaAddonOptionsPayload,
  type SupervisorServiceEntry,
} from "@domains/webserver"
import { logApiError } from "@lib/api-logger"
import { canManageSystemSettings } from "@lib/settings-security"

/**
 * GET /api/ha/services — List available HA Core services, Supervisor services,
 * and (for administrators) Meitheal's Webserver add-on options projection.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const isAdmin = canManageSystemSettings(request, locals)
    let supervisorServices: SupervisorServiceEntry[] = []
    let webserverOptions: HaAddonOptionsPayload | undefined

    if (isAdmin) {
      try {
        const view = await loadWebserverSnapshotView(request)
        supervisorServices = view.supervisor.supervisorServices
        webserverOptions = view.haOptions
      } catch {
        // Non-fatal: HA Core services still load independently
      }
    }

    const conn = await getHAConnection()
    if (!conn) {
      return new Response(JSON.stringify({
        services: [],
        supervisorServices,
        ...(webserverOptions ? { webserverOptions } : {}),
        error: "No HA connection",
      }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "private, no-store" },
      })
    }

    const result = await conn.sendMessagePromise({ type: "get_services" }) as Record<string, unknown>

    const services: { domain: string; services: Record<string, unknown> }[] = []
    if (result && typeof result === "object") {
      for (const [domain, svcDefs] of Object.entries(result)) {
        if (typeof svcDefs === "object" && svcDefs !== null) {
          services.push({ domain, services: svcDefs as Record<string, unknown> })
        }
      }
    }

    return new Response(JSON.stringify({
      services,
      supervisorServices,
      ...(webserverOptions ? { webserverOptions } : {}),
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": isAdmin ? "private, no-store" : "private, max-age=60",
      },
    })
  } catch (err) {
    logApiError("ha-services", err instanceof Error ? err.message : String(err), { endpoint: "/api/ha/services" })
    return new Response(JSON.stringify({ services: [], supervisorServices: [], error: "Failed to fetch HA services" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}
