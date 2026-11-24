import { randomUUID } from "node:crypto"

const operation = action => ({ resource: "task", action })
const read = [operation("read")]
const importWork = [operation("read"), operation("create"), operation("edit"), operation("complete"), operation("reopen"), operation("delete")]
const tableExists = async (tx, name) => (await tx.execute({
  sql: "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", args: [name],
})).rows.length > 0

function decode(value) {
  try { return JSON.parse(String(value)) } catch { return value }
}

// Frozen compatibility parsing for the predecessor startup settings. This is
// admitted migration code, not a runtime default or source of new Board grants.
function calendarIds(settings) {
  for (const key of ["calendar_entities", "calendar_entity", "cal_entity", "calendar-entity", "calendar-entities"]) {
    let value = settings[key]
    if (typeof value === "string" && value.trimStart().startsWith("[")) {
      try { value = JSON.parse(value) } catch { continue }
    }
    const ids = [...new Set((Array.isArray(value) ? value : [value])
      .filter(id => typeof id === "string" && /^calendar\.[a-z0-9_]+$/.test(id)))]
    if (key === "calendar_entities" && Array.isArray(value)) return ids
    if (key === "calendar_entity" && value === "") return []
    if (ids.length) return ids
  }
  return []
}

/** Called only by admitted0016 in the same startup policy/epoch writer. */
export async function enrollLegacyWorkDestinations(tx, legacyBoardId, now) {
  const settings = Object.create(null)
  if (await tableExists(tx, "settings")) {
    const { rows } = await tx.execute("SELECT key, value FROM settings")
    for (const row of rows) settings[String(row.key)] = decode(row.value)
  } else {
    await tx.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  }
  // Never replace a prior conversion or guess a destination from browser state.
  if (settings["work-destinations"] !== undefined) throw new Error("Unexpected work destination conversion state")
  const bindings = []
  const add = (integration, sourceId, purpose, allowedOperations, placement = {}) => {
    const binding = { id: randomUUID(), generation: 1, integration, sourceId, purpose,
      enabled: true, destination: { boardId: legacyBoardId, ...placement }, allowedOperations }
    bindings.push(binding)
    return binding
  }
  if (settings.todo_sync_enabled === true || settings.todo_sync_enabled === "true") {
    let entities = settings.todo_entities
    if (typeof entities === "string") { try { entities = JSON.parse(entities) } catch { entities = [] } }
    if (!Array.isArray(entities) || !entities.length) entities = [settings.todo_entity]
    const incoming = settings.todo_sync_direction !== "outbound"
    for (const id of new Set(entities.filter(id => typeof id === "string" && id.length > 0))) {
      add("todo", id, "todo.sync", incoming ? importWork : read)
    }
  }
  // The predecessor used this exact string check after JSON decoding.
  if (settings.calendar_sync_enabled !== "false") {
    const modes = decode(settings.calendar_sync_modes)
    for (const id of calendarIds(settings)) {
      const mode = modes && typeof modes === "object" ? modes[id] ?? settings.calendar_sync_mode : settings.calendar_sync_mode
      add("calendar", id, "calendar.sync", mode === "export" ? read : importWork)
    }
    if (typeof settings.caldav_url === "string" && settings.caldav_url) add("caldav", "configured-caldav", "calendar.sync", importWork)
  }
  if ([true, 1, "true", "1"].includes(settings.grocy_sync_enabled) && settings.grocy_url && settings.grocy_api_key) {
    add("grocy", "configured-grocy", "grocy.sync", settings.grocy_sync_mode === "export" ? read : importWork)
  }
  for (const [key, id] of [["webhook_endpoint", "generic-webhook"], ["n8n_webhook_url", "n8n-webhook"]]) {
    if (typeof settings[key] === "string" && settings[key]) add("webhook", id, "webhook.delivery", read)
  }
  // These jobs already ran for the original collection, independently of HA.
  add("builtin", `builtin:overdue:${legacyBoardId}`, "builtin.overdue.observe", [operation("read"), operation("edit")])
  add("builtin", `builtin:reminders:${legacyBoardId}`, "builtin.reminders.observe", [operation("read"), operation("edit")])
  add("builtin", `builtin:inactivity:${legacyBoardId}`, "builtin.inactivity.defer", [operation("read"), operation("edit")])
  const preferences = settings.notification_preferences
  if (!preferences || preferences.enabled !== false) {
    if (!preferences?.channels || preferences.channels.sidebar !== false) add("notification", "persistent_notification", "notify.delivery", read)
    if (preferences?.channels?.mobile_push && Array.isArray(preferences.mobile_targets)) {
      for (const target of new Set(preferences.mobile_targets.filter(item => typeof item === "string" && item))) {
        add("notification", target, "notify.delivery", read)
      }
    }
  }
  if ((!preferences || preferences.enabled !== false) && preferences?.due_date_reminders !== false) {
    const present = []
    for (const key of ["calendar_entity", "calendar_entities"]) {
      if (settings[key] === undefined) continue
      const value = decode(settings[key])
      present.push(Array.isArray(value) ? value[0] : value)
    }
    if (present.length && present.every(value => value === present[0]) && typeof present[0] === "string" && /^calendar\.[a-z0-9_]+$/.test(present[0])) {
      add("calendar_reminder", present[0], "calendar.reminder", read)
    }
  }
  add("ha_events", "meitheal", "webhook.delivery", read)
  if (await tableExists(tx, "task_templates")) {
    const { rows } = await tx.execute("SELECT id, area_id FROM task_templates WHERE owner_board_id IS NULL AND is_routine = 1")
    for (const row of rows) add("routine", `routine:${row.id}`, "builtin.routine.generate", [operation("read"), operation("create")],
      row.area_id ? { areaId: String(row.area_id) } : {})
  }
  const { rows: recurring } = await tx.execute("SELECT id FROM tasks WHERE task_board_id IS NULL AND NULLIF(trim(recurrence_rule), '') IS NOT NULL")
  for (const row of recurring) add("recurrence", `recurrence:${row.id}`, "builtin.recurrence.generate", [operation("read"), operation("create")])
  const configuration = { version: 1, revision: randomUUID(), bindings }
  if (await tableExists(tx, "app_settings")) {
    await tx.execute({
      sql: `INSERT INTO app_settings(key, value, updated_at)
        SELECT ?, value, updated_at FROM app_settings WHERE key = 'system.overdue-events.checked-at'
        ON CONFLICT(key) DO NOTHING`,
      args: [`system.overdue-events.checked-at:${legacyBoardId}`],
    })
  }
  await tx.execute({
    sql: "INSERT INTO settings(key, value, updated_at) VALUES ('work-destinations', ?, ?)",
    args: [JSON.stringify(configuration), now],
  })
  for (const binding of bindings) {
    await tx.execute({
      sql: `INSERT INTO board_access_grants(board_id, principal_type, principal_id, role, authority_limits)
        VALUES (?, 'service', ?, 'service', ?)`,
      args: [legacyBoardId, binding.id, JSON.stringify({ operations: binding.allowedOperations, purpose: binding.purpose })],
    })
  }
  return configuration
}
