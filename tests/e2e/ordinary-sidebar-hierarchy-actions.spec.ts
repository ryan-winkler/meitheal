import { closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { GET as boardDirectory } from "../../apps/web/src/pages/api/boards/index"
import { GET as areaRead, PUT as areaUpdate, DELETE as areaDelete } from "../../apps/web/src/pages/api/areas/[id]"
import { GET as projectRead, PUT as projectUpdate, DELETE as projectDelete } from "../../apps/web/src/pages/api/projects/[id]"
import { POST as areaCreate } from "../../apps/web/src/pages/api/areas/index"
import { POST as agenda } from "../../apps/web/src/pages/api/calendar/agenda"
import { POST as createProject } from "../../apps/web/src/pages/api/projects/index"
import { GET as users } from "../../apps/web/src/pages/api/users/index"
import { POST as customUser } from "../../apps/web/src/pages/api/users/custom"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { getHouseholdProjectLabels } from "../../apps/web/src/lib/household-project-grouping"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { verifiedBoardRequestPrincipal, resolveBoardRequestScope } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { POST as createTask } from "../../apps/web/src/pages/api/tasks/index"
import { GET as readTask, PUT as updateTask, DELETE as deleteTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { HEAD as verifyBoard, PATCH as updateBoard } from "../../apps/web/src/pages/api/boards/[id]/index"
import { GET as routineLibrary } from "../../apps/web/src/pages/api/boards/routines"
import { POST as planning } from "../../apps/web/src/pages/api/boards/[id]/planning"
import { readBoardPagePlacement } from "../../apps/web/src/lib/board-page-placement"
import { boardNavigationLinks } from "../../apps/web/src/lib/board-workspace"

// The routed source fixture owns its own origin independently of the packaged App.
test.use({ extraHTTPHeaders: {}, serviceWorkers: "block" })

type APIContext = Parameters<typeof createTask>[0]
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
const origin = "http://127.0.0.1:8930"
const source = resolve(import.meta.dirname, "../../apps/web/src")
const ts = createRequire(import.meta.url)("../../apps/web/node_modules/typescript/lib/typescript.js")
const requireRuntime = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocket, WebSocketServer } = requireRuntime("ws") as typeof import("../../apps/web/node_modules/@types/ws")
const esbuild = createRequire(import.meta.url)("../../node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js")
let directory: string, session: string, work: string
let markup = ""
let actor: "local" | "owner" | "viewer" = "local"
let socketServer: InstanceType<typeof WebSocketServer> | undefined
const originalSocket = globalThis.WebSocket
let previousSupervisor: string | undefined
let previous: string | undefined
let beforeVerify: (() => Promise<void>) | undefined
let calls: Array<{ method: string; path: string; board: string | null; body: unknown }>
function context(request: Request, params = {}): APIContext {
  return { request, url: new URL(request.url), params,
    locals: actor === "local" ? {} : { behindIngress: true, hassUserId: actor, hassIsAdmin: actor === "owner" } } as APIContext
}
async function call(route: typeof createTask, path: string, board: string, body?: unknown, method = "POST", params = {}) {
  const request = new Request(origin + path, { method, headers: { "content-type": "application/json", "x-meitheal-board-id": board, "x-meitheal-board-session": session },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return runWithIngressTransport(actor === "local" ? transport : { ...transport, fromSupervisor: true }, () => route(context(request, params)))
}
async function task(board: string) {
  const response = await call(createTask, "/api/tasks", board, { title: "Concurrent task", description: "Original description", start_date: "2026-11-19", due_date: "2026-11-20" })
  expect(response.status, await response.clone().text()).toBe(201)
  return response.json()
}
async function load(id: string, board: string) {
  const response = await call(readTask, "/api/tasks/" + id, board, undefined, "GET", { id })
  expect(response.status).toBe(200)
  return response.json()
}
test.beforeEach(async () => {
  previous = process.env.MEITHEAL_DB_URL
  previousSupervisor = process.env.SUPERVISOR_TOKEN
  delete process.env.SUPERVISOR_TOKEN
  actor = "local"
  markup = ""
  directory = await mkdtemp(join(tmpdir(), "ordinary-browser-work-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(directory, "tasks.db")
  await ensureSchema()
  calls = []
  beforeVerify = undefined
  await runWithIngressTransport(transport, async () => {
    const principal = await verifiedBoardRequestPrincipal({ request: new Request(origin + "/boards"), locals: {} as App.Locals })
    if (!principal) throw new Error("Actual current standalone principal required")
    session = boardSessionProof(principal.id)
    const created = await new NamedBoardRepository(getPersistenceClient()).create(principal, "Work")
    if (created.status !== "committed") throw new Error("Current Board creation required")
    work = created.result.id
  })
})
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" })
  closeHAConnection()
  globalThis.WebSocket = originalSocket
  if (socketServer) {
    for (const socket of socketServer.clients) socket.terminate()
    await new Promise<void>(resolve => socketServer!.close(() => resolve()))
    socketServer = undefined
  }
  if (previousSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN
  else process.env.SUPERVISOR_TOKEN = previousSupervisor
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})
async function browser(page: Page, board: string, query = "", widget = false) {
  await page.route(origin + "/**", async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname.startsWith("/api/")) {
      calls.push({ method: request.method(), path: url.pathname + url.search, board: request.headers()["x-meitheal-board-id"] ?? null, body: request.postDataJSON() })
      const webRequest = new Request(request.url(), { method: request.method(), headers: request.headers(),
        ...(request.postData() ? { body: request.postData()! } : {}) })
      const areaMatch = /^\/api\/areas\/([^/]+)$/.exec(url.pathname)
      const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)
      const boardMatch = /^\/api\/boards\/([^/]+)\/planning$/.exec(url.pathname)
      const verifyMatch = /^\/api\/boards\/([^/]+)$/.exec(url.pathname)
      if (verifyMatch && beforeVerify) await beforeVerify()
      const handler = url.pathname === "/api/boards" ? boardDirectory
        : areaMatch ? request.method() === "GET" ? areaRead : request.method() === "DELETE" ? areaDelete : areaUpdate
        : projectMatch ? request.method() === "GET" ? projectRead : request.method() === "DELETE" ? projectDelete : projectUpdate
        : taskMatch ? request.method() === "GET" ? readTask : request.method() === "DELETE" ? deleteTask : updateTask
        : url.pathname === "/api/calendar/agenda" ? agenda
        : url.pathname === "/api/users" ? users
        : url.pathname === "/api/tasks" && request.method() === "POST" ? createTask
        : url.pathname === "/api/boards/routines" ? routineLibrary : boardMatch ? planning : verifyMatch ? verifyBoard : null
      if (!handler) return route.fulfill({ status: 404 })
      const response = await runWithIngressTransport(actor === "local" ? transport : { ...transport, fromSupervisor: true }, () => handler(context(webRequest, { ...(areaMatch ? { id: areaMatch[1] } : {}), ...(projectMatch ? { id: projectMatch[1] } : {}), ...(taskMatch ? { id: taskMatch[1] } : {}), ...(boardMatch ? { id: boardMatch[1] } : {}), ...(verifyMatch ? { id: verifyMatch[1] } : {}) })))
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    }
    if (url.pathname === "/package-date") return route.fulfill({ contentType: "text/javascript", body: esbuild.buildSync({ entryPoints: [resolve(requireRuntime.resolve("date-fns-tz/package.json"), "../dist/esm/index.js")], bundle: true, write: false, platform: "browser", format: "esm" }).outputFiles[0].text })
    if (url.pathname === "/package-sortable") return route.fulfill({ contentType: "text/javascript", body: esbuild.buildSync({ entryPoints: [requireRuntime.resolve("sortablejs/modular/sortable.esm.js")], bundle: true, write: false, platform: "browser", format: "esm" }).outputFiles[0].text })
    if (url.pathname.startsWith("/package-task/")) {
      const filename = url.pathname.slice("/package-task/".length)
      if (!/^[\w-]+$/.test(filename)) return route.fulfill({ status: 404 })
      const packageRoot = resolve(import.meta.dirname, "../../packages/domain-tasks/src")
      if (filename === "browser-values") return route.fulfill({ contentType: "text/javascript", body: ts.transpileModule(
        (await readFile(join(packageRoot, "task.ts"), "utf8")) + "\n" + (await readFile(join(packageRoot, "domain-model.ts"), "utf8")),
        { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText })
      const raw = await readFile(join(packageRoot, filename === "status-values" ? "task-status-values.mjs" : filename + ".ts"), "utf8")
      return route.fulfill({ contentType: "text/javascript", body: ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText })
    }
    if (url.pathname === "/styles/tabler-surface.scss") return route.fulfill({ contentType: "text/javascript", body: 'export default "/fixture-tabler.css"' })
    if (url.pathname === "/fixture-tabler.css") return route.fulfill({ contentType: "text/css", body: await readFile(resolve(source, "../node_modules/@tabler/core/dist/css/tabler.min.css"), "utf8") })
    if (url.pathname.startsWith("/tabler/")) {
      const filename = url.pathname.slice("/tabler/".length).replace(/\.js$/, "")
      if (!/^[\w/-]+$/.test(filename)) return route.fulfill({ status: 404 })
      const raw = await readFile(resolve(source, "../node_modules/@tabler/core/js/src/bootstrap", filename + ".ts"), "utf8")
      return route.fulfill({ contentType: "text/javascript", body: ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText })
    }
    if (/^\/(lib|generated|components|domains|i18n)\//.test(url.pathname)) {
      if (!/^\/(lib|generated|components|domains|i18n)\/[\w/.-]+$/.test(url.pathname)) return route.fulfill({ status: 404 })
      if (url.pathname.endsWith(".json")) return route.fulfill({ contentType: "application/json", body: await readFile(resolve(source, url.pathname.slice(1)), "utf8") })
      const raw = url.pathname === "/components/layout/sidebar-nav-inline"
        ? (await readFile(resolve(source, "components/layout/SidebarNavList.astro"), "utf8")).match(/<script>([\s\S]*?)<\/script>/i)![1]!
        : await readFile(resolve(source, url.pathname.slice(1) + ".ts"), "utf8")
      const compiled = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        .replaceAll('"@lib/', '"/lib/').replaceAll('"@domains/', '"/domains/')
        .replaceAll('"@meitheal/domain-tasks/status-values"', '"/package-task/status-values"')
        .replaceAll('"@meitheal/domain-tasks"', '"/package-task/browser-values"')
        .replaceAll('"date-fns-tz"', '"/package-date"')
        .replaceAll('"sortablejs"', '"/package-sortable"')
        .replaceAll('"@tabler/core/js/src/bootstrap/modal"', '"/tabler/modal"')
        .replaceAll("import.meta.env", '{ DEV: false, PROD: true }')
      return route.fulfill({ contentType: "text/javascript", body: compiled })
    }
    const placement = new URLSearchParams(query)
    placement.set("board_id", board)
    const html = `<meta name="meitheal-work-board" content="${board}"><meta name="meitheal-work-session" content="${session}"><meta name="meitheal-work-actor" content="actual-fixture-actor"><textarea id="local-input">Retained local input</textarea>${markup}${widget ? `<section data-board-routine-checkins data-board-id="${board}" data-routine-query="${placement}" hidden><ul data-board-routine-list></ul><p data-board-routine-feedback></p><p data-board-routine-more hidden></p></section>` : ""}`
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
  })
  await page.goto(origin + "/today?board_id=" + board + (query ? "&" + query : ""))
}

async function makeTask(board: string, title: string, fields: Record<string, unknown> = {}) {
  const response = await call(createTask, "/api/tasks", board, { title, due_date: "2026-11-19", ...fields })
  expect(response.status, await response.clone().text()).toBe(201)
  return response.json()
}
async function currentCore() {
  await runWithIngressTransport(transport, async () => {
    const principal = await verifiedBoardRequestPrincipal({ request: new Request(origin + "/boards"), locals: {} as App.Locals })
    if (!principal) throw new Error("Actual admitted fixture owner required")
    const grant = await changeBoardGrants(getPersistenceClient(), principal, async tx => {
      for (const boardId of ["household", work]) {
        for (const [id, role] of [["owner", "owner"], ["viewer", "viewer"]]) await tx.execute({ sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role) VALUES (?,'ha_user',?,?)", args: [boardId!, id!, role!] })
      }
      return { next: true }
    })
    expect(grant.status).toBe("committed")
  })
  socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>(resolve => socketServer!.once("listening", resolve))
  socketServer.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.1" }))
    socket.on("message", raw => {
      const command = JSON.parse(raw.toString())
      if (command.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }))
      else socket.send(JSON.stringify({ id: command.id, type: "result", success: true, result: command.type === "config/auth/list"
        ? ["owner", "viewer"].map(id => ({ id, is_active: true, is_owner: id === "owner", system_generated: false, group_ids: [] })) : [] }))
    })
  })
  const address = socketServer.address()
  if (!address || typeof address === "string") throw new Error("Loopback Core fixture required")
  const port = address.port
  globalThis.WebSocket = class extends WebSocket {
    constructor(url: string | URL, options?: import("../../apps/web/node_modules/@types/ws").ClientOptions) {
      if (String(url) !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected Core endpoint")
      super(`ws://127.0.0.1:${port}`, options)
    }
  } as unknown as typeof globalThis.WebSocket
  process.env.SUPERVISOR_TOKEN = "fixture-current-core"
}

function actionTemplates() {
  return `<template id="tmpl-area-menu"><div id="area-menu-dropdown" class="stree__dropdown"><a data-action="manage">Edit Area</a><button data-action="rename">Rename</button><button data-action="color-icon">Color &amp; Icon</button><button data-action="delete">Delete Area</button></div></template><template id="tmpl-project-menu"><div id="project-menu-dropdown" class="stree__dropdown"><a data-action="manage">Edit Project</a><button data-action="rename">Rename</button><button data-action="color-icon">Color &amp; Icon</button><button data-action="delete">Delete Project</button></div></template><template id="tmpl-task-kind"><div id="task-kind-dropdown" class="stree__dropdown"><button data-task-kind="standard_action">Task</button></div></template><template id="tmpl-color-icon"><div id="color-icon-popover" class="stree__popover"><button data-emoji-tab="0">Emoji</button><div data-emoji-panel="0"><button data-emoji-value="🚀">Rocket</button></div><input id="entity-icon-input"><span id="entity-icon-preview"></span><button data-swatch-color="#146C4E">Green</button><button id="color-icon-save">Save</button></div></template>`
}
async function sidebar(page: Page, current = "household") {
  page.setDefaultTimeout(6_000)
  page.on("pageerror", error => console.error("Sidebar fixture browser:", error.message))
  markup = `<aside id="sidebar"><button data-sidebar-boards-toggle aria-expanded="true">Boards</button><ul id="sidebar-board-children" data-sidebar-board-children data-sidebar-boards data-board-group-label="Areas" data-board-project-label="Projects" data-areas-enabled="true" data-projects-enabled="true"></ul></aside>${actionTemplates()}`
  await browser(page, current)
  await page.addStyleTag({ content: await readFile(resolve(source, "styles/sidebar-hierarchy-actions.css"), "utf8") })
  await page.evaluate(async () => { const url = "/lib/sidebar-boards"; (await import(url)).bindSidebarBoards(new AbortController().signal) })
}
async function fixtureProject(board: string) {
  const a = await call(areaCreate, "/api/areas", board, { name: "Editable Garden" })
  expect(a.status).toBe(201)
  const area = await a.json()
  const p = await call(createProject, "/api/projects", board, { title: "Garden maintenance", area_id: area.id })
  expect(p.status).toBe(201)
  return { area, project: await p.json() }
}
async function openProject(page: Page, board: string, area: string, project: string) {
  const parent = page.locator("[data-sidebar-boards-toggle]")
  if (await parent.getAttribute("aria-expanded") !== "true") await parent.click()
  const row = page.locator(`[data-named-board-shortcut="${board}"]`)
  await row.locator(":scope > .sidebar-board-row > .sidebar-board-toggle").click()
  await row.locator(`[data-area-toggle="${area}"]`).click()
  const menu = row.locator(`[data-project-menu="${project}"]`)
  await expect(menu).toBeVisible()
  await menu.locator("xpath=ancestor::div[contains(@class,'stree__project')][1]").hover()
  return row
}
for (const encoding of ["legacy", "ordinary"] as const) {
  test(`Paged ${encoding} peer retains Rename/Escape, Color/Icon, Delete dismissal and keyboard pin from another Board`, async ({ page }) => {
    const board = encoding === "legacy" ? "household" : work
    const original = encoding === "legacy" ? work : "household"
    const { area, project } = await fixtureProject(board)
    await sidebar(page, original)
    const row = await openProject(page, board, area.id, project.id)
    const trigger = row.locator(`[data-project-menu="${project.id}"]`)
    const projectRow = trigger.locator("xpath=ancestor::div[contains(@class,'stree__project')][1]")
    await projectRow.hover(); await projectRow.hover(); await trigger.click()
    await page.locator("#project-menu-dropdown").getByRole("button", { name: "Rename", exact: true }).click()
    const input = projectRow.locator(".stree__inline-input")
    await expect(input).toBeFocused(); await input.fill("Must not save"); await input.press("Escape")
    await expect(trigger).toBeFocused(); await page.waitForTimeout(150)
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(0)
    await projectRow.hover(); await trigger.click(); await page.locator("#project-menu-dropdown").getByRole("button", { name: "Rename", exact: true }).click()
    await input.fill("Renamed peer Project")
    const saved = page.waitForResponse(response => response.request().method() === "PUT")
    await input.press("Enter"); expect((await saved).status()).toBe(200)
    await expect(projectRow.locator(".stree__project-name")).toHaveText("Renamed peer Project")
    expect(calls.find(call => call.method === "PUT")?.board).toBe(board)
    await projectRow.hover(); await trigger.click(); await page.locator("#project-menu-dropdown").getByRole("button", { name: "Color & Icon", exact: true }).click()
    await page.locator("#color-icon-popover [data-emoji-value]").click()
    const colored = page.waitForResponse(response => response.request().method() === "PUT")
    await page.locator("#color-icon-save").click(); expect((await colored).status()).toBe(200)
    const detail = await call(projectRead, "/api/projects/" + project.id, board, undefined, "GET", { id: project.id })
    expect((await detail.json()).icon).toBe("🚀")
    await projectRow.hover(); await trigger.click(); await page.locator("#project-menu-dropdown").getByRole("button", { name: "Delete Project", exact: true }).click()
    const confirmation = projectRow.locator(".stree__confirm-delete")
    await expect(confirmation).toBeFocused(); await confirmation.press("Escape")
    await expect(confirmation).toHaveCount(0); await expect(trigger).toBeFocused()
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(0)
    const link = projectRow.locator("[data-project-id]")
    await link.click({ button: "right" })
    const pinned = row.locator(`[data-board-pinned-list] [data-project-id="${project.id}"]`)
    await expect(pinned).toBeVisible(); await pinned.focus(); await page.keyboard.press("Tab")
    const unpin = row.getByRole("button", { name: "Unpin project", exact: true })
    await expect(unpin).toBeFocused(); await unpin.press("Enter")
    await expect(pinned).toHaveCount(0); await expect(link).toBeFocused()
    expect(calls.filter(call => call.method === "PUT").every(call => call.board === board)).toBe(true)
    expect(await page.locator('meta[name="meitheal-work-board"]').getAttribute("content")).toBe(original)
  })
}
test("Sidebar peer commands cancel after the original document identity changes", async ({ page }) => {
  const { area, project } = await fixtureProject(work)
  await sidebar(page)
  const row = await openProject(page, work, area.id, project.id)
  await row.locator(`[data-project-menu="${project.id}"]`).click()
  await page.locator("#project-menu-dropdown").getByRole("button", { name: "Rename", exact: true }).click()
  const input = row.locator(".stree__inline-input")
  await input.fill("No cross-actor save")
  await page.evaluate(() => { document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-actor"]')!.content = "different-actor" })
  await expect(input).toHaveCount(0)
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(0)
})
test("Viewer peer menus retain Manage but cannot expose edit/delete/create operations", async ({ page }) => {
  const { area, project } = await fixtureProject(work)
  await currentCore(); actor = "viewer"; session = boardSessionProof("viewer")
  await sidebar(page)
  const row = await openProject(page, work, area.id, project.id)
  await row.locator(`[data-project-menu="${project.id}"]`).click()
  const menu = page.locator("#project-menu-dropdown")
  await expect(menu.getByRole("link", { name: "Edit Project" })).toBeVisible()
  await expect(menu.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0)
  await expect(menu.getByRole("button", { name: "Delete Project", exact: true })).toHaveCount(0)
  await expect(row.locator("[data-task-add-project]")).toHaveCount(0)
  await expect(row.locator("[data-area-add]")).toHaveCount(0)
  expect((await call(projectUpdate, "/api/projects/" + project.id, work, { title: "Denied" }, "PUT", { id: project.id })).status).toBe(403)
  expect((await call(projectDelete, "/api/projects/" + project.id, work, {}, "DELETE", { id: project.id })).status).toBe(403)
})

async function inspector(page: Page, id?: string) {
  const raw = await readFile(resolve(source, "components/tasks/TaskDetailModal.astro"), "utf8")
  const elements = [...raw.matchAll(/<([\w-]+)\b[^>]*\bid="(td-[^"]+)"/g)].map(match => [match[1]!, match[2]!] as const)
  await page.evaluate(elements => {
    document.body.insertAdjacentHTML("beforeend", `<div id="task-detail-overlay"><section id="task-detail-panel"><div id="td-loaded-content"><textarea id="td-title"></textarea><textarea id="td-description"></textarea><select id="td-status"></select><div id="td-sections"></div><div id="td-labels"></div><div id="td-cf-list"></div><button id="td-delete">Delete task</button></div><p id="td-load-error" role="alert" data-unavailable="This task is unavailable."></p></section></div>`)
    // Feature templates require their inner markup. Keep these out of the synthetic Inspector.
    for (const [tag, id] of elements) if (tag !== "template" && !document.getElementById(id)) {
      const node = document.createElement(tag); node.id = id; document.getElementById("td-sections")!.append(node)
    }
    document.getElementById("td-close")!.textContent = "Close detail"
  }, elements)
  await page.evaluate(async id => {
    const url = "/lib/task-modal-controller"; await import(url); document.dispatchEvent(new Event("astro:page-load"))
    if (id) await window.openTaskDetail?.(id)
  }, id)
}

test("Temporary inspector verification preserves drafts while terminal Board revocation removes private live DOM", async ({ page }) => {
  const created = await makeTask(work, "Private inspector original")
  await browser(page, work); await inspector(page, created.id)
  await expect(page.locator("#td-title")).toHaveValue("Private inspector original")
  await page.evaluate(() => {
    document.querySelector<HTMLTextAreaElement>("#td-title")!.value = "Private retained title"
    document.querySelector<HTMLTextAreaElement>("#td-description")!.value = "Private retained description"
  })
  await page.evaluate(() => document.dispatchEvent(new Event("meitheal:board-hidden")))
  await expect(page.locator("#task-detail-overlay")).toBeHidden()
  await page.evaluate(() => document.dispatchEvent(new Event("meitheal:board-verified")))
  await expect(page.locator("#td-title")).toHaveValue("Private retained title")
  await expect(page.locator("#td-description")).toHaveValue("Private retained description")
  await page.evaluate(boardId => document.dispatchEvent(new CustomEvent("meitheal:board-revoked", { detail: { boardId } })), work)
  await expect(page.locator("#task-detail-overlay")).toHaveCount(0)
  expect(await page.locator("textarea").evaluateAll(nodes => nodes.some(node => node instanceof HTMLTextAreaElement && node.value.includes("Private retained")))).toBe(false)
  const before = calls.filter(call => call.path.startsWith("/api/tasks/")).length
  await page.evaluate(async id => { document.dispatchEvent(new Event("meitheal:board-verified")); await window.openTaskDetail?.(id) }, created.id)
  await expect(page.locator("#task-detail-overlay")).toHaveCount(0)
  expect(calls.filter(call => call.path.startsWith("/api/tasks/")).length).toBe(before)
})
