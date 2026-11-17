import type { APIContext } from "astro"
import { getCurrentHAUserRoster } from "@domains/ha/ha-users"
import {
  allowsOrganizationAudience, OrganizationAccessRepository, type OrganizationPolicy,
} from "@domains/tasks/persistence/organization-access-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { getFeatureFlags, type FeatureFlags } from "./feature-flags"
import { verifiedIngressUser } from "./verified-ingress-user"

export const ORGANIZATION_FEATURES = {
  organizer: { label: "Boards organizer" },
  groups: { label: "Groups" },
  projects: { label: "Projects" },
  planning: { label: "Planning" },
  goals: { label: "Goals" },
  routines: { label: "Routines", legacy: "habits" },
  pillars: { label: "Pillars" },
  principles: { label: "Principles" },
  achievements: { label: "Achievements", legacy: "gamification" },
  home_assistant_area: { label: "Home Assistant Area", defaultAvailable: false },
} as const satisfies Record<string, { label: string; legacy?: string; defaultAvailable?: boolean }>

export type OrganizationFeature = keyof typeof ORGANIZATION_FEATURES
type AccessContext = Pick<APIContext, "locals" | "request">

const features = Object.keys(ORGANIZATION_FEATURES) as OrganizationFeature[]
const byRequest = new WeakMap<App.Locals, Promise<OrganizationAvailability>>()

export interface OrganizationAvailability {
  locked: boolean
  includes: (feature: OrganizationFeature) => boolean
  revision: (feature: OrganizationFeature) => string | null
}

export function inheritedOrganizationAvailability(feature: OrganizationFeature, flags: FeatureFlags): boolean {
  const definition = ORGANIZATION_FEATURES[feature]
  if ("legacy" in definition) return flags[definition.legacy] !== false
  return "defaultAvailable" in definition ? definition.defaultAvailable : true
}

export function resolveOrganizationAvailability(
  policies: readonly OrganizationPolicy[], flags: FeatureFlags, activeUserId: string | null,
): OrganizationAvailability {
  const decisions = new Map(policies.map(policy => [policy.scope.id, policy]))
  const available = new Set(features.filter(feature => {
    const policy = decisions.get(feature)
    return policy ? allowsOrganizationAudience(policy, activeUserId) : inheritedOrganizationAvailability(feature, flags)
  }))
  if (!available.has("pillars")) available.delete("principles")
  return {
    locked: false,
    includes: feature => available.has(feature),
    revision: feature => decisions.get(feature)?.revision ?? null,
  }
}

const unavailable: OrganizationAvailability = { locked: true, includes: () => false, revision: () => null }

export function getOrganizationAvailability(context: AccessContext): Promise<OrganizationAvailability> {
  const previous = byRequest.get(context.locals)
  if (previous) return previous
  const pending = loadOrganizationAvailability(context).catch(() => unavailable)
  byRequest.set(context.locals, pending)
  return pending
}

async function loadOrganizationAvailability(context: AccessContext): Promise<OrganizationAvailability> {
  await ensureSchema()
  const repository = new OrganizationAccessRepository(getPersistenceClient())
  const [policies, flags] = await Promise.all([repository.policies("feature", ""), getFeatureFlags()])
  if (policies.status === "locked") return unavailable
  const user = verifiedIngressUser(context.locals)
  const selected = user && policies.policies.some(policy => policy.audience === "selected" && policy.users.includes(user.id))
  const active = selected ? await getCurrentHAUserRoster(user.id, context.request.signal) : null
  return resolveOrganizationAvailability(policies.policies, flags, active ? user?.id ?? null : null)
}
