import { expect, type Page } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"
import { deferred } from "./_helpers"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and authenticated Core fixture")

async function observeFeedback(page: Page) {
  const counterWrites: string[] = []
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/api/gamification") && !["GET", "HEAD"].includes(request.method())) {
      counterWrites.push(request.method())
    }
  })
  await page.evaluate(() => {
    const messages: string[] = []
    const seen = new WeakSet<Element>()
    const record = (toast: Element) => {
      if (seen.has(toast)) return
      seen.add(toast)
      const message = toast.children[1]?.textContent ?? ""
      if (/^\+\d+ XP$|Achievement:/.test(message)) messages.push(message)
    }
    Reflect.set(window, "__completionFeedbackReceipts", messages)
    new MutationObserver(records => {
      for (const mutation of records) for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(".toast")) record(node)
        node.querySelectorAll(".toast").forEach(record)
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  })
  return {
    counterWrites,
    messages: () => page.evaluate(() => Reflect.get(window, "__completionFeedbackReceipts") as string[]),
  }
}

async function holdAcknowledgement(page: Page, id: string) {
  const arrived = deferred<{ gamification: { xp: number; newAchievements: Array<{ name: string }> } }>()
  const release = deferred<void>()
  await page.route(`**/api/tasks/${id}`, async route => {
    if (route.request().method() !== "PUT") return route.continue()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const json = await response.json()
    arrived.resolve(json)
    await release.promise
    await route.fulfill({ response, json })
  })
  return { arrived: arrived.promise, release: () => release.resolve() }
}

test("Today celebrates the acknowledged 40 XP and achievement once without another counter write", async ({ page, request }) => {
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Dublin" })
  const created = await request.post("/api/tasks", { data: { title: "Acknowledged Today completion", priority: 2, due_date: date } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const initial = (await (await request.get("/api/gamification")).json()).stats
  expect(initial).toMatchObject({ totalCompleted: 0, totalPoints: 0 })
  await page.goto("/today")
  const feedback = await observeFeedback(page)
  const held = await holdAcknowledgement(page, id)
  try {
    await page.locator(`.tli__checkbox[data-id="${id}"]:visible`).first().check()
    const acknowledged = await held.arrived
    expect(acknowledged.gamification).toMatchObject({ xp: 40,
      newAchievements: expect.arrayContaining([expect.objectContaining({ name: "First Steps", id: "first_task", icon: "🎯" })]) })
    expect(await feedback.messages()).toEqual([])
    held.release()
    await expect.poll(feedback.messages).toEqual(["+40 XP", "🎯 Achievement: First Steps"])
    const recorded = (await (await request.get("/api/gamification")).json()).stats
    expect(recorded).toMatchObject({ totalCompleted: 1, totalPoints: 40 })
    const repeat = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
    expect(repeat.status()).toBe(200)
    expect((await repeat.json()).gamification).toBeUndefined()
    expect((await (await request.get("/api/gamification")).json()).stats).toEqual(recorded)
    expect(await feedback.messages()).toEqual(["+40 XP", "🎯 Achievement: First Steps"])
    expect(feedback.counterWrites).toEqual([])
  } finally { held.release() }
})

test("Kanban celebrates acknowledged XP while a rejected move stays pending without earned feedback", async ({ page, request }) => {
  const ids: string[] = []
  for (const title of ["Acknowledged Kanban completion", "Rejected Kanban completion"]) {
    const created = await request.post("/api/tasks", { data: { title, priority: 2 } })
    expect(created.status()).toBe(201)
    ids.push((await created.json()).id)
  }
  await page.goto("/tasks#kanban")
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  const feedback = await observeFeedback(page)
  const held = await holdAcknowledgement(page, ids[0]!)
  const card = (id: string) => page.locator(`.kanban-card[data-id="${id}"]`)
  const pending = page.locator('.kanban-column[data-status="pending"]')
  const complete = page.locator('.kanban-column[data-status="complete"]')
  const finish = async (id: string) => {
    await card(id).getByRole("button", { name: /^Task actions for/ }).press("Enter")
    await page.getByRole("group", { name: "Task actions", exact: true }).getByRole("button", { name: "Done", exact: true }).press("Enter")
  }
  try {
    await finish(ids[0]!)
    expect((await held.arrived).gamification.xp).toBe(40)
    expect(await feedback.messages()).toEqual([])
    await expect(pending.locator(card(ids[0]!))).toBeVisible()
    held.release()
    await expect(complete.locator(card(ids[0]!))).toBeVisible()
    await expect.poll(feedback.messages).toEqual(["+40 XP", "🎯 Achievement: First Steps"])
    const earned = await feedback.messages()
    const recorded = (await (await request.get("/api/gamification")).json()).stats
    expect(recorded).toMatchObject({ totalCompleted: 1, totalPoints: 40 })
    await page.route(`**/api/tasks/${ids[1]}`, route => route.request().method() === "PUT"
      ? route.fulfill({ status: 503, contentType: "application/problem+json", json: { status: 503, error: "Fixture unavailable" } })
      : route.continue())
    await finish(ids[1]!)
    await expect(page.locator("#toast-container .toast.error")).toContainText("Couldn’t move the task. Try again.")
    await expect(pending.locator(card(ids[1]!))).toBeVisible()
    await expect(complete.locator(card(ids[1]!))).toHaveCount(0)
    expect((await (await request.get(`/api/tasks/${ids[1]}`)).json()).status).toBe("pending")
    expect((await (await request.get("/api/gamification")).json()).stats).toEqual(recorded)
    expect(await feedback.messages()).toEqual(earned)
    expect(feedback.counterWrites).toEqual([])
  } finally { held.release() }
})
