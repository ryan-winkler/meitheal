export type SettingsSectionId =
  | "look-and-feel-settings"
  | "language-time-settings"
  | "navigation-settings"
  | "tasks-boards-settings"
  | "people-notifications-settings"
  | "scoring-settings"
  | "ai-agents-settings"
  | "connections-settings"
  | "app-pwa-settings"
  | "backups-reset-settings"

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
  "app-pwa": "app-pwa-settings",
  "danger-zone-settings": "backups-reset-settings",
  "data-settings": "backups-reset-settings",
}

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
  outlineIcon: "sparkles" | "calendar" | "link" | "kanban" | "bell" | "sliders" | "automation" | "plug" | "phone" | "warning"
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
    id: "look-and-feel-settings",
    label: "Look & Feel",
    icon: "🎨",
    outlineIcon: "sparkles",
    description: "Set your theme mode, accent color, font family, and surface contrast.",
    navDetail: "Theme mode, accent color, typography, and density",
    statusLabel: "Theme",
    summaryTitle: "Look & Feel",
    summaryDetail: "Theme",
    introTitle: "Make Meitheal comfortable to read and use",
    introDescription:
      "Choose your theme mode, accent color, typeface, corner roundness, and layout width across Home Assistant, mobile, and standalone sessions.",
    featuredTasks: ["Theme and accent", "Font and density", "Custom theme CSS"],
    statusTargetId: "settings-summary-theme",
    keywords: ["theme", "appearance", "accent", "font", "typeface", "typography", "contrast", "density", "look", "feel", "colors"],
  },
  {
    id: "language-time-settings",
    label: "Language & Time",
    icon: "🌐",
    outlineIcon: "calendar",
    description: "Choose your display language, timezone, date format, and start of week.",
    navDetail: "Language, locale, timezone, and calendar week start",
    statusLabel: "Locale",
    summaryTitle: "Language & Time",
    summaryDetail: "Locale & dates",
    introTitle: "Match dates, times, and language to your home",
    introDescription:
      "Set the display language, timezone, date formatting, and first day of the week used across calendars, due dates, and reminders.",
    featuredTasks: ["Display language", "Household timezone", "Week start and date format"],
    statusTargetId: "locale-select",
    keywords: ["language", "locale", "timezone", "date", "time", "week start", "calendar", "english", "gaeilge"],
  },
  {
    id: "navigation-settings",
    label: "Navigation & Shortcuts",
    icon: "🧭",
    outlineIcon: "link",
    description: "Arrange the sidebar or top bar, task menu items, and keyboard shortcuts.",
    navDetail: "Navigation layout, sidebar behavior, pinned task types, shortcuts",
    statusLabel: "Navigation",
    summaryTitle: "Navigation",
    summaryDetail: "Sidebar & keys",
    introTitle: "Keep your favorite views one tap or keystroke away",
    introDescription:
      "Choose sidebar or top navigation, hover-to-expand behavior, which task views appear in the Tasks menu, custom links, and keyboard shortcuts.",
    featuredTasks: ["Sidebar or top bar", "Tasks menu & pinned types", "Keyboard shortcuts"],
    statusTargetId: "sidebar-item-list",
    keywords: ["sidebar", "navbar", "top bar", "navigation", "hover", "pinned", "task types", "shortcuts", "keyboard", "custom links"],
  },
  {
    id: "tasks-boards-settings",
    label: "Tasks & Boards",
    icon: "📋",
    outlineIcon: "kanban",
    description: "Configure board lanes, card fields, labels, and completed task retention.",
    navDetail: "Backlog lane, completed cleanup, custom fields, labels, optional modules",
    statusLabel: "Boards",
    summaryTitle: "Tasks & Boards",
    summaryDetail: "Ready to customize",
    introTitle: "Shape how tasks, lists, and boards stay organized",
    introDescription:
      "Control how Backlog and Completed tasks behave, manage labels and custom card fields, and toggle optional task features.",
    featuredTasks: ["Board & archive defaults", "Labels & cleanup", "Custom fields & modules"],
    statusTargetId: "settings-summary-workflow",
    keywords: ["tasks", "boards", "kanban", "backlog", "completed", "archive", "labels", "tags", "custom fields", "features"],
  },
  {
    id: "people-notifications-settings",
    label: "People & Notifications",
    icon: "👥",
    outlineIcon: "bell",
    description: "Manage household members, default assignees, and reminder notifications.",
    navDetail: "Household people, Home Assistant linking, push reminders",
    statusLabel: "People",
    summaryTitle: "People & Alerts",
    summaryDetail: "Household & push",
    introTitle: "Coordinate household people and timely reminders",
    introDescription:
      "Link Home Assistant household members, add custom assignees, pick a default owner, and tune mobile and due-date notifications.",
    featuredTasks: ["Household people", "Default assignee", "Push & due-date reminders"],
    statusTargetId: "notif-global-toggle",
    keywords: ["people", "users", "members", "household", "assignee", "notifications", "reminders", "push", "alerts"],
  },
  {
    id: "scoring-settings",
    label: "Scoring & Rules",
    icon: "⚖️",
    outlineIcon: "sliders",
    description: "Choose task priority presets, scoring weights, and AI editing guardrails.",
    navDetail: "Scoring presets, per-type rules, AI guardrails, framework weights",
    statusLabel: "Rules",
    summaryTitle: "Scoring & Rules",
    summaryDetail: "Configured",
    introTitle: "Guide how tasks are prioritized and what AI can update",
    introDescription:
      "Pick a quick preset, match scoring methods to task types, tune priority weights, and set clear boundaries for automatic AI updates.",
    featuredTasks: ["Apply a preset", "Configure AI guardrails", "Tune scoring weights"],
    statusTargetId: "rules-lenses-settings",
    keywords: ["scoring", "rules", "lenses", "rice", "heart", "kcs", "eis", "wsjf", "ai scope", "presets", "frameworks", "guardrails", "weights", "points", "streaks"],
  },
  {
    id: "ai-agents-settings",
    label: "AI & Agent Access",
    icon: "🤖",
    outlineIcon: "automation",
    description: "Set up voice assistants, external AI providers, protocols, and API tokens.",
    navDetail: "Assist agents, AI providers, MCP/A2A protocols, agent tokens",
    statusLabel: "Agents",
    summaryTitle: "AI & Agents",
    summaryDetail: "Available",
    introTitle: "Control how AI assistants and automation agents connect",
    introDescription:
      "Configure Home Assistant Assist, external AI providers, protocol access, proposal approvals, and scoped API tokens for external agents.",
    featuredTasks: ["Conversation agent", "Agent API tokens", "MCP, A2A, and WebMCP"],
    statusTargetId: "agent-protocols-status",
    keywords: ["ai", "assist", "agent", "tokens", "api key", "a2a", "mcp", "webmcp", "provider", "ollama", "claude", "chatgpt", "llm"],
  },
  {
    id: "connections-settings",
    label: "Connected Services",
    icon: "🔌",
    outlineIcon: "plug",
    description: "Connect Home Assistant, CalDAV calendars, to-do lists, Grocy, and webhooks.",
    navDetail: "Home Assistant, calendars, to-do lists, Grocy, n8n, webhooks",
    statusLabel: "HA",
    summaryTitle: "Connections",
    summaryDetail: "Checking",
    introTitle: "Sync with the tools and calendars your household relies on",
    introDescription:
      "Bring Home Assistant, CalDAV/iCal calendars, to-do lists, Grocy chores, n8n or Node-RED flows, and outbound webhooks into one place.",
    featuredTasks: ["Connect Home Assistant", "Sync calendars and to-dos", "n8n, Node-RED, and webhooks"],
    statusTargetId: "ha-connection-badge",
    keywords: ["home assistant", "ha", "calendar", "caldav", "ical", "todo", "grocy", "n8n", "node-red", "webhooks", "sync", "integrations"],
  },
  {
    id: "app-pwa-settings",
    label: "App & Companion",
    icon: "📲",
    outlineIcon: "phone",
    description: "Check app status, install as an app, open in Home Assistant, or send feedback.",
    navDetail: "Version, installability, companion handoff, guides, and feedback",
    statusLabel: "PWA",
    summaryTitle: "App Readiness",
    summaryDetail: "Checking",
    introTitle: "Keep Meitheal dependable across browser, app, and Companion",
    introDescription:
      "Check app version and offline readiness, hand off cleanly to the Home Assistant Companion app without leaving ingress scope, and browse guides or send feedback.",
    featuredTasks: ["Install and offline status", "Companion handoff", "Version, guides, and feedback"],
    statusTargetId: "pwa-compact-badge",
    keywords: ["pwa", "app", "offline", "install", "companion", "version", "license", "about", "feedback", "help", "x-callback", "url handler"],
  },
  {
    id: "backups-reset-settings",
    label: "Backups & Reset",
    icon: "🗂️",
    outlineIcon: "warning",
    description: "Export or import backups, trim old completed tasks, or reset your workspace.",
    navDetail: "Exports, settings backup/import, retention, and protected resets",
    statusLabel: "Protected",
    summaryTitle: "Backups & Reset",
    summaryDetail: "Protected actions",
    introTitle: "Back up your data and keep destructive resets isolated",
    introDescription:
      "Export tasks or settings before big changes, import a saved configuration, trim old completed tasks, or reset your workspace deliberately.",
    featuredTasks: ["Export & import backups", "Delete old completed tasks", "Purge or reset workspace"],
    keywords: ["backup", "export", "import", "restore", "json", "csv", "sqlite", "reset", "purge", "delete", "danger", "factory reset", "archive", "retention", "old tasks"],
  },
]

