import type { OrganizationAvailability, OrganizationFeature } from "./organization-availability"

export function organizationRouteAvailable(path: string, availability: OrganizationAvailability, params: URLSearchParams): boolean {
  if (/^\/(?:api\/)?boards\//.test(path)) {
    if (params.has("area") && !availability.includes("groups")) return false
    if (params.has("project") && !availability.includes("projects")) return false
    if ((params.get("view") === "groups" || params.get("planning") === "1") && !availability.includes("organizer")) return false
  }
  const routes: [RegExp, OrganizationFeature][] = [
    [/^\/(?:api\/)?areas(?:\/|$)/, "groups"],
    [/^\/(?:api\/)?projects(?:\/|$)/, "projects"],
    [/^\/(?:api\/)?goals(?:\/|$)/, "goals"],
    [/^\/(?:api\/)?(?:habits|routines)(?:\/|$)/, "routines"],
    [/^\/(?:api\/)?pillars(?:\/|$)/, "pillars"],
    [/^\/api\/pillars\/[^/]+\/principles(?:\/|$)/, "principles"],
    [/^\/(?:api\/)?(?:gamification|achievements)(?:\/|$)/, "achievements"],
    [/^\/(?:planning|eisenhower|triage|review)(?:\/|$)/, "planning"],
  ]
  return routes.every(([route, feature]) => !route.test(path) || availability.includes(feature))
}
