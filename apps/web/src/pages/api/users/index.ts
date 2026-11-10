import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { UserRepository } from "@domains/tasks/persistence/user-repository"
import { listHAUsers, type MeithealUser } from "@domains/ha/ha-users"

/**
 * GET /api/users — Merged list of HA users + custom users.
 * No auth required — uses existing SUPERVISOR_TOKEN for HA discovery.
 */
export const GET: APIRoute = async () => {
  await ensureSchema()
  const repo = new UserRepository(getPersistenceClient())

  // Fetch HA users (auto-discovered, cached 60s)
  const haUsers = await listHAUsers()
  const haUserList: MeithealUser[] = haUsers.map((u) => ({
    id: `ha_${u.id}`,
    name: u.name,
    source: "home_assistant" as const,
    is_owner: u.is_owner,
  }))

  // Fetch custom users from SQLite via repository
  const customRows = await repo.listCustomUsersMinimal()
  const customUserList: MeithealUser[] = customRows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      name: String(r.name),
      source: "custom" as const,
      color: typeof r.color === "string" ? r.color : "#6366f1",
    }
  })

  // Merge: HA users first, then custom
  const users = [...haUserList, ...customUserList]

  // Fetch default assignee setting via repository
  const defaultAssignee = await repo.getDefaultAssigneeSetting()

  return new Response(JSON.stringify({
    users,
    ha_connected: haUsers.length > 0,
    default_assignee: defaultAssignee,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, max-age=30, no-store",
    },
  })
}
