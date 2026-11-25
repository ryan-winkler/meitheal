import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { currentBoardScope } from "../helpers/current-board-scope"
import { ensureSchema, getPersistenceClient } from "../helpers/persistence-fixture"

test("Task settings follow external commits and require current authorization even after warm reads", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "meitheal-task-settings-"))
  const dbPath = join(scratch, "tasks.db")
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${dbPath}`
  const now = Date.now
  let settingsWriter: DatabaseSync | undefined
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const expiresAt = now() + 60_000
    const owner = registerVerifiedPrincipal({ kind: "ha_user", id: "fixture-owner" }, { administrator: true, expiresAt })
    const scope = await currentBoardScope(client, "household", owner)
    const repository = new TaskRepository(client, scope)
    const assignee = "default_assignee:household"
    const notification = "notification_preferences"
    settingsWriter = new DatabaseSync(dbPath)
    const putAssignee = settingsWriter.prepare("INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    const putNotification = settingsWriter.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")

    expect(await repository.getDefaultAssignee()).toBeNull()
    putAssignee.run(assignee, "first", now())
    putNotification.run(notification, JSON.stringify({ enabled: false, disabled_users: ["first"] }), now())
    expect(await repository.getDefaultAssignee()).toBe("first")
    expect(await repository.getDefaultAssignee()).toBe("first")
    expect(await repository.getNotificationPreferences()).toMatchObject({ enabled: false, disabledUsers: new Set(["first"]) })

    putAssignee.run(assignee, "second", now())
    putNotification.run(notification, JSON.stringify({ enabled: false, disabled_users: ["second"] }), now())
    expect(await repository.getDefaultAssignee()).toBe("second")
    expect(await repository.getNotificationPreferences()).toMatchObject({ enabled: false, disabledUsers: new Set(["second"]) })

    Date.now = () => expiresAt + 1
    expect(await repository.getDefaultAssignee()).toBeNull()
    expect(await repository.getNotificationPreferences()).toMatchObject({ enabled: true, disabledUsers: new Set() })
  } finally {
    Date.now = now
    settingsWriter?.close()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(scratch, { recursive: true, force: true })
  }
})
