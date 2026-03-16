/**
 * Node-RED Admin API Utility — communicates with Node-RED's Admin API
 *
 * Inside the HA Supervisor Docker network, addons can reach each other via
 * their slug hostname. Node-RED HA addon slug: a0d7b954_nodered, port 1880.
 *
 * API Reference: https://nodered.org/docs/api/admin/methods
 *
 * @domain integrations
 * @bounded-context nodered
 */

import { logApiError } from "./api-logger"

/** Standard Node-RED addon slug in the hassio-addons repository */
const NODERED_ADDON_SLUG = "a0d7b954_nodered"
const NODERED_PORT = 1880
const DEFAULT_TIMEOUT_MS = 10_000

/** Meitheal flow tab identifier — used to detect if already deployed */
export const MEITHEAL_FLOW_LABEL = "Meitheal Automations"
export const MEITHEAL_FLOW_TAB_ID = "meitheal-tab"

/** Node-RED flow node shape (partial — only fields we use) */
export interface NodeRedFlowNode {
  id: string
  type: string
  label?: string
  name?: string
  z?: string
  [key: string]: unknown
}

/** Result of checking Node-RED status */
export interface NodeRedStatus {
  reachable: boolean
  flowDeployed: boolean
  flowTabId?: string | undefined
  nodeRedUrl?: string | undefined
  addonSlug: string
  error?: string | undefined
}

/**
 * Get the internal Docker network URL for the Node-RED addon.
 * Inside HA Supervisor, addons communicate via http://<slug>:<port>
 *
 * Converts underscores to hyphens for hostname resolution since
 * Docker container names use hyphens.
 */
export function getNodeRedInternalUrl(): string {
  // Supervisor hostnames use the slug directly with underscores replaced
  const hostname = NODERED_ADDON_SLUG.replace(/_/g, "-")
  return `http://${hostname}:${NODERED_PORT}`
}

/**
 * Fetch wrapper for Node-RED Admin API with timeout and error handling.
 *
 * Node-RED within HA addons typically has adminAuth disabled for
 * internal network access. If auth is needed, this can be extended
 * to use the Supervisor API proxy.
 */
export async function nodeRedFetch(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const baseUrl = getNodeRedInternalUrl()

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Node-RED-API-Version": "v2",
        ...fetchOptions.headers,
      },
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Get all flows currently deployed in Node-RED.
 * Uses GET /flows (v2 format returns { rev, flows[] })
 */
export async function getNodeRedFlows(): Promise<{
  rev?: string | undefined
  flows: NodeRedFlowNode[]
} | null> {
  try {
    const res = await nodeRedFetch("/flows")
    if (!res.ok) return null
    const data = await res.json() as { rev?: string; flows?: NodeRedFlowNode[] }
    // v2 returns { rev, flows }, v1 returns just the array
    if (Array.isArray(data)) {
      return { flows: data as NodeRedFlowNode[] }
    }
    return { rev: data.rev, flows: data.flows || [] }
  } catch (err) {
    logApiError("nodered-admin", "Failed to get Node-RED flows", err)
    return null
  }
}

/**
 * Check if Meitheal flows are already deployed in Node-RED.
 * Looks for a tab node with our known label.
 */
export async function isMeithealFlowDeployed(): Promise<{
  deployed: boolean
  tabId?: string | undefined
}> {
  const flows = await getNodeRedFlows()
  if (!flows) return { deployed: false }

  const meithealTab = flows.flows.find(
    (n) =>
      n.type === "tab" &&
      (n.label === MEITHEAL_FLOW_LABEL || n.id === MEITHEAL_FLOW_TAB_ID),
  )

  return {
    deployed: !!meithealTab,
    tabId: meithealTab?.id ?? undefined,
  }
}

/**
 * Deploy Meitheal flows to Node-RED using POST /flows.
 *
 * Uses the `nodes` deployment type which only restarts modified nodes,
 * leaving existing user flows undisturbed.
 *
 * The flow JSON is merged with existing flows — we fetch current flows,
 * append ours (or replace existing Meitheal tab), then POST full config.
 */
export async function deployMeithealFlows(
  meithealFlowNodes: NodeRedFlowNode[],
): Promise<{
  success: boolean
  message: string
  flowTabId?: string | undefined
}> {
  try {
    // Get current flows
    const current = await getNodeRedFlows()
    if (!current) {
      return { success: false, message: "Cannot reach Node-RED to read current flows" }
    }

    // Remove any existing Meitheal flows (by tab ID or label match)
    const meithealNodeIds = new Set(meithealFlowNodes.map((n) => n.id))
    const existingWithoutMeitheal = current.flows.filter((n) => {
      // Remove our tab
      if (n.type === "tab" && (n.label === MEITHEAL_FLOW_LABEL || n.id === MEITHEAL_FLOW_TAB_ID)) {
        return false
      }
      // Remove nodes on our tab
      if (n.z === MEITHEAL_FLOW_TAB_ID || meithealNodeIds.has(n.id)) {
        return false
      }
      return true
    })

    // Merge: existing + our new flows
    const merged = [...existingWithoutMeitheal, ...meithealFlowNodes]

    // Deploy with 'nodes' mode to minimize disruption
    const res = await nodeRedFetch("/flows", {
      method: "POST",
      body: JSON.stringify({ flows: merged }),
      headers: {
        "Node-RED-Deployment-Type": "nodes",
        "Node-RED-API-Version": "v2",
      },
      timeoutMs: 15_000,
    })

    if (res.ok) {
      return {
        success: true,
        message: "Meitheal flows deployed to Node-RED successfully",
        flowTabId: MEITHEAL_FLOW_TAB_ID,
      }
    }

    const errBody = await res.text().catch(() => "")
    return {
      success: false,
      message: `Node-RED API returned ${res.status}: ${errBody}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    logApiError("nodered-admin", "Failed to deploy flows", err)
    return { success: false, message: msg }
  }
}

/**
 * Check Node-RED reachability and flow deployment status.
 */
export async function getNodeRedStatus(ingressUrl?: string): Promise<NodeRedStatus> {
  const status: NodeRedStatus = {
    reachable: false,
    flowDeployed: false,
    addonSlug: NODERED_ADDON_SLUG,
    nodeRedUrl: ingressUrl,
  }

  try {
    const res = await nodeRedFetch("/settings", { timeoutMs: 5_000 })
    status.reachable = res.ok

    if (res.ok) {
      const deployCheck = await isMeithealFlowDeployed()
      status.flowDeployed = deployCheck.deployed
      status.flowTabId = deployCheck.tabId
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : "Unknown error"
  }

  return status
}
