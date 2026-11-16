import { expect, test } from "@playwright/test"
import { safeIngressHref } from "../../apps/web/src/lib/ingress-navigation"

const ingress = "/api/hassio_ingress/fixture"

test("app links keep one ingress prefix and preserve the destination", () => {
  const destination = "/tasks?view=calendar#upcoming"
  expect(safeIngressHref(destination, ingress)).toBe(ingress + destination)
  expect(safeIngressHref(ingress + destination, ingress + "/")).toBe(ingress + destination)
  expect(safeIngressHref("today", "")).toBe("/today")
})

test("unsupported link formats fall back to the app root", () => {
  for (const destination of ["mailto:help@example.test", "//example.test", "\\notes"]) {
    expect(safeIngressHref(destination, ingress)).toBe(ingress + "/")
  }
  for (const prefix of ["relative", "//example.test", "/\\notes"]) {
    expect(safeIngressHref("/today", prefix)).toBe("/today")
  }
})
