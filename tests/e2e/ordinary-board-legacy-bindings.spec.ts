import { expect, test } from "@playwright/test"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { enrollLegacyWorkDestinations } from "../../apps/web/scripts/legacy-work-destinations.mjs"
import { parseWorkDestinations } from "../../apps/web/src/domains/tasks/integration-destinations"

test("admitted legacy conversion pins each old source and grant to its original Board", async () => {
  const db = await openDatabase(":memory:")
  try {
    await db.executeMultiple(`
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE board_access_grants(board_id TEXT,principal_type TEXT,principal_id TEXT,role TEXT,authority_limits TEXT);
      CREATE TABLE tasks(id TEXT PRIMARY KEY,task_board_id TEXT,recurrence_rule TEXT);
      CREATE TABLE task_templates(id TEXT PRIMARY KEY,owner_board_id TEXT,area_id TEXT,is_routine INTEGER);
      INSERT INTO tasks VALUES ('old-repeat',NULL,'FREQ=DAILY'),('private-repeat','private-work','FREQ=WEEKLY');
      INSERT INTO task_templates VALUES ('old-routine',NULL,'kitchen',1),('private-routine','private-work',NULL,1);
    `)
    for (const [key, value] of Object.entries({
      todo_sync_enabled: true, todo_entities: ["todo.family"], todo_sync_direction: "inbound",
      calendar_entities: ["calendar.work"], calendar_sync_mode: "export", calendar_sync_enabled: "true",
      grocy_sync_enabled: true, grocy_url: "https://example.invalid", grocy_api_key: "private-credential",
      webhook_endpoint: "https://example.invalid/webhook", webhook_secret: "private-signing-secret",
      notification_preferences: { enabled: true, channels: { sidebar: false, mobile_push: true }, mobile_targets: ["notify.example"] },
    })) await db.execute({ sql: "INSERT INTO settings VALUES (?, ?, 1)", args: [key, JSON.stringify(value)] })
    const result = await enrollLegacyWorkDestinations(db, "opaque-original-board", 1234)
    expect(parseWorkDestinations(result)).not.toBeNull()
    expect(result.bindings.every(binding => binding.destination.boardId === "opaque-original-board")).toBe(true)
    expect(result.bindings.find(binding => binding.sourceId === "calendar.work")?.allowedOperations).toEqual([{ resource: "task", action: "read" }])
    expect(result.bindings.find(binding => binding.sourceId === "routine:old-routine")?.destination.areaId).toBe("kitchen")
    expect(result.bindings.some(binding => binding.sourceId.includes("private-"))).toBe(false)
    expect(result.bindings.some(binding => binding.sourceId === "persistent_notification")).toBe(false)
    expect(result.bindings.some(binding => binding.sourceId === "notify.example")).toBe(true)
    const grants = await db.execute("SELECT * FROM board_access_grants")
    expect(grants.rows).toHaveLength(result.bindings.length)
    expect(grants.rows.every(row => row.board_id === "opaque-original-board" && row.principal_type === "service")).toBe(true)
    expect(JSON.stringify(result)).not.toContain("private-credential")
    expect(JSON.stringify(result)).not.toContain("private-signing-secret")
    await expect(enrollLegacyWorkDestinations(db, "other-board", 5678)).rejects.toThrow("Unexpected work destination conversion state")
    expect((await db.execute("SELECT COUNT(*) AS count FROM board_access_grants")).rows[0]?.count).toBe(grants.rows.length)
  } finally { db.close() }
})
