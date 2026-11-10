/**
 * HA Addons API — list installed HA Supervisor add-ons
 *
 * GET /api/ha/addons
 *
 * Queries the HA Supervisor REST API for installed add-ons.
 * Used by SettingsIntegrations.astro to auto-detect Grocy, n8n, Node-RED, etc.
 *
 * @domain ha
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import { logApiError, logApiWarn } from "../../../lib/api-logger";
import { supervisorFetch } from "../../../lib/supervisor-fetch";

interface SupervisorAddon {
  slug: string;
  name: string;
  state: string;
  version: string;
  ingress_url?: string;
  ingress?: boolean;
}

export const GET: APIRoute = async () => {
  try {
    const res = await supervisorFetch("/addons");
    if (!res) {
      return new Response(
        JSON.stringify({ addons: [], message: "Not running as HA addon" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!res.ok) {
      // 403/401 = addon lacks sufficient hassio_role for /addons endpoint.
      // This is expected on older deployments with hassio_role: default.
      // Don't log as error — it's a known config issue, not a crash.
      if (res.status === 403 || res.status === 401) {
        logApiWarn("ha-addons", `Supervisor API returned ${res.status} — addon may need hassio_role: manager`);
        return new Response(
          JSON.stringify({ addons: [], message: "Insufficient permissions — upgrade addon to enable auto-discovery" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      logApiError("ha-addons", `Supervisor API returned ${res.status}`, new Error(`HTTP ${res.status}`));
      return new Response(
        JSON.stringify({ addons: [], message: `Supervisor API error: ${res.status}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = (await res.json()) as {
      data?: { addons?: SupervisorAddon[] };
    };

    const addons = (data.data?.addons ?? []).map((a) => ({
      slug: a.slug,
      name: a.name,
      state: a.state,
      version: a.version,
      ingress_url: a.ingress_url ?? null,
    }));

    return new Response(JSON.stringify({ addons }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("ha-addons", "Failed to query Supervisor API", err);
    return new Response(
      JSON.stringify({ addons: [], message: "Failed to query Supervisor API" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
