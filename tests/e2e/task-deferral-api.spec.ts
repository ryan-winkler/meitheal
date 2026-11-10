import { expect, test, type APIRequestContext } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Needs the isolated built app fixture")

async function createTask(request: APIRequestContext, title: string, status = "backlog") {
  const response = await request.post("/api/tasks", { data: { title, status } })
  expect(response.ok()).toBe(true)
  const task = await response.json() as { id: string; ticket_key: string; title: string }
  const detail = await request.get(`/api/tasks/${task.id}`)
  expect(detail.ok()).toBe(true)
  return { ...task, updated_at: Number((await detail.json()).task_version) }
}

test("defer through a ticket key, refresh on conflict, and keep a searchable task", async ({ request }) => {
  const task = await createTask(request, "deferral-http-visible")
  try {
    const route = `/api/tasks/${task.ticket_key}/deferral`
    const original = { deferred: true, updated_at: task.updated_at, deferral_revision: null }
    const headers = { "x-request-id": "deferral-http-test", "idempotency-key": "defer-original" }
    expect((await request.patch(route, { data: { ...original, extra: "ignored?" } })).status()).toBe(400)
    const competing = await Promise.all([
      request.patch(route, { data: original, headers }),
      request.patch(route, { data: original, headers }),
    ])
    const winner = competing.find(response => response.ok())
    expect(competing.map(response => response.status()).sort()).toEqual([200, 409])
    const deferred = await winner!.json()
    expect(deferred).toMatchObject({ id: task.id, status: "backlog", updated_at: task.updated_at, deferred_at: expect.any(Number) })
    expect(deferred.deferral_revision).toMatch(/^[a-f0-9]{32}$/)

    const direct = await request.get(`/api/tasks/${task.id}?deferralRead=proof`)
    expect(direct.headers()["cache-control"]).toBe("no-store")
    expect(await direct.json()).toMatchObject({ task_version: task.updated_at, deferred_at: deferred.deferred_at })
    const list = await request.get(`/api/tasks?deferred=1&q=${task.title}&limit=1`)
    expect(await list.json()).toMatchObject({ total: 1, tasks: [{ id: task.id }] })
    const excluded = await request.get(`/api/tasks?deferred=0&q=${task.title}`)
    expect(await excluded.json()).toMatchObject({ total: 0, tasks: [] })
    const legacy = await request.get(`/api/tasks?q=${task.title}`)
    expect(await legacy.json()).toMatchObject({ total: 1, tasks: [{ id: task.id }] })
    expect((await request.get("/api/tasks?deferred=yes")).status()).toBe(400)

    const staleTriage = await request.put(`/api/tasks/${task.id}`, {
      data: { status: "pending", updated_at: task.updated_at, expected_status: "backlog" },
    })
    expect(staleTriage.status()).toBe(409)
    expect(await staleTriage.json()).toMatchObject({ errorCode: "TASK_VERSION_CONFLICT" })

    const resumed = await request.patch(route, {
      data: { deferred: false, updated_at: task.updated_at, deferral_revision: deferred.deferral_revision },
    })
    expect(resumed.ok()).toBe(true)
    expect(await resumed.json()).toMatchObject({ status: "backlog", deferred_at: null })
    const replay = await request.patch(route, { data: original, headers })
    expect(replay.status()).toBe(409)
    expect(await replay.json()).toMatchObject({ errorCode: "TASK_VERSION_CONFLICT" })
    const timeline = await request.get(`/api/tasks/${task.id}/timeline?actor_type=human&event_type=field_change`)
    expect(await timeline.json()).toMatchObject({
      total: 2,
      events: expect.arrayContaining([
        expect.objectContaining({ field: "deferred_at", actor: "user", correlation_id: "deferral-http-test" }),
      ]),
    })
  } finally { expect((await request.delete(`/api/tasks/${task.id}`, { data: {} })).status()).toBe(204) }
})

test("bulk and anchored reorder refuse deferred participants", async ({ request }) => {
  const earlier = await createTask(request, "deferral-reorder-earlier")
  const hidden = await createTask(request, "deferral-reorder-hidden")
  const later = await createTask(request, "deferral-reorder-later")
  expect((await request.patch(`/api/tasks/${hidden.id}/deferral`, {
    data: { deferred: true, updated_at: hidden.updated_at, deferral_revision: null },
  })).ok()).toBe(true)
  for (const data of [
    { ordered_ids: [earlier.id, hidden.id, later.id] },
    { ordered_ids: [earlier.id, earlier.id] },
    { task_id: earlier.id, anchor_id: hidden.id, lane: "backlog", before: true },
  ]) {
    const rejected = await request.post("/api/tasks/reorder", { data })
    expect(rejected.status()).toBe(409)
    expect(await rejected.json()).toMatchObject({ errorCode: "TASK_ORDER_CONFLICT" })
  }
  const reordered = await request.post("/api/tasks/reorder", { data: { ordered_ids: [earlier.id, later.id] } })
  expect(reordered.status()).toBe(200)
  for (const id of [earlier.id, hidden.id, later.id]) {
    const deleted = await request.delete(`/api/tasks/${id}`, { data: {} })
    expect(deleted.status(), await deleted.text()).toBe(204)
  }
})
