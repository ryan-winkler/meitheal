/**
 * Node-RED Deploy API — POST /api/integrations/nodered/deploy
 *
 * Deploys Meitheal automation flows directly to Node-RED via its Admin API.
 * Non-destructive: merges with existing flows, only replaces the Meitheal tab.
 *
 * @domain integrations
 * @bounded-context nodered
 */
import type { APIRoute } from "astro"
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deployMeithealFlows, type NodeRedFlowNode } from "../../../../lib/nodered-admin"
import { logApiError } from "../../../../lib/api-logger"

let flowCache: NodeRedFlowNode[] | null = null

function loadFlowJson(): NodeRedFlowNode[] {
  if (flowCache) return flowCache

  const paths = [
    join(process.cwd(), "../../integrations/nodered/meitheal-flows.json"),
    join(process.cwd(), "../integrations/nodered/meitheal-flows.json"),
    join(process.cwd(), "integrations/nodered/meitheal-flows.json"),
  ]

  for (const p of paths) {
    try {
      const raw = readFileSync(p, "utf-8")
      flowCache = JSON.parse(raw) as NodeRedFlowNode[]
      return flowCache
    } catch { continue }
  }

  // Fallback: minimal flow with just a tab and comment
  flowCache = [
    {
      id: "meitheal-tab", type: "tab",
      label: "Meitheal Automations",
      info: "Add HA server-events nodes filtered to meitheal_task_* events.",
    },
    {
      id: "meitheal-example", type: "comment",
      z: "meitheal-tab",
      name: "Add 'events: all' nodes for meitheal_task_created, meitheal_task_completed, etc.",
      x: 400, y: 100,
    },
  ]
  return flowCache
}

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    // Only available when running as HA addon
    if (!process.env.SUPERVISOR_TOKEN) {
      return new Response(JSON.stringify({
        success: false,
        error: "not_addon",
        message: "Deploy to Node-RED is only available when running as a Home Assistant addon. Use 'Copy Flow JSON' in standalone mode.",
      }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })
    }

    const flows = loadFlowJson()
    const result = await deployMeithealFlows(flows)

    return new Response(JSON.stringify({
      success: result.success,
      message: result.message,
      flowTabId: result.flowTabId,
      nodeCount: flows.length,
    }), {
      status: result.success ? 200 : 502,
      headers: { "content-type": "application/json" },
    })
  } catch (err) {
    logApiError("nodered-deploy", "Failed to deploy flows to Node-RED", err)
    return new Response(JSON.stringify({
      success: false,
      error: "internal_error",
      message: "Failed to deploy flows to Node-RED",
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }
}
