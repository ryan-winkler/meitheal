/**
 * External Connector Test & Idempotent Sync API (Admin-Only)
 *
 * Runs built-in external connectors (GitHub Issues, Gitea Issues) through
 * the SSRF-hardened plugin HTTP gateway and imports items idempotently into
 * Meitheal tasks using `externalId` as `idempotency_key`.
 *
 * @domain plugins
 * @bounded-context plugins
 */
import type { APIRoute } from "astro"
import { getPluginService } from "@domains/plugins"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiError, apiJson, apiProblem } from "../../../../lib/api-response"
import { readWithinLimit } from "../../../../lib/bounded-body"
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"
import { STATUS } from "../../../../lib/status-config"

const NO_STORE = { "Cache-Control": "private, no-store" }
const MAX_CONNECTOR_BODY_BYTES = 16 * 1024

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

function pluginJson(data: unknown, status = 200): Response {
  const res = apiJson(data, status)
  res.headers.set("Cache-Control", "private, no-store")
  return res
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  const id = params.id ?? ""
  const rawBytes = await readWithinLimit(request.body, MAX_CONNECTOR_BODY_BYTES, request.signal)
  if (!rawBytes) {
    return apiProblem({ status: 413, title: "Payload Too Large", detail: "Connector request exceeds 16 KB.", extraHeaders: NO_STORE })
  }
  let body: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch { body = null }
  const action = typeof body?.action === "string" ? body.action : "test"
  const service = getPluginService()

  try {
    if (action === "test") {
      const result = await service.testConnector(id)
      if (!result.ok) {
        return apiProblem({ status: result.status ?? 400, title: result.errorCode, detail: result.error, extraHeaders: NO_STORE })
      }
      return pluginJson(result.data)
    }

    if (action === "sync") {
      const fetched = await service.fetchConnectorItems(id)
      if (!fetched.ok) {
        return apiProblem({ status: fetched.status ?? 400, title: fetched.errorCode, detail: fetched.error, extraHeaders: NO_STORE })
      }

      await ensureSchema()
      const db = getPersistenceClient()
      let createdCount = 0
      let skippedCount = 0
      const now = Date.now()

      for (const item of fetched.data) {
        const key = `plugin:${item.externalId}`
        const existing = await db.execute({
          sql: "SELECT id FROM tasks WHERE idempotency_key = ? LIMIT 1",
          args: [key],
        })
        if (existing.rows.length > 0) {
          skippedCount += 1
          continue
        }
        const taskId = `task_${crypto.randomUUID()}`
        const description = item.url
          ? `${item.description ? `${item.description}\n\n` : ""}Source: ${item.url}`
          : (item.description ?? "")
        await db.execute({
          sql: `INSERT INTO tasks (id, title, description, status, due_date, request_id, idempotency_key, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [taskId, item.title, description, STATUS.PENDING, item.dueDate ?? null, key, key, now, now],
        })
        createdCount += 1
      }

      logger.audit({
        event: "audit.plugins.connector_synced",
        domain: "audit",
        component: "plugins-api",
        request_id: crypto.randomUUID(),
        message: "External connector sync completed",
        metadata: { plugin_id: id, created_count: createdCount, skipped_count: skippedCount },
      })
      return pluginJson({ synced: true, createdCount, skippedCount, totalFetched: fetched.data.length })
    }

    return apiProblem({
      status: 400,
      title: "Invalid Action",
      detail: 'Action must be "test" or "sync".',
      extraHeaders: NO_STORE,
    })
  } catch {
    return apiError("Connector operation failed", 500)
  }
}
