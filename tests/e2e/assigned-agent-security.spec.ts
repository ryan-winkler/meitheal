import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type APIRequestContext } from "@playwright/test"
import { getPersistenceClient, ensureSchema, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskRepository, type TaskCreationData } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { CommentMentionRepository } from "../../apps/web/src/domains/tasks/persistence/comment-mention-repository"
import { startTimeEntryForTask } from "../../apps/web/src/domains/pomodoro"
import { PATCH as patchDeferral } from "../../apps/web/src/pages/api/tasks/[id]/deferral"
import { POST as postLink, DELETE as deleteLink } from "../../apps/web/src/pages/api/tasks/[id]/links"
import { PUT as putTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { startCoreFixture } from "../scripts/task-pins-fixture"

function makeTaskData(overrides: Partial<TaskCreationData> = {}): TaskCreationData {
  return {
    id: crypto.randomUUID(),
    title: "Assigned agent security task",
    description: "",
    status: "backlog",
    priority: 2,
    due_date: null,
    labels: "[]",
    framework_payload: "{}",
    parent_id: null,
    area_id: "general",
    custom_fields: "{}",
    start_date: null,
    end_date: null,
    progress: 0,
    color: null,
    is_favorite: 0,
    task_type: "task",
    assigned_to: null,
    ...overrides,
  }
}

type DbFixture = {
  repo: TaskRepository
}

const dbTest = test.extend<DbFixture>({
  repo: async ({}, use) => {
    const previousDbUrl = process.env.MEITHEAL_DB_URL
    const dir = mkdtempSync(join(tmpdir(), "meitheal-assigned-sec-"))
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "test.db")}`
    resetPersistenceForTests()
    await ensureSchema()
    try {
      await use(new TaskRepository(getPersistenceClient()))
    } finally {
      getPersistenceClient().close()
      resetPersistenceForTests()
      if (previousDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previousDbUrl
      rmSync(dir, { recursive: true, force: true })
    }
  },
})

function agentLocals(assigneeId: string, scopes = ["tasks:read", "tasks:write:assigned", "mcp:execute"]) {
  return {
    agentToken: {
      tokenId: "tok-1",
      tokenName: "Agent Alpha",
      scopes,
      assigneeId,
    },
  }
}

dbTest.describe("Assigned-Agent Authorization & Repository Guards", () => {
  dbTest("updateTask expectedAssignedTo rejects concurrent reassignment before version conflict", async ({ repo }) => {
    const id = crypto.randomUUID()
    await repo.createTask(makeTaskData({ id, assigned_to: "custom_agent_a" }))
    const staleBefore = await repo.findById(id)
    // Simulate concurrent reassignment before updateTask commits (which also advances updated_at)
    await repo.updateTask(id, { assigned_to: "custom_agent_b" })

    const res = await repo.updateTask(
      id,
      { status: "in_progress" },
      { expectedAssignedTo: "custom_agent_a", version: { updatedAt: Number(staleBefore!.updated_at) } },
    )
    expect(res).toEqual({ ok: false, errorCode: "assignee_mismatch" })
  })

  dbTest("cascadeCompleteIds and getChildrenIds scope updates to assigned agent only", async ({ repo }) => {
    const parentId = crypto.randomUUID()
    const ownChildId = crypto.randomUUID()
    const otherChildId = crypto.randomUUID()
    await repo.createTask(makeTaskData({ id: parentId, assigned_to: "custom_agent_a" }))
    await repo.createTask(makeTaskData({ id: ownChildId, parent_id: parentId, assigned_to: "custom_agent_a" }))
    await repo.createTask(makeTaskData({ id: otherChildId, parent_id: parentId, assigned_to: "custom_agent_b" }))

    const ownIds = await repo.getChildrenIds(parentId, "custom_agent_a")
    expect(ownIds).toEqual([ownChildId])

    const completedIds = await repo.cascadeCompleteIds(parentId, "custom_agent_a")
    expect(completedIds).toEqual([ownChildId])

    const ownChild = await repo.findById(ownChildId)
    const otherChild = await repo.findById(otherChildId)
    expect(ownChild?.status).toBe("complete")
    expect(otherChild?.status).toBe("backlog")
  })

  dbTest("PATCH /api/tasks/[id]/deferral enforces assigned-task ownership", async ({ repo }) => {
    const ownId = crypto.randomUUID()
    const otherId = crypto.randomUUID()
    await repo.createTask(makeTaskData({ id: ownId, assigned_to: "custom_agent_a" }))
    await repo.createTask(makeTaskData({ id: otherId, assigned_to: "custom_agent_b" }))

    const otherTask = (await repo.findById(otherId))!
    const deniedRes = await patchDeferral({
      params: { id: otherId },
      request: new Request(`http://localhost/api/tasks/${otherId}/deferral`, {
        method: "PATCH",
        body: JSON.stringify({
          deferred: true,
          updated_at: Number(otherTask.updated_at),
          deferral_revision: otherTask.deferral_revision ?? null,
        }),
      }),
      locals: agentLocals("custom_agent_a"),
    } as unknown as Parameters<typeof patchDeferral>[0])
    expect(deniedRes.status).toBe(403)

    const ownTask = (await repo.findById(ownId))!
    const allowedRes = await patchDeferral({
      params: { id: ownId },
      request: new Request(`http://localhost/api/tasks/${ownId}/deferral`, {
        method: "PATCH",
        body: JSON.stringify({
          deferred: true,
          updated_at: Number(ownTask.updated_at),
          deferral_revision: ownTask.deferral_revision ?? null,
        }),
      }),
      locals: agentLocals("custom_agent_a"),
    } as unknown as Parameters<typeof patchDeferral>[0])
    expect(allowedRes.status).toBe(200)
  })

  dbTest("POST and DELETE /api/tasks/[id]/links require ownership of both endpoints", async ({ repo }) => {
    const ownA = crypto.randomUUID()
    const ownB = crypto.randomUUID()
    const foreign = crypto.randomUUID()
    await repo.createTask(makeTaskData({ id: ownA, assigned_to: "custom_agent_a" }))
    await repo.createTask(makeTaskData({ id: ownB, assigned_to: "custom_agent_a" }))
    await repo.createTask(makeTaskData({ id: foreign, assigned_to: "custom_agent_b" }))

    // Agent A cannot link its own task to Agent B's task
    const crossCreate = await postLink({
      params: { id: ownA },
      request: new Request(`http://localhost/api/tasks/${ownA}/links`, {
        method: "POST",
        body: JSON.stringify({ target_task_id: foreign, link_type: "related_to" }),
      }),
      locals: agentLocals("custom_agent_a"),
    } as unknown as Parameters<typeof postLink>[0])
    expect(crossCreate.status).toBe(403)

    // Agent A can link two tasks both assigned to Agent A
    const ownCreate = await postLink({
      params: { id: ownA },
      request: new Request(`http://localhost/api/tasks/${ownA}/links`, {
        method: "POST",
        body: JSON.stringify({ target_task_id: ownB, link_type: "related_to" }),
      }),
      locals: agentLocals("custom_agent_a"),
    } as unknown as Parameters<typeof postLink>[0])
    expect(ownCreate.status).toBe(201)
    const { id: linkId } = await ownCreate.json()
    expect(await repo.getLinkEndpoints(linkId, ownA)).toEqual({
      source_task_id: ownA,
      target_task_id: ownB,
    })

    // Reassign target endpoint to Agent B; Agent A can no longer delete the cross-boundary link
    await repo.updateTask(ownB, { assigned_to: "custom_agent_b" })
    const crossDelete = await deleteLink({
      params: { id: ownA },
      url: new URL(`http://localhost/api/tasks/${ownA}/links?link_id=${linkId}`),
      request: new Request(`http://localhost/api/tasks/${ownA}/links?link_id=${linkId}`, { method: "DELETE" }),
      locals: agentLocals("custom_agent_a"),
    } as unknown as Parameters<typeof deleteLink>[0])
    expect(crossDelete.status).toBe(403)
  })

  dbTest("PUT /api/tasks/[id] resets owner to human when reassigning from bot to ha_ user", async ({ repo }) => {
    const id = crypto.randomUUID()
    await repo.createTask(makeTaskData({ id, assigned_to: "custom_agent_a" }))
    await repo.updateTask(id, { owner: "bot:Agent Alpha" })

    const res = await putTask({
      params: { id },
      request: new Request(`http://localhost/api/tasks/${id}`, {
        method: "PUT",
        body: JSON.stringify({ assigned_to: "ha_person_1" }),
      }),
      locals: { hassIsAdmin: true },
    } as unknown as Parameters<typeof putTask>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.assigned_to).toBe("ha_person_1")
    expect(body.owner).toBe("human")
  })

  dbTest("atomic sub-route guards reject mismatched assignees in SQL without TOCTOU", async ({ repo }) => {
    const id = crypto.randomUUID()
    await repo.createTask(makeTaskData({ id, assigned_to: "custom_agent_a" }))
    const initial = await repo.findById(id)

    const cOk = await repo.addCommentChecked(id, "Initial note", "Agent Alpha", "agent:Agent Alpha", false, "custom_agent_a")
    expect(cOk.state).toBe("created")
    const commentId = Number(cOk.state === "created" ? cOk.comment.id : 0)

    // Reassign atomically before subsequent sub-route mutations
    await repo.updateTask(id, { assigned_to: "custom_agent_b" })

    const cDeny = await repo.addCommentChecked(id, "Late note", "Agent Alpha", "agent:Agent Alpha", false, "custom_agent_a")
    expect(cDeny).toEqual({ state: "assignee_mismatch" })

    const editDeny = await new CommentMentionRepository(getPersistenceClient()).editChecked(
      id, commentId, "agent:Agent Alpha", "Edited late", [], "custom_agent_a",
    )
    expect(editDeny).toEqual({ state: "assignee_mismatch" })

    const timeDeny = await startTimeEntryForTask(id, "custom_agent_a")
    expect(timeDeny).toEqual({ ok: false, errorCode: "assignee_mismatch" })

    const deferDeny = await repo.setDeferral(
      id,
      true,
      { updatedAt: Number(initial!.updated_at), revision: (initial!.deferral_revision as string | null) ?? null },
      { id: "tok-1", type: "agent", requestId: "req-1" },
      "custom_agent_a",
    )
    expect(deferDeny).toEqual({ ok: false, errorCode: "assignee_mismatch" })
  })
})

