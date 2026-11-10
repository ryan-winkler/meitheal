import { expect, test } from "@playwright/test"
import * as auth from "../../packages/domain-auth/src/index"
import { readFileSync } from "node:fs"

test("production auth exposes no always-verified passkey mock", () => {
  expect("createWebAuthnMock" in auth).toBe(false)
  expect(readFileSync(new URL("../../apps/web/src/content/config/auth.yaml", import.meta.url), "utf8")).toContain("enabled: false")
})
