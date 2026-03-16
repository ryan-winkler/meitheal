/**
 * Node-RED Status API — GET /api/integrations/nodered/status
 *
 * Checks Node-RED reachability and whether Meitheal flows are deployed.
 * Returns addon info, flow deployment status, and ingress URL.
 *
 * @domain integrations
 * @bounded-context nodered
 */
import type { APIRoute } from "astro"
import { getNodeRedStatus } from "../../../../lib/nodered-admin"
import { supervisorFetch } from "../../../../lib/supervisor-fetch"
import { logApiError } from "../../../../lib/api-logger"

export const GET: APIRoute = async () => {
  try {
    // Only available when running as HA addon
    if (!process.env.SUPERVISOR_TOKEN) {
      return new Response(JSON.stringify({
        available: false,
        reason: "not_addon",
        message: "Node-RED status is only available when running as a Home Assistant addon.",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    // Try to get Node-RED addon info from Supervisor for the ingress URL
    let ingressUrl: string | undefined
    let addonState: string | undefined
    try {
      const addonRes = await supervisorFetch("/addons/a0d7b954_nodered/info")
      if (addonRes?.ok) {
        const addonData = await addonRes.json() as {
          data?: {
            ingress_url?: string
            state?: string
            version?: string
          }
        }
        ingressUrl = addonData.data?.ingress_url ?? undefined
        addonState = addonData.data?.state ?? undefined
      }
    } catch { /* addon not installed or inaccessible */ }

    // Check Node-RED reachability and flow status
    const status = await getNodeRedStatus(ingressUrl)

    return new Response(JSON.stringify({
      available: true,
      reachable: status.reachable,
      flowDeployed: status.flowDeployed,
      flowTabId: status.flowTabId,
      nodeRedUrl: status.nodeRedUrl,
      addonState: addonState ?? (status.reachable ? "started" : "unknown"),
      addonSlug: status.addonSlug,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  } catch (err) {
    logApiError("nodered-status", "Failed to check Node-RED status", err)
    return new Response(JSON.stringify({
      available: false,
      reason: "error",
      message: "Failed to check Node-RED status",
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }
}
