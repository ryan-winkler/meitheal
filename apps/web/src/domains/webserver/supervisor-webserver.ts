/**
 * Supervisor Webserver Bridge — Home Assistant Supervisor API & Services Integration
 *
 * Maximizes Home Assistant Supervisor API capabilities:
 *   - GET /addons/self/info    (add-on slug, hostname, ingress_url, ingress_port, network ports, options)
 *   - GET /network/info        (host network interfaces for Bind IP/interface selection)
 *   - GET /services            (Supervisor Services registry: mqtt, mysql, etc.)
 *   - GET /core/info           (HA Core version, port, ssl)
 *   - GET /api/config (Core)   (HA Core internal_url & external_url auto-discovery)
 *   - POST /addons/self/options (optional add-on option sync when running in HA OS)
 *
 * @domain webserver
 * @bounded-context integration
 */
import os from "node:os"
import { getHAConnection, getHAConnectionStatus, haRestFetch } from "@domains/ha"
import { supervisorFetch } from "@lib/supervisor-fetch"
import type { HaAddonOptionsPayload } from "./webserver-config"

export interface BindInterfaceOption {
  address: string
  label: string
  source: "default" | "supervisor" | "host"
}

export interface SupervisorServiceEntry {
  name: string
  available: boolean
  providers: string[]
}

export interface SupervisorWebserverSnapshot {
  mode: "ha-addon" | "standalone"
  supervisorAvailable: boolean
  haConnected: boolean
  haVersion: string | null
  addonSlug: string | null
  addonHostname: string | null
  ingressUrl: string | null
  ingressPort: number | null
  networkPorts: Record<string, number | null>
  detectedHaInternalUrl: string | null
  detectedHaExternalUrl: string | null
  detectedHaUrl: string | null
  interfaces: BindInterfaceOption[]
  supervisorServices: SupervisorServiceEntry[]
  addonOptionsSupported: boolean
}

function collectLocalInterfaces(): BindInterfaceOption[] {
  const options: BindInterfaceOption[] = [
    { address: "0.0.0.0", label: "0.0.0.0 [default — all IPv4 interfaces]", source: "default" },
    { address: "127.0.0.1", label: "127.0.0.1 [loopback only]", source: "default" },
    { address: "::", label: ":: [all IPv6 & dual-stack interfaces]", source: "default" },
  ]
  const seen = new Set(options.map((item) => item.address))

  try {
    const nets = os.networkInterfaces()
    for (const [ifaceName, entries] of Object.entries(nets)) {
      if (!entries) continue
      for (const entry of entries) {
        if (!entry.address || entry.internal || seen.has(entry.address)) continue
        if (entry.family === "IPv4" || (entry.family === "IPv6" && !entry.address.startsWith("fe80:"))) {
          seen.add(entry.address)
          options.push({
            address: entry.address,
            label: `${entry.address} (${ifaceName})`,
            source: "host",
          })
        }
      }
    }
  } catch {
    // Host interface inspection is best-effort.
  }

  return options
}

async function readSupervisorJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await supervisorFetch(path, {}, 4_000)
    if (!res || !res.ok) return null
    const json = (await res.json()) as { data?: Record<string, unknown> }
    return json?.data && typeof json.data === "object" ? json.data : null
  } catch {
    return null
  }
}

