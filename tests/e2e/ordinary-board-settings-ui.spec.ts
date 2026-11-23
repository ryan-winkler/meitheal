import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

// These routed module origins use the browser Origin, not the unrelated App-server fixture Origin.
test.use({ extraHTTPHeaders: {} })

const require = createRequire(import.meta.url)
const ts = require("../../apps/web/node_modules/typescript/lib/typescript.js")
const sourceRoot = resolve(import.meta.dirname, "../../apps/web/src")
const origin = "http://127.0.0.1:8920"
const markup = `<p data-board-expired hidden></p>
<div data-board-directory data-board-id="example" data-board-key="view" data-board-authority="authority" data-board-session="current-session" data-board-verify="/api/boards/example">
<form data-board-form="rename"><input name="revision" value="7" type="hidden"><input name="name" value="Household"><p data-board-feedback role="status"></p><button type="submit">Save name</button><button type="button" data-board-form-refresh hidden>Refresh Board</button></form>
<form data-board-form="sharing"><input name="revision" value="7" type="hidden"><select name="visibility"><option value="restricted">People you add</option><option value="shared">All active Home Assistant users</option></select><fieldset data-board-shared-settings hidden><select name="sharedRole"><option value="viewer">Viewer</option><option value="member" selected>Member</option></select><input name="sharedAdminManagement" type="checkbox" checked></fieldset><p data-board-feedback role="status"></p><button type="submit">Save sharing</button><button type="button" data-board-form-refresh hidden>Refresh Board</button></form>
<form data-board-form="create"><input name="name" value="Work"><p data-board-feedback></p><button type="submit">Create Board</button><button type="button" data-board-form-refresh hidden>Refresh Boards</button></form>
</div>`

test.beforeEach(async ({ page }) => {
  await page.route(origin + "/**", async route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/") return route.fulfill({ contentType: "text/html", body: markup })
    if (!/^\/(?:lib|generated|domains\/[\w-]+)\/[\w-]+$/.test(path)) return route.fulfill({ status: 404 })
    const source = await readFile(resolve(sourceRoot, path.slice(1) + ".ts"), "utf8")
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    // Serve workspace aliases the way the App bundle resolves them.
    return route.fulfill({ contentType: "text/javascript", body: compiled.replaceAll('"@domains/', '"/domains/') })
  })
  await page.goto(origin)
  await page.evaluate(async () => {
    const url = "/lib/boards-page"
    const { bindBoardPage } = await import(url)
    bindBoardPage(new AbortController().signal)
  })
})

test("an example Board rename sends the current revision and exact Board, retaining a pending save", async ({ page }) => {
  let requests = 0
  let sent: unknown
  let headers: Record<string, string> = {}
  await page.route(origin + "/api/boards/example", async route => {
    requests++
    sent = route.request().postDataJSON()
    headers = route.request().headers()
    return route.fulfill({ status: 202, json: { ok: true, accessPending: true } })
  })
  const form = page.locator('[data-board-form="rename"]')
  await form.locator('[name="name"]').fill("Church")
  await form.locator('[type="submit"]').click()
  await expect(form.locator("[data-board-feedback]")).toContainText("Access is still being verified")
  expect(sent).toEqual({ action: "rename", name: "Church", revision: 7 })
  expect(headers["x-meitheal-board-id"]).toBe("example")
  expect(headers["x-meitheal-board-session"]).toBe("current-session")
  await expect(form.locator('[name="name"]')).toHaveValue("Church")
  await expect(form.locator('[type="submit"]')).toBeDisabled()
  await expect(form.locator("[data-board-form-refresh]")).toBeVisible()
  await form.evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(requests).toBe(1)
})

test("a stale sharing save keeps all selected policy values and allows a deliberate retry", async ({ page }) => {
  let sent: unknown
  await page.route(origin + "/api/boards/example", route => {
    sent = route.request().postDataJSON()
    return route.fulfill({ status: 409, json: { error: "This Board changed. Refresh it before trying again." } })
  })
  const form = page.locator('[data-board-form="sharing"]')
  await expect(form.locator("fieldset")).toBeHidden()
  await form.locator('[name="visibility"]').selectOption("shared")
  await expect(form.locator("fieldset")).toBeVisible()
  await form.locator('[name="sharedRole"]').selectOption("viewer")
  await form.locator('[name="sharedAdminManagement"]').uncheck()
  await form.locator('[type="submit"]').click()
  await expect(form.locator("[data-board-feedback]")).toContainText("This Board changed")
  expect(sent).toEqual({ action: "sharing", visibility: "shared", sharedRole: "viewer", sharedAdminManagement: false, revision: 7 })
  await expect(form.locator('[name="visibility"]')).toHaveValue("shared")
  await expect(form.locator('[name="sharedRole"]')).toHaveValue("viewer")
  await expect(form.locator('[name="sharedAdminManagement"]')).not.toBeChecked()
  await expect(form.locator('[type="submit"]')).toBeEnabled()
  await expect(form).not.toHaveAttribute("aria-busy")
})

test("restricting a Board preserves its exact stored shared policy for future sharing", async ({ page }) => {
  let sent: unknown
  await page.route(origin + "/api/boards/example", route => {
    sent = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: { ok: true, accessPending: true } })
  })
  const form = page.locator('[data-board-form="sharing"]')
  await form.locator('[type="submit"]').click()
  await expect(form.locator("[data-board-feedback]")).toContainText("Access is still being verified")
  expect(sent).toEqual({ action: "sharing", visibility: "restricted", sharedRole: "member", sharedAdminManagement: true, revision: 7 })
  await expect(form.locator("fieldset")).toBeHidden()
})

test("a committed but pending Board creation retains its ID and input without duplicate creation", async ({ page }) => {
  let requests = 0
  let body: unknown
  await page.route(origin + "/api/boards", route => {
    requests++
    body = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: { id: "new-board", name: "Work", accessPending: true } })
  })
  // The real directory has no selected Board.
  await page.evaluate(() => { delete document.querySelector<HTMLElement>("[data-board-directory]")!.dataset.boardId })
  const form = page.locator('[data-board-form="create"]')
  await form.locator('[type="submit"]').click()
  await expect(form.locator("[data-board-feedback]")).toContainText("Access is still being verified")
  expect(body).toEqual({ name: "Work" })
  await expect(form).toHaveAttribute("data-board-created-id", "new-board")
  await expect(form.locator('[name="name"]')).toHaveValue("Work")
  await expect(form.locator('[type="submit"]')).toBeDisabled()
  await expect(form.locator("[data-board-form-refresh]")).toBeVisible()
  await form.evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(requests).toBe(1)
  await Promise.all([page.waitForEvent("load"), form.locator("[data-board-form-refresh]").click()])
  expect(requests).toBe(1)
})
