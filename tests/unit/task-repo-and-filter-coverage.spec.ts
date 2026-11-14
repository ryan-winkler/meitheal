import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"

const workDir = mkdtempSync(path.join(tmpdir(), "meitheal-task-repo-unit-"))
const dbFile = path.join(workDir, "task-repo.db")
const dbUrl = `file:${dbFile}`

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test("filter-state and appearance-preferences cover filtering, serialization, grouping, and preference DOM helpers", async () => {
  const store = new Map<string, string>()
  let href = "https://meitheal.local/table"
  const listeners = new Map<string, Array<(ev?: unknown) => void>>()

  const prevWindow = (globalThis as Record<string, unknown>).window
  const prevDocument = (globalThis as Record<string, unknown>).document
  const prevStorage = (globalThis as Record<string, unknown>).localStorage
  const prevMatchMedia = (globalThis as Record<string, unknown>).matchMedia
  const prevInnerWidth = (globalThis as Record<string, unknown>).innerWidth

  const docDataset: Record<string, string> = {}
  const bodyClasses = new Set<string>()
  const addListener = (type: string, fn: (ev?: unknown) => void) => {
    const arr = listeners.get(type) ?? []
    arr.push(fn)
    listeners.set(type, arr)
  }

  const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  const fakeWindow = {
    location: {
      get href() { return href },
      get search() { return new URL(href).search },
    },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, nextUrl: string | URL) => {
        href = String(nextUrl)
      },
    },
    addEventListener: addListener,
  }
  const fakeDocument = {
    cookie: "",
    activeElement: null,
    documentElement: {
      dataset: docDataset,
      setAttribute: (name: string, val: string) => {
        const key = name.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
        docDataset[key] = String(val)
      },
      removeAttribute: (name: string) => {
        const key = name.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
        delete docDataset[key]
      },
    },
    body: {
      classList: {
        toggle: (cls: string, force?: boolean) => {
          if (force === undefined) {
            if (bodyClasses.has(cls)) bodyClasses.delete(cls)
            else bodyClasses.add(cls)
          } else if (force) bodyClasses.add(cls)
          else bodyClasses.delete(cls)
        },
        contains: (cls: string) => bodyClasses.has(cls),
      },
    },
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: addListener,
  }

  Object.assign(globalThis, {
    window: fakeWindow,
    document: fakeDocument,
    localStorage: fakeStorage,
    matchMedia: () => ({ matches: true }),
    innerWidth: 1280,
  })

  try {
    const fsMod = await import("../../apps/web/src/lib/filter-state")
    const apMod = await import("../../apps/web/src/lib/appearance-preferences")

    // URL label serialization
    const p1 = new URLSearchParams()
    fsMod.writeFilterLabels(p1, ["home", "urgent"])
    expect(p1.get("labels")).toBe("home,urgent")
    expect(fsMod.readFilterLabels(p1)).toEqual(["home", "urgent"])

    const p2 = new URLSearchParams()
    fsMod.writeFilterLabels(p2, ["a,b", "c"])
    expect(fsMod.readFilterLabels(p2)).toEqual(["a,b", "c"])

    // Table column & creation range normalization
    expect(fsMod.normalizeTableColumns(JSON.stringify(["status", "priority"]))).toContain("title")
    expect(fsMod.normalizeTableCreationRange("2026-11-01", "2026-11-10")).toEqual({
      createdFrom: "2026-11-01",
      createdThrough: "2026-11-10",
    })
    expect(fsMod.normalizeTableCreationRange("2026-11-10", "2026-11-01")).toBeNull()
    expect(fsMod.tableCreationRangeLabel("2026-11-01", "2026-11-01")).toBe("2026-11-01")
    expect(fsMod.tableCreationRangeLabel("2026-11-01", "2026-11-10")).toBe("2026-11-01 – 2026-11-10")
    expect(fsMod.tableCreationRangeLabel("2026-11-01", undefined)).toBe("≥ 2026-11-01")
    expect(fsMod.tableCreationRangeLabel(undefined, "2026-11-10")).toBe("≤ 2026-11-10")
    expect(fsMod.tableCreationRangeLabel(undefined, undefined)).toBe("")

    const saved = fsMod.normalizeSavedFilter(JSON.stringify({
      search: "boiler",
      status: "in_progress",
      sort: "due_asc",
      labels: ["heating"],
      groupBy: "board",
      advancedFilter: {
        id: "r",
        logic: "AND",
        conditions: [{ id: "c1", field: "status", operator: "equals", value: "done" }],
      },
    }))
    expect(saved?.sort).toBe("due_date-asc")
    expect(saved?.area).toBe("")
    expect(fsMod.normalizeSavedFilter("invalid-json")).toBeNull()

    // Save/Load/Clear FilterState & TableFilterState
    fsMod.saveTableFilterState({ search: "pump", status: "active", labels: ["home"], laneIds: ["lane-active"], createdFrom: "2026-11-01" }, 2)
    expect(href).toContain("tp=2")
    const loadedTable = fsMod.loadTableFilterState()
    expect(loadedTable.search).toBe("pump")
    expect(loadedTable.laneIds).toEqual(["lane-active"])

    fsMod.saveFilterState({
      search: "heat",
      status: "pending",
      priority: "1",
      sort: "priority-asc",
      types: ["standard_action"],
      labels: ["home"],
      advancedFilter: { id: "g", logic: "AND", conditions: [] },
    })
    expect(fsMod.loadFilterState().search).toBe("heat")
    fsMod.clearFilterState()
    expect(store.size).toBe(0)

    // Matching & Visibility & Grouping
    const el = {
      dataset: {
        search: "fix heating pump",
        title: "Fix Heating Pump",
        status: "active",
        priority: "1",
        rice: "18",
        assigned: "ryan",
        area: "home",
        taskType: "task",
        taskKind: "standard_action",
        labels: JSON.stringify(["home", { name: "Plumbing" }]),
        overdue: "true",
      },
    } as unknown as Pick<HTMLElement, "dataset">

    expect(fsMod.matchesStatusFilter(el, "overdue")).toBe(true)
    expect(fsMod.matchesStatusFilter(el, "active")).toBe(true)
    expect(fsMod.matchesRiceFilter(el, "high")).toBe(true)
    expect(fsMod.isTaskVisible(el, {
      search: "pump",
      status: "active",
      priority: "1",
      rice: "high",
      user: "ryan",
      area: "home",
      task_type: "task",
      types: ["standard_action"],
      labels: ["plumbing"],
    })).toBe(true)
    expect(fsMod.isTaskVisible(el, { user: "__unassigned__" })).toBe(false)

    for (const gb of ["none", "type", "priority", "area", "assignee", "status", "rice"] as const) {
      const k = fsMod.getGroupKey(el, gb)
      const disp = fsMod.getGroupDisplay(gb, k)
      expect(disp.label.length).toBeGreaterThan(0)
    }

    // Appearance preferences
    store.set(apMod.APPEARANCE_STORAGE_KEY, JSON.stringify({ navigation: "navbar", base: "slate" }))
    const prefs = apMod.readAppearancePreferences()
    expect(prefs.navigation).toBe("navbar")
    expect(apMod.appearanceAttribute("panelStyle")).toBe("data-appearance-panel-style")
    apMod.applyAppearancePreferences(prefs)
    expect(docDataset.appearanceNavigation).toBe("navbar")
    const ac = new AbortController()
    apMod.bindAppearanceNavigation(ac.signal)
    ac.abort()
  } finally {
    Object.assign(globalThis, {
      window: prevWindow,
      document: prevDocument,
      localStorage: prevStorage,
      matchMedia: prevMatchMedia,
      innerWidth: prevInnerWidth,
    })
  }
})

