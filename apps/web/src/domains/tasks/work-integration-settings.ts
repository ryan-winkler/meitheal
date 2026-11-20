const homeAssistantTodo = "todo"
const coreIntegrations = new Set([
  "calendar",
  "calendar_reminder",
  homeAssistantTodo,
  "ha_events",
  "notification",
  "notification_action"
])
const coreKeys = new Set(["ha_url", "ha-url", "ha_token", "ha-token"])
const calendarKeys = ["calendar_", "calendar-", "cal_entity"]
const notificationKeys = ["notification_"]
const integrationKeys = new Map<string, readonly string[]>([
  ["calendar_reminder", calendarKeys],
  [homeAssistantTodo, ["todo_"]],
  ["calendar", calendarKeys],
  ["caldav", ["caldav_"]],
  ["grocy", ["grocy_"]],
  ["webhook", ["webhook_", "n8n_"]],
  ["notification", notificationKeys],
  ["notification_action", notificationKeys]
])
export function isWorkIntegrationSetting(key: string): boolean {
  return (
    coreKeys.has(key) ||
    Array.from(integrationKeys.values()).some((prefixes) =>
      prefixes.some((prefix) => key.startsWith(prefix))
    )
  )
}
export function profileAffects(integration: string, key: string): boolean {
  return (
    (coreIntegrations.has(integration) && coreKeys.has(key)) ||
    (integrationKeys.get(integration) ?? []).some((prefix) => key.startsWith(prefix)) ||
    (integration === "ha_events" && key.startsWith("n8n_"))
  )
}
