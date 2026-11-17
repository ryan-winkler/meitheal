import type { APIContext } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { OrganizationAccessRepository } from "@domains/tasks/persistence/organization-access-repository"
import { apiProblem } from "./api-response"
import { currentSettingsAccess } from "./current-settings-access"

const governed: Record<string, string> = { feature_habits: "routines", feature_gamification: "achievements" }

export async function organizationLegacyFeatureWrite(
  request: Request, locals: APIContext["locals"], keys: string[],
): Promise<Response | null> {
  const features = keys.flatMap(key => governed[key] ? [governed[key]!] : [])
  if (!features.length) return null
  const access = await currentSettingsAccess(request, locals, true)
  if (access instanceof Response) return access
  await ensureSchema()
  const policies = await new OrganizationAccessRepository(getPersistenceClient()).policies("feature", "")
  if (policies.status === "locked") return apiProblem({ status: 503, detail: "Feature availability is locked. Check the restore status." })
  if (policies.policies.some(policy => features.includes(policy.scope.id))) {
    return apiProblem({
      status: 409, detail: "Manage this feature's audience in Settings → Tasks & Boards → Organization features.",
      extraHeaders: { "cache-control": "private, no-store" },
    })
  }
  return null
}
