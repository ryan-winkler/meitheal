import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and its disposable ingress fixture")

test("Review displays saved proposals without exposing approval actions", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-review-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [{ port, configuredPath: prefix }] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${port}`
    const reviewUrl = origin + prefix + "/review"
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ serviceWorkers: "block" })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(reviewUrl))?.status()).toBe(200)
    await expect(page.getByRole("heading", { name: "No saved proposals" })).toBeVisible()

    const title = "Replace smoke alarm batteries"
    const created = await pinRequest(page, prefix + "/api/tasks", "POST", { title })
    expect(created.status).toBe(201)
    const { id } = created.body
    const proposal = JSON.stringify({
      agent: "Fixture agent",
      summary: "Clarify which batteries need replacing.",
      changes: { title: { from: title, to: "Replace upstairs smoke alarm batteries" } },
    })
    const database = new DatabaseSync(join(work, "pins.db"))
    try {
      database.prepare("UPDATE tasks SET handoff_state = 'proposed', proposal_json = ?, proposal_hash = ? WHERE id = ?")
        .run(proposal, "fixture-proposal-hash", id)

      const refresh = page.getByRole("link", { name: "Refresh", exact: true })
      await expect(refresh).toHaveAttribute("href", prefix + "/review")
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url() === reviewUrl && response.request().isNavigationRequest()),
        refresh.click(),
      ])
      expect(response.status()).toBe(200)
      expect(response.headers()["cache-control"]).toBe("private, no-store")
      await expect(page.getByText("Approval and rejection are unavailable.", { exact: false })).toBeVisible()
      const card = page.locator(".review-card")
      await expect(card.getByRole("heading", { name: title })).toBeVisible()
      await expect(card.getByText("Fixture agent")).toBeVisible()
      await expect(card.getByText("Clarify which batteries need replacing.")).toBeVisible()
      await expect(card.getByRole("cell", { name: "Replace upstairs smoke alarm batteries" })).toBeVisible()
      await expect(card.getByRole("button", { name: /accept|approve|reject/i })).toHaveCount(0)
      expect(database.prepare("SELECT title, handoff_state, proposal_json, proposal_hash FROM tasks WHERE id = ?").get(id))
        .toMatchObject({ title, handoff_state: "proposed", proposal_json: proposal, proposal_hash: "fixture-proposal-hash" })
    } finally {
      database.close()
    }
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