test("TaskRepository and SettingsRepository AI handoff persistence cover full CRUD, pagination, search, hierarchy, comments, and cleanup", async () => {
  process.env.MEITHEAL_DB_URL = dbUrl
  const webDir = path.resolve(process.cwd(), "../apps/web")
  execFileSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: webDir,
    env: { ...process.env, MEITHEAL_DB_URL: dbUrl },
  })

  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  await store.ensureSchema()
  const client = store.getPersistenceClient()

  const settingsMod = await import("../../apps/web/src/domains/tasks/persistence/settings-repository")
  expect(settingsMod.getSettingsRevision()).toBeGreaterThanOrEqual(0)
  const settingsRepo = new settingsMod.SettingsRepository(client)
  await settingsRepo.ensureSettingsTable()
  expect(await settingsMod.saveAiHandoffSettings(
    client,
    { provider: null, url: null, shared: false },
    { provider: "custom", destination: { url: "https://llm.example/api", shared: true } },
  )).toBe(true)
  expect(await settingsMod.saveAiHandoffSettings(
    client,
    { provider: null, url: null, shared: false },
    { provider: "openai" },
  )).toBe(false)
  await settingsMod.saveLegacyAiHandoffUrl(client, "https://legacy.example/api")

  // Seed project so project_id queries have a match
  const now = Date.now()
  await client.execute({
    sql: `INSERT OR IGNORE INTO projects (id, title, area_id, status, created_at, updated_at)
          VALUES ('proj-1', 'Winter Prep', 'default', 'active', ?, ?)`,
    args: [now, now],
  })

  const { TaskRepository } = await import("../../apps/web/src/domains/tasks/persistence/task-repository")
  const repo = new TaskRepository(client)

  const todayStr = new Date(now).toISOString().split("T")[0]!
  const tomorrowStr = new Date(now + 86_400_000).toISOString().split("T")[0]!

  const epicTicket = await repo.createTask({
    id: "epic-1",
    title: "Winter Heating Upgrade",
    description: "Replace radiator valves",
    status: "pending",
    priority: 1,
    due_date: tomorrowStr,
    labels: JSON.stringify(["heating"]),
    framework_payload: "{}",
    parent_id: null,
    project_id: "proj-1",
    area_id: "default",
    custom_fields: "{}",
    start_date: todayStr,
    end_date: tomorrowStr,
    progress: 10,
    color: "#3b82f6",
    is_favorite: 1,
    task_type: "epic",
    assigned_to: "ryan",
  }, now)
  expect(epicTicket).toBeGreaterThanOrEqual(1)

  const childTicket = await repo.createTask({
    id: "child-1",
    title: "Bleed living room radiator",
    description: "Use brass radiator key",
    status: "pending",
    priority: 1,
    due_date: "2020-01-15",
    labels: JSON.stringify(["heating", "radiators"]),
    framework_payload: "{}",
    parent_id: "epic-1",
    project_id: "proj-1",
    area_id: "default",
    custom_fields: "{}",
    start_date: todayStr,
    end_date: tomorrowStr,
    progress: 0,
    color: "#ef4444",
    is_favorite: 0,
    task_type: "task",
    assigned_to: "ryan",
    recurrence_rule: "FREQ=WEEKLY;INTERVAL=1",
  }, now)
  expect(childTicket).toBeGreaterThan(epicTicket)

  await repo.createTask({
    id: "backlog-1",
    title: "Paint garden shed",
    description: "",
    status: "backlog",
    priority: 3,
    due_date: null,
    labels: "[]",
    framework_payload: "{}",
    parent_id: null,
    area_id: "default",
    custom_fields: "{}",
    start_date: null,
    end_date: null,
    progress: 0,
    color: null,
    is_favorite: 0,
    task_type: "task",
    assigned_to: null,
  }, now)

  await repo.createTask({
    id: "today-due-1",
    title: "Check loft insulation",
    description: "Measure depth",
    status: "active",
    priority: 2,
    due_date: todayStr,
    labels: JSON.stringify(["home"]),
    framework_payload: "{}",
    parent_id: null,
    area_id: "default",
    custom_fields: "{}",
    start_date: todayStr,
    end_date: todayStr,
    progress: 50,
    color: null,
    is_favorite: 1,
    task_type: "task",
    assigned_to: "ryan",
  }, now)

  // Reads & queries
  expect((await repo.resolveTaskId(`MTH-${epicTicket}`))?.id).toBe("epic-1")
  const foundEpic = await repo.findById("epic-1")
  expect(foundEpic?.title).toBe("Winter Heating Upgrade")
  expect((await repo.getRecentTasks(5)).length).toBeGreaterThanOrEqual(4)
  expect((await repo.findByProjectId("proj-1")).length).toBe(2)
  expect((await repo.getProjectTaskCounts()).get("proj-1")?.total).toBe(2)
  expect((await repo.getFavoriteTasks(5)).length).toBeGreaterThanOrEqual(1)
  expect((await repo.getOpenTasks(10)).length).toBeGreaterThanOrEqual(3)
  expect((await repo.getStatusCounts()).total).toBeGreaterThanOrEqual(4)
  expect(await repo.getOverdueCount(todayStr)).toBeGreaterThanOrEqual(1)
  expect((await repo.getAreas()).default?.name).toBeTruthy()
  expect((await repo.getCalendarTaskCounts("2020-01-01", "2099-12-31"))[todayStr]?.count).toBeGreaterThanOrEqual(1)
  expect(typeof (await repo.getCalendarHAEventCounts("2020-01-01", "2099-12-31"))).toBe("object")
  expect((await repo.getTimelineTasks()).length).toBeGreaterThanOrEqual(4)
  expect((await repo.getOverdueTasks(todayStr)).some(t => t.id === "child-1")).toBe(true)
  expect((await repo.getTasksDueOn(todayStr)).some(t => t.id === "today-due-1")).toBe(true)
  expect((await repo.getUnscheduledTasks(5)).some(t => t.id === "backlog-1")).toBe(true)
  expect((await repo.getSuggestedTasks(todayStr, 5)).length).toBeGreaterThanOrEqual(1)
  expect((await repo.getTasksInRange("2020-01-01", tomorrowStr)).length).toBeGreaterThanOrEqual(2)
  expect(await repo.getParentTaskType("epic-1")).toBe("epic")
  await repo.getDefaultAssignee()

  // Kanban snapshot reads & searchCatalog
  await repo.withKanbanRead(async (reader) => {
    const idx = await repo.getKanbanIndex(["pending", "active"], 0, { matchText: true, matchOverdue: true, today: todayStr }, reader)
    expect(idx.length).toBeGreaterThanOrEqual(3)
    const cards = await repo.getKanbanCards(idx.map(r => r.id), 0, reader)
    expect(cards.length).toBe(idx.length)
  })
  expect((await repo.findBacklogPage(1)).total).toBeGreaterThanOrEqual(1)
  expect((await repo.findAll({ status: "pending", areaId: "default", priority: 1 })).tasks.length).toBeGreaterThanOrEqual(1)
  expect((await repo.findAll({
    projectId: "proj-1",
    taskType: "task",
    parentId: "epic-1",
    search: "radiator",
    assignedTo: "ryan",
    label: "radiators",
    dueDate: "2020-01-15",
    deferred: false,
    sort: "priority",
    order: "ASC",
  })).total).toBe(1)
  expect((await repo.searchCatalog({ query: `MTH-${epicTicket}`, limit: 10 })).some(r => r.id === "epic-1")).toBe(true)
  expect((await repo.searchCatalog({ query: "radiator", status: "pending", sort: "relevance" })).some(r => r.id === "child-1")).toBe(true)
  expect((await repo.exportAll()).length).toBeGreaterThanOrEqual(4)

  // Updates, NFC, Activity log, Deferral, Comments, Kanban reorder
  const updated = await repo.updateTask("child-1", {
    description: "Use key + cloth",
    nfc_tag_id: "nfc-rad-1",
    progress: 75,
  })
  expect(updated.ok).toBe(true)
  expect((await repo.findByNfcTag("nfc-rad-1")).length).toBe(1)

  const preDiff = await repo.getFieldsForDiff("child-1")
  expect(preDiff?.progress).toBe(75)
  await repo.logActivity("child-1", [{ field: "progress", oldValue: "50", newValue: "75" }], {
    actor: "ryan",
    actor_type: "human",
  })
  await repo.recordTimelineEvent("child-1", {
    event_type: "field_change",
    actor: "ryan",
    actor_type: "human",
    summary: "Inspected valve",
  })

  const commentRes = await repo.addCommentChecked("child-1", "Bled valve cleanly", "ryan", "owner-key-1", true, "ryan")
  expect(commentRes.state).toBe("created")
  expect((await repo.getComments("child-1", "owner-key-1")).length).toBe(1)
  expect(await repo.addComment("child-1", "Follow-up note", "ryan", "owner-key-1", true)).toBeTruthy()
  expect((await repo.getActivityLog("child-1", 10, 0)).total).toBeGreaterThanOrEqual(2)

  // Defer & undefer + deferred page
  const latestChild = await repo.findById("child-1")
  const deferredRes = await repo.setDeferral(
    "child-1",
    true,
    { updatedAt: Number(latestChild!.task_version ?? latestChild!.updated_at), revision: latestChild!.deferral_revision ?? null },
    { id: "ryan", type: "human", requestId: "req-def-1" },
  )
  expect(deferredRes.ok).toBe(true)
  expect((await repo.findDeferredPage(1)).total).toBeGreaterThanOrEqual(1)
  if (deferredRes.ok) {
    const undeferRes = await repo.setDeferral(
      "child-1",
      false,
      { updatedAt: Number(deferredRes.task.updated_at), revision: deferredRes.task.deferral_revision ?? null },
      { id: "ryan", type: "human", requestId: "req-undef-1" },
    )
    expect(undeferRes.ok).toBe(true)
  }

  // Reorder two open tasks on the first matching lane
  const laneRows = await client.execute("SELECT key, includes FROM kanban_lanes")
  const pendingLane = laneRows.rows.find(r => String(r.includes).includes("pending"))
  if (pendingLane) {
    await repo.reorderKanbanCard({ id: "child-1", anchorId: "epic-1", lane: String(pendingLane.key), before: true })
  }

  // Recurrence clone, hierarchy, cascade complete & cleanup
  const recData = await repo.getRecurrenceData("child-1")
  expect(recData?.recurrence_rule).toBe("FREQ=WEEKLY;INTERVAL=1")
  const cloned = await repo.cloneForRecurrence(recData!, tomorrowStr, "FREQ=WEEKLY;INTERVAL=1")
  expect(cloned.ticketNumber).toBeGreaterThan(childTicket)
  expect(await repo.getOpenTaskCount()).toBeGreaterThanOrEqual(4)
  expect(await repo.getChildrenIds("epic-1")).toContain("child-1")
  expect(await repo.cascadeComplete("epic-1", "ryan")).toBeGreaterThanOrEqual(1)
  expect(await repo.getCompletedTodayCount(todayStr)).toBeGreaterThanOrEqual(1)

  const futureCutoff = Date.now() + 60_000
  expect(await repo.countCompletedBefore(futureCutoff)).toBeGreaterThanOrEqual(1)
  expect(await repo.deleteCompletedBefore(futureCutoff)).toBeGreaterThanOrEqual(1)

  await repo.deleteTask("backlog-1")
  expect(await repo.findById("backlog-1")).toBeNull()
})
