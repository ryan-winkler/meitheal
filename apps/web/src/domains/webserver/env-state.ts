/**
 * Webserver Environment State Reader — Strict Allowlist (.env + process.env)
 *
 * Server-only module that unifies live `process.env` and canonical `.env` file
 * state into a single, secret-free snapshot for the Webserver service layer.
 *
 * Security invariants (OWASP Top 10 / AGENTS.md):
 *   1. Strict allowlist: ONLY non-secret webserver/runtime keys are ever parsed
 *      or retained; tokens, passwords, and API keys in `.env` or `process.env`
 *      are discarded at parse time and never stored, logged, or returned.
 *   2. Fixed path confinement: `.env` locations are derived only from canonical
 *      process/workspace roots (never user input), verified with `lstatSync` to
 *      reject symlinks, non-regular files, and files larger than 64 KB.
 *   3. Real-time freshness: cached by `(path, mtimeMs, size)` so edits to `.env`
 *      reflect immediately without stale state or redundant disk reads.
 *
 * @domain webserver
 * @bounded-context configuration
 */
import { lstatSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export const ALLOWED_WEBSERVER_ENV_KEYS = [
  "PORT",
  "HOST",
  "MEITHEAL_PORTS",
  "MEITHEAL_HOST",
  "MEITHEAL_SERVER_NAME",
  "MEITHEAL_INTERNAL_URL",
  "MEITHEAL_EXTERNAL_URL",
  "SITE_URL",
  "HA_BASE_URL",
  "HA_URL",
  "TZ",
  "NODE_ENV",
] as const

export type AllowedWebserverEnvKey = (typeof ALLOWED_WEBSERVER_ENV_KEYS)[number]

const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_WEBSERVER_ENV_KEYS)
const MAX_DOTENV_BYTES = 65_536
const MAX_ENV_VALUE_LEN = 2048

export interface DotenvFileState {
  found: boolean
  fileLabel: string | null
  values: Partial<Record<AllowedWebserverEnvKey, string>>
  keys: AllowedWebserverEnvKey[]
}

export type EnvKeyOrigin = "process_env" | "dotenv" | "unset"

export interface UnifiedEnvSnapshot {
  processEnv: Partial<Record<AllowedWebserverEnvKey, string>>
  dotenv: DotenvFileState
  merged: Partial<Record<AllowedWebserverEnvKey, string>>
  keyOrigin: Record<AllowedWebserverEnvKey, EnvKeyOrigin>
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 0x1f || c === 0x7f) return true
  }
  return false
}

function sanitizeEnvValue(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_ENV_VALUE_LEN || hasControlChars(trimmed)) return null
  return trimmed
}

/**
 * Pure linear-time `.env` parser that extracts ONLY allowlisted non-secret keys.
 * Every non-allowlisted key (secrets, tokens, credentials) is ignored immediately.
 */
export function parseAllowlistedDotenvContent(content: string): Partial<Record<AllowedWebserverEnvKey, string>> {
  const result: Partial<Record<AllowedWebserverEnvKey, string>> = {}
  const lines = content.split(/\r?\n/)

  for (const rawLine of lines) {
    let line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("export ")) line = line.slice(7).trim()

    const eqIdx = line.indexOf("=")
    if (eqIdx <= 0) continue

    const key = line.slice(0, eqIdx).trim()
    if (!ALLOWED_KEY_SET.has(key)) continue

    let rawVal = line.slice(eqIdx + 1).trim()
    if (rawVal.length >= 2 && ((rawVal.startsWith("\"") && rawVal.endsWith("\"")) || (rawVal.startsWith("'") && rawVal.endsWith("'")))) {
      rawVal = rawVal.slice(1, -1)
    } else {
      const commentIdx = rawVal.indexOf(" #")
      if (commentIdx !== -1) rawVal = rawVal.slice(0, commentIdx).trim()
    }

    const clean = sanitizeEnvValue(rawVal)
    if (clean !== null) {
      result[key as AllowedWebserverEnvKey] = clean
    }
  }

  return result
}

