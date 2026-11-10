/**
 * Node-RED Flows API — GET /api/integrations/nodered/flows
 *
 * Returns the pre-built Meitheal example flows as importable JSON
 * for Node-RED. Users can paste this JSON into Node-RED → Import.
 *
 * @domain integrations
 * @bounded-context nodered
 */
import type { APIRoute } from "astro";
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"
import { readFileSync } from "node:fs";
import { join } from "node:path";

let flowCache: string | null = null;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    if (!flowCache) {
      // Resolve from project root — works in both dev and built
      const paths = [
        join(process.cwd(), "../../integrations/nodered/meitheal-flows.json"),
        join(process.cwd(), "../integrations/nodered/meitheal-flows.json"),
        join(process.cwd(), "integrations/nodered/meitheal-flows.json"),
      ];

      for (const p of paths) {
        try {
          flowCache = readFileSync(p, "utf-8");
          break;
        } catch { continue; }
      }

      // Fallback: inline minimal flow
      if (!flowCache) {
        flowCache = JSON.stringify([
          {
            id: "meitheal-tab", type: "tab",
            label: "Meitheal Automations",
            info: "Import this tab then add HA server-events nodes filtered to meitheal_task_* events.",
          },
          {
            id: "meitheal-example", type: "comment",
            z: "meitheal-tab", name: "Add 'events: all' nodes listening for meitheal_task_created, meitheal_task_completed, etc.",
            x: 400, y: 100,
          },
        ], null, 2);
      }
    }

    return new Response(flowCache, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": "attachment; filename=\"meitheal-nodered-flows.json\"",
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Failed to load flows" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
