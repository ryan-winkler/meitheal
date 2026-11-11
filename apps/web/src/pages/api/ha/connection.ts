/**
 * HA Connection Test API
 * GET /api/ha/connection
 *
 * Returns HA connection status in the shape expected by settings.astro:
 *   { connected, version, mode, components, location_name, time_zone, message }
 *
 * @domain ha
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import { getHAConnection, getHAConnectionStatus, getHAConfig } from "@domains/ha";
import { logApiError } from "../../../lib/api-logger";

const headers = { "Cache-Control": "no-store" }

export const GET: APIRoute = async () => {
  const mode = process.env.SUPERVISOR_TOKEN ? "ha-addon" : "standalone"
  if (mode === "standalone") {
    return Response.json({ connected: false, mode, message: "No Supervisor connection in standalone mode" }, { headers })
  }

  try {
    // The passive snapshot is only accurate after the shared connection has had a chance to start.
    await getHAConnection()
    const config = getHAConnectionStatus().connected ? await getHAConfig() : null
    const status = getHAConnectionStatus()

    if (!status.connected) {
      return Response.json({
        connected: false,
        mode,
        message: status.lastError ?? "Home Assistant is unreachable through Supervisor",
      }, { headers })
    }

    return Response.json({
      connected: true,
      version: config?.version ?? status.haVersion ?? "unknown",
      mode,
      components: config?.components ?? [],
      location_name: config?.location_name ?? "",
      time_zone: config?.time_zone ?? "",
    }, { headers })
  } catch (err) {
    logApiError("ha-connection", "Connection test failed", err)
    return Response.json({ connected: false, mode: "unknown", message: "Internal server error" }, { status: 500, headers })
  }
}
