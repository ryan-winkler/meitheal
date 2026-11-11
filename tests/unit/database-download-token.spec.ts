import { expect, test } from "@playwright/test"
import { issueDatabaseDownloadToken, verifyDatabaseDownloadToken } from "../../apps/web/src/lib/database-download-token"

test("database download tokens expire and are bound to the verified administrator", () => {
  const now = 1_700_000_000_000
  const token = issueDatabaseDownloadToken("admin-a", now)
  expect(verifyDatabaseDownloadToken(token, "admin-a", now)).toBe(true)
  expect(verifyDatabaseDownloadToken(token, "admin-b", now)).toBe(false)
  expect(verifyDatabaseDownloadToken(token, "admin-a", now + 15 * 60 * 1000)).toBe(false)
  const [expiresAt, signature] = token.split(".")
  expect(verifyDatabaseDownloadToken(`${Number(expiresAt) - 1}.${signature}`, "admin-a", now)).toBe(false)
})
