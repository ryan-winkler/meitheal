import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

test("due date filters rows and total before pagination", async ({ request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", {})
  const fixtures = [
    { title: "A different day", due_date: "2032-03-01" },
    { title: "B date only", due_date: "2032-02-29" },
    { title: "C stored timestamp", due_date: "2032-02-29T23:50:00-05:00" },
    { title: "D invalid stored date", due_date: "2032-02-29-invalid" },
    { title: "E unscheduled" },
  ]
  const ids: string[] = []
  for (const data of fixtures) {
    const response = await request.post("/api/tasks", { headers, data })
    expect(response.status(), await response.text()).toBe(201)
    ids.push((await response.json()).id)
  }

  // due_date matches the household calendar day (Europe/Dublin by default). The stored
  // 23:50 at -05:00 on 29 February is 04:50 on 1 March in the household, so it is due then.
  const params = { due_date: "2032-02-29", sort: "title", order: "asc", limit: "1" }
  const first = await request.get("/api/tasks", { params })
  expect(first.status(), await first.text()).toBe(200)
  expect(await first.json()).toMatchObject({
    tasks: [{ id: ids[1], due_date: "2032-02-29" }],
    total: 1, limit: 1, offset: 0,
  })

  const march = { due_date: "2032-03-01", sort: "title", order: "asc", limit: "1" }
  const marchFirst = await request.get("/api/tasks", { params: march })
  expect(marchFirst.status(), await marchFirst.text()).toBe(200)
  expect(await marchFirst.json()).toMatchObject({
    tasks: [{ id: ids[0], due_date: "2032-03-01" }],
    total: 2, limit: 1, offset: 0,
  })
  const marchNext = await request.get("/api/tasks", { params: { ...march, offset: "1" } })
  expect(marchNext.status(), await marchNext.text()).toBe(200)
  expect(await marchNext.json()).toMatchObject({
    tasks: [{ id: ids[2], due_date: "2032-02-29T23:50:00-05:00" }],
    total: 2, limit: 1, offset: 1,
  })

  for (const due_date of ["2031-02-29", "2032-02", "", "2032-02-29T00:00:00Z"]) {
    const invalid = await request.get("/api/tasks", { params: { due_date } })
    expect(invalid.status()).toBe(400)
  }
})

test("native task statuses normalize aliases and preserve configured workflow names", async ({ request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", {})
  const customStatuses = ["awaiting_parts", "constructor", "__proto__"]
  for (const status of customStatuses) {
    const unconfigured = await request.post("/api/tasks", { headers, data: { title: `Unconfigured ${status}`, status } })
    expect(unconfigured.status(), await unconfigured.text()).toBe(400)
    expect(await unconfigured.json()).toMatchObject({ errorCode: "invalid" })
  }

  const lane = await request.post("/api/lanes", { headers, data: { label: "Custom workflow" } })
  expect(lane.status(), await lane.text()).toBe(201)
  const { id } = await lane.json() as { id: string }
  const configured = await request.put(`/api/lanes/${id}`, {
    headers, data: { includes: JSON.stringify(customStatuses) },
  })
  expect(configured.status(), await configured.text()).toBe(200)

  const statuses = [
    { input: "todo", expected: "pending" },
    { input: "in_progress", expected: "active" },
    { input: "done", expected: "complete" },
    ...customStatuses.map(status => ({ input: status, expected: status })),
  ]

  for (const { input, expected } of statuses) {
    const response = await request.post("/api/tasks", { headers, data: { title: `Fixture ${input}`, status: input } })
    expect(response.status(), await response.text()).toBe(201)
    const task = await response.json()
    expect(task.status).toBe(expected)

    const stored = await request.get(`/api/tasks/${task.id}`)
    expect(stored.status()).toBe(200)
    expect(await stored.json()).toMatchObject({ id: task.id, status: expected })

    for (const status of new Set([input, expected])) {
      const filtered = await request.get("/api/tasks", { params: { status } })
      expect(filtered.status(), await filtered.text()).toBe(200)
      const { tasks } = await filtered.json()
      expect(tasks).toContainEqual(expect.objectContaining({ id: task.id, status: expected }))
    }
  }
})