test.describe("Live Built HTTP & MCP Assigned-Agent Contract", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires built App and Core ingress fixture")

  test("listMyTasks unwraps tasks, handBackTask comments before unassigning, and routes enforce ownership", async ({ playwright }) => {
    const work = await mkdtemp(join(tmpdir(), "meitheal-assigned-http-"))
    const child = startCoreFixture(work, true)
    child.stdout?.resume()
    child.stderr?.resume()
    let adminCtx: APIRequestContext | undefined
    let agentCtx: APIRequestContext | undefined

    try {
      const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `http://127.0.0.1:${info.port}`
      const p = (path: string) => info.configuredPath + path

      adminCtx = await playwright.request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { origin, cookie: "feedback-fixture=admin" },
      })

      const agentARes = await adminCtx.post(p("/api/users/custom"), { data: { name: "Agent Alpha", kind: "agent" } })
      expect(agentARes.status()).toBe(201)
      const agentA = await agentARes.json()

      const agentBRes = await adminCtx.post(p("/api/users/custom"), { data: { name: "Agent Beta", kind: "agent" } })
      expect(agentBRes.status()).toBe(201)
      const agentB = await agentBRes.json()

      const tokRes = await adminCtx.post(p("/api/agent-tokens"), {
        data: {
          name: "Agent Alpha Assigned",
          assignee_id: agentA.id,
          scopes: ["mcp:execute", "tasks:read", "tasks:write:assigned"],
        },
      })
      expect(tokRes.status()).toBe(201)
      const { token } = await tokRes.json()

      const parentRes = await adminCtx.post(p("/api/tasks"), {
        data: { title: "Alpha Parent Task", assigned_to: agentA.id },
      })
      expect(parentRes.status()).toBe(201)
      const parentTask = await parentRes.json()

      const ownChildRes = await adminCtx.post(p("/api/tasks"), {
        data: { title: "Alpha Subtask", parent_id: parentTask.id, assigned_to: agentA.id },
      })
      expect(ownChildRes.status()).toBe(201)
      const ownChild = await ownChildRes.json()

      const ownChild2Res = await adminCtx.post(p("/api/tasks"), {
        data: { title: "Alpha Cascade Subtask", parent_id: parentTask.id, assigned_to: agentA.id },
      })
      expect(ownChild2Res.status()).toBe(201)
      const ownChild2 = await ownChild2Res.json()

      const foreignChildRes = await adminCtx.post(p("/api/tasks"), {
        data: { title: "Beta Subtask", parent_id: parentTask.id, assigned_to: agentB.id },
      })
      expect(foreignChildRes.status()).toBe(201)
      const foreignChild = await foreignChildRes.json()

      const foreignTaskRes = await adminCtx.post(p("/api/tasks"), {
        data: { title: "Beta Standalone Task", assigned_to: agentB.id },
      })
      expect(foreignTaskRes.status()).toBe(201)
      const foreignTask = await foreignTaskRes.json()

      agentCtx = await playwright.request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { authorization: `Bearer ${token}`, origin, "content-type": "application/json" },
      })

      const rpc = async (name: string, args: Record<string, unknown>) => {
        const res = await agentCtx!.post(p("/api/mcp"), {
          data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        })
        expect(res.status()).toBe(200)
        const json = await res.json()
        expect(json.error).toBeUndefined()
        return json.result
      }

      // Assigned agent can read non-sensitive assignee directory via GET /api/users for HA name resolution, but cannot create users
      expect((await agentCtx.get(p("/api/users"))).status()).toBe(200)
      expect((await agentCtx.post(p("/api/users/custom"), { data: { name: "Injected" } })).status()).toBe(403)

      // tools/list hides createTask/reorderTasks from tasks:write:assigned token while keeping assigned-scoped tools
      const listToolsRes = await agentCtx.post(p("/api/mcp"), {
        data: { jsonrpc: "2.0", id: 99, method: "tools/list" },
      })
      expect(listToolsRes.status()).toBe(200)
      const toolNames = ((await listToolsRes.json()).result.tools as Array<{ name: string }>).map(t => t.name)
      expect(toolNames).toContain("listMyTasks")
      expect(toolNames).toContain("handBackTask")
      expect(toolNames).toContain("updateTask")
      expect(toolNames).not.toContain("createTask")
      expect(toolNames).not.toContain("reorderTasks")

      // listMyTasks unwraps { tasks } from GET /api/tasks
      const mine = await rpc("listMyTasks", {})
      expect(mine.isError).toBe(false)
      const minePayload = JSON.parse(mine.content[0].text)
      expect(minePayload.assignee_id).toBe(agentA.id)
      expect(minePayload.count).toBeGreaterThanOrEqual(2)
      expect(minePayload.tasks.some((t: { id: string }) => t.id === parentTask.id)).toBe(true)
      expect(minePayload.tasks.some((t: { id: string }) => t.id === foreignTask.id)).toBe(false)

      // handBackTask with tasks:write:assigned posts comment BEFORE unassigning
      const handback = await rpc("handBackTask", { id: ownChild.id, note: "Ready for human verification" })
      expect(handback.isError).toBe(false)

      const commentsRes = await adminCtx.get(p(`/api/tasks/${ownChild.id}/comments`))
      expect(commentsRes.status()).toBe(200)
      const commentsBody = await commentsRes.json()
      expect(commentsBody.comments.some((c: { content: string }) => c.content.includes("Ready for human verification"))).toBe(true)

      const handedChildRes = await adminCtx.get(p(`/api/tasks/${ownChild.id}`))
      expect(handedChildRes.status()).toBe(200)
      const handedChild = await handedChildRes.json()
      expect(handedChild.assigned_to).toBeNull()

      // Assigned agent cannot link its task to foreignTask
      const badLink = await agentCtx.post(p(`/api/tasks/${parentTask.id}/links`), {
        data: { target_task_id: foreignTask.id, link_type: "related_to" },
      })
      expect(badLink.status()).toBe(403)

      // Missing tasks must still return 404 (not 403) for assigned-only tokens
      const missingComment = await agentCtx.post(p("/api/tasks/missing-task-id/comments"), {
        data: { content: "Should return 404" },
      })
      expect(missingComment.status()).toBe(404)

      // Assigned agent cannot spoof human provenance via PUT owner field
      const spoofOwner = await agentCtx.put(p(`/api/tasks/${parentTask.id}`), {
        data: { title: parentTask.title, owner: "human" },
      })
      expect(spoofOwner.status()).toBe(200)
      const parentAfterSpoof = await (await adminCtx.get(p(`/api/tasks/${parentTask.id}`))).json()
      expect(parentAfterSpoof.owner).toBe("bot:Agent Alpha")

      // Assigned agent cannot defer foreignTask
      const badDefer = await agentCtx.patch(p(`/api/tasks/${foreignTask.id}/deferral`), {
        data: { deferred: true, updated_at: foreignTask.updated_at, deferral_revision: foreignTask.deferral_revision ?? null },
      })
      expect(badDefer.status()).toBe(403)

      // MCP completeTask preserves HTTP 403 detail instead of masking with "Tool execution failed"
      const deniedCompleteRes = await agentCtx.post(p("/api/mcp"), {
        data: { jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "completeTask", arguments: { id: foreignTask.id } } },
      })
      expect(deniedCompleteRes.status()).toBe(200)
      const deniedCompleteJson = await deniedCompleteRes.json()
      expect(String(deniedCompleteJson.error?.message ?? "")).toContain("Tool request failed with HTTP 403:")

      // Cascade complete completes Alpha's subtask and leaves Beta's subtask untouched
      const doneRes = await agentCtx.put(p(`/api/tasks/${parentTask.id}`), {
        data: { status: "complete", cascade: true },
      })
      expect(doneRes.status()).toBe(200)
      const ownChild2After = await (await adminCtx.get(p(`/api/tasks/${ownChild2.id}`))).json()
      expect(ownChild2After.status).toBe("complete")
      const foreignAfter = await (await adminCtx.get(p(`/api/tasks/${foreignChild.id}`))).json()
      expect(foreignAfter.status).toBe("pending")
    } finally {
      await agentCtx?.dispose()
      await adminCtx?.dispose()
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit")
        child.kill()
        await stopped
      }
      await rm(work, { recursive: true, force: true })
    }
  })
})
