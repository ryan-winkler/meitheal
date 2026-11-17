import type { APIRoute } from "astro"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiJson } from "@lib/api-response"
import { calendarToday } from "@lib/date"
import { currentBoardUser } from "@lib/named-board-request"

export const GET: APIRoute = async ({ locals, request }) => {
  const user = await currentBoardUser(locals, request.signal)
  const rows = user ? await dueWork(user.actor, calendarToday(locals.timezone ?? "Europe/Dublin")) : []
  const response = apiJson({ items: rows.slice(0, 30), hasMore: rows.length > 30 })
  response.headers.set("cache-control", "private, no-store")
  return response
}

async function dueWork(actor: { kind: "ha_user"; id: string }, day: string) {
  await ensureSchema()
  return new NamedBoardTaskRepository(getPersistenceClient()).dueWork(actor, day)
}
