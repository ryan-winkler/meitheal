/**
 * Grocy Test API — Connection Validation
 *
 * POST /api/grocy/test — validates Grocy URL + API key
 * Returns Grocy version info and entity counts on success.
 *
 * @domain grocy
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import { GrocyAdapter, validateGrocyBaseUrl } from "@meitheal/integration-core";
import { requireSystemSettingsAdmin } from "../../../lib/settings-security";
import { logApiError } from "../../../lib/api-logger";
import { supervisorFetch } from "../../../lib/supervisor-fetch";

/**
 * POST /api/grocy/test
 * Body: { url: string, api_key: string }
 *
 * Tests connection to a Grocy instance and returns system info.
 */
export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals);
  if (denied) return denied;
  try {
    let body: { url?: string; api_key?: string; auto_detected?: boolean };

    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let url = body.url?.trim();
    let apiKey = body.api_key?.trim();
    const autoDetected = body.auto_detected === true;

    // SSRF protection: validate user-supplied URL
    if (url) {
      const urlCheck = validateGrocyBaseUrl(url);
      if (!urlCheck.ok) {
        return new Response(JSON.stringify({ ok: false, error: urlCheck.error }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      url = urlCheck.normalizedUrl;
    }

    // For auto-detected installs, resolve URL via Supervisor if not provided
    if (autoDetected && !url) {
      try {
        const addonsRes = await supervisorFetch("/addons");
        if (addonsRes?.ok) {
          const addonsData = (await addonsRes.json()) as {
            data?: { addons?: { slug: string; ingress_url?: string; state?: string }[] };
          };
          const grocy = addonsData.data?.addons?.find(
            (a) => a.slug.includes("grocy") && a.state === "started"
          );
          if (typeof grocy?.ingress_url === "string" && grocy.ingress_url.startsWith("/") && !grocy.ingress_url.startsWith("//")) {
            url = `http://supervisor${grocy.ingress_url}`;
          }
        }
      } catch { /* Supervisor detection failed */ }
    }

    // For auto-detected installs, try fetching API key from saved settings
    if (autoDetected && !apiKey) {
      try {
        const { ensureSchema, getPersistenceClient } = await import("@domains/tasks/persistence/store")
        const { SettingsRepository } = await import("@domains/tasks/persistence/settings-repository")
        await ensureSchema()
        const repo = new SettingsRepository(getPersistenceClient())
        await repo.ensureSettingsTable()
        const result = await repo.getByKey("grocy_api_key")
        if (result?.value && typeof result.value === "string") {
          apiKey = result.value
        }
      } catch { /* Settings lookup failed */ }
    }

    if (!url || !apiKey) {
      const missing = !url && !apiKey ? "URL and API key" : !url ? "URL" : "API key";
      return new Response(
        JSON.stringify({ ok: false, error: `${missing} required. ${autoDetected ? "Try the ⚡ Auto button to generate an API key, or create one in Grocy → Settings → API Keys." : ""}` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const adapter = new GrocyAdapter({ baseUrl: url, apiKey, timeoutMs: 5000 });

    // Test connection with system info endpoint
    const sysResult = await adapter.getSystemInfo();

    if (!sysResult.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Connection failed: ${sysResult.message}`,
          errorCode: sysResult.errorCode,
          retryable: sysResult.retryable,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fetch counts for display
    let choreCount = 0;
    let taskCount = 0;
    let shoppingCount = 0;

    const [choresRes, tasksRes, shoppingRes] = await Promise.allSettled([
      adapter.getChores(),
      adapter.getTasks(false),
      adapter.getShoppingList(),
    ]);

    if (choresRes.status === "fulfilled" && choresRes.value.ok) {
      choreCount = choresRes.value.data.length;
    }
    if (tasksRes.status === "fulfilled" && tasksRes.value.ok) {
      taskCount = tasksRes.value.data.length;
    }
    if (shoppingRes.status === "fulfilled" && shoppingRes.value.ok) {
      shoppingCount = shoppingRes.value.data.length;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        version: sysResult.data.grocyVersionInfo.Version,
        releaseDate: sysResult.data.grocyVersionInfo.ReleaseDate,
        counts: { chores: choreCount, tasks: taskCount, shoppingItems: shoppingCount },
        message: `Connected to Grocy ${sysResult.data.grocyVersionInfo.Version}`,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    logApiError("grocy-test", "POST failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
