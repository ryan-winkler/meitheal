import type { APIRoute } from "astro"
import { NamedBoardTaskRepository, ensureSchema, getPersistenceClient } from "@domains/tasks"
import { withBoardScope } from "@lib/board-http"
import { apiJson } from "@lib/api-response"
import { calendarToday } from "@lib/date"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (context, scope) => {
  await ensureSchema()
  const rows = await new NamedBoardTaskRepository(getPersistenceClient(), scope).dueWork(scope.principal, calendarToday(context.locals.timezone ?? "Europe/Dublin"))
  return apiJson({ items: rows.slice(0, 100), hasMore: rows.length > 100 })
})
