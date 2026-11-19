import { verifiedBoardRequestPrincipal } from "@lib/board-request-context"
import { currentSettingsAccess } from "@lib/current-settings-access"
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
 * atomically initialized beside the local database with owner-only permissions,
 * and credentials saved by older releases with the legacy fallback key are
 * migrated in-place on first read.
 *
 * @domain calendar
 * @bounded-context integration
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { APIRoute } from "astro"
import { testConnection } from "@domains/calendar/caldav-client"
import { ensureSchema, getLocalDataDirectory, getPersistenceClient, SettingsRepository, saveWorkIntegrationSettings } from "@domains/tasks"
import { logApiError, logApiWarn } from "../../../../lib/api-logger"
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"

// ─── Encryption Helpers ─────────────────────────────────────────────

const ALGO = "aes-256-gcm"
const IV_LEN = 16
const TAG_LEN = 16
const KEY_FILE = "caldav-credentials.key"

// Pre-0.0.2 public fallback KDF input ("meitheal-dev-fallback-key" in hex),
// retained strictly for one-time decryption + automatic re-encryption migration.
const LEGACY_KDF_INPUT_HEX = "6d6569746865616c2d6465762d66616c6c6261636b2d6b6579"

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code
}

function parseKeyHex(raw: string, file: string): Buffer {
  const trimmed = raw.trim()
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error(`${file} is not a 32-byte hex key`)
  }
  return Buffer.from(trimmed, "hex")
}

function resolveCredentialKeyDirectory(): string | null {
  const explicitDir = process.env.MEITHEAL_DATA_DIR?.trim()
  if (explicitDir) return explicitDir
  const localDir = getLocalDataDirectory()
  if (localDir) return localDir
  const rawDbUrl = (process.env.MEITHEAL_DB_URL ?? "").trim()
  if (rawDbUrl && !/^(?:file:|:memory:)/i.test(rawDbUrl)) {
    return path.join(homedir(), ".local", "share", "meitheal")
  }
  return null
}

function fsyncDirectoryBestEffort(directory: string): void {
  try {
    const dirFd = openSync(directory, "r")
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // Some container/virtual filesystems do not support directory fsync.
  }
}

/**
 * Read the per-install key, or atomically initialize it (0600) via a private
 * temporary file + hard link so concurrent callers and interrupted writes
 * never overwrite or expose a partial key.
 */
function installKey(): Buffer {
  const directory = resolveCredentialKeyDirectory()
  if (!directory) {
    throw new Error("CalDAV credentials need SUPERVISOR_TOKEN, HA_TOKEN or a local database directory for their encryption key")
  }
  const file = path.join(directory, KEY_FILE)
  try {
    return parseKeyHex(readFileSync(file, "utf8"), file)
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) throw err
  }

  mkdirSync(directory, { recursive: true })
  const tmpFile = path.join(directory, `${KEY_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  const fd = openSync(tmpFile, "wx", 0o600)
  try {
    writeFileSync(fd, randomBytes(32).toString("hex"), "utf8")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  let published = false
  try {
    linkSync(tmpFile, file)
    published = true
  } catch (err) {
    if (!isErrnoCode(err, "EEXIST")) throw err
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch {
      // Best-effort cleanup of the private temporary file.
    }
  }
  if (published) {
    fsyncDirectoryBestEffort(directory)
  }
  return parseKeyHex(readFileSync(file, "utf8"), file)
}

function hasHaToken(): boolean {
  return Boolean(process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN)
}

/** The 32-byte AES key for CalDAV passwords. */
function deriveKey(): Buffer {
  const token = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN
  return token ? scryptSync(token, "meitheal-caldav-salt", 32) : installKey()
}

function deriveLegacyMigrationKey(): Buffer {
  return scryptSync(Buffer.from(LEGACY_KDF_INPUT_HEX, "hex"), "meitheal-caldav-salt", 32)
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

function encrypt(plaintext: string): string {
  return encryptWithKey(plaintext, deriveKey())
}

function decryptWithKey(encoded: string, key: Buffer): string {
  const trimmed = encoded.trim()
  const normalized = trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed
  const raw = Buffer.from(normalized, "base64")
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error("Truncated CalDAV ciphertext")
  }
  const iv = raw.subarray(0, IV_LEN)
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

function migrateLegacyStoredPassword(legacyEncoded: string, reencrypted: string): void {
  try {
    const client = getPersistenceClient()
    void client.execute({
      sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'caldav_password_enc' AND (value = ? OR value = ?)",
      args: [reencrypted, Date.now(), legacyEncoded, JSON.stringify(legacyEncoded)],
    }).catch(() => {
      logApiWarn("caldav-credentials", "Failed to persist migrated CalDAV credential; will retry on next read")
    })
  } catch {
    // Non-fatal if persistence is not open during an isolated unit call.
  }
}

/** @internal — exported for bridge sync use only */
export function decryptCalDAVPassword(encoded: string): string {
  const primaryKey = deriveKey()
  try {
    return decryptWithKey(encoded, primaryKey)
  } catch {
    if (!hasHaToken()) {
      try {
        const plaintext = decryptWithKey(encoded, deriveLegacyMigrationKey())
        const upgraded = encryptWithKey(plaintext, primaryKey)
        migrateLegacyStoredPassword(encoded, upgraded)
        return plaintext
      } catch {
        // Fall through to actionable error below.
      }
    }
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

    const access = await currentSettingsAccess(request, locals, true)
    if (access instanceof Response) return access
    const principal = await verifiedBoardRequestPrincipal({ request, locals }, true)
    if (!principal || !await saveWorkIntegrationSettings(getPersistenceClient(), principal, [
      { key: "caldav_url", value: url },
      { key: "caldav_username", value: username },
      { key: "caldav_password_enc", value: encryptedPassword },
    ])) return Response.json({ ok: false, error: "Review management access for every CalDAV destination Board before changing this profile." }, { status: 409 })

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

    const access = await currentSettingsAccess(request, locals, true)
    if (access instanceof Response) return access
    const principal = await verifiedBoardRequestPrincipal({ request, locals }, true)
    if (!principal || !await saveWorkIntegrationSettings(getPersistenceClient(), principal, CALDAV_KEYS.map(key => ({ key, value: "" })))) {
      return Response.json({ ok: false, error: "Review management access for every CalDAV destination Board before removing this profile." }, { status: 409 })
    }

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
