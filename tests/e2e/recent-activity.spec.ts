import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Browser, type Page } from "@playwright/test"
import { recentActivityPersonKey } from "../../apps/web/src/domains/tasks/persistence/recent-activity"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and disposable HTTPS ingress")

async function mutate(page: Page, path: string, method: string, body: object, token?: string) {
  return page.evaluate(async ({ path, method, body, token }) => {
    const response = await fetch(path, {
      method, headers: { "content-type": "application/json", "x-agent-id": "spoofed-person-name", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }, { path, method, body, token })
}

test("verified members see committed task activity and can filter it by current area and person", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-recent-activity-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser: Browser | undefined
  let db: DatabaseSync | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const activity = origin + prefix + "/activity"
    const aKey = recentActivityPersonKey("fixture-member")
    const bKey = recentActivityPersonKey("fixture-member-two")
    browser = await launchPinBrowser(work)
    async function open(user: string) {
      const context = await browser!.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
      await context.addCookies([{ name: "feedback-fixture", value: user, url: origin }])
      return context.newPage()
    }
    const [a, b, old] = await Promise.all([open("member"), open("member-two"), open("old")])
    const background: string[] = []
    a.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/activity")) background.push(request.url())
    })
    expect((await a.goto(origin + prefix + "/today"))?.status()).toBe(200)
    const sidebarLink = a.getByRole("navigation", { name: "Main Navigation" }).getByRole("link", { name: "Recent activity" })
    await expect(sidebarLink).toHaveAttribute("data-astro-prefetch", "false")
    expect(background).toEqual([])
    expect((await b.goto(origin + prefix + "/fixture"))?.status()).toBe(200)

    const garden = await mutate(a, prefix + "/api/areas", "POST", { name: "Garden area" })
    const house = await mutate(a, prefix + "/api/areas", "POST", { name: "House area" })
    expect([garden.status, house.status]).toEqual([201, 201])

    const first = await mutate(a, prefix + "/api/tasks", "POST", {
      title: "Old title sentinel", description: "Old description sentinel", area_id: garden.body.id,
      author: "supplied-person-sentinel",
    })
    const second = await mutate(b, prefix + "/api/tasks", "POST", {
      title: "Service the boiler", area_id: house.body.id, labels: '["Boiler label"]', new_labels: ["Boiler label"],
    })
    expect([first.status, second.status]).toEqual([201, 201])
    const task = prefix + "/api/tasks/" + first.body.id
    const revision = await a.evaluate(async path => (await (await fetch(path)).json()).task_version, task)
    expect((await mutate(a, task, "PATCH", { title: "Repair the fence", description: "Current description sentinel" })).status).toBe(200)
    expect((await mutate(b, task, "PATCH", { title: "Repair the fence" })).status).toBe(200)
    expect((await mutate(b, task, "PATCH", { title: "Stale title", updated_at: revision })).status).toBe(409)
    expect((await mutate(b, task, "PATCH", { status: "done" })).status).toBe(200)
    expect((await mutate(b, task, "PATCH", { status: "complete" })).status).toBe(200)
    expect((await mutate(a, task, "PATCH", { status: "todo" })).status).toBe(200)

    db = new DatabaseSync(join(work, "pins.db"))
    // The spoofed X-Agent-Id header must not become stored attribution.
    expect({ ...db.prepare("SELECT source, created_by FROM tasks WHERE id = ?").get(first.body.id) })
      .toEqual({ source: "user", created_by: null })
    db.prepare(`INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, created_at)
      VALUES (?, 'description', 'legacy-old-sentinel', 'legacy-new-sentinel', 'legacy-actor-sentinel', ?)`)
      .run(first.body.id, Date.now())
    const actions = () => db!.prepare(
      "SELECT feed_action FROM task_activity_log WHERE task_id = ? AND feed_action IS NOT NULL ORDER BY id",
    ).all(first.body.id).map(row => row.feed_action)
    expect(actions()).toEqual(["added", "edited", "closed", "reopened"])
    db.exec(`CREATE TRIGGER test_rollback_activity BEFORE INSERT ON task_activity_log
      WHEN new.feed_action IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture event rejected'); END`)
    expect((await mutate(a, task, "PATCH", { title: "Rolled back edit" })).status).toBe(500)
    expect((await mutate(a, prefix + "/api/tasks", "POST", { title: "Rolled back addition" })).status).toBe(500)
    db.exec("DROP TRIGGER test_rollback_activity")
    db.exec(`CREATE TRIGGER test_ignored_update BEFORE UPDATE OF title ON tasks
      WHEN new.title = 'Ignored write' BEGIN SELECT RAISE(IGNORE); END`)
    expect((await mutate(a, task, "PATCH", { title: "Ignored write" })).status).toBe(404)
    db.exec("DROP TRIGGER test_ignored_update")
    expect(actions()).toEqual(["added", "edited", "closed", "reopened"])
    expect(db.prepare("SELECT title FROM tasks WHERE id = ?").get(first.body.id)?.title).toBe("Repair the fence")
    expect(db.prepare("SELECT count(*) AS n FROM tasks WHERE title = 'Rolled back addition'").get()?.n).toBe(0)

    const firstFeed = a.waitForResponse(response => response.url() === activity)
    await sidebarLink.press("Enter")
    expect((await firstFeed).headers()["cache-control"]).toBe("private, no-store")
    const events = a.locator("[data-activity-event]")
    await expect(events).toHaveCount(5)
    await expect(events.filter({ hasText: "Repair the fence" })).toHaveCount(4)
    const markup = await a.locator(".recent-activity").innerHTML()
    for (const sentinel of ["Old title sentinel", "Old description sentinel", "Current description sentinel",
      "supplied-person-sentinel", "spoofed-person-name", "legacy-old-sentinel", "legacy-new-sentinel",
      "legacy-actor-sentinel", "fixture-member", "Rolled back edit", "Ignored write"]) {
      expect(markup).not.toContain(sentinel)
    }
    const token = "mth_" + "b".repeat(64)
    expect((await mutate(b, prefix + "/api/tasks", "POST", { title: "Denied automation" }, token)).status).toBe(401)
    db.prepare(`INSERT INTO agent_tokens (id, name, token_hash, token_prefix, scopes, created_at)
      VALUES (?, ?, ?, ?, '["tasks:write"]', ?)`).run(
      "synthetic-token-id", "synthetic-token-name", createHash("sha256").update(token).digest("hex"),
      token.slice(0, 8), new Date().toISOString(),
    )
    expect((await mutate(b, prefix + "/api/tasks", "POST", { title: "Automated capture", actor: "spoofed actor" }, token)).status).toBe(201)
    const automation = await a.reload()
    await expect(events.filter({ hasText: "Automated capture" })).toContainText("Automation added a task")
    expect(await automation?.text()).not.toMatch(/synthetic-token-(id|name)|spoofed actor/)
    await a.setViewportSize({ width: 320, height: 740 })
    await expect.poll(() => a.locator(".recent-activity").evaluate(element =>
      element.scrollWidth <= element.clientWidth)).toBe(true)
    await a.evaluate(() => localStorage.setItem("meitheal-theme", "dark"))
    await a.reload()
    await expect(a.locator("html")).toHaveAttribute("data-theme", "dark")
    const contrast = await new AxeBuilder({ page: a }).include("[data-recent-activity]")
      .withRules(["color-contrast"]).analyze()
    expect(contrast.violations).toEqual([])
    const people = a.getByRole("combobox", { name: "Person" })
    const optionA = people.locator(`option[value="${aKey}"]`)
    const optionB = people.locator(`option[value="${bKey}"]`)
    expect(await optionA.textContent()).not.toBe(await optionB.textContent())
    await a.getByRole("combobox", { name: "Current area" }).selectOption(garden.body.id)
    await people.selectOption(bKey)
    await a.getByRole("button", { name: "Apply filters" }).press("Enter")
    await expect(a).toHaveURL(url => url.pathname === prefix + "/activity" && url.searchParams.get("person") === bKey)
    await expect(events).toHaveCount(1)
    await expect(events.first()).toContainText("closed a task")

    expect((await mutate(a, task, "PATCH", { area_id: house.body.id })).status).toBe(200)
    await a.reload()
    await expect(events).toHaveCount(0)
    await a.getByRole("combobox", { name: "Current area" }).selectOption(house.body.id)
    await a.getByRole("button", { name: "Apply filters" }).press("Enter")
    await expect(events).toHaveCount(2)
    await expect(events.filter({ hasText: "Repair the fence" })).toHaveCount(1)
    await expect(events.first().getByRole("link")).toHaveAttribute("href", new RegExp(`^${prefix}/tickets/`))
    const taskLink = events.filter({ hasText: "Repair the fence" }).getByRole("link")
    await taskLink.press("Enter")
    await expect(a.locator("#task-detail-overlay")).toHaveAttribute("data-open-task-id", first.body.id)
    await a.goBack()
    await expect(events).toHaveCount(2)

    const addAt = db.prepare(`INSERT INTO task_activity_log
      (task_id, field, created_at, feed_action, feed_person_key, actor_type)
      VALUES (?, 'activity', 9999999999999, 'edited', ?, 'human')`)
    for (let index = 0; index < 26; index++) addAt.run(second.body.id, bKey)
    await a.reload()
    await expect(events).toHaveCount(25)
    const firstIds = await events.evaluateAll(rows => rows.map(row => row.getAttribute("data-activity-event")))
    await a.getByRole("link", { name: "Older activity" }).click()
    await expect(events).toHaveCount(3)
    const olderIds = await events.evaluateAll(rows => rows.map(row => row.getAttribute("data-activity-event")))
    expect(firstIds.filter(id => olderIds.includes(id))).toEqual([])

    expect((await mutate(a, task, "DELETE", {})).status).toBe(204)
    await a.reload()
    await expect(events.filter({ hasText: "Repair the fence" })).toHaveCount(0)
    const denied = await old.goto(activity)
    expect(denied?.status()).toBe(403)
    expect(denied?.headers()["cache-control"]).toBe("private, no-store")
    expect(await denied?.text()).not.toContain("Service the boiler")

    async function setCoreMember(user: string, active: boolean, name?: string) {
      const changed = once(child, "message", { signal: AbortSignal.timeout(3_000) })
      child.send({ type: "fixture-core", user, active, name })
      expect((await changed)[0]).toEqual({ coreChanged: true })
    }
    await setCoreMember("member-two", false)
    expect((await a.goto(activity))?.status()).toBe(200)
    await expect(optionB).toHaveCount(0)
    expect((await a.goto(activity + "?person=" + bKey))?.status()).toBe(400)
    await setCoreMember("member-two", true, "<".repeat(32 * 1024))
    expect((await a.goto(activity + "?person=" + bKey))?.status()).toBe(200)
    await expect(optionB).toHaveText("<".repeat(256))

    await setCoreMember("member", false)
    const revoked = await a.goto(activity + "?person=" + bKey)
    expect(revoked?.status()).toBe(403)
    expect(revoked?.headers()["cache-control"]).toBe("private, no-store")
    expect(await revoked?.text()).not.toContain("Service the boiler")
  } finally {
    db?.close()
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
