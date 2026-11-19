const coreIntegrations = new Set([
  "calendar",
  "calendar_reminder",
  "todo",
  "ha_events",
  "notification",
  "notification_action"
])
const coreKeys = new Set(["ha_url", "ha-url", "ha_token", "ha-token"])
const integrationKeys: Record<string, readonly string[]> = {
  calendar_reminder: ["calendar_", "calendar-", "cal_entity"],
  todo: ["todo_"],
  calendar: ["calendar_", "calendar-", "cal_entity"],
  caldav: ["caldav_"],
  grocy: ["grocy_"],
  webhook: ["webhook_", "n8n_"],
  notification: ["notification_"],
  notification_action: ["notification_"]
}
export function isWorkIntegrationSetting(key: string): boolean {
  return (
    coreKeys.has(key) ||
    Object.values(integrationKeys).some((prefixes) =>
      prefixes.some((prefix) => key.startsWith(prefix))
    )
  )
}
export function profileAffects(integration: string, key: string): boolean {
  return (
    (coreIntegrations.has(integration) && coreKeys.has(key)) ||
    (integrationKeys[integration] ?? []).some((prefix) => key.startsWith(prefix)) ||
    (integration === "ha_events" && key.startsWith("n8n_"))
  )
}
