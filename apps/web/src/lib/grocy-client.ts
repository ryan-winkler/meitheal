import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { GrocyAdapter, validateGrocyBaseUrl } from "@meitheal/integration-core"
import { getPersistenceClient, SettingsRepository } from "@domains/tasks"
import { supervisorFetch } from "./supervisor-fetch"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
})

const LEGACY_HASSIO_INGRESS_PATH = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/

/**
 * Extract normalized `/api/hassio_ingress/<token>` path when `rawUrl` is either a bare
 * Supervisor ingress path or the legacy `http://supervisor/api/hassio_ingress/<token>` URL.
 */
export function extractLegacyIngressPath(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (LEGACY_HASSIO_INGRESS_PATH.test(trimmed)) {
    return trimmed.replace(/\/+$/, "")
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (
    parsed.protocol === "http:" &&
    parsed.hostname.toLowerCase() === "supervisor" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    LEGACY_HASSIO_INGRESS_PATH.test(parsed.pathname)
  ) {
    return parsed.pathname.replace(/\/+$/, "")
  }
  return null
}

/**
 * True when a URL matches the legacy auto-detected `http://supervisor/api/hassio_ingress/<token>`
 * or bare `/api/hassio_ingress/<token>` form written before Supervisor hostnames were blocked.
 */
export function isLegacySupervisorIngressUrl(rawUrl: string): boolean {
  return extractLegacyIngressPath(rawUrl) !== null
}

function isValidSupervisorNetworkEntry(mapped: unknown): boolean {
  return (
    mapped === null ||
    (typeof mapped === "number" && Number.isInteger(mapped) && mapped > 0 && mapped <= 65535)
  )
}

function selectAddonPort(info: {
  ingress_port?: unknown
  network?: Record<string, unknown>
}): number {
  const network = info.network
  if (network && typeof network === "object") {
    if (Object.hasOwn(network, "80/tcp") && isValidSupervisorNetworkEntry(network["80/tcp"])) {
      return 80
    }
    for (const [key, mapped] of Object.entries(network)) {
      const match = /^(\d+)\/tcp$/.exec(key)
      if (match && isValidSupervisorNetworkEntry(mapped)) {
        const containerPort = Number(match[1])
        if (Number.isInteger(containerPort) && containerPort > 0 && containerPort <= 65535) {
          return containerPort
        }
      }
    }
  }
  if (
    typeof info.ingress_port === "number" &&
    Number.isInteger(info.ingress_port) &&
    info.ingress_port > 0 &&
    info.ingress_port <= 65535
  ) {
    return info.ingress_port
  }
  return 80
}

async function resolveStartedAddonContainerUrl(slug: string): Promise<string | null> {
  const infoRes = await supervisorFetch(`/addons/${encodeURIComponent(slug)}/info`).catch(() => null)
  if (!infoRes?.ok) {
    await infoRes?.body?.cancel().catch(() => undefined)
    return null
  }
  const info = (await infoRes.json().catch(() => null)) as {
    data?: { hostname?: unknown; ingress_port?: unknown; network?: Record<string, unknown> }
  } | null
  const data = info?.data
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const hostname = (typeof data.hostname === "string" && data.hostname.trim()) || slug.replace(/_/g, "-")
  const port = selectAddonPort(data)

  const check = validateGrocyBaseUrl(`http://${hostname}:${port}`)
  if (!check.ok) return null
  return check.normalizedUrl
}

async function listStartedSupervisorGrocyAddons(): Promise<
  Array<{ slug: string; ingress_url?: string; state?: string }>
> {
  const addonsRes = await supervisorFetch("/addons")
  if (!addonsRes?.ok) {
    await addonsRes?.body?.cancel().catch(() => undefined)
    return []
  }
  const addonsData = (await addonsRes.json()) as {
    data?: { addons?: { slug: string; ingress_url?: string; state?: string }[] }
  }
  return (addonsData.data?.addons ?? []).filter(
    (addon) => addon.slug.includes("grocy") && addon.state === "started",
  )
}

/**
 * Resolve the direct internal container URL for a started Home Assistant Grocy add-on
 * (e.g. `http://a0d7b954-grocy` or `http://a0d7b954-grocy:<port>`) via Supervisor metadata
 * rather than proxying `http://supervisor/*`.
 *
 * When `expectedIngressUrl` is provided, matches the add-on's `ingress_url` so migrating
 * a saved URL never switches to a different Grocy add-on instance.
 */
export async function resolveSupervisorGrocyAddon(
  expectedIngressUrl?: string,
): Promise<{ slug: string; url: string } | null> {
  try {
    const startedAddons = await listStartedSupervisorGrocyAddons()
    const expectedPath = expectedIngressUrl ? extractLegacyIngressPath(expectedIngressUrl) : null
    const grocy = expectedPath
      ? startedAddons.find(
          (addon) =>
            typeof addon.ingress_url === "string" &&
            addon.ingress_url.replace(/\/+$/, "") === expectedPath,
        )
      : startedAddons[0]
    if (!grocy?.slug) return null

    const url = await resolveStartedAddonContainerUrl(grocy.slug)
    if (!url) return null
    return { slug: grocy.slug, url }
  } catch {
    return null
  }
}

/**
 * Return the Supervisor add-on slug whose resolved internal container endpoint matches `targetUrl`
 * (scheme, host, port, and normalized base path), or `null` when `targetUrl` points elsewhere.
 */
export async function resolveSupervisorGrocySlugForUrl(targetUrl: string): Promise<string | null> {
  try {
    const target = new URL(targetUrl)
    const targetBasePath = target.pathname.replace(/\/+$/, "")
    const startedAddons = await listStartedSupervisorGrocyAddons()
    for (const addon of startedAddons) {
      if (!addon.slug) continue
      const resolvedUrl = await resolveStartedAddonContainerUrl(addon.slug)
      if (!resolvedUrl) continue
      const resolved = new URL(resolvedUrl)
      if (
        resolved.origin === target.origin &&
        resolved.pathname.replace(/\/+$/, "") === targetBasePath
      ) {
        return addon.slug
      }
    }
    return null
  } catch {
    return null
  }
}

export async function createGrocyClient(): Promise<GrocyAdapter | null> {
  try {
    const client = getPersistenceClient()
    const readConfig = () => client.execute(
      "SELECT key, value FROM settings WHERE key IN ('grocy_url', 'grocy_api_key')",
    )
    let { rows } = await readConfig()
    const storedUrl = rows.find((row) => row.key === "grocy_url")?.value
    if (typeof storedUrl !== "string" || !rows.some((row) => row.key === "grocy_api_key")) return null

    function decode(value: unknown): unknown {
      if (typeof value !== "string") return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }
    const originalUrl = decode(storedUrl)
    if (typeof originalUrl === "string" && isLegacySupervisorIngressUrl(originalUrl)) {
      const detected = await resolveSupervisorGrocyAddon(originalUrl)
      if (!detected) return null
      const repo = new SettingsRepository(client)
      await repo.replaceIfUnchanged("grocy_url", storedUrl, JSON.stringify(detected.url))
      rows = (await readConfig()).rows
    }
    const baseUrl = decode(rows.find((row) => row.key === "grocy_url")?.value)
    const storedKey = decode(rows.find((row) => row.key === "grocy_api_key")?.value)
    const apiKey = typeof storedKey === "number" && Number.isFinite(storedKey) ? String(storedKey) : storedKey
    if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey) return null

    const urlCheck = validateGrocyBaseUrl(baseUrl)
    if (!urlCheck.ok) {
      logger.log("warn", {
        event: "integration.grocy.invalid_url",
        domain: "integrations",
        component: "grocy-client",
        request_id: crypto.randomUUID(),
        message: urlCheck.error,
      })
      return null
    }

    return new GrocyAdapter({
      baseUrl: urlCheck.normalizedUrl,
      apiKey,
      timeoutMs: 5000,
    })
  } catch (err) {
    logger.log("error", {
      event: "integration.grocy.config_failed",
      domain: "integrations",
      component: "grocy-client",
      request_id: crypto.randomUUID(),
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
