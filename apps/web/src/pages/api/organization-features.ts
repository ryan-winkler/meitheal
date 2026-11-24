import { verifiedBoardRequestPrincipal } from "@lib/board-request-context"
import type { APIContext, APIRoute } from "astro"
import { getCurrentHAUserRoster } from "@domains/ha/ha-users"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import {
  OrganizationAccessRepository,
  type OrganizationAudience
} from "@domains/tasks/persistence/organization-access-repository"
import { apiJson, apiProblem } from "@lib/api-response"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { boardSessionProof, readBoardRequest } from "@lib/named-board-request"
import {
  ORGANIZATION_FEATURES,
  inheritedOrganizationAvailability,
  type OrganizationFeature
} from "@lib/organization-availability"
import { getStoredFeatureFlags } from "@lib/feature-flags"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const noStore = { "cache-control": "private, no-store" }

function problem(status: number, detail: string) {
  return apiProblem({ status, detail, extraHeaders: noStore })
}

async function administrator(context: APIContext) {
  const user = verifiedIngressUser(context.locals)
  if (!user?.isAdmin)
    return problem(403, "Only a current Home Assistant administrator can set feature availability.")
  const access = await currentSettingsAccess(context.request, context.locals, true)
  if (access instanceof Response) return access
  const roster = await getCurrentHAUserRoster(user.id, context.request.signal)
  const principal = await verifiedBoardRequestPrincipal(context)
  return roster && principal
    ? { roster, principal, proof: boardSessionProof(user.id) }
    : problem(503, "Could not check the Home Assistant user list. Try again later.")
}

export const HEAD: APIRoute = async (context) => {
  const admin = await administrator(context)
  if (admin instanceof Response)
    return new Response(null, { status: admin.status, headers: noStore })
  return new Response(null, {
    status: 204,
    headers: { ...noStore, "x-meitheal-area-admin": admin.proof }
  })
}

export const GET: APIRoute = async (context) => {
  const admin = await administrator(context)
  if (admin instanceof Response) return admin
  const { roster, proof } = admin
  await ensureSchema()
  const records = await new OrganizationAccessRepository(getPersistenceClient()).policies(
    "feature",
    ""
  )
  if (records.status === "locked")
    return problem(503, "Feature access is locked. Check the Home Assistant backup restore status.")
  const flags = await getStoredFeatureFlags()
  const features = Object.fromEntries(
    Object.entries(ORGANIZATION_FEATURES).map(([id, definition]) => {
      const policy = records.policies.find((item) => item.scope.id === id)
      return [
        id,
        {
          label: definition.label,
          audience:
            policy?.audience ??
            (inheritedOrganizationAvailability(id as OrganizationFeature, flags)
              ? "everyone"
              : "nobody"),
          users: policy?.users ?? [],
          revision: policy?.revision ?? null
        }
      ]
    })
  )
  const response = apiJson({
    features,
    home_assistant_area: features.home_assistant_area,
    roster: [...roster].map(([id, name]) => ({ id, name: name || "Home Assistant user" }))
  })
  response.headers.set("cache-control", noStore["cache-control"])
  response.headers.set("x-meitheal-area-admin", proof)
  return response
}

export const PUT: APIRoute = async (context) => {
  const admin = await administrator(context)
  if (admin instanceof Response) return admin
  const { roster, proof } = admin
  if (context.request.headers.get("x-meitheal-area-admin") !== proof) {
    return problem(412, "The Home Assistant administrator session changed. Reopen Settings.")
  }
  const body = await readBoardRequest(context.request)
  if (
    !body ||
    typeof body.feature !== "string" ||
    !Object.hasOwn(ORGANIZATION_FEATURES, body.feature) ||
    (body.revision !== null &&
      (typeof body.revision !== "string" || !/^[0-9a-f-]{36}$/.test(body.revision))) ||
    (body.audience !== "everyone" && body.audience !== "selected" && body.audience !== "nobody") ||
    !Array.isArray(body.users) ||
    body.users.length > 256 ||
    body.users.some((id) => typeof id !== "string" || !roster.has(id))
  ) {
    return problem(400, "Choose a valid audience and current Home Assistant users.")
  }
  let choice: OrganizationAudience
  if (body.audience === "selected" && body.users.length) {
    choice = { audience: "selected", users: [...new Set<string>(body.users)] }
  } else {
    choice = { audience: body.audience === "everyone" ? "everyone" : "nobody", users: [] }
  }
  await ensureSchema()
  const saved = await new OrganizationAccessRepository(getPersistenceClient()).change(
    {
      scope: "feature",
      id: body.feature,
      boardId: ""
    },
    body.revision,
    choice,
    admin.principal
  )
  if (saved.status === "locked" || saved.status === "committed-locked") {
    return problem(503, "Feature access is locked. Check the Home Assistant backup restore status.")
  }
  if (saved.result === "stale")
    return problem(
      409,
      "Feature availability changed. Refresh Settings and review the current audience."
    )
  return new Response(null, { status: 204, headers: noStore })
}
