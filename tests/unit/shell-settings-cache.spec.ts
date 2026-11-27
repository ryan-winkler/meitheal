import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import {
  readCachedAiAssistDisabled,
  readCachedBoardName,
  readCachedCalendarPushPolicy,
  readCachedHasActivePlugins,
  readCachedSidebarAndProfile,
  readCachedTaskDetailLayout,
  readCachedWorkInstallationId,
} from "../../apps/web/src/lib/shell-settings-cache"
import { taskDetailServerSettingKey } from "../../apps/web/src/lib/task-detail-layout"

test("shell settings follow external SQLite commits and keep legacy values readable", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "meitheal-shell-cache-"))
  const database = join(scratch, "tasks.db")
  const db = openDatabase(`file:${database}`)
  let writer: DatabaseSync | undefined
  try {
    await db.executeMultiple(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE task_boards (id TEXT PRIMARY KEY, name TEXT);
    `)
    writer = new DatabaseSync(database)
    const putSetting = writer.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")

    expect(await readCachedWorkInstallationId(db)).toBeUndefined()
    expect(await readCachedBoardName(db, "household", "Household")).toBe("Household")
    expect(await readCachedTaskDetailLayout(db)).toBeNull()
    expect(await readCachedAiAssistDisabled(db)).toBe(false)
    expect(await readCachedSidebarAndProfile(db)).toEqual({
      rawSidebarConfig: null, rawUserProfile: null, cacheKey: "[null,null]",
    })

    writer.prepare("INSERT INTO app_settings VALUES ('work_installation_id', ?)").run("fixture-a")
    const renameBoard = writer.prepare("INSERT OR REPLACE INTO task_boards VALUES (?, ?)")
    renameBoard.run("household", "Home")
    renameBoard.run("club", "Club")
    putSetting.run(taskDetailServerSettingKey, "legacy layout")
    putSetting.run("ai_assist_disabled", "true")
    putSetting.run("sidebar_config", '{"collapsed":true}')
    putSetting.run("user_profile", '{"displayName":"Alex"}')
    putSetting.run("calendar_manual_push_enabled", "false")
    putSetting.run("calendar_sync_enabled", '"true"')
    putSetting.run("calendar_sync_mode", "push")
    putSetting.run("calendar_write_back", "null")
    putSetting.run("calendar_sync_interval_ms", "60000")

    expect(await readCachedWorkInstallationId(db)).toBe("fixture-a")
    expect(await readCachedWorkInstallationId(db)).toBe("fixture-a")
    expect(await readCachedBoardName(db, "household", "Household")).toBe("Home")
    expect(await readCachedBoardName(db, "club", "Club")).toBe("Club")
    expect(await readCachedBoardName(db, "household", "Household")).toBe("Home")
    expect(await readCachedTaskDetailLayout(db)).toBe("legacy layout")
    expect(await readCachedTaskDetailLayout(db)).toBe("legacy layout")
    expect(await readCachedAiAssistDisabled(db)).toBe(true)
    expect(await readCachedAiAssistDisabled(db)).toBe(true)
    const profile = await readCachedSidebarAndProfile(db)
    expect(profile).toMatchObject({
      rawSidebarConfig: '{"collapsed":true}', rawUserProfile: '{"displayName":"Alex"}',
    })
    expect(await readCachedSidebarAndProfile(db)).toEqual(profile)
    const policy = await readCachedCalendarPushPolicy(db)
    expect(policy).toEqual({
      calendar_manual_push_enabled: false,
      calendar_sync_enabled: "true",
      calendar_sync_mode: "push",
      calendar_write_back: null,
      calendar_sync_interval_ms: 60000,
    })
    policy.calendar_sync_interval_ms = 1
    expect((await readCachedCalendarPushPolicy(db)).calendar_sync_interval_ms).toBe(60000)

    renameBoard.run("household", "Renamed Home")
    putSetting.run(taskDetailServerSettingKey, JSON.stringify("new layout"))
    putSetting.run("ai_assist_disabled", "false")
    putSetting.run("user_profile", '{"displayName":"Sam"}')
    expect(await readCachedBoardName(db, "household", "Household")).toBe("Renamed Home")
    expect(await readCachedTaskDetailLayout(db)).toBe("new layout")
    expect(await readCachedAiAssistDisabled(db)).toBe(false)
    expect((await readCachedSidebarAndProfile(db)).cacheKey).not.toBe(profile.cacheKey)
  } finally {
    writer?.close()
    db.close()
    await rm(scratch, { recursive: true, force: true })
  }
})

test("a plugin read overtaken by a database commit does not enter the shell cache", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "meitheal-shell-plugin-cache-"))
  const database = join(scratch, "tasks.db")
  const db = openDatabase(`file:${database}`)
  let writer: DatabaseSync | undefined
  try {
    await db.executeMultiple("CREATE TABLE plugin_state (enabled INTEGER); INSERT INTO plugin_state VALUES (0);")
    writer = new DatabaseSync(database)
    let finish!: (value: boolean) => void
    const snapshot = new Promise<boolean>(resolve => { finish = resolve })
    const reading = readCachedHasActivePlugins(db, () => snapshot)
    writer.exec("UPDATE plugin_state SET enabled = 1")
    finish(false)
    expect(await reading).toBe(false)

    let reads = 0
    const readLive = async () => {
      reads++
      const { rows: [row] } = await db.execute("SELECT enabled FROM plugin_state")
      return row?.enabled === 1
    }
    expect(await readCachedHasActivePlugins(db, readLive)).toBe(true)
    expect(await readCachedHasActivePlugins(db, readLive)).toBe(true)
    expect(reads).toBe(1)
  } finally {
    writer?.close()
    db.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
