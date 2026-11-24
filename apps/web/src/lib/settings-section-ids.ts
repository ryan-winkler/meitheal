/**
 * Canonical Settings Section IDs & Legacy Hash Aliases
 *
 * Lightweight client-safe slice of `settings-registry.ts` so browser navigation
 * (`settings-shell-controller.ts`) resolves hash destinations without bundling
 * server-only search metadata and keyword registries into client JS.
 */

export const SETTINGS_SECTION_IDS = [
  "look-and-feel-settings",
  "language-time-settings",
  "navigation-settings",
  "tasks-boards-settings",
  "people-notifications-settings",
  "scoring-settings",
  "ai-agents-settings",
  "connections-settings",
  "plugins-settings",
  "webserver-settings",
  "app-pwa-settings",
  "backups-reset-settings",
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

const SECTION_ID_SET = new Set<string>(SETTINGS_SECTION_IDS)

export const LEGACY_SETTINGS_SECTION_ALIASES: Record<string, SettingsSectionId> = {
  "personal-settings": "look-and-feel-settings",
  "appearance-settings": "look-and-feel-settings",
  "language-settings": "language-time-settings",
  "locale-settings": "language-time-settings",
  "general-settings": "navigation-settings",
  "sidebar-settings": "navigation-settings",
  "shortcuts-settings": "navigation-settings",
  "workflow-settings": "tasks-boards-settings",
  "labels-settings": "tasks-boards-settings",
  "boards-settings": "tasks-boards-settings",
  "users-settings": "people-notifications-settings",
  "people-settings": "people-notifications-settings",
  "notifications-settings": "people-notifications-settings",
  "rules-lenses-settings": "scoring-settings",
  "rules-settings": "scoring-settings",
  "automation-ai-settings": "ai-agents-settings",
  "agents-settings": "ai-agents-settings",
  "integrations-settings": "connections-settings",
  "extensions-settings": "plugins-settings",
  "addons-settings": "plugins-settings",
  "server-settings": "webserver-settings",
  "network-settings": "webserver-settings",
  "ports-settings": "webserver-settings",
  "app-pwa": "app-pwa-settings",
  "danger-zone-settings": "backups-reset-settings",
  "data-settings": "backups-reset-settings",
}

export function resolveSettingsSectionId(id: string): SettingsSectionId | undefined {
  if (SECTION_ID_SET.has(id)) return id as SettingsSectionId
  return LEGACY_SETTINGS_SECTION_ALIASES[id]
}
