import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Browser } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLuoAAAAASUVORK5CYII=", "base64")

for (const width of [991, 390]) {
  test(`attaching an image keeps the discussion in place at ${width}px`, async () => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and HTTPS ingress fixture")
    const work = await mkdtemp(join(tmpdir(), "meitheal-attachments-"))
    const child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser: Browser | undefined
    try {
      const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${info.port}`
      const base = origin + info.configuredPath
      browser = await launchPinBrowser(work)
      const context = await browser.newContext({
        viewport: { width, height: 873 },
        hasTouch: width < 500,
        extraHTTPHeaders: {},
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
      })
      await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
      const page = await context.newPage()
      await page.goto(base + "/fixture")
      const headers = await currentBoardWriteHeaders(context.request, "household", { origin }, base)
      const created = await context.request.post(base + "/api/tasks", {
        headers, data: { title: "Attachment fixture", description: "Test a comment draft and image" },
      })
      expect(created.status()).toBe(201)
      const task = await created.json()
      await page.goto(base + "/tickets/" + task.ticket_key)
      await expect(page.locator("#td-title")).toHaveValue("Attachment fixture")
      const composer = page.locator("#td-comment-input")
      const paperclip = page.getByRole("button", { name: "Attach image", exact: true })
      await composer.fill("Keep this comment draft")
      await paperclip.scrollIntoViewIfNeeded()
      const position = () => paperclip.evaluate(button => ({
        top: button.getBoundingClientRect().top,
        detail: document.getElementById("td-loaded-content")?.scrollTop,
        page: document.scrollingElement?.scrollTop,
      }))
      const before = await position()
      const open = async () => {
        const chooser = page.waitForEvent("filechooser", { timeout: 5000 })
        if (width < 500) await paperclip.tap()
        else await paperclip.press("Enter")
        return chooser
      }

      const cancelled = await open()
      expect(await cancelled.element().evaluate(input => (input as HTMLInputElement).hidden)).toBe(true)
      await cancelled.element().dispatchEvent("cancel")
      await expect(paperclip).toBeFocused()
      expect(await position()).toEqual(before)
      await expect(composer).toHaveValue("Keep this comment draft")

      await (await open()).setFiles({ name: "sample.heic", mimeType: "image/heic", buffer: Buffer.from("unsupported source") })
      await expect(page.getByText("Choose a PNG, JPEG, GIF, WebP, or AVIF image.")).toBeVisible()
      await expect(page.locator("#td-attachments img")).toHaveCount(0)
      expect(await position()).toEqual(before)

      await (await open()).setFiles({ name: "example.png", mimeType: "image/png", buffer: image })
      const confirmation = page.locator("#toast-container").getByText("Image attached to task", { exact: true })
      await expect(confirmation).toBeVisible()
      await expect(composer).toHaveValue("Keep this comment draft")
      const afterSave = await position()
      expect(afterSave.page).toBe(before.page)
      expect(Math.abs(afterSave.top - before.top)).toBeLessThanOrEqual(1)
      await page.getByRole("button", { name: "View image", exact: true }).click()
      const preview = page.locator("dialog.m-attachment-lightbox")
      const displayedImage = preview.getByRole("img", { name: "example.png" })
      await expect(displayedImage).toBeVisible()
      await expect.poll(() => displayedImage.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await preview.getByRole("button", { name: "Close attachment preview" }).click()
      await expect(paperclip).toBeFocused()
      await page.reload()
      await expect(page.locator('#td-attachments img[alt="example.png"]')).toHaveCount(1)
    } finally {
      await browser?.close()
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close")
        child.kill("SIGTERM")
        await closed
      }
      await rm(work, { recursive: true, force: true })
    }
  })
}
