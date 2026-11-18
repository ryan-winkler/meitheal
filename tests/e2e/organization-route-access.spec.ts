import { expect, test } from "@playwright/test"

import type { OrganizationAvailability, OrganizationFeature } from "../../apps/web/src/lib/organization-availability"
import { organizationRouteAvailable } from "../../apps/web/src/lib/organization-route-access"

function without(...features: OrganizationFeature[]): OrganizationAvailability {
  return { locked: false, needsVerification: true, includes: feature => !features.includes(feature), revision: () => null }
}

test("Empty All Areas scope keeps Household and named Board routes available", () => {
  for (const path of ["/boards/household", "/api/boards/household", "/boards/named-board", "/api/boards/named-board"]) {
    for (const query of ["", "area=", "area=&area="]) {
      expect(organizationRouteAvailable(path, without("groups"), new URLSearchParams(query)), `${path}?${query}`).toBe(true)
    }
  }
})

test("Explicit Area scopes still require Areas availability", () => {
  for (const path of ["/boards/household", "/api/boards/household", "/boards/named-board", "/api/boards/named-board"]) {
    for (const query of ["area=known-area", "area=%20", "area=%09", "area=&area=known-area", "area=known-area&area="]) {
      expect(organizationRouteAvailable(path, without("groups"), new URLSearchParams(query)), `${path}?${query}`).toBe(false)
    }
    expect(organizationRouteAvailable(path, without(), new URLSearchParams("area=known-area"))).toBe(true)
  }
})

test("Empty All Areas scope preserves other organization feature gates", () => {
  for (const path of ["/boards/household", "/api/boards/named-board"]) {
    for (const query of ["area=&project=known-project", "area=&project="]) {
      expect(organizationRouteAvailable(path, without("projects"), new URLSearchParams(query))).toBe(false)
    }
    for (const query of ["area=&view=groups", "area=&planning=1"]) {
      expect(organizationRouteAvailable(path, without("organizer"), new URLSearchParams(query))).toBe(false)
    }
  }
  expect(organizationRouteAvailable("/api/areas", without("groups"), new URLSearchParams("area="))).toBe(false)
})
