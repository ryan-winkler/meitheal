import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { sanitizeMarkdownInput } from "../../apps/web/src/lib/sanitize"
import {
  boardCustomFieldsSettingKey,
  formatCardCustomFieldValue,
  normalizeCustomFieldDefs,
  parseVisibleCardCustomFields,
} from "../../apps/web/src/lib/custom-field-defs"
import {
  buildTaskPrefillUrl,
  parseTaskUrlPrefill,
  stripTaskUrlPrefillParams,
} from "../../apps/web/src/lib/task-url-prefill"
import {
  detectLegacyConfidenceFraction,
  formatRiceFormulaBreakdown,
  readRiceAssessment,
  riceLensScore,
} from "../../apps/web/src/lib/rice-lens"
import { defaultTaskSortOrder, TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { scopeCommentOwnerKey } from "../../apps/web/src/domains/tasks/board-scope"
import { LaneDeleteError, LaneRepository } from "../../apps/web/src/domains/tasks/persistence/lane-repository"
import { TaskReactionRepository } from "../../apps/web/src/domains/tasks/persistence/task-reaction-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"

test("R03: sanitizeMarkdownInput preserves code syntax/entities and strips dangerous HTML outside code", () => {
  const input = [
    "# Heading with a < b && c > d & \"quotes\"",
    "",
    "Use `Array<string>` & `x < y && y > z` inline.",
    "",
    "```ts",
    "const html = '<script>alert(1)</script>'",
    "if (a < b && c > d) console.log(\"ok\")",
    "```",
    "",
    "Injected <script>alert(1)</script> and <svg onload=\"alert(2)\">box</svg> and [bad](javascript:alert(3))",
  ].join("\n")

  const clean = sanitizeMarkdownInput(input)
  expect(clean).toContain('a < b && c > d & "quotes"')
  expect(clean).not.toContain("&lt;Generics&gt;")
  expect(clean).not.toContain("&amp;")
  expect(clean).toContain("`Array<string>` & `x < y && y > z`")
  expect(clean).toContain("const html = '<script>alert(1)</script>'")
  expect(clean).not.toContain("Injected <script>")
  expect(clean).not.toContain("<svg")
  expect(clean).not.toContain("onload=")
  expect(clean).not.toContain("javascript:")

  // Multi-backtick spans, balanced parens in links, and null-byte obfuscation
  const tricky = [
    "Multi: ``a `<script>` b`` and link [wiki](https://example.com/a_(b)_c)",
    "Obfuscated: [bad](java\u0000script:alert(1))",
  ].join("\n")
  const trickyClean = sanitizeMarkdownInput(tricky)
  expect(trickyClean).toContain("``a `<script>` b``")
  expect(trickyClean).toContain("[wiki](https://example.com/a_(b)_c)")
  expect(trickyClean).toContain("[bad](#)")
  expect(trickyClean).not.toContain("javascript:")
})

test("R10/R11: boardCustomFieldsSettingKey, normalization, and non-object card formatting", () => {
  expect(boardCustomFieldsSettingKey("household")).toBe("custom_fields")
  expect(boardCustomFieldsSettingKey("board_abc")).toBe("custom_fields:board:board_abc")

  const normalized = normalizeCustomFieldDefs(JSON.stringify([
    { name: " Sprint ", type: "text" },
    { name: "sprint", type: "number" },
    { name: "Env", type: "select", options: ["prod", "staging", "prod"] },
    { name: "", type: "text" },
  ]))
  expect(normalized).toEqual([
    { name: "Sprint", type: "text" },
    { name: "Env", type: "select", options: ["prod", "staging"] },
  ])

  expect(formatCardCustomFieldValue({ name: "Milk", qty: 1 })).toBeNull()
  expect(formatCardCustomFieldValue([{ name: "Milk" }])).toBeNull()
  expect(formatCardCustomFieldValue(null)).toBeNull()
  expect(formatCardCustomFieldValue("")).toBeNull()
  expect(formatCardCustomFieldValue(true)).toBe("Yes")
  expect(formatCardCustomFieldValue(42)).toBe("42")
  expect(formatCardCustomFieldValue("Sprint 12")).toBe("Sprint 12")

  expect(parseVisibleCardCustomFields('["a","b","a","c","d","e"]')).toEqual(["a", "b", "c", "d"])
})

test("R13: task URL prefill validates params, strips custom_fields by default, and cleans URL", () => {
  const qs = "?create=1&v=1&title=Check+HVAC&priority=1&due_date=2026-12-01&task_type=story&labels=home,urgent&custom_fields=%7B%22sprint%22%3A%22S5%22%2C%22bad%22%3A%7B%22x%22%3A1%7D%7D"
  const withoutCf = parseTaskUrlPrefill(qs)
  expect(withoutCf).toEqual({
    title: "Check HVAC",
    priority: 1,
    dueDate: "2026-12-01",
    taskType: "story",
    labels: ["home", "urgent"],
  })
  expect(withoutCf?.customFields).toBeUndefined()

  const withCf = parseTaskUrlPrefill(qs, { allowCustomFields: true })
  expect(withCf?.customFields).toEqual({ sprint: "S5" })

  expect(parseTaskUrlPrefill("?create=1&v=99&title=ignored")).toBeNull()
  expect(stripTaskUrlPrefillParams(new URL(`http://127.0.0.1/tasks${qs}&keep=yes`))).toBe("/tasks?keep=yes")

  const built = buildTaskPrefillUrl("http://127.0.0.1/tasks?foo=1", {
    title: "Test task",
    priority: 2,
    dueDate: "2026-12-25",
    taskType: "epic",
    labels: ["ops"],
    customFields: { sprint: "S9", points: 5 },
  })
  expect(built).toContain("create=1")
  expect(built).toContain("v=1")
  expect(built).toContain("title=Test+task")
  expect(built).toContain("priority=2")
  expect(built).toContain("custom_fields=")

  const roundTrip = parseTaskUrlPrefill(new URL(built).search, { allowCustomFields: true })
  expect(roundTrip?.dueDate).toBe("2026-12-25")
  expect(roundTrip?.customFields).toEqual({ sprint: "S9", points: 5 })

  // Invalid calendar dates must be rejected while leap-day is accepted
  expect(parseTaskUrlPrefill("?create=1&due_date=2026-02-31")?.dueDate).toBeUndefined()
  expect(parseTaskUrlPrefill("?create=1&due_date=2026-04-31")?.dueDate).toBeUndefined()
  expect(parseTaskUrlPrefill("?create=1&due_date=2024-02-29")?.dueDate).toBe("2024-02-29")
})

test("R15: rice-lens detects legacy fractions and formats percent-normalized breakdowns", () => {
  expect(detectLegacyConfidenceFraction({ confidence: 0.8 })).toEqual({
    legacyConfidence: 0.8,
    suggestedPercent: 80,
  })
  expect(detectLegacyConfidenceFraction({ confidence: 0.8, confidence_unit: "percent" })).toBeNull()
  expect(detectLegacyConfidenceFraction({ confidence: 80 })).toBeNull()

  const legacy = readRiceAssessment({ reach: 100, impact: 2, confidence: 0.8, effort: 4 })
  expect(legacy.status).toBe("legacy_ambiguous")

  const scored = readRiceAssessment({ reach: 100, impact: 2, confidence: 80, effort: 4 })
  expect(scored.status).toBe("scored")
  if (scored.status === "scored") {
    expect(scored.score).toBe(40)
    expect(formatRiceFormulaBreakdown(scored.inputs, scored.score)).toBe("(100 × 2 × 80%) ÷ 4 = 40")
  }
  expect(riceLensScore({ reach: 10, impact: 2, confidence: 80, effort: 0 })).toBeNull()
})

test("R17/R18/R19: LaneRepository colors/reorder, reorderTableTasks, reaction groups, and due_date NULLS LAST", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meitheal-exp-unit-"))
  const prevUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(dir, "exp.db")}`
  resetPersistenceForTests()

  try {
    await ensureSchema()
    const db = getPersistenceClient()
    const scope = await currentBoardScope(db)
    const tasks = new TaskRepository(db, scope)
    const lanes = new LaneRepository(db, scope)
    const reactions = new TaskReactionRepository(db, scope)

    expect(defaultTaskSortOrder("priority")).toBe("ASC")
    expect(defaultTaskSortOrder("due_date")).toBe("ASC")
    expect(defaultTaskSortOrder("created_at")).toBe("DESC")

    const make = async (id: string, opts: { title: string; priority?: number; due_date?: string | null; status?: string }) => {
      const prep = await prepareTaskCreation(tasks, {
        title: opts.title,
        priority: opts.priority ?? 3,
        due_date: opts.due_date ?? null,
        status: opts.status ?? "pending",
      }, { id, useDefaultAssignee: false })
      if (!prep.ok) throw new Error(prep.error)
      return tasks.createWorkCommand(prep.task)
    }

    await make("u-null", { title: "No due date", priority: 4, due_date: null })
    await make("u-empty", { title: "Empty due date", priority: 2, due_date: "" })
    await make("u-later", { title: "Later", priority: 3, due_date: "2026-12-20" })
    await make("u-soon", { title: "Soon P1", priority: 1, due_date: "2026-12-05" })

    const byPriority = await tasks.findAll({ sort: "priority" })
    expect(byPriority.tasks.slice(0, 4).map(t => t.id)).toEqual(["u-soon", "u-empty", "u-later", "u-null"])

    const byDueAsc = await tasks.findAll({ sort: "due_date" })
    expect(byDueAsc.tasks.slice(0, 2).map(t => t.id)).toEqual(["u-soon", "u-later"])
    expect(byDueAsc.tasks.slice(-2).map(t => t.id).sort()).toEqual(["u-empty", "u-null"])

    const byDueDesc = await tasks.findAll({ sort: "due_date", order: "DESC" })
    expect(byDueDesc.tasks.slice(0, 2).map(t => t.id)).toEqual(["u-later", "u-soon"])
    expect(byDueDesc.tasks.slice(-2).map(t => t.id).sort()).toEqual(["u-empty", "u-null"])

    // Table manual reorder & Kanban manual reorder (verifies SQLite subquery depth <= limit)
    expect(await tasks.reorderTableTasks(["u-later", "u-soon", "u-empty", "u-null"])).toBe(true)
    const manual = await tasks.findAll({ sort: "table_position" })
    expect(manual.tasks.slice(0, 4).map(t => t.id)).toEqual(["u-later", "u-soon", "u-empty", "u-null"])

    expect(await tasks.reorderTasks(["u-empty", "u-later", "u-soon", "u-null"])).toBe(true)
    const kanbanManual = await tasks.findAll({ sort: "kanban_position" })
    expect(kanbanManual.tasks.slice(0, 4).map(t => t.id)).toEqual(["u-empty", "u-later", "u-soon", "u-null"])

    // Lane color, reorder, intake conflict, and deletion reassignment (including Done lane)
    await lanes.create({
      id: "lane-custom",
      key: "qa_review",
      label: "QA Review",
      icon: "eye",
      color: "#22c55e",
      position: 99,
      wipLimit: 0,
      includes: JSON.stringify(["qa_review", "review"]),
    })
    const createdLane = await lanes.findById("lane-custom")
    expect(createdLane?.color).toBe("#22c55e")
    expect(await lanes.reorder(["nonexistent-lane"])).toBe(false)
    expect(await lanes.reorder(["lane-custom", "lane-custom"])).toBe(false)
    const allLanes = await lanes.findAll()
    const reorderedIds = [String(allLanes[allLanes.length - 1]!.id), ...allLanes.slice(0, -1).map(l => String(l.id))]
    expect(await lanes.reorder(reorderedIds)).toBe(true)
    const afterReorder = await lanes.findAll()
    expect(afterReorder[0]?.id).toBe("lane-custom")

    // Board intake reference must block lane deletion with 409 LaneDeleteError
    await db.execute({
      sql: "INSERT INTO board_intakes (id, board_id, lane_id, label) VALUES (?, ?, ?, ?)",
      args: ["intake-test-1", scope.boardId, "lane-custom", "Intake Trap"],
    })
    await expect(lanes.delete("lane-custom", "qa_review")).rejects.toMatchObject({
      name: LaneDeleteError.name,
      status: 409,
    })
    await db.execute({ sql: "DELETE FROM board_intakes WHERE id = ?", args: ["intake-test-1"] })

    // Invalid destination lane rejects with 400 LaneDeleteError
    await expect(lanes.delete("lane-custom", "qa_review", "no-such-lane")).rejects.toMatchObject({
      status: 400,
    })

    // Reassign tasks on delete into Done lane (household lane membership mapped by status)
    await make("u-review", { title: "In QA lane", status: "qa_review" })
    const doneLane = afterReorder.find(l => l.key === "complete") ?? afterReorder.find(l => l.id !== "lane-custom")!
    const expectedTargetStatus = JSON.parse(String(doneLane.includes ?? '["pending"]'))[0]
    await lanes.delete("lane-custom", "qa_review", String(doneLane.id))
    const reassigned = await tasks.findById("u-review")
    expect(reassigned?.status).toBe(expectedTargetStatus)

    // Reactions empty vs conditional groups
    const ownerKey = scopeCommentOwnerKey(scope)!
    const emptyReactions = await reactions.list({ taskId: "u-soon", commentId: null }, Number.MAX_SAFE_INTEGER, ownerKey)
    expect(emptyReactions).toEqual({ reactions: [], next_cursor: null })
    const added = await reactions.add({ taskId: "u-soon", commentId: null }, "🔥", "User One", ownerKey)
    expect(added?.content).toBe("🔥")
    const populatedReactions = await reactions.list({ taskId: "u-soon", commentId: null }, Number.MAX_SAFE_INTEGER, ownerKey)
    expect(populatedReactions?.groups).toEqual([{
      content: "🔥",
      count: 1,
      reacted: true,
      my_reaction_id: added!.id,
    }])

    // Title tag stripping preserves literal ampersands without &amp; entity corruption
    const createdTitle = await prepareTaskCreation(tasks, {
      title: "  <b>Winter</b> Energy & Heating Audit  ",
    })
    expect(createdTitle.ok).toBe(true)
    if (createdTitle.ok) {
      expect(createdTitle.task.title).toBe("Winter Energy & Heating Audit")
    }
  } finally {
    resetPersistenceForTests()
    if (prevUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prevUrl
    rmSync(dir, { recursive: true, force: true })
  }
})
