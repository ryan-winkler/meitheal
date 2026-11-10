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

export const GET: APIRoute = async () => {
  try {
    // Ensure the HA connection is attempted before checking status.
    // getHAConnectionStatus() only reads the in-memory singleton;
    // without this call it would always report "disconnected" if no
    // other code path has triggered getHAConnection() yet.
    await getHAConnection();

    const status = getHAConnectionStatus();
    const mode = process.env.SUPERVISOR_TOKEN ? "ha-addon" : "standalone";

    if (!status.connected) {
      return new Response(JSON.stringify({
        connected: false,
        mode,
        message: status.lastError ?? "HA not reachable",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const config = await getHAConfig().catch(() => null);

    return new Response(JSON.stringify({
      connected: true,
      version: config?.version ?? status.haVersion ?? "unknown",
      mode,
      components: config?.components ?? [],
      location_name: config?.location_name ?? "",
      time_zone: config?.time_zone ?? "",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("ha-connection", "Connection test failed", err);
    return new Response(JSON.stringify({
      connected: false,
      mode: "unknown",
      message: "Internal server error",
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
