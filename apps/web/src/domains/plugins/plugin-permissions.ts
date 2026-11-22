/**
 * Plugin Permission Enforcement & Upgrade Diff Policy
 *
 * Maps plugin capabilities onto Meitheal's `AgentScope` model, enforces
 * Safe Mode, and detects privilege escalations on plugin upgrades so
 * administrators must re-consent before enabling an upgraded plugin.
 *
 * @domain plugins
 * @bounded-context plugins
 */
import type { PluginManifest, PluginPermission, PluginRecord, PluginResult } from "./types"

export interface PluginPermissionDescriptor {
  permission: PluginPermission
  label: string
  description: string
  agentScope: string | null
  risk: "low" | "medium" | "high"
}

export const PLUGIN_PERMISSION_CATALOG: Record<PluginPermission, PluginPermissionDescriptor> = {
  "tasks:read": {
    permission: "tasks:read",
    label: "Read tasks",
    description: "Read tasks on boards visible to the active user.",
    agentScope: "tasks:read",
    risk: "low",
  },
  "tasks:write": {
    permission: "tasks:write",
    label: "Create & edit tasks",
    description: "Create, update, and complete tasks on boards editable by the active user.",
    agentScope: "tasks:write",
    risk: "medium",
  },
  "boards:read": {
    permission: "boards:read",
    label: "List boards",
    description: "View board names accessible to the active user.",
    agentScope: "boards:read",
    risk: "low",
  },
  "storage:local": {
    permission: "storage:local",
    label: "Plugin storage",
    description: "Store up to 256 KB of data inside this plugin's isolated namespace.",
    agentScope: null,
    risk: "low",
  },
  "ui:header-button": {
    permission: "ui:header-button",
    label: "Header button",
    description: "Add up to two buttons in the workspace plugin bar.",
    agentScope: null,
    risk: "low",
  },
  "ui:side-panel": {
    permission: "ui:side-panel",
    label: "Side panel",
    description: "Render a sandboxed side panel inside the workspace.",
    agentScope: null,
    risk: "low",
  },
  "ui:toast": {
    permission: "ui:toast",
    label: "Notifications",
    description: "Show status toasts through Meitheal's notification region.",
    agentScope: null,
    risk: "low",
  },
  "http:outbound": {
    permission: "http:outbound",
    label: "External network requests",
    description: "Send HTTPS requests through the Meitheal gateway to allowed hosts only.",
    agentScope: null,
    risk: "high",
  },
  "secrets:use": {
    permission: "secrets:use",
    label: "Use saved secrets",
    description: "Inject administrator-saved API keys into gateway request headers on the server.",
    agentScope: null,
    risk: "high",
  },
}

export function checkPluginCapability(
  plugin: Pick<PluginRecord, "id" | "enabled" | "needsReconsent" | "manifest">,
  required: PluginPermission,
  safeMode: boolean,
): PluginResult<true> {
  if (safeMode) {
    return {
      ok: false,
      errorCode: "SAFE_MODE_ACTIVE",
      error: "Plugins are paused while Safe Mode is enabled.",
      status: 403,
    }
  }
  if (!plugin.enabled) {
    return {
      ok: false,
      errorCode: "PLUGIN_DISABLED",
      error: `Plugin "${plugin.id}" is disabled.`,
      status: 403,
    }
  }
  if (plugin.needsReconsent) {
    return {
      ok: false,
      errorCode: "RECONSENT_REQUIRED",
      error: `Plugin "${plugin.id}" requested new permissions and needs administrator approval.`,
      status: 403,
    }
  }
  if (!plugin.manifest.permissions.includes(required)) {
    return {
      ok: false,
      errorCode: "PERMISSION_DENIED",
      error: `Plugin "${plugin.id}" does not have the "${required}" permission.`,
      status: 403,
    }
  }
  return { ok: true, data: true }
}

/**
 * Returns true if the incoming manifest requests any permission or host
 * that was not present in the previous manifest.
 */
export function requiresPermissionReconsent(
  previous: Pick<PluginManifest, "permissions" | "allowedHosts">,
  next: Pick<PluginManifest, "permissions" | "allowedHosts">,
): boolean {
  const prevPerms = new Set(previous.permissions)
  const prevHosts = new Set(previous.allowedHosts)
  const hasNewPerm = next.permissions.some((p) => !prevPerms.has(p))
  const hasNewHost = next.allowedHosts.some((h) => !prevHosts.has(h))
  return hasNewPerm || hasNewHost
}
