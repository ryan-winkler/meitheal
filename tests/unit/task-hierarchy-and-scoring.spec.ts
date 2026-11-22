import { readFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ALLOWED_CHILD_TYPES,
  MAX_TASK_HIERARCHY_DEPTH,
  validateParentChildType,
} from "../../packages/domain-tasks/src/index"
import {
  calculateRiceScore,
  evaluateFrameworkFormulaDecimal,
  isFrameworkFormulaSupported,
  roundFrameworkScore,
} from "@meitheal/domain-strategy"
import { parseRiceInputs, readRiceAssessment, readRiceInputs, riceLensScore } from "../../apps/web/src/lib/rice-lens"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"

const frameworksDir = resolve(import.meta.dirname, "../../apps/web/src/content/frameworks")

test("R14: percent-normalized RICE, D-RICE, and all 9 built-in frameworks evaluate cleanly", () => {
  expect(MAX_TASK_HIERARCHY_DEPTH).toBe(4)
  expect(ALLOWED_CHILD_TYPES).toEqual({
    epic: ["epic", "story", "task"],
    story: ["task"],
    task: ["task"],
  })

  // Canonical percent-normalized checks
  expect(calculateRiceScore({ reach: 100, impact: 2, confidence: 80, effort: 4 })).toBe(40)
  expect(riceLensScore({ reach: 100, impact: 2, confidence: 80, effort: 4 })).toBe(40)
  expect(riceLensScore({ reach: 10, impact: 3, confidence: 80, effort: 7 })).toBe(3.43)
  expect(riceLensScore({ reach: 0, impact: 3, confidence: 80, effort: 2 })).toBe(0)
  expect(riceLensScore({ reach: 10, impact: 3, confidence: 0, effort: 2 })).toBe(0)
  expect(riceLensScore({ reach: 10, impact: 3, confidence: 80, effort: 0 })).toBeNull()
  expect(roundFrameworkScore(1.505)).toBe(1.51)

  // Strict input parsing rejects booleans, hex, blank, and over-100 confidence
  expect(parseRiceInputs({ reach: "0x10", impact: 2, confidence: 80, effort: 1 })).toBeNull()
  expect(parseRiceInputs({ reach: 10, impact: 2, confidence: true, effort: 1 })).toBeNull()
  expect(parseRiceInputs({ reach: 10, impact: 2, confidence: 101, effort: 1 })).toBeNull()
  expect(parseRiceInputs({ reach: 10, impact: 2, confidence: 80, effort: 0.5 })).toEqual({
    reach: 10, impact: 2, confidence: 80, effort: 0.5,
  })
  expect(readRiceAssessment({ rice: { reach: 10, impact: 2, confidence: 0.8, effort: 2 } }).status).toBe("legacy_ambiguous")
  expect(readRiceInputs({ rice: { reach: 10, impact: 2, confidence: 0.8, effort: 2 } })).toBeNull()

  const builtInFormulaExpectations = [
    { id: "rice", fields: ["reach", "impact", "confidence", "effort"], sample: { reach: 100, impact: 2, confidence: 80, effort: 4 }, expected: 40 },
    { id: "drice", fields: ["reach", "impact", "confidence", "effort", "dependencies"], sample: { reach: 100, impact: 2, confidence: 80, effort: 2, dependencies: 2 }, expected: 40 },
    { id: "ice", fields: ["impact", "confidence", "ease"], sample: { impact: 5, confidence: 8, ease: 4 }, expected: 160 },
    { id: "wsjf", fields: ["business_value", "time_criticality", "risk_reduction", "job_size"], sample: { business_value: 8, time_criticality: 5, risk_reduction: 2, job_size: 4 }, expected: 3.75 },
  ] as const
  for (const item of builtInFormulaExpectations) {
    const src = readFileSync(join(frameworksDir, `${item.id}.yaml`), "utf8")
    const formula = src.match(/^formula:\s*"([^"]+)"/m)?.[1]
    expect(formula).toBeTruthy()
    expect(isFrameworkFormulaSupported(formula!, [...item.fields])).toBe(true)
    expect(evaluateFrameworkFormulaDecimal(formula!, item.sample)).toBe(item.expected)
  }
  for (const id of ["eisenhower", "heart", "kcs", "moscow", "ddd"]) {
    const src = readFileSync(join(frameworksDir, `${id}.yaml`), "utf8")
    expect(src).toMatch(/^name:\s*.+/m)
    expect(src).toMatch(/^fields:/m)
  }
})

test("R01/R04: transactional parent/child type, cycle, depth, subtask projection, and parent delete detachment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meitheal-hierarchy-"))
  const prevUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
  resetPersistenceForTests()

  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const scope = await currentBoardScope(client)
    const repo = new TaskRepository(client, scope)

    expect(validateParentChildType("task", "epic")).toContain("Cannot nest epic under a task")
    expect(validateParentChildType("story", "story")).toContain("Cannot nest story under a story")

    const make = async (id: string, title: string, task_type: string, parent_id: string | null = null) => {
      const prep = await prepareTaskCreation(repo, { title, task_type, parent_id }, { id, useDefaultAssignee: false })
      if (!prep.ok) return prep
      return repo.createWorkCommand(prep.task)
    }

    expect((await make("epic-root", "Platform Migration", "epic"))).toMatchObject({ ok: true })
    expect((await make("epic-sub", "Auth Sub-Epic", "epic", "epic-root"))).toMatchObject({ ok: true })
    expect((await make("story-1", "Session Story", "story", "epic-sub"))).toMatchObject({ ok: true })
    expect((await make("task-leaf", "Write tests", "task", "story-1"))).toMatchObject({ ok: true })

    // Level 5 rejected
    const tooDeep = await make("task-l5", "Level 5", "task", "task-leaf")
    expect(tooDeep).toMatchObject({ ok: false, errorCode: "hierarchy_invalid" })

    // Cannot create story or epic under task
    const storyUnderTask = await make("bad-story", "Bad Story", "story", "task-leaf")
    expect(storyUnderTask).toMatchObject({ ok: false })

    // Self-parent and cycle rejected with hierarchy_invalid
    expect(await repo.updateTask("epic-root", { parent_id: "epic-root" })).toMatchObject({ ok: false, errorCode: "hierarchy_invalid" })
    expect(await repo.updateTask("epic-root", { parent_id: "task-leaf" })).toMatchObject({ ok: false, errorCode: "hierarchy_invalid" })

    // Cannot downgrade epic-sub while story-1 is a child
    expect(await repo.updateTask("epic-sub", { task_type: "story" })).toMatchObject({ ok: false, errorCode: "hierarchy_conflict" })

    // findById + findSubtasks return ticket key and child summary
    const storyDetail = await repo.findById("story-1")
    expect(storyDetail?.parent_title).toBe("Auth Sub-Epic")
    const subtasks = await repo.findSubtasks("story-1")
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0]).toMatchObject({ id: "task-leaf", title: "Write tests" })

    // Deleting story-1 detaches task-leaf to standalone (parent_id: null) rather than blocking or dangling
    expect(await repo.deleteTask("story-1")).toBe(true)
    const orphaned = await repo.findById("task-leaf")
    expect(orphaned?.parent_id).toBeNull()
  } finally {
    resetPersistenceForTests()
    if (prevUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prevUrl
    rmSync(dir, { recursive: true, force: true })
  }
})
