import { hasBoardSelection, unavailableBoardResponse } from "@domains/tasks/board-availability"
import { readBoardCustomFieldDefs, writeBoardCustomFieldDefs } from "@domains/tasks/custom-fields"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { withBoardScope } from "@lib/board-http"
import { apiError, apiJson } from "@lib/api-response"
import { BUILT_IN_CUSTOM_FIELDS, normalizeCustomFieldDefs } from "@lib/custom-field-defs"
import type { APIRoute } from "astro"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (_context, scope) => {
  await ensureSchema()
  const fields = await readBoardCustomFieldDefs(getPersistenceClient(), scope)
  return apiJson({
    boardId: scope.boardId,
    fields,
    builtIn: BUILT_IN_CUSTOM_FIELDS,
  })
})

export const PUT: APIRoute = withBoardScope({ resource: "board", action: "manage" }, async ({ request }, scope) => {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("Expected a JSON object with a fields array", 400)
  }
  if (hasBoardSelection(body)) return unavailableBoardResponse()
  if (!Array.isArray(body.fields)) {
    return apiError("fields must be an array of custom field definitions", 400)
  }

  await ensureSchema()
  const fields = await writeBoardCustomFieldDefs(
    getPersistenceClient(),
    scope,
    normalizeCustomFieldDefs(body.fields),
  )
  return apiJson({
    boardId: scope.boardId,
    fields,
    builtIn: BUILT_IN_CUSTOM_FIELDS,
  })
})
