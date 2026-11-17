import type { APIContext, APIRoute } from "astro"
import { getCurrentHAUserRoster } from "@domains/ha/ha-users"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { OrganizationAccessRepository, type OrganizationAudience } from "@domains/tasks/persistence/organization-access-repository"
import { apiJson, apiProblem } from "@lib/api-response"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { readBoardRequest } from "@lib/named-board-request"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const noStore = { "cache-control": "private, no-store" }
const field = { scope: "feature", id: "home_assistant_area", boardId: "" } as const

function problem(status: number, detail: string) {
  return apiProblem({ status, detail, extraHeaders: noStore })
}

async function administrator(context: APIContext) {
  const user = verifiedIngressUser(context.locals)
  if (!user?.isAdmin) return problem(403, "Only a current Home Assistant administrator can set feature availability.")
  const access = await currentSettingsAccess(context.request, context.locals, true)
  if (access instanceof Response) return access
  return await getCurrentHAUserRoster(user.id, context.request.signal) ??
    problem(503, "Could not check the Home Assistant user list. Try again later.")
}

export const GET: APIRoute = async context => {
  const roster = await administrator(context)
  if (roster instanceof Response) return roster
  await ensureSchema()
  const records = await new OrganizationAccessRepository(getPersistenceClient()).policies("feature", "")
  if (records.status === "locked") return problem(503, "Feature access is locked. Check the Home Assistant backup restore status.")
  const policy = records.policies.find(item => item.scope.id === field.id)
  const response = apiJson({
    home_assistant_area: { audience: policy?.audience ?? "nobody", users: policy?.users ?? [], revision: policy?.revision ?? null },
    roster: [...roster].map(([id, name]) => ({ id, name: name || "Home Assistant user" })),
  })
  response.headers.set("cache-control", noStore["cache-control"])
  return response
}

export const PUT: APIRoute = async context => {
  const roster = await administrator(context)
  if (roster instanceof Response) return roster
  const body = await readBoardRequest(context.request)
  if (!body || body.feature !== field.id ||
    (body.revision !== null && (typeof body.revision !== "string" || !/^[0-9a-f-]{36}$/.test(body.revision))) ||
    (body.audience !== "everyone" && body.audience !== "selected" && body.audience !== "nobody") ||
    !Array.isArray(body.users) || body.users.length > 256 ||
    body.users.some(id => typeof id !== "string" || !roster.has(id))) {
    return problem(400, "Choose a valid audience and current Home Assistant users.")
  }
  let choice: OrganizationAudience
  if (body.audience === "selected" && body.users.length) {
    choice = { audience: "selected", users: [...new Set<string>(body.users)] }
  } else {
    choice = { audience: body.audience === "everyone" ? "everyone" : "nobody", users: [] }
  }
  await ensureSchema()
  const saved = await new OrganizationAccessRepository(getPersistenceClient()).change(field, body.revision, choice)
  if (saved.status === "locked" || saved.status === "committed-locked") {
    return problem(503, "Feature access is locked. Check the Home Assistant backup restore status.")
  }
  if (saved.result === "stale") return problem(409, "Feature availability changed. Refresh Settings and review the current audience.")
  return new Response(null, { status: 204, headers: noStore })
}
