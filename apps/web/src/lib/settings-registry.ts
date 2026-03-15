export type SettingsSectionId =
  | "personal-settings"
  | "workflow-settings"
  | "integrations-settings"
  | "automation-ai-settings"
  | "app-pwa-settings"
  | "danger-zone-settings"

export interface SettingsFieldDescriptor {
  id: string
  label: string
  anchorId: string
  sectionId: SettingsSectionId
  keywords: string[]
}

export interface SettingsSectionDescriptor {
  id: SettingsSectionId
  label: string
  icon: string
  description: string
  statusLabel: string
  statusTargetId?: string
  keywords: string[]
}

export interface SettingsSearchResult {
  id: string
  label: string
  description: string
  anchorId: string
  sectionId: SettingsSectionId
  type: "section" | "field"
}

export const SETTINGS_SECTIONS: SettingsSectionDescriptor[] = [
  {
    id: "personal-settings",
    label: "Personal",
    icon: "🎨",
    description: "Theme, language, timezone, and everyday preferences",
    statusLabel: "Theme",
    statusTargetId: "settings-summary-theme",
    keywords: ["theme", "language", "timezone", "date", "appearance", "accent", "shortcuts"],
  },
  {
    id: "workflow-settings",
    label: "Workflow",
    icon: "🧭",
    description: "Sidebar, fields, labels, notifications, backlog, and task logic",
    statusLabel: "Labels",
    statusTargetId: "settings-summary-workflow",
    keywords: ["labels", "custom fields", "sidebar", "notifications", "backlog", "retention", "users", "frameworks"],
  },
  {
    id: "integrations-settings",
    label: "Integrations",
    icon: "🔌",
    description: "Home Assistant, calendar, todo, Grocy, n8n, and webhooks",
    statusLabel: "HA",
    statusTargetId: "ha-connection-badge",
    keywords: ["home assistant", "calendar", "todo", "grocy", "n8n", "node-red", "webhooks", "sync"],
  },
  {
    id: "automation-ai-settings",
    label: "Automation & AI",
    icon: "🤖",
    description: "Conversation agents, external AI, and protocol exposure",
    statusLabel: "Protocols",
    statusTargetId: "agent-protocols-status",
    keywords: ["ai", "assist", "agent", "a2a", "mcp", "webmcp", "provider", "ollama", "claude", "chatgpt"],
  },
  {
    id: "app-pwa-settings",
    label: "App & PWA",
    icon: "📲",
    description: "Exports, installability, offline, companion links, and support",
    statusLabel: "PWA",
    statusTargetId: "pwa-compact-badge",
    keywords: ["pwa", "offline", "install", "export", "import", "companion", "x-callback", "url handler"],
  },
  {
    id: "danger-zone-settings",
    label: "Danger Zone",
    icon: "⚠",
    description: "Purge and reset operations",
    statusLabel: "Protected",
    keywords: ["reset", "purge", "delete", "danger", "factory reset"],
  },
]

