import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"

const workDir = mkdtempSync(path.join(tmpdir(), "meitheal-repos-unit-"))
const dbFile = path.join(workDir, "repos.db")
const dbUrl = `file:${dbFile}`

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test("Pomodoro, Template, Settings, Rule, CustomFramework, CommentMention repositories and title cleanup work end-to-end", async () => {
  process.env.MEITHEAL_DB_URL = dbUrl
  const webDir = path.resolve(process.cwd(), "../apps/web")
  execFileSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: webDir,
    env: { ...process.env, MEITHEAL_DB_URL: dbUrl },
  })

  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  await store.ensureSchema()
  const client = store.getPersistenceClient()

  // Seed a base task so foreign-key tables (time_entries, comments, mentions) have a valid target
  const taskId = "task-repo-unit-1"
  const corruptId1 = "task-corrupt-dup-1"
  const corruptId2 = "task-corrupt-clean-2"
  const now = Date.now()
  for (const [id, title, assignedTo] of [
    [taskId, "Smoke Alarm Battery", "ryan"],
    [corruptId1, "MTH-3: MTH-2: MTH-1: Dup loop", null],
    [corruptId2, "📋 MTH-9: Oil gate — DUE — DUE", null],
  ] as const) {
    await client.execute({
      sql: `INSERT INTO tasks (id, title, status, priority, labels, task_type, assigned_to, area_id,
            framework_payload, calendar_sync_state, idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, 'pending', 2, '[]', 'task', ?, 'default', '{}', 'pending', ?, ?, ?, ?)`,
      args: [id, title, assignedTo, `idem-${id}`, `req-${id}`, now, now],
    })
  }

  // 1. PomodoroService
  const pomodoro = await import("../../apps/web/src/domains/pomodoro/pomodoro-service")
  pomodoro.resetPomodoroForTests()
  expect(pomodoro.getTimerState().phase).toBe("idle")
  const focus = await pomodoro.startFocus(taskId)
  expect(focus.phase).toBe("focus")
  const brk = await pomodoro.skipToBreak()
  expect(brk.phase).toBe("short_break")
  const backToFocus = await pomodoro.skipBreak()
  expect(backToFocus.phase).toBe("focus")
  const cancelled = await pomodoro.cancelSession()
  expect(cancelled.phase).toBe("idle")
  expect((await pomodoro.getSessionHistory(5)).length).toBeGreaterThanOrEqual(1)
  expect((await pomodoro.getTodayStats()).sessionsCompleted).toBeGreaterThanOrEqual(1)

  expect(await pomodoro.startTimeEntryForTask("missing-task", "ryan")).toEqual({ ok: false, errorCode: "not_found" })
  expect(await pomodoro.startTimeEntryForTask(taskId, "someone-else")).toEqual({ ok: false, errorCode: "assignee_mismatch" })
  const startedEntry = await pomodoro.startTimeEntryForTask(taskId, "ryan")
  expect(startedEntry.ok).toBe(true)
  expect((await pomodoro.stopTimeEntryForTask(taskId, "ryan")).ok).toBe(true)
  await pomodoro.startTimeEntry(taskId)
  await pomodoro.stopTimeEntry(taskId)
  expect((await pomodoro.getTimeEntries(taskId)).length).toBeGreaterThanOrEqual(2)
  expect(await pomodoro.getTotalTimeForTask(taskId)).toBeGreaterThanOrEqual(0)
  pomodoro.resetPomodoroForTests()

  // 2. TemplateRepository
  const { TemplateRepository } = await import("../../apps/web/src/domains/tasks/persistence/template-repository")
  const templates = new TemplateRepository(client)
  const tmplId = "tmpl-routine-1"
  await templates.create({
    id: tmplId,
    name: "Morning Water",
    templateJson: JSON.stringify({
      title: "Morning Water",
      description: "500ml water",
      priority: 2,
      labels: ["wellness"],
      checklists: [{ text: "Fill glass" }],
    }),
    icon: "💧",
    position: await templates.getNextPosition(),
    isRoutine: true,
    cadence: "daily",
  })
  expect((await templates.findAll()).length).toBeGreaterThanOrEqual(1)
  expect((await templates.findById(tmplId))?.name).toBe("Morning Water")
  await templates.instantiateFromTemplate("tmpl-inst-1", { title: "Standalone Instance", priority: 1 })
  await templates.update(tmplId, { name: "Morning Water Updated", cadence: "daily", streak_freezes_used: 1, streak_freeze_limit: 3 })
  expect((await templates.findHabits()).some(r => r.id === tmplId)).toBe(true)
  const firstRoutine = await templates.instantiateHabitTask(tmplId)
  expect(firstRoutine.alreadyExisted).toBe(false)
  expect((await templates.instantiateRoutineTask(tmplId)).alreadyExisted).toBe(true)
  await client.execute({ sql: "UPDATE tasks SET status = 'complete' WHERE id = ?", args: [firstRoutine.taskId] })
  const yday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, priority, labels, task_type, due_date, source_template_id,
          area_id, framework_payload, calendar_sync_state, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, 'Yesterday Water', 'complete', 2, '[]', 'task', ?, ?, 'default', '{}', 'pending', 'idem-yday', 'req-yday', ?, ?)`,
    args: ["task-yday-routine", yday, tmplId, now, now],
  })
  const stats = await templates.getHabitsWithStats()
  const routineStats = stats.find(r => r.id === tmplId)
  expect(routineStats?.todayCompleted).toBe(true)
  expect(routineStats?.currentStreak).toBeGreaterThanOrEqual(2)
  await templates.delete(tmplId)
  expect(await templates.findById(tmplId)).toBeNull()

  // 3. SettingsRepository
  const { SettingsRepository } = await import("../../apps/web/src/domains/tasks/persistence/settings-repository")
  const settings = new SettingsRepository(client)
  await settings.ensureSettingsTable()
  await settings.upsert("date_format", JSON.stringify("absolute-iso"))
  expect(await settings.getByKey("date_format")).toEqual({ key: "date_format", value: "absolute-iso" })
  await settings.importBatch([{ key: "timezone", value: JSON.stringify("Europe/Dublin") }])
  expect(await settings.getByKeys(["date_format", "timezone"])).toEqual({ date_format: "absolute-iso", timezone: "Europe/Dublin" })
  expect((await settings.getAll()).length).toBeGreaterThanOrEqual(2)
  await settings.snoozeReminder(taskId, new Date(Date.now() - 60_000).toISOString())
  expect((await settings.getPendingReminders()).reminders.length).toBeGreaterThanOrEqual(1)
  await settings.dismissReminder(taskId)
  const filterId = "sf-1"
  await settings.createFilter({ id: filterId, name: "Urgent", queryJson: "{}", icon: "🔥", position: await settings.getNextFilterPosition() })
  expect((await settings.listFilters()).length).toBeGreaterThanOrEqual(1)
  await settings.deleteFilter(filterId)
  await settings.deleteByKeys(["timezone"])

  // 4. RuleRepository & CustomFrameworkRepository
  const rulesRepo = await import("../../apps/web/src/domains/strategy/rule-repository")
  const rule = await rulesRepo.createRule({
    id: "rule-unit-1",
    name: "Household Priority",
    description: "Boost urgency",
    ruleType: "ai-scope",
    taskTypes: ["task"],
    tags: ["home"],
    lensIds: [],
    aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: true, canSuggestLabels: false, customInstructions: "Keep safe" },
    constraints: "Keep safe",
    priority: 10,
    enabled: true,
    createdAt: "",
    updatedAt: "",
  })
  expect(rule.id).toBe("rule-unit-1")
  expect((await rulesRepo.findAllRules({ taskType: "task", tag: "home" })).length).toBeGreaterThanOrEqual(1)
  expect((await rulesRepo.updateRule("rule-unit-1", { priority: 5 }))?.priority).toBe(5)
  expect(await rulesRepo.countRules()).toBeGreaterThanOrEqual(1)
  await rulesRepo.replaceRules([rule], ["rule-unit-1"], false, client)
  expect(await rulesRepo.deleteRule("rule-unit-1")).toBe(true)

  const fwRepo = await import("../../apps/web/src/domains/strategy/custom-framework-repository")
  await fwRepo.createCustomFramework({
    id: "fw-unit-1",
    name: "Unit Score",
    version: "1.0.0",
    archetype: "formula",
    source: "user",
    fields: [{ key: "impact", label: "Impact", type: "number", uiType: "slider", weight: 1, min: 1, max: 10, helpText: "Impact score" }],
    formula: "impact * 2",
    badgeThresholds: [],
  })
  expect(await fwRepo.isFrameworkIdTaken("fw-unit-1")).toBe(true)
  expect((await fwRepo.getAllCustomFrameworks()).some(f => f.id === "fw-unit-1")).toBe(true)
  expect((await fwRepo.getCustomFramework("fw-unit-1"))?.name).toBe("Unit Score")
  await fwRepo.restoreCustomFramework(client, {
    id: "fw-unit-1",
    name: "Restored Score",
    version: "1.0.0",
    archetype: "formula",
    source: "imported",
    fields: [],
    badgeThresholds: [],
  })
  expect((await fwRepo.updateCustomFramework("fw-unit-1", {
    id: "fw-unit-1",
    name: "Updated Score",
    version: "1.0.0",
    archetype: "formula",
    source: "user",
    fields: [],
    badgeThresholds: [],
  }))?.name).toBe("Updated Score")
  expect(await fwRepo.deleteCustomFramework("fw-unit-1")).toBe(true)

  // 5. CommentMentionRepository
  const { CommentMentionRepository } = await import("../../apps/web/src/domains/tasks/persistence/comment-mention-repository")
  const mentions = new CommentMentionRepository(client)
  const recipientKey = "0123456789abcdef0123456789abcdef"
  const ownerKey = "fedcba9876543210fedcba9876543210"
  const createdComment = await mentions.create(
    taskId,
    "Check @claire",
    "ryan",
    ownerKey,
    [recipientKey],
    { key: "attempt-1", issuedAt: now, rawContent: "Check @claire", cutoff: now - 10_000 },
    true,
  )
  expect(createdComment.state).toBe("created")
  if (createdComment.state === "created") {
    const cid = Number(createdComment.comment.id)
    expect((await mentions.replay(taskId, ownerKey, "attempt-1", "Check @claire"))?.state).toBe("replayed")
    expect((await mentions.editChecked(taskId, cid, ownerKey, "Updated @claire", [recipientKey], "wrong-owner")).state).toBe("assignee_mismatch")
    expect(await mentions.edit(taskId, cid, ownerKey, "Final edit", [])).toBeTruthy()
    const inbox = await mentions.page(recipientKey, null)
    expect(inbox.rows).toBeDefined()
    expect(await mentions.mark(recipientKey, null, true)).toBe(true)
  }

  // 6. cleanupCorruptTitles
  const { cleanupCorruptTitles } = await import("../../apps/web/src/lib/cleanup-corrupt-titles")
  const touched = await cleanupCorruptTitles()
  expect(touched).toBeGreaterThanOrEqual(2)
})
