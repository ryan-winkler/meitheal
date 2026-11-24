import { expect, test, type APIRequestContext } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

async function createTask(request: APIRequestContext, headers: Record<string, string>, title: string, blockedBy?: string) {
  const response = await request.post("/api/tasks", { headers, data: { title, blocked_by: blockedBy } })
  expect(response.status(), await response.text()).toBe(201)
  const { id, ticket_key, blocked_by } = await response.json() as {
    id: string; ticket_key: string; blocked_by: string | null
  }
  expect(blocked_by).toBe(blockedBy ?? null)
  return { id, title, ticket_key }
}

async function link(request: APIRequestContext, headers: Record<string, string>, source: string, target: string, type: string) {
  const response = await request.post(`/api/tasks/${source}/links`, {
    headers, data: { target_task_id: target, link_type: type },
  })
  expect(response.status(), await response.text()).toBe(201)
}

test("an outbound blocked_by link blocks the dependent but does not block the prerequisite", async ({ request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", {})
  const dependent = await createTask(request, headers, "Fit the new door")
  const prerequisite = await createTask(request, headers, "Deliver the new door")
  await link(request, headers, dependent.id, prerequisite.id, "blocked_by")

  const rejected = await request.patch(`/api/tasks/${dependent.id}`, {
    headers, data: { status: "in_progress", title: "This edit must not be saved" },
  })
  expect(rejected.status(), await rejected.text()).toBe(409)
  expect(await rejected.json()).toEqual({
    error: "Cannot activate: task is blocked by open dependencies",
    errorCode: "TASK_BLOCKED",
    blocked_by: [{ ...prerequisite, status: "pending" }],
  })
  expect(await (await request.get(`/api/tasks/${dependent.id}`)).json()).toMatchObject({
    status: "pending",
    title: dependent.title,
  })

  const allowed = await request.put(`/api/tasks/${prerequisite.id}`, { headers, data: { status: "active" } })
  expect(allowed.status(), await allowed.text()).toBe(200)
})

test("an inbound blocks link follows the same policy and reciprocal links list one prerequisite", async ({ request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", {})
  const dependent = await createTask(request, headers, "Put away the groceries", "Legacy note kept for display")
  const prerequisite = await createTask(request, headers, "Collect the groceries")
  const archived = await createTask(request, headers, "Prepare storage")
  const unrelated = await createTask(request, headers, "Do a separate errand")
  await link(request, headers, prerequisite.id, dependent.id, "blocks")
  await link(request, headers, archived.id, dependent.id, "blocks")
  await link(request, headers, dependent.id, unrelated.id, "related_to")
  const complete = await request.patch(`/api/tasks/${archived.id}`, { headers, data: { status: "done" } })
  expect(complete.status(), await complete.text()).toBe(200)
  const archive = await request.post("/api/tasks/clear-completed", { headers, data: {} })
  expect(archive.status(), await archive.text()).toBe(200)
  expect(await (await request.get(`/api/tasks/${archived.id}`)).json()).toMatchObject({ status: "archived" })

  const activate = () => request.put(`/api/tasks/${dependent.id}`, { headers, data: { status: "active" } })
  const first = await activate()
  expect(first.status(), await first.text()).toBe(409)
  expect((await first.json()).blocked_by).toEqual([{ ...prerequisite, status: "pending" }])

  await link(request, headers, dependent.id, prerequisite.id, "blocked_by")
  const reciprocal = await activate()
  expect(reciprocal.status()).toBe(409)
  expect((await reciprocal.json()).blocked_by).toEqual([{ ...prerequisite, status: "pending" }])

  expect((await request.patch(`/api/tasks/${prerequisite.id}`, { headers, data: { status: "done" } })).status()).toBe(200)
  const allowed = await activate()
  expect(allowed.status(), await allowed.text()).toBe(200)
  expect(await (await request.get(`/api/tasks/${dependent.id}`)).json()).toMatchObject({ status: "active" })
})

test("intake updates validate the version and reject stale or noncanonical decisions", async ({ request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", {})
  const creation = await request.post("/api/tasks", { headers, data: { title: "Intake API decision", status: "backlog" } })
  expect(creation.status()).toBe(201)
  const { id, created_at, updated_at } = await creation.json()
  const path = `/api/tasks/${id}`
  const created = await request.get(path)
  expect(created.status()).toBe(200)
  expect(await created.json()).toMatchObject({ created_at, updated_at })
  const invalid = await request.patch(path, {
    headers: { ...headers, "content-type": "application/json" },
    data: '{"status":"pending","updated_at":1e309}',
  })
  expect(invalid.status()).toBe(400)
  const alias = await request.patch(path, { headers, data: { status: "todo", expected_status: "backlog", updated_at } })
  expect(alias.status()).toBe(400)

  const accepted = await request.patch(path, { headers, data: { status: "pending", expected_status: "backlog", updated_at } })
  expect(accepted.status()).toBe(200)
  expect(await accepted.json()).toMatchObject({ id, status: "pending" })
  const stale = await request.patch(path, { headers, data: { status: "active", expected_status: "backlog", updated_at } })
  expect(stale.status()).toBe(409)
  expect(await stale.json()).toMatchObject({ errorCode: "TASK_VERSION_CONFLICT", client_updated_at: updated_at })
  expect(await (await request.get(path)).json()).toMatchObject({ status: "pending" })
})
