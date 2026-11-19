import type { APIRoute } from "astro"
import { NamedBoardTaskRepository, ensureSchema, getPersistenceClient } from "@domains/tasks"
import { withBoardScope } from "@lib/board-http"
import { apiJson } from "@lib/api-response"

export const GET: APIRoute = withBoardScope({ resource: "routine", action: "read" }, async (context, scope) => {
  await ensureSchema()
  const rows = await new NamedBoardTaskRepository(getPersistenceClient(), scope).routineLibrary(scope.principal)
  return apiJson({ items: rows.slice(0, 100), hasMore: rows.length > 100 })
})