export const SETTINGS_FIELDS: SettingsFieldDescriptor[] = [
  {
    id: "field-theme",
    label: "Theme",
    anchorId: "theme-select",
    sectionId: "look-and-feel-settings",
    keywords: ["theme", "dark", "light", "auto", "custom theme", "appearance", "accent"],
  },
  {
    id: "field-appearance-customize",
    label: "Typography & Density",
    anchorId: "appearance-settings",
    sectionId: "look-and-feel-settings",
    keywords: ["font", "typeface", "typography", "corners", "roundness", "radius", "palette", "width", "density", "outfit", "inter", "geist"],
  },
  {
    id: "field-language",
    label: "Display Language",
    anchorId: "locale-select",
    sectionId: "language-time-settings",
    keywords: ["language", "locale", "english", "gaeilge"],
  },
  {
    id: "field-timezone",
    label: "Timezone & Date Format",
    anchorId: "timezone-select",
    sectionId: "language-time-settings",
    keywords: ["timezone", "date format", "week start", "calendar locale", "monday", "sunday"],
  },
  {
    id: "field-navigation-layout",
    label: "Navigation Layout & Hover",
    anchorId: "navigation-appearance-form",
    sectionId: "navigation-settings",
    keywords: ["navigation", "sidebar", "top bar", "navbar", "hover", "folded", "expanded", "edges", "color"],
  },
  {
    id: "field-sidebar",
    label: "Sidebar Items & Custom Links",
    anchorId: "sidebar-item-list",
    sectionId: "navigation-settings",
    keywords: ["sidebar", "navigation", "custom links", "menu", "order", "visibility"],
  },
  {
    id: "field-task-nav-prefs",
    label: "Tasks Menu & Pinned Types",
    anchorId: "task-nav-prefs-card",
    sectionId: "navigation-settings",
    keywords: ["tasks menu", "submenu", "pinned", "standard", "shopping", "checklists", "events"],
  },
  {
    id: "field-shortcuts",
    label: "Keyboard Shortcuts",
    anchorId: "single-key-shortcuts",
    sectionId: "navigation-settings",
    keywords: ["shortcuts", "keyboard", "hotkeys", "single key"],
  },
  {
    id: "field-boards-behavior",
    label: "Board Lanes & Completed Retention",
    anchorId: "backlog-mode-select",
    sectionId: "tasks-boards-settings",
    keywords: ["kanban", "board", "backlog", "completed", "archive", "retention"],
  },
  {
    id: "field-fields",
    label: "Custom Fields",
    anchorId: "custom-fields-list",
    sectionId: "tasks-boards-settings",
    keywords: ["custom fields", "field types", "task metadata"],
  },
  {
    id: "field-labels",
    label: "Labels",
    anchorId: "labels-list",
    sectionId: "tasks-boards-settings",
    keywords: ["labels", "tags", "colors", "cleanup"],
  },
  {
    id: "field-optional-features",
    label: "Optional Features",
    anchorId: "feature-toggles-container",
    sectionId: "tasks-boards-settings",
    keywords: ["features", "modules", "toggles", "gamification", "streaks"],
  },
  {
    id: "field-people",
    label: "Household People",
    anchorId: "default-assignee-select",
    sectionId: "people-notifications-settings",
    keywords: ["people", "users", "members", "assignee", "home assistant users"],
  },
  {
    id: "field-notifications",
    label: "Notifications",
    anchorId: "notif-user-toggles",
    sectionId: "people-notifications-settings",
    keywords: ["notifications", "reminders", "mobile push", "due dates"],
  },
  {
    id: "field-rules-presets",
    label: "Quick Presets",
    anchorId: "rules-presets",
    sectionId: "scoring-settings",
    keywords: ["preset", "strategic", "ux-focused", "simple", "quick apply"],
  },
  {
    id: "field-rules-assignment",
    label: "Scoring Assignment",
    anchorId: "rules-assignment-grid",
    sectionId: "scoring-settings",
    keywords: ["framework", "scoring", "rice", "heart", "kcs", "epic", "story", "task"],
  },
  {
    id: "field-rules-ai-scope",
    label: "AI Guardrails",
    anchorId: "ai-scope-disclosure",
    sectionId: "scoring-settings",
    keywords: ["ai", "scope", "auto-score", "auto-close", "priority", "labels", "guardrails"],
  },
  {
    id: "field-rules-framework-config",
    label: "Scoring Weights",
    anchorId: "framework-config-disclosure",
    sectionId: "scoring-settings",
    keywords: ["weights", "formula", "description", "configuration", "customize"],
  },
  {
    id: "field-ha-agent",
    label: "HA Conversation Agent",
    anchorId: "ha-agent-select-settings",
    sectionId: "ai-agents-settings",
    keywords: ["assist", "conversation", "agent", "voice assistants"],
  },
  {
    id: "field-ai-provider",
    label: "External AI Provider",
    anchorId: "ai-provider",
    sectionId: "ai-agents-settings",
    keywords: ["chatgpt", "claude", "gemini", "ollama", "custom api"],
  },
  {
    id: "field-protocols",
    label: "Agent Protocols",
    anchorId: "save-agent-protocols",
    sectionId: "ai-agents-settings",
    keywords: ["a2a", "mcp", "webmcp", "protocols"],
  },
  {
    id: "field-bot-proposals",
    label: "Agent Handoff Status",
    anchorId: "bot-allow-proposals",
    sectionId: "ai-agents-settings",
    keywords: ["bot", "proposals", "handoff", "agent", "accept", "lock"],
  },
  {
    id: "field-agent-tokens",
    label: "Agent Tokens",
    anchorId: "agent-tokens-card",
    sectionId: "ai-agents-settings",
    keywords: ["agent", "token", "api key", "bearer", "scope", "n8n", "node-red", "automation", "zero-trust", "revoke"],
  },
  {
    id: "field-home-assistant",
    label: "Home Assistant Connection",
    anchorId: "integration-ha",
    sectionId: "connections-settings",
    keywords: ["home assistant", "ha", "token", "standalone mode"],
  },
  {
    id: "field-calendar",
    label: "Calendar Sync",
    anchorId: "integration-calendar",
    sectionId: "connections-settings",
    keywords: ["calendar", "caldav", "ical", "sync", "events"],
  },
  {
    id: "field-todo",
    label: "Todo Sync",
    anchorId: "integration-todo",
    sectionId: "connections-settings",
    keywords: ["todo", "shopping list", "ha bridge"],
  },
  {
    id: "field-webhooks",
    label: "Webhooks",
    anchorId: "integration-webhooks",
    sectionId: "connections-settings",
    keywords: ["webhooks", "zapier", "ifttt", "n8n", "node-red", "endpoint", "signing secret"],
  },
  {
    id: "field-pwa",
    label: "PWA & Version Status",
    anchorId: "pwa-status-compact",
    sectionId: "app-pwa-settings",
    keywords: ["pwa", "install", "offline", "cache", "service worker", "version", "license"],
  },
  {
    id: "field-companion",
    label: "Companion App Links",
    anchorId: "pwa-companion-open",
    sectionId: "app-pwa-settings",
    keywords: ["companion", "url handler", "x-callback", "deeplink", "mobile app"],
  },
  {
    id: "field-export",
    label: "Export & Import",
    anchorId: "export-json-btn",
    sectionId: "backups-reset-settings",
    keywords: ["export", "import", "backup", "restore", "sqlite", "csv", "json"],
  },
  {
    id: "field-retention",
    label: "Data Retention",
    anchorId: "retention-months-select",
    sectionId: "backups-reset-settings",
    keywords: ["retention", "archive", "delete completed", "old tasks", "cleanup", "data slim", "3 months", "6 months", "12 months", "24 months"],
  },
  {
    id: "field-danger",
    label: "Reset & Purge",
    anchorId: "purge-tasks",
    sectionId: "backups-reset-settings",
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

export function resolveSettingsSectionId(id: string): SettingsSectionId | undefined {
  if (SETTINGS_SECTIONS.some((section) => section.id === id)) {
    return id as SettingsSectionId
  }
  return LEGACY_SETTINGS_SECTION_ALIASES[id]
}

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