/** Query Home Assistant Supervisor API, HA Core config, and local host interfaces. */
export async function readSupervisorWebserverSnapshot(): Promise<SupervisorWebserverSnapshot> {
  const hasSupervisorToken = Boolean(process.env.SUPERVISOR_TOKEN)
  const interfaces = collectLocalInterfaces()
  const seenAddresses = new Set(interfaces.map((item) => item.address))

  let haConnected = false
  let haVersion: string | null = null
  let detectedHaInternalUrl: string | null = null
  let detectedHaExternalUrl: string | null = null

  // Check HA connection & Core /api/config (works in both HA Add-on and configured Standalone modes)
  try {
    await getHAConnection()
    const status = getHAConnectionStatus()
    haConnected = status.connected
    haVersion = status.haVersion
  } catch {
    // Passive fallback below
  }

  try {
    const coreConfigRes = await haRestFetch("/api/config")
    if (coreConfigRes.ok) {
      const coreConfig = (await coreConfigRes.json()) as Record<string, unknown>
      if (typeof coreConfig.internal_url === "string" && coreConfig.internal_url.trim()) {
        detectedHaInternalUrl = coreConfig.internal_url.trim().replace(/\/+$/, "")
      }
      if (typeof coreConfig.external_url === "string" && coreConfig.external_url.trim()) {
        detectedHaExternalUrl = coreConfig.external_url.trim().replace(/\/+$/, "")
      }
      if (typeof coreConfig.version === "string" && coreConfig.version.trim()) {
        haVersion = coreConfig.version.trim()
      }
      haConnected = true
    }
  } catch {
    // HA Core REST config is optional in standalone mode.
  }

  if (!hasSupervisorToken) {
    const rawEnvHa = process.env.HA_BASE_URL?.trim() || process.env.HA_URL?.trim() || ""
    const envHaUrl = rawEnvHa ? rawEnvHa.replace(/\/+$/, "") : null
    return {
      mode: "standalone",
      supervisorAvailable: false,
      haConnected,
      haVersion,
      addonSlug: null,
      addonHostname: null,
      ingressUrl: process.env.INGRESS_PATH ?? null,
      ingressPort: null,
      networkPorts: {},
      detectedHaInternalUrl,
      detectedHaExternalUrl,
      detectedHaUrl: detectedHaExternalUrl ?? detectedHaInternalUrl ?? envHaUrl,
      interfaces,
      supervisorServices: [],
      addonOptionsSupported: false,
    }
  }

  const [addonInfo, networkInfo, servicesInfo, coreInfo] = await Promise.all([
    readSupervisorJson("/addons/self/info"),
    readSupervisorJson("/network/info"),
    readSupervisorJson("/services"),
    readSupervisorJson("/core/info"),
  ])

  const supervisorAvailable = Boolean(addonInfo || networkInfo || servicesInfo || coreInfo)

  // Extract Supervisor network interfaces into bind selector
  if (networkInfo && Array.isArray(networkInfo.interfaces)) {
    for (const rawIface of networkInfo.interfaces as Record<string, unknown>[]) {
      const name = typeof rawIface.interface === "string" ? rawIface.interface : "ha-net"
      const ipv4 = rawIface.ipv4 as { address?: string[] } | undefined
      if (Array.isArray(ipv4?.address)) {
        for (const cidr of ipv4.address) {
          const ip = String(cidr).split("/")[0]?.trim()
          if (ip && !seenAddresses.has(ip)) {
            seenAddresses.add(ip)
            interfaces.push({
              address: ip,
              label: `${ip} (Supervisor · ${name})`,
              source: "supervisor",
            })
          }
        }
      }
    }
  }

  // Extract Supervisor Services registry (GET /services)
  const supervisorServices: SupervisorServiceEntry[] = []
  if (servicesInfo && Array.isArray(servicesInfo.services)) {
    for (const svc of servicesInfo.services as Record<string, unknown>[]) {
      if (typeof svc.slug === "string") {
        supervisorServices.push({
          name: svc.slug,
          available: Boolean(svc.available),
          providers: Array.isArray(svc.providers) ? svc.providers.map(String) : [],
        })
      }
    }
  }

  const networkPorts: Record<string, number | null> = {}
  if (addonInfo?.network && typeof addonInfo.network === "object") {
    for (const [containerPort, hostPort] of Object.entries(addonInfo.network as Record<string, unknown>)) {
      networkPorts[containerPort] = typeof hostPort === "number" ? hostPort : null
    }
  }

  // Derive HA URL from Core info if /api/config did not return one
  let coreFallbackUrl: string | null = null
  if (coreInfo) {
    const scheme = coreInfo.ssl ? "https" : "http"
    const corePort = typeof coreInfo.port === "number" ? coreInfo.port : 8123
    if (!haVersion && typeof coreInfo.version === "string") haVersion = coreInfo.version
    coreFallbackUrl = `${scheme}://homeassistant.local:${corePort}`
  }

  return {
    mode: "ha-addon",
    supervisorAvailable,
    haConnected,
    haVersion,
    addonSlug: typeof addonInfo?.slug === "string" ? addonInfo.slug : null,
    addonHostname: typeof addonInfo?.hostname === "string" ? addonInfo.hostname : null,
    ingressUrl: typeof addonInfo?.ingress_url === "string" ? addonInfo.ingress_url : (process.env.INGRESS_PATH ?? null),
    ingressPort: typeof addonInfo?.ingress_port === "number" ? addonInfo.ingress_port : null,
    networkPorts,
    detectedHaInternalUrl,
    detectedHaExternalUrl,
    detectedHaUrl: detectedHaExternalUrl ?? detectedHaInternalUrl ?? coreFallbackUrl,
    interfaces,
    supervisorServices,
    addonOptionsSupported: Boolean(addonInfo),
  }
}

/**
 * Push compatible webserver options to Home Assistant Supervisor (/addons/self/options)
 * when running as an HA Add-on. Non-fatal if the add-on schema doesn't declare all keys.
 */
export async function syncWebserverOptionsToSupervisor(
  payload: HaAddonOptionsPayload,
): Promise<{ synced: boolean; detail: string }> {
  if (!process.env.SUPERVISOR_TOKEN) {
    return {
      synced: false,
      detail: "Running in standalone mode; saved to Meitheal settings database.",
    }
  }

  try {
    const currentInfo = await readSupervisorJson("/addons/self/info")
    const existingOptions =
      currentInfo?.options && typeof currentInfo.options === "object"
        ? (currentInfo.options as Record<string, unknown>)
        : {}

    const nextOptions = {
      ...existingOptions,
      webserver_ports: payload.ports_spec,
      webserver_internal_url: payload.internal_url,
      webserver_external_url: payload.external_url,
      webserver_home_assistant_url: payload.home_assistant_url,
      webserver_bind_address: payload.bind_address,
      webserver_tls_enabled: payload.tls_enabled,
    }

    const res = await supervisorFetch("/addons/self/options", {
      method: "POST",
      body: JSON.stringify({ options: nextOptions }),
    })

    if (!res || !res.ok) {
      return {
        synced: false,
        detail: "Saved in Meitheal. Supervisor add-on manifest did not accept option sync (restart or update add-on config if needed).",
      }
    }

    return {
      synced: true,
      detail: "Synchronized with Home Assistant Supervisor add-on options.",
    }
  } catch {
    return {
      synced: false,
      detail: "Saved in Meitheal. Home Assistant Supervisor was unreachable during option sync.",
    }
  }
}
