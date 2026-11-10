import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { UserRepository } from "@domains/tasks/persistence/user-repository"
import { sanitize } from "../../../lib/sanitize"

/**
 * Custom (non-HA) users CRUD.
 * GET  /api/users/custom — List custom users
 * POST /api/users/custom — Create custom user { name, color? }
 */
export const GET: APIRoute = async () => {
  await ensureSchema()
  const repo = new UserRepository(getPersistenceClient())
  const rows = await repo.listCustomUsers()
  const users = rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      name: String(r.name),
      color: String(r.color ?? "#6366f1"),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    }
  })
  return new Response(JSON.stringify({ users }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  })
}

export const POST: APIRoute = async ({ request }) => {
  await ensureSchema()
  const repo = new UserRepository(getPersistenceClient())
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  const rawName = typeof body.name === "string" ? body.name.trim() : ""
  const name = sanitize(rawName)
  if (!name || name.length > 100) {
    return new Response(JSON.stringify({ error: "name is required (max 100 chars)" }), {
      status: 400, headers: { "content-type": "application/json" },
    })
  }

  const color = typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color)
    ? body.color : "#6366f1"

  if (await repo.countCustomUsers() >= 50) {
    return new Response(JSON.stringify({ error: "Maximum 50 custom users allowed" }), {
      status: 409, headers: { "content-type": "application/json" },
    })
  }

  if (await repo.customUserNameExists(name)) {
    return new Response(JSON.stringify({ error: "A custom user with this name already exists" }), {
      status: 409, headers: { "content-type": "application/json" },
    })
  }

  const id = `custom_${crypto.randomUUID().slice(0, 8)}`
  const now = await repo.createCustomUser(id, name, color)

  return new Response(JSON.stringify({ id, name, color, created_at: now, updated_at: now }), {
    status: 201, headers: { "content-type": "application/json" },
  })
}

export const DELETE: APIRoute = async ({ request }) => {
  await ensureSchema()
  const repo = new UserRepository(getPersistenceClient())
  const url = new URL(request.url)
  const id = url.searchParams.get("id")?.trim() ?? ""

  if (!id) {
    return new Response(JSON.stringify({ error: "id is required" }), {
      status: 400, headers: { "content-type": "application/json" },
    })
  }

  if (!(await repo.customUserExists(id))) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404, headers: { "content-type": "application/json" },
    })
  }

  await repo.deleteCustomUser(id)

  return new Response(JSON.stringify({ deleted: true }), {
    status: 200, headers: { "content-type": "application/json" },
  })
}
