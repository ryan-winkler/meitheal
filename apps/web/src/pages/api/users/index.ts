import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { customUserKind, UserRepository, IdentityRepository } from "@domains/tasks"
import { listHAUserDirectory, type MeithealUser } from "@domains/ha"

/**
 * GET /api/users — Merged list of HA users + custom users.
 * No auth required — uses existing SUPERVISOR_TOKEN for HA discovery.
 */
export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (_context, scope) => {
  await ensureSchema()
  const repo = new IdentityRepository(getPersistenceClient())

  const [{ users: haUsers, verified }, customRows, defaultAssignee] = await Promise.all([
    listHAUserDirectory(),
    repo.listCustomUsersMinimal(),
    new UserRepository(getPersistenceClient(), scope).getDefaultAssigneeSetting(),
  ])
  const haUserList: MeithealUser[] = haUsers.map((u) => ({
    id: `ha_${u.id}`,
    name: u.name,
    source: "home_assistant" as const,
    kind: "human" as const,
    is_owner: u.is_owner,
  }))

  const customUserList: MeithealUser[] = customRows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      name: String(r.name),
      source: "custom" as const,
      kind: customUserKind(r.kind),
      color: typeof r.color === "string" ? r.color : "#6366f1",
    }
  })

  // Merge: HA users first, then custom
  const users = [...haUserList, ...customUserList]

  return new Response(JSON.stringify({
    users,
    ha_connected: haUsers.length > 0,
    ha_roster_verified: verified,
    default_assignee: defaultAssignee,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, max-age=30, no-store",
    },
  })
})
