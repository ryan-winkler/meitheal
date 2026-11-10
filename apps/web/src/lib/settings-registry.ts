export type SettingsSectionId =
  | "personal-settings"
  | "workflow-settings"
  | "rules-lenses-settings"
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
  navDetail: string
  statusLabel: string
  summaryTitle: string
  summaryDetail: string
  introTitle: string
  introDescription: string
  featuredTasks: string[]
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
    description: "Set up appearance, language, dates and keyboard shortcuts.",
    navDetail: "Appearance, locale, shortcuts, and date defaults",
    statusLabel: "Theme",
    summaryTitle: "Appearance",
    summaryDetail: "Theme",
    introTitle: "Make Meitheal feel like your workspace",
    introDescription:
      "Tune appearance, language, timezone, shortcuts, and the daily defaults that should follow you across Home Assistant, mobile, and standalone sessions.",
    featuredTasks: ["Theme and accent", "Language and timezone", "Keyboard shortcuts"],
    statusTargetId: "settings-summary-theme",
    keywords: ["theme", "language", "timezone", "date", "appearance", "accent", "shortcuts"],
  },
  {
    id: "workflow-settings",
    label: "Workflow",
    icon: "🧭",
    description: "Manage your sidebar, labels, task defaults and notifications.",
    navDetail: "Sidebar, labels, custom fields, defaults, and notifications",
    statusLabel: "Labels",
    summaryTitle: "Task model",
    summaryDetail: "Ready to customize",
    introTitle: "Shape how work moves through the day",
    introDescription:
      "Control sidebar structure, custom fields, labels, strategic lenses, notifications, and the workflow defaults that turn Meitheal into your operating system.",
    featuredTasks: ["Sidebar setup", "Labels and fields", "Defaults and notifications"],
    statusTargetId: "settings-summary-workflow",
    keywords: ["labels", "custom fields", "sidebar", "notifications", "backlog", "retention", "users", "frameworks"],
  },
  {
    id: "rules-lenses-settings",
    label: "Rules & Lenses",
    icon: "📏",
    description: "Choose task rules, scoring frameworks and AI permissions.",
    navDetail: "Per-type lens assignment, AI guardrails, framework configuration",
    statusLabel: "Rules",
    summaryTitle: "Strategy",
    summaryDetail: "Configured",
    introTitle: "Shape how tasks are evaluated and what AI can do",
    introDescription:
      "Assign strategic frameworks per task type, control AI scope with per-type guardrails, tune RICE/HEART/DDD/KCS weights, and apply presets to get started fast.",
    featuredTasks: ["Apply a preset", "Configure AI scope", "Tune framework weights"],
    statusTargetId: "rules-lenses-settings",
    keywords: ["rules", "lenses", "rice", "heart", "ddd", "kcs", "ai scope", "presets", "frameworks", "strategic", "guardrails", "weights"],
  },
  {
    id: "automation-ai-settings",
    label: "Automation & AI",
    icon: "🤖",
    description: "Set up conversation agents, AI providers and access for other tools.",
    navDetail: "Assist agents, providers, and protocol exposure",
    statusLabel: "Protocols",
    summaryTitle: "Agents",
    summaryDetail: "Available",
    introTitle: "Choose how Meitheal talks to other systems",
    introDescription:
      "Configure Home Assistant conversation agents, external AI providers, and protocol exposure so assistants and automations can meet your workflow safely.",
    featuredTasks: ["Conversation agent", "External AI provider", "A2A, MCP, and WebMCP"],
    statusTargetId: "agent-protocols-status",
    keywords: ["ai", "assist", "agent", "a2a", "mcp", "webmcp", "provider", "ollama", "claude", "chatgpt"],
  },
  {
    id: "integrations-settings",
    label: "Integrations",
    icon: "🔌",
    description: "Connect Home Assistant, calendars, to-do lists and other services.",
    navDetail: "Home Assistant, calendars, todo lists, Grocy, n8n, and webhooks",
    statusLabel: "HA",
    summaryTitle: "Home Assistant",
    summaryDetail: "Checking",
    introTitle: "Connect the services around your work",
    introDescription:
      "Bring Home Assistant, calendars, todo lists, Grocy, n8n, and outgoing automations into one control surface without losing ingress-safe behavior.",
    featuredTasks: ["Connect Home Assistant", "Sync calendars and todos", "Expose outbound automations"],
    statusTargetId: "ha-connection-badge",
    keywords: ["home assistant", "calendar", "todo", "grocy", "n8n", "node-red", "webhooks", "sync"],
  },
  {
    id: "app-pwa-settings",
    label: "App & PWA",
    icon: "📲",
    description: "Install Meitheal, open it in the Home Assistant app, or move your data.",
    navDetail: "Installability, companion handoff, exports, and recovery",
    statusLabel: "PWA",
    summaryTitle: "Offline readiness",
    summaryDetail: "Checking",
    introTitle: "Keep Meitheal dependable across browser, PWA, and companion",
    introDescription:
      "Monitor installability, export data, troubleshoot offline behavior, and hand off cleanly to the Home Assistant companion app without escaping ingress scope.",
    featuredTasks: ["Install and update", "Companion handoff", "Export and recovery"],
    statusTargetId: "pwa-compact-badge",
    keywords: ["pwa", "offline", "install", "export", "import", "companion", "x-callback", "url handler"],
  },
  {
    id: "danger-zone-settings",
    label: "Danger Zone",
    icon: "⚠",
    description: "Preview and delete old tasks, purge all tasks or reset settings.",
    navDetail: "Data retention, protected reset, and purge operations",
    statusLabel: "Protected",
    summaryTitle: "Protected",
    summaryDetail: "Protected actions",
    introTitle: "Keep destructive actions isolated and deliberate",
    introDescription:
      "Resets, purges, and data retention controls live here behind clear warnings so they never blend into everyday preference changes or mobile quick taps.",
    featuredTasks: ["Delete old completed tasks", "Purge all tasks", "Reset settings"],
    keywords: ["reset", "purge", "delete", "danger", "factory reset", "archive", "retention", "old tasks", "data cleanup", "completed tasks"],
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
    id: "field-bot-proposals",
    label: "Bot Proposals",
    anchorId: "bot-allow-proposals",
    sectionId: "automation-ai-settings",
    keywords: ["bot", "proposals", "handoff", "agent", "accept", "lock"],
  },
  {
    id: "field-agent-tokens",
    label: "Agent Tokens",
    anchorId: "agent-tokens-card",
    sectionId: "automation-ai-settings",
    keywords: ["agent", "token", "api key", "bearer", "scope", "n8n", "node-red", "automation", "zero-trust", "revoke"],
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
  {
    id: "field-retention",
    label: "Data Retention",
    anchorId: "retention-months-select",
    sectionId: "danger-zone-settings",
    keywords: ["retention", "archive", "delete completed", "old tasks", "cleanup", "data slim", "3 months", "6 months", "12 months", "24 months"],
  },
  {
    id: "field-rules-presets",
    label: "Quick Presets",
    anchorId: "rules-presets",
    sectionId: "rules-lenses-settings",
    keywords: ["preset", "strategic", "ux-focused", "simple", "quick apply"],
  },
  {
    id: "field-rules-assignment",
    label: "Framework Assignment",
    anchorId: "rules-assignment-grid",
    sectionId: "rules-lenses-settings",
    keywords: ["framework", "lens", "rice", "heart", "ddd", "kcs", "epic", "story", "task"],
  },
  {
    id: "field-rules-ai-scope",
    label: "AI Scope",
    anchorId: "ai-scope-disclosure",
    sectionId: "rules-lenses-settings",
    keywords: ["ai", "scope", "auto-score", "auto-close", "priority", "labels", "guardrails"],
  },
  {
    id: "field-rules-framework-config",
    label: "Framework Configuration",
    anchorId: "framework-config-disclosure",
    sectionId: "rules-lenses-settings",
    keywords: ["weights", "formula", "description", "configuration", "customize"],
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
