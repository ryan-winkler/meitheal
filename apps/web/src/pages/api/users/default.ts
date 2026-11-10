import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { UserRepository } from "@domains/tasks/persistence/user-repository"

/**
 * Default assignee setting.
 * GET  /api/users/default — Get current default assignee
 * PUT  /api/users/default — Set default assignee { user_id } (null to clear)
 */
export const GET: APIRoute = async () => {
  await ensureSchema()
  const repo = new UserRepository(getPersistenceClient())
  const value = await repo.getDefaultAssigneeSetting()

  return new Response(JSON.stringify({ default_assignee: value }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  })
}

export const PUT: APIRoute = async ({ request }) => {
  await ensureSchema()
  const repo = new UserRepository(getPersistenceClient())
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const userId = body.user_id

  if (userId === null || userId === undefined || userId === "") {
    await repo.clearDefaultAssignee()
    return new Response(JSON.stringify({ default_assignee: null }), {
      status: 200, headers: { "content-type": "application/json" },
    })
  }

  if (typeof userId !== "string") {
    return new Response(JSON.stringify({ error: "user_id must be a string or null" }), {
      status: 400, headers: { "content-type": "application/json" },
    })
  }

  if (userId.length > 255) {
    return new Response(JSON.stringify({ error: "user_id exceeds max length (255)" }), {
      status: 400, headers: { "content-type": "application/json" },
    })
  }

  if (!/^(ha_|custom_)/.test(userId)) {
    return new Response(JSON.stringify({ error: "user_id must start with 'ha_' or 'custom_'" }), {
      status: 400, headers: { "content-type": "application/json" },
    })
  }

  await repo.setDefaultAssignee(userId)

  return new Response(JSON.stringify({ default_assignee: userId }), {
    status: 200, headers: { "content-type": "application/json" },
  })
}
