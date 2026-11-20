import type { APIRoute } from "astro"
import {
  syncFromGrocy,
  getGrocySyncStatus,
  startGrocySync,
  stopGrocySync,
  getActiveGrocySyncConfig
} from "@domains/grocy"
import { withBoardScope, boardScopeErrorResponse } from "@lib/board-http"
import { requestIntegrationBinding } from "@lib/integration-binding-access"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { createGrocyClient } from "@lib/grocy-client"
import { apiJson, apiError } from "@lib/api-response"

export const GET: APIRoute = withBoardScope(
  { resource: "task", action: "read" },
  async (_context, scope) => apiJson({ ok: true, sync: await getGrocySyncStatus(scope) })
)
export const POST: APIRoute = async (context) => {
  const raw: unknown = await context.request.json().catch(() => null)
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return apiError("Choose a Grocy action and approved destination.", 400)
  const body = raw as Record<string, unknown>
  if (Object.hasOwn(body, "board_id"))
    return apiError("Select the Board using the request context.", 400)
  const action = body.action ?? "sync"
  if (!["sync", "enable", "disable"].includes(String(action)))
    return apiError("Choose sync, enable or disable.", 400)
  return withBoardScope(
    { resource: "board", action: "manage" },
    async (requestContext, scope) => {
      try {
        if (action !== "sync") {
          const access = await currentSettingsAccess(
            requestContext.request,
            requestContext.locals,
            true
          )
          if (access instanceof Response) return access
        }
        const approved = await requestIntegrationBinding(scope, "grocy", "grocy.sync", body, {
          resource: "board",
          action: "manage"
        })
        if (!approved?.ok)
          return apiError("Choose a current approved Grocy destination in this Board.", 404)
        const { binding } = approved.value
        if (action === "disable") {
          stopGrocySync(binding.id, binding.generation)
          return apiJson({ ok: true, message: "Grocy sync disabled for this destination." })
        }
        if (action === "enable") {
          const mode = body.sync_mode ?? "bidirectional",
            interval = body.interval_ms ?? 900000
          if (
            !["import", "export", "bidirectional"].includes(String(mode)) ||
            typeof interval !== "number" ||
            !Number.isSafeInteger(interval) ||
            interval < 0 ||
            interval > 2147483647
          )
            return apiError("Choose a valid Grocy mode and interval.", 400)
          const started = await startGrocySync(
            {
              bindingId: binding.id,
              generation: binding.generation,
              syncEnabled: true,
              syncMode: mode as "import" | "export" | "bidirectional",
              intervalMs: interval
            },
            createGrocyClient,
            approved.value
          )
          if (!started)
            return apiError(
              "Grocy configuration is unavailable. Check its URL and API key in Settings.",
              409
            )
          return apiJson({ ok: true, message: "Grocy sync enabled for this destination." })
        }
        const active = getActiveGrocySyncConfig(binding.id)
        if (!active || active.generation !== binding.generation)
          return apiError("Enable this approved Grocy destination before syncing.", 409)
        const result = await syncFromGrocy(binding.id, scope, {
          resource: "board",
          action: "manage"
        })
        return apiJson(
          {
            ok: result.errors === 0,
            ...result,
            status: await getGrocySyncStatus(scope),
            message: result.errors
              ? "Grocy sync was incomplete. Check this destination and retry."
              : "Grocy sync completed."
          },
          result.errors ? 409 : 200
        )
      } catch (error) {
        return (
          boardScopeErrorResponse(error) ??
          apiError("Grocy sync is unavailable. Check this destination and retry.", 503)
        )
      }
    },
    { write: true }
  )(context)
}
