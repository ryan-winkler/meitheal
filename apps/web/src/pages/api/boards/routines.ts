import type { APIRoute } from "astro"
import { NamedBoardTaskRepository, ensureSchema, getPersistenceClient } from "@domains/tasks"
import { readBoardPagePlacement } from "@lib/board-page-placement"
import { boardSessionProof } from "@lib/named-board-request"
import { withBoardScope, boardScopeResponse } from "@lib/board-http"
import { apiJson } from "@lib/api-response"
import { isValidTimezone } from "@lib/date"
import { readStoredHouseholdTimezone } from "@lib/task-queries"

export const GET: APIRoute = withBoardScope({ resource: "routine", action: "read" }, async (context, scope) => {
  await ensureSchema()
  const selected = await readBoardPagePlacement(scope, context.url)
  if (!selected.ok) return boardScopeResponse(selected.errorCode)
  const rawTz = context.locals?.timezone?.trim() ?? ""
  const timezone = isValidTimezone(rawTz) ? rawTz : await readStoredHouseholdTimezone()
  const rows = await new NamedBoardTaskRepository(getPersistenceClient(), scope).routineLibrary(scope.principal, selected.placement, timezone)
  const response = apiJson({ items: rows.slice(0, 100), hasMore: rows.length > 100 })
  if (["ha_user", "local_operator"].includes(scope.principal.kind)) response.headers.set("x-meitheal-board-session", boardSessionProof(scope.principal.id))
  return response
})
