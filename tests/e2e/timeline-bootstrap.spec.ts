import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run API and page specs")

test("task labels round-trip without escaping the timeline data block", async ({ request, baseURL }) => {
  const labels = JSON.stringify(["</ScRiPt ><img data-timeline-injection>"])
  const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
  const create = await request.post("/api/tasks", {
    headers,
    data: { title: "Timeline bootstrap regression", labels },
  })
  expect(create.status()).toBe(201)
  const { id } = await create.json()

  try {
    const kanban = await request.get("/tasks")
    expect(kanban.ok()).toBeTruthy()
    expect(await kanban.text()).not.toContain('id="timeline-data"')

    const response = await request.get("/tasks?view=timeline")
    expect(response.ok()).toBeTruthy()
    const html = await response.text()
    const data = html.match(/<script\b[^>]*\bid="timeline-data"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
    if (data === undefined) throw new Error("Timeline data block missing")
    expect(data.includes("<")).toBe(false)
    const tasks = JSON.parse(data) as Array<{ id: string; labels: string }>
    expect(tasks.find(task => task.id === id)?.labels).toBe(labels)
  } finally {
    const removed = await request.delete(`/api/tasks/${id}`, { headers })
    expect(removed.status()).toBe(204)
  }
})
