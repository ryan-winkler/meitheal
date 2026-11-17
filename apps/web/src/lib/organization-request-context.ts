import { AsyncLocalStorage } from "node:async_hooks"
import type { OrganizationAvailability, OrganizationFeature } from "./organization-availability"

const context = new AsyncLocalStorage<OrganizationAvailability>()

export function withOrganizationAvailability<T>(availability: OrganizationAvailability, run: () => T): T {
  return context.run(availability, run)
}

export function isOrganizationFeatureAvailable(feature: OrganizationFeature): boolean {
  return context.getStore()?.includes(feature) ?? true
}

export function effectiveOrganizationFlags(flags: Record<string, boolean>) {
  const availability = context.getStore()
  if (!availability) return flags
  return {
    ...flags,
    organizer: availability.includes("organizer"),
    groups: availability.includes("groups"),
    projects: availability.includes("projects"),
    planning: availability.includes("planning"),
    goals: availability.includes("goals"),
    pillars: availability.includes("pillars"),
    principles: availability.includes("principles"),
    habits: availability.includes("routines"),
    gamification: availability.includes("achievements"),
  }
}


export function organizationNeedsVerification(): boolean {
  return context.getStore()?.needsVerification ?? false
}
