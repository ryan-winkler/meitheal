import { createCipheriv, randomBytes, scryptSync } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { decryptCalDAVPassword } from "../../apps/web/src/pages/api/integrations/calendar/caldav-credentials"

function encryptWith(secret: string, plaintext: string): string {
  const key = scryptSync(secret, "meitheal-caldav-salt", 32)
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
}

test("without a token, CalDAV passwords use a private secret beside the database and older passwords still decrypt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-caldav-key-"))
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_TOKEN"].map(key => [key, process.env[key]]))
  try {
    delete process.env.SUPERVISOR_TOKEN
    delete process.env.HA_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`

    // A password saved by an older release with the public fallback secret is still readable.
    expect(decryptCalDAVPassword(encryptWith("meitheal-dev-fallback-key", "legacy-secret"))).toBe("legacy-secret")

    // Reading created the private secret with owner-only permissions.
    const keyFile = join(directory, ".caldav-key")
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600)

    // A value encrypted with some other secret is rejected rather than decrypted with a guessable key.
    expect(() => decryptCalDAVPassword(encryptWith("someone-else", "nope"))).toThrow()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