export const SETTINGS_FIELDS: SettingsFieldDescriptor[] = [
  {
    id: "field-theme",
    label: "Theme",
    anchorId: "theme-select",
    sectionId: "personal-settings",
    keywords: ["theme", "dark", "light", "custom theme", "appearance"],
  },
  {
    id: "field-language",
    label: "Display Language",
    anchorId: "locale-select",
    sectionId: "personal-settings",
    keywords: ["language", "locale", "english", "gaeilge"],
  },
  {
    id: "field-timezone",
    label: "Timezone",
    anchorId: "timezone-select",
    sectionId: "personal-settings",
    keywords: ["timezone", "date format", "week start", "calendar locale"],
  },
  {
    id: "field-sidebar",
    label: "Sidebar Configuration",
    anchorId: "sidebar-item-list",
    sectionId: "workflow-settings",
    keywords: ["sidebar", "navigation", "custom links", "menu"],
  },
  {
    id: "field-fields",
    label: "Custom Fields",
    anchorId: "custom-fields-list",
    sectionId: "workflow-settings",
    keywords: ["custom fields", "field types", "task metadata"],
  },
  {
    id: "field-labels",
    label: "Labels",
    anchorId: "labels-list",
    sectionId: "workflow-settings",
    keywords: ["labels", "tags", "colors"],
  },
  {
    id: "field-notifications",
    label: "Notifications",
    anchorId: "notif-user-toggles",
    sectionId: "workflow-settings",
    keywords: ["notifications", "reminders", "mobile push", "due dates"],
  },
  {
    id: "field-home-assistant",
    label: "Home Assistant Connection",
    anchorId: "integration-ha",
    sectionId: "integrations-settings",
    keywords: ["home assistant", "ha", "token", "standalone mode"],
  },
  {
    id: "field-calendar",
    label: "Calendar Sync",
    anchorId: "integration-calendar",
    sectionId: "integrations-settings",
    keywords: ["calendar", "caldav", "sync", "events"],
  },
  {
    id: "field-todo",
    label: "Todo Sync",
    anchorId: "integration-todo",
    sectionId: "integrations-settings",
    keywords: ["todo", "shopping list", "ha bridge"],
  },
  {
    id: "field-webhooks",
    label: "Webhooks",
    anchorId: "integration-webhooks",
    sectionId: "integrations-settings",
    keywords: ["webhooks", "zapier", "ifttt", "endpoint", "signing secret"],
  },
  {
    id: "field-ha-agent",
    label: "HA Conversation Agent",
    anchorId: "ha-agent-select-settings",
    sectionId: "automation-ai-settings",
    keywords: ["assist", "conversation", "agent", "voice assistants"],
  },
  {
    id: "field-ai-provider",
    label: "External AI Provider",
    anchorId: "ai-provider",
    sectionId: "automation-ai-settings",
    keywords: ["chatgpt", "claude", "gemini", "ollama", "custom api"],
  },
  {
    id: "field-protocols",
    label: "Agent Protocols",
    anchorId: "save-agent-protocols",
    sectionId: "automation-ai-settings",
    keywords: ["a2a", "mcp", "webmcp", "protocols"],
  },
  {
    id: "field-export",
    label: "Export & Import",
    anchorId: "export-json-btn",
    sectionId: "app-pwa-settings",
    keywords: ["export", "import", "backup", "restore", "sqlite", "csv", "json"],
  },
  {
    id: "field-pwa",
    label: "PWA Status",
    anchorId: "pwa-status-compact",
    sectionId: "app-pwa-settings",
    keywords: ["pwa", "install", "offline", "cache", "service worker", "companion"],
  },
  {
    id: "field-companion",
    label: "Companion App Links",
    anchorId: "pwa-companion-open",
    sectionId: "app-pwa-settings",
    keywords: ["companion", "url handler", "x-callback", "deeplink", "mobile app"],
  },
  {
    id: "field-danger",
    label: "Reset & Purge",
    anchorId: "purge-tasks",
    sectionId: "danger-zone-settings",
    keywords: ["purge", "reset", "delete all", "factory reset"],
  },
]

const SEARCHABLE: SettingsSearchResult[] = [
  ...SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    description: section.description,
    anchorId: section.id,
    sectionId: section.id,
    type: "section" as const,
  })),
  ...SETTINGS_FIELDS.map((field) => ({
    id: field.id,
    label: field.label,
    description: SETTINGS_SECTIONS.find((section) => section.id === field.sectionId)?.label ?? field.sectionId,
    anchorId: field.anchorId,
    sectionId: field.sectionId,
    type: "field" as const,
  })),
]

export function getSettingsSection(sectionId: SettingsSectionId): SettingsSectionDescriptor | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === sectionId)
}

export function searchSettingsRegistry(query: string): SettingsSearchResult[] {
  const term = query.trim().toLowerCase()
  if (!term) return []

  return SEARCHABLE.filter((entry) => {
    const section = getSettingsSection(entry.sectionId)
    const field = SETTINGS_FIELDS.find((item) => item.id === entry.id)
    const haystack = [
      entry.label,
      entry.description,
      ...(section?.keywords ?? []),
      ...(field?.keywords ?? []),
    ].join(" ").toLowerCase()

    return haystack.includes(term)
  })
    .sort((left, right) => {
      const leftSection = getSettingsSection(left.sectionId)
      const rightSection = getSettingsSection(right.sectionId)
      const leftField = SETTINGS_FIELDS.find((item) => item.id === left.id)
      const rightField = SETTINGS_FIELDS.find((item) => item.id === right.id)

      const score = (
        entry: SettingsSearchResult,
        sectionKeywords: string[],
        fieldKeywords: string[],
      ): number => {
        const label = entry.label.toLowerCase()
        const keywords = [...fieldKeywords, ...sectionKeywords].map((keyword) => keyword.toLowerCase())

        let total = entry.type === "field" ? 10 : 0
        if (label === term) total += 30
        else if (label.startsWith(term)) total += 20
        else if (label.includes(term)) total += 10

        if (keywords.includes(term)) total += 15
        if (keywords.some((keyword) => keyword.startsWith(term))) total += 5

        return total
      }

      const leftScore = score(left, leftSection?.keywords ?? [], leftField?.keywords ?? [])
      const rightScore = score(right, rightSection?.keywords ?? [], rightField?.keywords ?? [])

      if (leftScore !== rightScore) return rightScore - leftScore
      return left.label.localeCompare(right.label)
    })
    .slice(0, 8)
}