interface DotenvCacheEntry {
  mtimeMs: number
  size: number
  values: Partial<Record<AllowedWebserverEnvKey, string>>
}

const dotenvCache = new Map<string, DotenvCacheEntry>()

function defaultCandidateDotenvFiles(): Array<{ path: string; label: string }> {
  const cwd = process.cwd()
  const candidates: Array<{ path: string; label: string }> = [
    { path: resolve(cwd, ".env"), label: ".env" },
    { path: resolve(cwd, "../../.env"), label: "repo/.env" },
    { path: resolve(cwd, "apps/web/.env"), label: "apps/web/.env" },
  ]
  const seen = new Set<string>()
  return candidates.filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
}

/**
 * Safely inspect canonical `.env` file locations without following symlinks or
 * reading oversized files, returning ONLY allowlisted non-secret keys.
 */
export function readSafeDotenvState(
  candidates: Array<{ path: string; label: string }> = defaultCandidateDotenvFiles(),
): DotenvFileState {
  const mergedValues: Partial<Record<AllowedWebserverEnvKey, string>> = {}
  const labels: string[] = []

  // Apply root/repo .env first so app-local .env takes precedence when both exist
  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOTENV_BYTES) continue

      const cached = dotenvCache.get(candidate.path)
      let parsed: Partial<Record<AllowedWebserverEnvKey, string>>
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        parsed = cached.values
      } else {
        const raw = readFileSync(candidate.path, "utf8")
        parsed = parseAllowlistedDotenvContent(raw)
        dotenvCache.set(candidate.path, { mtimeMs: stat.mtimeMs, size: stat.size, values: parsed })
      }

      labels.push(candidate.label)
      for (const key of ALLOWED_WEBSERVER_ENV_KEYS) {
        if (parsed[key] !== undefined && mergedValues[key] === undefined) {
          mergedValues[key] = parsed[key]
        }
      }
    } catch {
      // Missing or unreadable .env is normal and non-fatal.
      dotenvCache.delete(candidate.path)
    }
  }

  const keys = ALLOWED_WEBSERVER_ENV_KEYS.filter((k) => mergedValues[k] !== undefined)
  return {
    found: labels.length > 0,
    fileLabel: labels[0] ?? null,
    values: mergedValues,
    keys,
  }
}

/** Merge live `process.env` (higher precedence) over `.env` file state (lower precedence). */
export function mergeEnvLayers(
  rawProcessEnv: Record<string, string | undefined>,
  dotenv: DotenvFileState,
): UnifiedEnvSnapshot {
  const processEnv: Partial<Record<AllowedWebserverEnvKey, string>> = {}
  const merged: Partial<Record<AllowedWebserverEnvKey, string>> = {}
  const keyOrigin = {} as Record<AllowedWebserverEnvKey, EnvKeyOrigin>

  for (const key of ALLOWED_WEBSERVER_ENV_KEYS) {
    const fromProc = sanitizeEnvValue(rawProcessEnv[key])
    const fromFile = sanitizeEnvValue(dotenv.values[key])

    if (fromProc !== null) {
      processEnv[key] = fromProc
      merged[key] = fromProc
      keyOrigin[key] = "process_env"
    } else if (fromFile !== null) {
      merged[key] = fromFile
      keyOrigin[key] = "dotenv"
    } else {
      keyOrigin[key] = "unset"
    }
  }

  return { processEnv, dotenv, merged, keyOrigin }
}

/** Read real-time unified environment state from `process.env` + canonical `.env` files. */
export function readUnifiedEnvSnapshot(options?: {
  processEnv?: Record<string, string | undefined>
  candidates?: Array<{ path: string; label: string }>
}): UnifiedEnvSnapshot {
  const dotenv = readSafeDotenvState(options?.candidates)
  return mergeEnvLayers(options?.processEnv ?? process.env, dotenv)
}
