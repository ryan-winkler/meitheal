import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

test("due date filters rows and total before pagination", async ({ request }) => {
  const fixtures = [
    { title: "A different day", due_date: "2032-03-01" },
    { title: "B date only", due_date: "2032-02-29" },
    { title: "C stored timestamp", due_date: "2032-02-29T23:50:00-05:00" },
    { title: "D invalid stored date", due_date: "2032-02-29-invalid" },
    { title: "E unscheduled" },
  ]
  const ids: string[] = []
  for (const data of fixtures) {
    const response = await request.post("/api/tasks", { data })
    expect(response.status(), await response.text()).toBe(201)
    ids.push((await response.json()).id)
  }

  const params = { due_date: "2032-02-29", sort: "title", order: "asc", limit: "1" }
  const first = await request.get("/api/tasks", { params })
  expect(first.status(), await first.text()).toBe(200)
  expect(await first.json()).toMatchObject({
    tasks: [{ id: ids[1], due_date: "2032-02-29" }],
    total: 2, limit: 1, offset: 0,
  })

  const next = await request.get("/api/tasks", { params: { ...params, offset: "1" } })
  expect(next.status(), await next.text()).toBe(200)
  expect(await next.json()).toMatchObject({
    tasks: [{ id: ids[2], due_date: "2032-02-29T23:50:00-05:00" }],
    total: 2, limit: 1, offset: 1,
  })

  for (const due_date of ["2031-02-29", "2032-02", "", "2032-02-29T00:00:00Z"]) {
    const invalid = await request.get("/api/tasks", { params: { due_date } })
    expect(invalid.status()).toBe(400)
  }
})

test("native task statuses normalize aliases and preserve custom names", async ({ request }) => {
  const statuses = [
    { input: "todo", expected: "pending" },
    { input: "in_progress", expected: "active" },
    { input: "done", expected: "complete" },
    { input: "awaiting_parts", expected: "awaiting_parts" },
    { input: "constructor", expected: "constructor" },
    { input: "__proto__", expected: "__proto__" },
  ]

  for (const { input, expected } of statuses) {
    const response = await request.post("/api/tasks", { data: { title: `Fixture ${input}`, status: input } })
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
