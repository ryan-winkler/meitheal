import { NamedBoardPlanningRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-planning-repository"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import {
  registerVerifiedPrincipal,
  type BoardScope,
  type VerifiedPrincipal
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import {
  changeGoalShare,
  listSharedGoals
} from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import {
  createPillar,
  getPillars,
  getPillarById
} from "../../apps/web/src/domains/pillars/pillar-service"
import {
  createPrinciple,
  getAllPrinciples
} from "../../apps/web/src/domains/pillars/principle-service"
import { personalPillarScope } from "../../apps/web/src/domains/pillars/pillar-owner"
import {
  linkEntity,
  getPillarsForEntity,
  setEntityPillar
} from "../../apps/web/src/domains/pillars/pillar-association-service"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
let directory: string
const previous = process.env.MEITHEAL_DB_URL
const parent = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "parent" },
    { expiresAt: Date.now() + 60000, administrator: true }
  )
const child = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "child" },
    { expiresAt: Date.now() + 60000, administrator: false }
  )
async function scope(principal: VerifiedPrincipal, id: string): Promise<BoardScope> {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(principal, id, {
    resource: "task",
    action: "read"
  })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
async function board(principal: VerifiedPrincipal, name: string) {
  const result = await new NamedBoardRepository(getPersistenceClient()).create(principal, name)
  if (result.status !== "committed") throw new Error("Board fixture failed")
  return result.result.id
}
async function task(work: BoardScope, title: string) {
  const repository = new TaskRepository(getPersistenceClient(), work)
  const parsed = await prepareTaskCreation(
    repository,
    { title, area_id: null },
    { useDefaultAssignee: false }
  )
  if (!parsed.ok) throw new Error(parsed.error)
  const result = await repository.createWorkCommand(parsed.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-planning-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})
for (const encoding of ["legacy", "scoped"] as const) {
  test(`${encoding}: real Areas, Board/Area/Project Routines, check-in restrictions and private Pillars`, async () => {
    const owner = parent(),
      boards = new NamedBoardRepository(getPersistenceClient())
    const id = encoding === "legacy" ? "household" : await board(owner, "Work")
    if (encoding === "legacy")
      expect(await boards.rename(owner, id, "Church", 1)).toMatchObject({ result: "saved" })
    let work = await scope(owner, id),
      hierarchy = new HierarchyRepository(getPersistenceClient(), work)
    const areaId = encoding === "legacy" ? "default" : randomUUID()
    if (encoding === "legacy")
      expect(await hierarchy.updateArea(areaId, { name: "Kitchen" })).toBe(true)
    else await hierarchy.createArea({ id: areaId, name: "Kitchen" })
    const projectId = randomUUID(),
      unfiledId = randomUUID()
    expect(await hierarchy.createProject({ id: projectId, title: "Garden", area_id: areaId })).toBe(
      true
    )
    expect(await hierarchy.createProject({ id: unfiledId, title: "Unfiled", area_id: null })).toBe(
      true
    )
    const templates = new TemplateRepository(getPersistenceClient(), work)
    for (const [label, area, project] of [
      ["Board", null, null],
      ["Area", areaId, null],
      ["Project", areaId, projectId],
      ["Unfiled Project", null, unfiledId]
    ] as const) {
      const templateId = randomUUID()
      expect(
        await templates.create({
          id: templateId,
          name: label,
          templateJson: JSON.stringify({ title: label, area_id: area, project_id: project }),
          icon: "✅",
          position: 0,
          isRoutine: true,
          cadence: "daily",
          areaId: area,
          projectId: project
        })
      ).toBe(true)
      if (label === "Project") {
        const planning = new NamedBoardPlanningRepository(getPersistenceClient(), work)
        expect(
          await planning.save(owner.id, id, {
            action: "routine",
            id: templateId,
            title: label + " edited",
            description: "Edited",
            cadence: "weekly"
          })
        ).toBe(true)
        expect(
          JSON.parse(String((await templates.findById(templateId))?.template_json)).project_id
        ).toBe(projectId)
        expect(
          await planning.save(owner.id, id, {
            action: "routine",
            id: templateId,
            title: label,
            description: "",
            cadence: "daily",
            projectId: null
          })
        ).toBe(true)
        expect(
          JSON.parse(String((await templates.findById(templateId))?.template_json)).project_id
        ).toBeNull()
        expect(
          await planning.save(owner.id, id, {
            action: "routine",
            id: templateId,
            title: label,
            description: "",
            cadence: "daily",
            projectId
          })
        ).toBe(true)
      }
      const first = await templates.instantiateRoutineTask(templateId)
      const second = await templates.instantiateRoutineTask(templateId)
      expect(second).toMatchObject({ taskId: first.taskId, alreadyExisted: true })
      const generated = await new TaskRepository(getPersistenceClient(), work).findById(
        first.taskId
      )
      expect(generated).toMatchObject({
        task_kind: "routine_instance",
        source_template_id: templateId,
        area_id: area,
        project_id: project
      })
      const completed = await templates.completeRoutine(templateId)
      expect(completed).toMatchObject({ taskId: first.taskId, completed: true })
      expect(
        (await templates.getRoutinesWithStats()).find((routine) => routine.id === templateId)
          ?.todayCompleted
      ).toBe(true)
    }
    const legacyTemplate = randomUUID(),
      legacyTask = randomUUID()
    expect(
      await templates.create({
        id: legacyTemplate,
        name: "Legacy label template",
        templateJson: "{}",
        icon: "house",
        position: 0,
        isRoutine: true
      })
    ).toBe(true)
    const legacyLabels =
      '[{"name":"Keep","retained":true,"reference":9007199254740993,"large":1e999},"Other"]'
    const legacyJson =
      '{"title":"Legacy template instance","area_id":null,"project_id":null,"labels":' +
      legacyLabels +
      "}"
    await getPersistenceClient().execute({
      sql: "UPDATE task_templates SET template_json=? WHERE id=?",
      args: [legacyJson, legacyTemplate]
    })
    await templates.instantiateFromTemplate(legacyTask, JSON.parse(legacyJson), legacyTemplate)
    expect(
      (
        await getPersistenceClient().execute({
          sql: "SELECT labels FROM tasks WHERE id=?",
          args: [legacyTask]
        })
      ).rows[0]?.labels
    ).toBe(legacyLabels)
    expect(
      await prepareTaskCreation(new TaskRepository(getPersistenceClient(), work), {
        title: "Native invalid labels",
        labels: [{ name: "Keep", retained: true }]
      })
    ).toMatchObject({ ok: false })
    await expect(
      templates.instantiateFromTemplate(randomUUID(), JSON.parse(legacyJson), "missing-template")
    ).rejects.toThrow("Template changed")
    const routineAssignee = randomUUID(),
      assignedRoutineId = randomUUID()
    await new IdentityRepository(getPersistenceClient()).createCustomUser(
      routineAssignee,
      "Approved routine agent",
      "#ffffff",
      "agent"
    )
    await templates.create({
      id: assignedRoutineId,
      name: "Assigned routine",
      templateJson: JSON.stringify({
        title: "Assigned routine",
        assigned_to: routineAssignee,
        area_id: null
      }),
      icon: "✅",
      position: 1,
      isRoutine: true,
      cadence: "daily",
      areaId: null,
      projectId: null
    })
    const assignedOccurrence = await templates.instantiateRoutineTask(assignedRoutineId)
    expect(
      (await new TaskRepository(getPersistenceClient(), work).findById(assignedOccurrence.taskId))
        ?.assigned_to
    ).toBe(routineAssignee)
    expect(await templates.completeRoutine(assignedRoutineId)).toMatchObject({
      taskId: assignedOccurrence.taskId,
      completed: true
    })
    const protectedTemplate = randomUUID()
    await templates.create({
      id: protectedTemplate,
      name: "Adult review",
      templateJson: '{"title":"Adult review"}',
      icon: "✅",
      position: 1,
      isRoutine: true
    })
    expect(
      await boards.updateMember(
        owner,
        id,
        "child",
        { role: "member", denyCompletion: true, denyDeletion: true },
        ["parent", "child"]
      )
    ).toMatchObject({ result: "saved" })
    work = await scope(owner, id)
    const childWork = await scope(child(), id)
    const before = await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")
    await expect(
      new TemplateRepository(getPersistenceClient(), childWork).completeRoutine(protectedTemplate)
    ).rejects.toThrow()
    expect(
      (await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows
    ).toEqual(before.rows)
    const shared = await createPillar(work, { name: "Health" })
    const personal = personalPillarScope(owner),
      otherPersonal = personalPillarScope(child())
    const privatePillar = await createPillar(personal, { name: "Private Identity" })
    await createPrinciple(personal, { pillarId: privatePillar.id, statement: "Private principle" })
    expect((await getPillars(childWork)).map((pillar) => pillar.id)).toContain(shared.id)
    expect((await getPillars(childWork)).map((pillar) => pillar.id)).not.toContain(privatePillar.id)
    expect(await getPillarById(childWork, privatePillar.id)).toBeNull()
    expect(await getPillars(otherPersonal)).toEqual([])
    expect((await getAllPrinciples(otherPersonal)).size).toBe(0)
    const target = await task(work, "Care for Kitchen")
    expect(await linkEntity(work, shared.id, "task", String(target.id))).not.toBeNull()
    expect(
      await linkEntity(personal, privatePillar.id, "task", String(target.id), work)
    ).not.toBeNull()
    expect(
      (await getPillarsForEntity(childWork, "task", String(target.id))).map((pillar) => pillar.id)
    ).toEqual([shared.id])
    expect(await setEntityPillar(personal, "tasks", String(target.id), privatePillar.id)).toBe(
      false
    )
  })
}
test("shared Goal on Home shows only readable Project progress and explicit selected associations", async () => {
  const owner = parent(),
    boards = new NamedBoardRepository(getPersistenceClient())
  const workId = await board(owner, "Private Work"),
    homeId = await board(owner, "House")
  await boards.updateMember(
    owner,
    homeId,
    "child",
    { role: "member", denyCompletion: false, denyDeletion: true },
    ["parent", "child"]
  )
  let work = await scope(owner, workId),
    home = await scope(owner, homeId)
  const workHierarchy = new HierarchyRepository(getPersistenceClient(), work),
    homeHierarchy = new HierarchyRepository(getPersistenceClient(), home)
  const goalId = randomUUID(),
    areaId = randomUUID(),
    otherAreaId = randomUUID()
  await workHierarchy.createGoal({
    id: goalId,
    title: "Shared Goal",
    description: "Private Work description"
  })
  await workHierarchy.createProject({
    id: randomUUID(),
    title: "Secret Work Project",
    goal_id: goalId,
    status: "completed"
  })
  await homeHierarchy.createArea({ id: areaId, name: "Kitchen" })
  await homeHierarchy.createArea({ id: otherAreaId, name: "Yard" })
  expect(
    await changeGoalShare(
      getPersistenceClient(),
      work,
      goalId,
      { kind: "board", boardId: homeId },
      true
    )
  ).toMatchObject({ result: "saved" })
  home = await scope(owner, homeId)
  const viewer = await scope(child(), homeId)
  expect(await listSharedGoals(getPersistenceClient(), viewer, { areaId })).toEqual([])
  const homeProject = randomUUID()
  expect(
    await new HierarchyRepository(getPersistenceClient(), home).createProject({
      id: homeProject,
      title: "Family Project",
      area_id: areaId,
      goal_id: goalId,
      status: "completed"
    })
  ).toBe(true)
  const goals = await listSharedGoals(getPersistenceClient(), viewer)
  expect(goals).toEqual([
    expect.objectContaining({
      id: goalId,
      title: "Shared Goal",
      project_count: 1,
      completed_project_count: 1
    })
  ])
  expect(JSON.stringify(goals)).not.toContain("Secret Work")
  expect(JSON.stringify(goals)).not.toContain("Private Work description")
  expect(await listSharedGoals(getPersistenceClient(), viewer, { areaId })).toHaveLength(1)
  expect(await listSharedGoals(getPersistenceClient(), viewer, { areaId: otherAreaId })).toEqual([])
  expect(
    await listSharedGoals(getPersistenceClient(), viewer, { projectId: homeProject })
  ).toHaveLength(1)
})
