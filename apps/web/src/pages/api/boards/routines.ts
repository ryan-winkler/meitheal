import type { APIRoute } from "astro"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiJson } from "@lib/api-response"
import { isOrganizationFeatureAvailable as available } from "@lib/organization-request-context"
import { boardSessionProof, currentBoardUser } from "@lib/named-board-request"

export const GET: APIRoute = async ({ locals, request }) => {
  const user = available("routines") ? await currentBoardUser(locals, request.signal) : null
  await ensureSchema()
  const rows = user ? await new NamedBoardTaskRepository(getPersistenceClient()).routineLibrary(user.actor) : []
  const response = apiJson({ items: rows.slice(0, 100), hasMore: rows.length > 100 })
  response.headers.set("cache-control", "private, no-store")
  if (user) response.headers.set("x-meitheal-board-session", boardSessionProof(user.actor.id))
  return response
}
