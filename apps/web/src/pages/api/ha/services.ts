import type { APIRoute } from "astro";
import { getHAConnection } from "@domains/ha/ha-connection";
import { logApiError } from "@lib/api-logger";

/**
 * GET /api/ha/services — List available HA services.
 * Returns array of { domain, services } objects from the HA WebSocket API.
 * Used by the notification settings to discover notify.mobile_app_* targets.
 */
export const GET: APIRoute = async () => {
  try {
    const conn = await getHAConnection();
    if (!conn) {
      return new Response(JSON.stringify({ services: [], error: "No HA connection" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Use HA WebSocket message type "get_services"
    const result = await conn.sendMessagePromise({ type: "get_services" }) as Record<string, unknown>;

    // HA returns an object keyed by domain, each containing an object of service definitions.
    // Transform to array of { domain, services } for easier client-side consumption.
    const services: { domain: string; services: Record<string, unknown> }[] = [];
    if (result && typeof result === "object") {
      for (const [domain, svcDefs] of Object.entries(result)) {
        if (typeof svcDefs === "object" && svcDefs !== null) {
          services.push({ domain, services: svcDefs as Record<string, unknown> });
        }
      }
    }

    return new Response(JSON.stringify({ services }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, max-age=60",
      },
    });
  } catch (err) {
    logApiError("ha-services", err instanceof Error ? err.message : String(err), { endpoint: "/api/ha/services" });
    return new Response(JSON.stringify({ services: [], error: "Failed to fetch HA services" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
};
