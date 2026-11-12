import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

interface ReviewFixture {
  page: Page
  api: APIRequestContext
  child: ChildProcess
  origin: string
  prefix: string
  propose(title: string, to: string, id?: string): Promise<{ id: string; hash: string }>
}

async function withReview(playwright: PlaywrightWorkerArgs["playwright"], run: (fixture: ReviewFixture) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "meitheal-proposal-review-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  let api: APIRequestContext | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const apiContext = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true,
      extraHTTPHeaders: { cookie: "feedback-fixture=admin", origin } })
    api = apiContext
    const minted = await apiContext.post(prefix + "/api/agent-tokens", { data: { name: "Review fixture agent", scopes: ["tasks:propose"] } })
    expect(minted.status()).toBe(201)
    const agent = { authorization: `Bearer ${(await minted.json()).token}` }
    const propose: ReviewFixture["propose"] = async (title, to, existingId) => {
      let id = existingId
      if (!id) {
        const created = await apiContext.post(prefix + "/api/tasks", { data: { title, description: "Existing description" } })
        expect(created.status()).toBe(201)
        id = (await created.json()).id as string
      }
      const claim = await apiContext.post(`${prefix}/api/tasks/${id}/handoff`, { headers: agent, data: { action: "claim" } })
      expect(claim.status()).toBe(200)
      const proposed = await apiContext.post(`${prefix}/api/tasks/${id}/handoff`, { headers: agent, data: {
        action: "propose", lease: (await claim.json()).lease, summary: "Clarify the household task.", updates: { title: to },
      } })
      expect(proposed.status()).toBe(200)
      return { id, hash: (await proposed.json()).hash as string }
    }
    await run({ page, api: apiContext, child, origin, prefix, propose })
  } finally {
    await browser?.close()
    await api?.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(4_000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
}

const cardFor = (page: Page, id: string) => page.locator(`[data-proposal-review][data-task-id="${id}"]`)

test("standalone Review requires a verified Home Assistant administrator", async ({ page }) => {
  test.skip(!process.env.E2E_BASE_URL, "Set E2E_BASE_URL for the disposable local UI")
  expect((await page.goto("/review"))?.status()).toBe(403)
  await expect(page.getByRole("heading", { name: "Administrator access required" })).toBeVisible()
  await expect(page.locator("[data-proposal-review]")).toHaveCount(0)
})

test.describe("Review decisions through owned Home Assistant ingress", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and its disposable ingress/Core fixture")

  test("shows the displayed values, retains pending focus, and accepts or rejects only after an acknowledgement", async ({ playwright }) => {
    await withReview(playwright, async ({ page, api, origin, prefix, propose }) => {
      const accepted = await propose("Replace batteries", "Replace upstairs smoke alarm batteries")
      const rejected = await propose("Check the back door", "Check the front door instead")
      const response = await page.goto(origin + prefix + "/review")
      expect(response?.status()).toBe(200)
      expect(response?.headers()["cache-control"]).toBe("private, no-store")
      await page.setViewportSize({ width: 320, height: 812 })
      const card = cardFor(page, accepted.id)
      await expect(card.locator("[data-current-value]")).toHaveText("Replace batteries")
      await expect(card.locator("[data-proposed-value]")).toHaveText("Replace upstairs smoke alarm batteries")
      const comparison = card.getByRole("region", { name: "Proposal comparison for Replace batteries" })
      await card.locator(".review-card__ticket").focus()
      await page.keyboard.press("Tab")
      await expect(comparison).toBeFocused()
      await page.keyboard.press("ArrowRight")
      await expect.poll(() => comparison.evaluate(region => region.scrollLeft)).toBeGreaterThan(0)
      await page.keyboard.press("Shift+Tab")
      await expect(card.locator(".review-card__ticket")).toBeFocused()
      await expect(card.locator("time")).toHaveAttribute("datetime", /T/)
      await expect(card.getByRole("link", { name: "Refresh proposal" })).toHaveAttribute("href", prefix + "/review")
      const accept = card.getByRole("button", { name: "Accept proposal", exact: true })
      await expect(accept).toBeEnabled()
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let submissions = 0
      await page.route(`**/api/tasks/${accepted.id}/accept-proposal`, async route => {
        submissions += 1
        expect(route.request().postDataJSON()).toEqual({ action: "accept", proposal_hash: accepted.hash })
        await gate
        await route.continue()
      })
      await accept.click()
      await expect(card).toHaveAttribute("aria-busy", "true")
      await expect(accept).toBeFocused()
      await expect(accept).toHaveAttribute("aria-disabled", "true")
      await accept.press("Enter")
      expect(submissions).toBe(1)
      await expect(card.locator("[data-proposed-value]")).toHaveText("Replace upstairs smoke alarm batteries")
      release()
      await expect(card.locator("[data-review-status]")).toHaveText("Proposal accepted. The task was updated.")
      await expect(card.locator("[data-review-status]")).toBeFocused()
      expect((await (await api.get(`${prefix}/api/tasks/${accepted.id}`)).json()).title).toBe("Replace upstairs smoke alarm batteries")
      const rejectCard = cardFor(page, rejected.id)
      await rejectCard.getByRole("button", { name: "Reject proposal", exact: true }).click()
      await expect(rejectCard.locator("[data-review-status]")).toHaveText("Proposal rejected. The task was not changed.")
      expect((await (await api.get(`${prefix}/api/tasks/${rejected.id}`)).json()).title).toBe("Check the back door")
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
      await page.getByRole("link", { name: "Refresh queue", exact: true }).click()
      await expect(page.getByRole("heading", { name: "No pending proposals" })).toBeVisible()
    })
  })

  test("a changed task requires refresh; its old baseline and current value remain distinct and rejection stays available", async ({ playwright }) => {
    await withReview(playwright, async ({ page, api, origin, prefix, propose }) => {
      const proposal = await propose("Original task title", "Agent title")
      await page.goto(origin + prefix + "/review")
      const card = cardFor(page, proposal.id)
      await expect(card.getByRole("button", { name: "Accept proposal" })).toBeEnabled()
      expect((await api.put(`${prefix}/api/tasks/${proposal.id}`, { data: { title: "Household changed the task" } })).status()).toBe(200)
      await card.getByRole("button", { name: "Accept proposal" }).click()
      await expect(card.locator("[data-review-status]")).toContainText("The task changed")
      await expect(card).toHaveAttribute("data-proposal-hash", proposal.hash)
      await expect(card.locator("[data-current-value]")).toHaveText("Original task title")
      await card.getByRole("link", { name: "Refresh proposal" }).click()
      await expect(card.locator(".diff-from")).toHaveText("Original task title")
      await expect(card.locator("[data-current-value]")).toHaveText("Household changed the task")
      await expect(card.locator("[data-proposed-value]")).toHaveText("Agent title")
      await expect(card.getByRole("button", { name: "Accept proposal" })).toBeDisabled()
      await expect(card.getByRole("button", { name: "Reject proposal" })).toBeEnabled()
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => localStorage.setItem("meitheal-theme", value), theme)
        await page.reload()
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        const audit = await new AxeBuilder({ page }).withRules(["color-contrast"])
          .include(".review-card__ticket")
          .include(".review-card__agent")
          .include(".diff-to")
          .include(".review-stale")
          .analyze()
        expect(audit.violations, theme).toEqual([])
        expect(audit.passes.find(({ id }) => id === "color-contrast")?.nodes ?? [], theme).toHaveLength(4)
      }
      await card.getByRole("button", { name: "Reject proposal" }).click()
      await expect(card.locator("[data-review-status]")).toContainText("Proposal rejected")
      expect((await (await api.get(`${prefix}/api/tasks/${proposal.id}`)).json()).title).toBe("Household changed the task")
    })
  })

  test("a replaced proposal never substitutes a newly fetched hash before the reviewer refreshes", async ({ playwright }) => {
    await withReview(playwright, async ({ page, api, origin, prefix, propose }) => {
      const old = await propose("Original task", "First agent proposal")
      await page.goto(origin + prefix + "/review")
      const card = cardFor(page, old.id)
      await expect(card.getByRole("button", { name: "Accept proposal" })).toBeEnabled()
      expect((await api.post(`${prefix}/api/tasks/${old.id}/accept-proposal`, { data: { action: "reject", proposal_hash: old.hash } })).status()).toBe(200)
      const replacement = await propose("Original task", "Replacement proposal", old.id)
      const sent = page.waitForRequest(request => request.url().endsWith(`/api/tasks/${old.id}/accept-proposal`))
      await card.getByRole("button", { name: "Accept proposal" }).click()
      expect((await sent).postDataJSON()).toEqual({ action: "accept", proposal_hash: old.hash })
      await expect(card.locator("[data-review-status]")).toContainText("changed, expired, or has already been reviewed")
      await expect(card.locator("[data-proposed-value]")).toHaveText("First agent proposal")
      await expect(card).toHaveAttribute("data-proposal-hash", old.hash)
      await card.getByRole("link", { name: "Refresh proposal" }).click()
      await expect(card).toHaveAttribute("data-proposal-hash", replacement.hash)
      await expect(card.locator("[data-proposed-value]")).toHaveText("Replacement proposal")
      await card.getByRole("button", { name: "Accept proposal" }).click()
      await expect(card.locator("[data-review-status]")).toContainText("Proposal accepted")
    })
  })

  test("a lost receipt keeps the displayed card and uncertainty until explicit refresh", async ({ playwright }) => {
    await withReview(playwright, async ({ page, api, origin, prefix, propose }) => {
      const proposal = await propose("Before lost receipt", "Saved despite lost receipt")
      await page.goto(origin + prefix + "/review")
      const card = cardFor(page, proposal.id)
      await page.route(`**/api/tasks/${proposal.id}/accept-proposal`, async route => {
        const saved = await api.post(route.request().url(), { data: route.request().postDataJSON() })
        expect(saved.status()).toBe(200)
        await route.abort("connectionreset")
      })
      await card.getByRole("button", { name: "Accept proposal" }).click()
      await expect(card.locator("[data-review-status]")).toContainText("The decision may have been saved")
      await expect(card.locator("[data-current-value]")).toHaveText("Before lost receipt")
      await expect(card.getByRole("button", { name: "Accept proposal" })).toBeDisabled()
      expect((await (await api.get(`${prefix}/api/tasks/${proposal.id}`)).json()).title).toBe("Saved despite lost receipt")
      await card.getByRole("link", { name: "Refresh proposal" }).click()
      await expect(page.getByRole("heading", { name: "No pending proposals" })).toBeVisible()
    })
  })

  test("the displayed expiry disables decisions without removing the values or refresh link", async ({ playwright }) => {
    await withReview(playwright, async ({ page, origin, prefix, propose }) => {
      const proposal = await propose("Expires in the queue", "Expired proposal")
      await page.clock.install({ time: new Date() })
      await page.goto(origin + prefix + "/review")
      const card = cardFor(page, proposal.id)
      await expect(card.getByRole("button", { name: "Accept proposal" })).toBeEnabled()
      const expiresAt = Number(await card.getAttribute("data-expires-at"))
      await page.clock.setFixedTime(expiresAt + 1000)
      await page.clock.runFor(1000)
      await expect(card.locator("[data-review-status]")).toContainText("This proposal expired")
      await expect(card.getByRole("button", { name: "Accept proposal" })).toBeDisabled()
      await expect(card.getByRole("button", { name: "Reject proposal" })).toBeDisabled()
      await expect(card.locator("[data-proposed-value]")).toHaveText("Expired proposal")
      await expect(card.getByRole("link", { name: "Refresh proposal" })).toHaveAttribute("href", prefix + "/review")
    })
  })

  test("Core role revocation denies a decision despite the old ingress administrator header; members cannot open Review", async ({ playwright }) => {
    await withReview(playwright, async ({ page, api, child, origin, prefix, propose }) => {
      const proposal = await propose("Current administrator required", "Must not apply")
      await page.goto(origin + prefix + "/review")
      const card = cardFor(page, proposal.id)
      await expect(card.getByRole("button", { name: "Accept proposal" })).toBeEnabled()
      const changed = once(child, "message", { signal: AbortSignal.timeout(4000) })
      child.send({ type: "fixture-core", user: "admin", isOwner: false, groupIds: ["system-users"] })
      expect((await changed)[0]).toEqual({ coreChanged: true })
      await card.getByRole("button", { name: "Accept proposal" }).click()
      await expect(card.locator("[data-review-status]")).toContainText("current Home Assistant administrator")
      await expect(page.locator("#review-authority-status")).toContainText("Decisions are unavailable")
      expect((await (await api.get(`${prefix}/api/tasks/${proposal.id}`)).json()).title).toBe("Current administrator required")
      expect((await page.reload())?.status()).toBe(403)
      await expect(page.locator("[data-proposal-review]")).toHaveCount(0)
      await page.context().addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
      expect((await page.reload())?.status()).toBe(403)
      await expect(page.getByRole("heading", { name: "Administrator access required" })).toBeVisible()
    })
  })
})
