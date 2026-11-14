/**
 * CalDAV Credentials API — Encrypted credential management
 *
 * POST — save/test CalDAV credentials
 * GET  — check if credentials exist (never returns password)
 * DELETE — remove credentials
 *
 * Passwords are encrypted at rest using AES-256-GCM. The key is derived from
 * SUPERVISOR_TOKEN or HA_TOKEN when one is set (unchanged, so existing
 * ciphertexts keep decrypting). Without either, a random per-install key is
 * created beside the local database with owner-only permissions. There is no
 * built-in fallback key.
 *
 * @domain calendar
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ensureSchema, getLocalDataDirectory, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { testConnection } from "@domains/calendar/caldav-client"
import { logApiError } from "../../../../lib/api-logger"

// ─── Encryption Helpers ─────────────────────────────────────────────

const ALGO = "aes-256-gcm"
const IV_LEN = 16
const TAG_LEN = 16

const KEY_FILE = "caldav-credentials.key"

/** Read the per-install key, creating it (0600) on first use. */
function installKey(): Buffer {
  const directory = getLocalDataDirectory()
  if (!directory) {
    throw new Error("CalDAV credentials need SUPERVISOR_TOKEN, HA_TOKEN or a local database directory for their encryption key")
  }
  const file = path.join(directory, KEY_FILE)
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
  }
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex")
  if (key.length !== 32) throw new Error(`${file} is not a 32-byte hex key`)
  return key
}

/** The 32-byte AES key for CalDAV passwords. */
function deriveKey(): Buffer {
  const token = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN
  return token ? scryptSync(token, "meitheal-caldav-salt", 32) : installKey()
}

function encrypt(plaintext: string): string {
  const key = deriveKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

/** @internal — exported for bridge sync use only */
export function decryptCalDAVPassword(encoded: string): string {
  const key = deriveKey()
  const raw = Buffer.from(encoded, "base64")
  const iv = raw.subarray(0, IV_LEN)
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN)
  try {
    const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN })
    decipher.setAuthTag(tag)
    return decipher.update(ciphertext) + decipher.final("utf8")
  } catch {
    throw new Error("The saved CalDAV password cannot be decrypted with this install's key; enter it again in Settings → Integrations")
  }
}

// ─── CalDAV Settings Keys ───────────────────────────────────────────

const CALDAV_KEYS = ["caldav_url", "caldav_username", "caldav_password_enc"] as const

// ─── API Routes ─────────────────────────────────────────────────────

/**
 * GET — check if CalDAV credentials are configured
 * Returns { configured: boolean, url?: string, username?: string }
 * NEVER returns the password.
 */
export const GET: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const settings = await repo.getByKeys([...CALDAV_KEYS])

    return new Response(JSON.stringify({
      ok: true,
      configured: !!(settings.caldav_url && settings.caldav_password_enc),
      url: (settings.caldav_url as string) || null,
      username: (settings.caldav_username as string) || null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  } catch (err) {
    logApiError("caldav-credentials", "GET failed", err)
    return new Response(
      JSON.stringify({ ok: false, error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

/**
 * POST — save or test CalDAV credentials
 * Body: { action: "save" | "test", url, username, password }
 */
export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    let body: { action?: "save" | "test"; url?: string; username?: string; password?: string }
    try {
      body = await request.json()
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const { url, username, password } = body
    if (!url || !username || !password) {
      return new Response(
        JSON.stringify({ ok: false, error: "url, username, and password are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const action = body.action ?? "save"

    if (action === "test") {
      const result = await testConnection({ url, username, password })
      return new Response(JSON.stringify(result), {
        status: 200, headers: { "Content-Type": "application/json" },
      })
    }

    // Save: encrypt password and store atomically
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()
    const encryptedPassword = encrypt(password)

    await repo.importBatch([
      { key: "caldav_url", value: url },
      { key: "caldav_username", value: username },
      { key: "caldav_password_enc", value: encryptedPassword },
    ])

    return new Response(JSON.stringify({
      ok: true, message: "CalDAV credentials saved securely",
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  } catch (err) {
    logApiError("caldav-credentials", "POST failed", err)
    return new Response(
      JSON.stringify({ ok: false, error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

/**
 * DELETE — remove CalDAV credentials
 */
export const DELETE: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    await repo.deleteByKeys([...CALDAV_KEYS])

    return new Response(JSON.stringify({
      ok: true, message: "CalDAV credentials removed",
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  } catch (err) {
    logApiError("caldav-credentials", "DELETE failed", err)
    return new Response(
      JSON.stringify({ ok: false, error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
