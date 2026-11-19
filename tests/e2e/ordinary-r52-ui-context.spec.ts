import { closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
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
test.afterEach(async () => {
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
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)
      const boardMatch = /^\/api\/boards\/([^/]+)\/planning$/.exec(url.pathname)
      const verifyMatch = /^\/api\/boards\/([^/]+)$/.exec(url.pathname)
      if (verifyMatch && beforeVerify) await beforeVerify()
      const handler = taskMatch ? request.method() === "GET" ? readTask : request.method() === "DELETE" ? deleteTask : updateTask
        : url.pathname === "/api/calendar/agenda" ? agenda
        : url.pathname === "/api/users" ? users
        : url.pathname === "/api/tasks" && request.method() === "POST" ? createTask
        : url.pathname === "/api/boards/routines" ? routineLibrary : boardMatch ? planning : verifyMatch ? verifyBoard : null
      if (!handler) return route.fulfill({ status: 404 })
      const response = await runWithIngressTransport(actor === "local" ? transport : { ...transport, fromSupervisor: true }, () => handler(context(webRequest, { ...(taskMatch ? { id: taskMatch[1] } : {}), ...(boardMatch ? { id: boardMatch[1] } : {}), ...(verifyMatch ? { id: verifyMatch[1] } : {}) })))
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    }
    if (url.pathname === "/package-date") return route.fulfill({ contentType: "text/javascript", body: esbuild.buildSync({ entryPoints: [resolve(requireRuntime.resolve("date-fns-tz/package.json"), "../dist/esm/index.js")], bundle: true, write: false, platform: "browser", format: "esm" }).outputFiles[0].text })
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
        .replaceAll('"@tabler/core/js/src/bootstrap/modal"', '"/tabler/modal"')
        .replaceAll("import.meta.env", '{ DEV: false, PROD: true }')
      return route.fulfill({ contentType: "text/javascript", body: compiled })
    }
    const placement = new URLSearchParams(query)
    placement.set("board_id", board)
    const html = `<meta name="meitheal-work-board" content="${board}"><meta name="meitheal-work-session" content="${session}"><meta name="meitheal-work-actor" content="actual-fixture-actor"><textarea id="local-input">Retained local input</textarea>${markup}${widget ? `<section data-board-routine-checkins data-board-id="${board}" data-routine-query="${placement}" hidden><ul data-board-routine-list></ul><p data-board-routine-feedback></p><p data-board-routine-more hidden></p></section>` : ""}`
    return route.fulfill({ contentType: "text/html", body: html })
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
function calendarMarkup() {
  return `<section id="calendar-shell" data-timezone="UTC"><p data-calendar-status></p><button data-calendar-retry>Retry</button><div data-calendar-month data-calendar-available="true" data-calendar-events="false"><button class="cal-cell" role="button" data-date="2026-11-19">19</button></div></section><div id="day-drawer" aria-hidden="true"><section role="dialog"><button id="day-drawer-close">Close day</button><h2 id="day-drawer-title"></h2><div data-calendar-events-section><div id="day-drawer-event-items"></div><p id="day-drawer-event-status"></p></div><div id="day-drawer-task-items"></div><p id="day-drawer-task-status"></p><button id="day-drawer-more-tasks">More</button></section></div>`
}
for (const encoding of ["legacy", "ordinary"] as const) {
  for (const role of ["owner", "viewer"] as const) {
    test(`Calendar pure-read drawer selects ${encoding} Board for a real current ${role}`, async ({ page }) => {
      const board = encoding === "legacy" ? "household" : work
      const other = encoding === "legacy" ? work : "household"
      await makeTask(board, "Selected Calendar work")
      await makeTask(other, "Other Calendar work")
      await currentCore()
      actor = role
      session = boardSessionProof(role)
      const noProof = new Request(origin + "/api/calendar/agenda", { method: "POST", headers: { "content-type": "application/json", "x-meitheal-board-id": board }, body: JSON.stringify({ date: "2026-11-19", filters: "", offset: 0, limit: 100 }) })
      const response = await runWithIngressTransport({ ...transport, fromSupervisor: true }, () => agenda(context(noProof)))
      expect(response.status, await response.clone().text()).toBe(200)
      expect((await response.json()).tasks.map((task: { title: string }) => task.title)).toEqual(["Selected Calendar work"])
      if (role === "viewer") {
        const selected = await runWithIngressTransport({ ...transport, fromSupervisor: true }, () => resolveBoardRequestScope(context(noProof), { operation: { resource: "task", action: "create" }, write: false }))
        expect(selected.ok).toBe(false)
      }
      markup = calendarMarkup()
      await browser(page, board)
      await page.evaluate(async () => { const url = "/lib/calendar-controller"; (await import(url)).initCalendarPage(new AbortController().signal) })
      await page.getByRole("button", { name: "19", exact: true }).click()
      await expect(page.locator("#day-drawer-task-items")).toContainText("Selected Calendar work")
      await expect(page.locator("#day-drawer-task-items")).not.toContainText("Other Calendar work")
      expect(calls.find(call => call.path === "/api/calendar/agenda")?.board).toBe(board)
    })
  }
}

for (const path of ["/today", "/upcoming", "/progress", "/planning", "/", "/boards/planning"] as const) {
  test(`Sidebar task views leave ${path} and preserve the selected unfiled Project`, async ({ page }) => {
    const created = await call(createProject, "/api/projects", work, { title: "Unfiled navigation Project" })
    const project = (await created.json()).id
    markup = `<aside id="sidebar" class="sidebar"><a class="nav-link" data-task-view-link="table">Table</a><a class="nav-link" data-task-view-link="calendar">Calendar</a><a class="nav-link" data-task-view-link="timeline">Timeline</a></aside>`
    await browser(page, work)
    await page.evaluate(({ board, project, path }) => {
      const url = path === "/boards/planning" ? `/boards/${board}?view=groups&planning=1&project=${project}` : `${path}?board_id=${board}&project_id=${project}`
      history.replaceState({}, "", url)
    }, { board: work, project, path })
    await page.evaluate(async () => { const url = "/components/layout/sidebar-nav-inline"; await import(url); document.dispatchEvent(new Event("astro:page-load")) })
    for (const view of ["table", "calendar", "timeline"]) {
      const href = new URL((await page.locator(`[data-task-view-link="${view}"]`).getAttribute("href"))!, origin)
      expect(href.pathname).toBe(`/boards/${work}`)
      expect(href.searchParams.get("project")).toBe(project)
      expect(href.searchParams.get("view")).toBe(view)
      expect(href.searchParams.has("planning")).toBe(false)
    }
  })
}

function tableMarkup(tasks: Array<{ id: string; title: string; task_version: number }>) {
  const stats = JSON.stringify({ total: { count: tasks.length, riceCount: 0, riceSum: 0 }, groups: [], subgroups: [], epicLabels: [] })
  return `<section id="table-shell" data-table-filters="{}"><p id="table-refresh-status"><span data-table-refresh-message></span><button data-table-retry>Retry Table</button></p><div class="table-container"><table id="task-table" data-table-page="1" data-table-stats='${stats}'><thead><tr><th><input type="checkbox" id="select-all"></th></tr></thead><tbody>${tasks.map(task => `<tr class="table-row" data-id="${task.id}" data-task-version="${task.task_version}" data-status="pending" data-priority="3" data-title="${task.title}"><td><input class="row-check" type="checkbox" data-id="${task.id}"></td><td class="editable-cell" contenteditable="true" data-id="${task.id}" data-original="${task.title}">${task.title}</td><td><select class="inline-select" data-id="${task.id}" data-field="status"><option value="pending">Pending</option><option value="active">Active</option></select></td><td><button class="delete-row">Delete row</button></td></tr>`).join("")}</tbody></table></div><div id="bulk-bar"><span id="selected-count"></span><select id="bulk-priority"><option value="">Priority</option><option value="1">High</option></select><button id="bulk-delete">Delete selected</button></div></section>`
}
async function initTable(page: Page) {
  await page.evaluate(async () => { const url = "/lib/table-controller"; await import(url); document.dispatchEvent(new Event("astro:page-load")) })
}
for (const encoding of ["legacy", "ordinary"] as const) {
  test(`Table inline conflict and stale deletion retain inputs on ${encoding} Board`, async ({ page }) => {
    const board = encoding === "legacy" ? "household" : work
    const titleTask = await makeTask(board, "Original Table title")
    const deleteTask = await makeTask(board, "Original Table deletion")
    markup = tableMarkup([titleTask, deleteTask])
    await browser(page, board)
    await initTable(page)
    for (const task of [titleTask, deleteTask]) {
      const changed = await call(updateTask, "/api/tasks/" + task.id, board, { title: "Newer server " + task.id, updated_at: task.task_version }, "PUT", { id: task.id })
      expect(changed.status).toBe(200)
    }
    const title = page.locator(`.table-row[data-id="${titleTask.id}"] .editable-cell`)
    await title.fill("Retained Table proposal")
    await title.press("Tab")
    await expect(page.locator("#table-pending-edits")).toContainText("Retained Table proposal")
    await expect(title).toHaveText("Retained Table proposal")
    await page.locator(`.table-row[data-id="${deleteTask.id}"] .delete-row`).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
    await expect(page.locator("#table-pending-edits")).toContainText("Deletion not confirmed")
    expect(calls.find(call => call.method === "DELETE")?.body).toEqual({ version: deleteTask.task_version })
    expect((await load(titleTask.id, board)).title).toBe("Newer server " + titleTask.id)
    expect((await load(deleteTask.id, board)).title).toBe("Newer server " + deleteTask.id)
  })
}

test("Table bulk edits apply current rows and keep conflicted proposals without refreshing them away", async ({ page }) => {
  const first = await makeTask(work, "Current bulk row"), stale = await makeTask(work, "Stale bulk row")
  markup = tableMarkup([first, stale])
  await browser(page, work)
  await initTable(page)
  expect((await call(updateTask, "/api/tasks/" + stale.id, work, { title: "Changed outside Table", updated_at: stale.task_version }, "PUT", { id: stale.id })).status).toBe(200)
  await page.locator("#select-all").check()
  await page.locator("#bulk-priority").selectOption("1")
  await expect(page.locator("#table-pending-edits")).toContainText("priority: 1")
  expect((await load(first.id, work)).priority).toBe(1)
  expect((await load(stale.id, work)).priority).toBe(3)
  expect(calls.filter(call => call.method === "PUT").map(call => (call.body as { updated_at: number }).updated_at)).toEqual([first.task_version, stale.task_version])
})

test("Table pending deletion confirmation is cancelled by Board hiding and cannot resume", async ({ page }) => {
  const created = await makeTask(work, "Withheld Table row")
  markup = tableMarkup([created])
  await browser(page, work); await initTable(page)
  await page.locator(".delete-row").click()
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await page.evaluate(() => document.dispatchEvent(new Event("meitheal:board-hidden")))
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await page.evaluate(() => document.dispatchEvent(new Event("meitheal:board-verified")))
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(0)
  expect((await load(created.id, work)).title).toBe("Withheld Table row")
})

async function inspector(page: Page, id?: string) {
  const raw = await readFile(resolve(source, "components/tasks/TaskDetailModal.astro"), "utf8")
  const elements = [...raw.matchAll(/<([\w-]+)\b[^>]*\bid="(td-[^"]+)"/g)].map(match => [match[1]!, match[2]!] as const)
  await page.evaluate(elements => {
    document.body.insertAdjacentHTML("beforeend", `<div id="task-detail-overlay"><section id="task-detail-panel"><div id="td-loaded-content"><textarea id="td-title"></textarea><textarea id="td-description"></textarea><select id="td-status"></select><div id="td-sections"></div><div id="td-labels"></div><div id="td-cf-list"></div><button id="td-delete">Delete task</button></div><p id="td-load-error" role="alert" data-unavailable="This task is unavailable."></p></section></div>`)
    for (const [tag, id] of elements) if (!document.getElementById(id)) {
      const node = document.createElement(tag); node.id = id; document.getElementById("td-sections")!.append(node)
    }
    document.getElementById("td-close")!.textContent = "Close detail"
  }, elements)
  await page.evaluate(async id => {
    const url = "/lib/task-modal-controller"; await import(url); document.dispatchEvent(new Event("astro:page-load"))
    if (id) await window.openTaskDetail?.(id)
  }, id)
}
for (const event of ["meitheal:board-hidden", "meitheal:board-revoked"]) {
  test(`Inspector pending confirmation aborts on ${event} and cannot replay`, async ({ page }) => {
    const created = await makeTask(work, "Inspector cancellation")
    await browser(page, work); await inspector(page, created.id)
    await expect(page.locator("#td-title")).toHaveValue("Inspector cancellation")
    await page.locator("#td-delete").click()
    await expect(page.getByRole("alertdialog")).toBeVisible()
    await page.evaluate(event => document.dispatchEvent(new Event(event)), event)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await page.evaluate(() => document.dispatchEvent(new Event("meitheal:board-verified")))
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(0)
    expect((await load(created.id, work)).title).toBe("Inspector cancellation")
    if (event === "meitheal:board-hidden") {
      await page.locator("#td-delete").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete Task", exact: true }).click()
      await expect.poll(() => calls.filter(call => call.method === "DELETE").length).toBe(1)
      expect(calls.find(call => call.method === "DELETE")?.body).toEqual({ version: created.task_version })
      await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    } else await expect(page.locator("#task-detail-overlay")).toBeHidden()
  })
}
for (const encoding of ["legacy", "ordinary"] as const) {
  test(`Legacy ticket query opens the common inspector on ${encoding} Board and closes cleanly`, async ({ page }) => {
    const board = encoding === "legacy" ? "household" : work
    const created = await makeTask(board, "Legacy ticket alias")
    await browser(page, board)
    await page.evaluate(({ board, id }) => history.replaceState({}, "", `/boards/${board}?ticket=${id}`), { board, id: created.id })
    await inspector(page)
    await expect(page.locator("#td-title")).toHaveValue("Legacy ticket alias")
    expect(calls.find(call => call.path === `/api/tasks/${created.id}`)?.board).toBe(board)
    await page.getByRole("button", { name: "Close detail", exact: true }).click()
    expect(new URL(page.url()).searchParams.has("ticket")).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")))
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
  })
}
test("A foreign legacy ticket query stays opaque in the selected Board", async ({ page }) => {
  const created = await makeTask("household", "Private foreign alias title")
  await browser(page, work, `ticket=${created.id}`); await inspector(page)
  await expect(page.locator("#td-load-error")).toContainText("This task is unavailable.")
  await expect(page.locator("#td-title")).not.toHaveValue("Private foreign alias title")
  expect(calls.find(call => call.path === `/api/tasks/${created.id}`)?.board).toBe(work)
})

test("Eisenhower delegates a unique verified directory name using its real identity ID", async ({ page }) => {
  const response = await call(customUser, "/api/users/custom", work, { name: "Garden Agent", kind: "agent" })
  expect(response.status, await response.clone().text()).toBe(201)
  const assignee = await response.json()
  const created = await makeTask(work, "Delegate this task")
  markup = `<section id="eisenhower-shell"><section data-quadrant="delegate"><div data-drop-zone><article class="tli" data-id="${created.id}" data-status="pending"></article></div><div class="quadrant__action-bar"><button data-action="assign-q3">Assign delegate tasks</button></div></section></section>`
  await browser(page, work)
  await page.evaluate(async () => { const url = "/lib/eisenhower-controller"; (await import(url)).initEisenhowerPage({ signal: new AbortController().signal }) })
  await page.getByRole("button", { name: "Assign delegate tasks" }).click()
  await page.locator("#prompt-input").fill("Garden Agent")
  const saved = page.waitForResponse(response => response.request().method() === "PUT")
  await page.locator("#prompt-ok").click()
  expect((await saved).status()).toBe(200)
  await expect.poll(() => calls.filter(call => call.method === "PUT").length).toBe(1)
  expect((calls.find(call => call.method === "PUT")?.body as { assigned_to: string }).assigned_to).toBe(assignee.id)
  expect((await load(created.id, work)).assigned_to).toBe(assignee.id)
})
test("Eisenhower unknown assignee does not send a Task mutation", async ({ page }) => {
  const created = await makeTask(work, "Keep unassigned")
  markup = `<section id="eisenhower-shell"><section data-quadrant="delegate"><div data-drop-zone><article class="tli" data-id="${created.id}" data-status="pending"></article></div><div class="quadrant__action-bar"><button data-action="assign-q3">Assign delegate tasks</button></div></section></section>`
  await browser(page, work)
  await page.evaluate(async () => { const url = "/lib/eisenhower-controller"; (await import(url)).initEisenhowerPage({ signal: new AbortController().signal }) })
  await page.getByRole("button", { name: "Assign delegate tasks" }).click()
  await page.locator("#prompt-input").fill("Nobody with this name")
  await page.locator("#prompt-ok").click()
  await expect(page.locator("body")).toContainText("No eligible assignee")
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(0)
  expect((await load(created.id, work)).assigned_to).toBeNull()
})
for (const encoding of ["legacy", "ordinary"] as const) {
  test(`Triage filters the actual scoped backlog by Area and unfiled Project: ${encoding}`, async () => {
    const board = encoding === "legacy" ? "household" : work
    await runWithIngressTransport(transport, async () => {
      const resolved = await resolveBoardRequestScope(context(new Request(origin + "/triage", { headers: { "x-meitheal-board-id": board } })), { operation: { resource: "task", action: "read" } })
      if (!resolved.ok) throw new Error("Actual selected Board scope required")
      const hierarchy = new HierarchyRepository(getPersistenceClient(), resolved.scope)
      await hierarchy.createArea({ id: "yard", name: "Yard" }); await hierarchy.createArea({ id: "kitchen", name: "Kitchen" })
      expect(await hierarchy.createProject({ id: "unfiled-triage", title: "Unfiled Triage Project", area_id: null })).toBe(true)
      const yard = await makeTask(board, "Yard backlog", { status: "backlog", area_id: "yard" })
      await makeTask(board, "Kitchen backlog", { status: "backlog", area_id: "kitchen" })
      const unfiled = await makeTask(board, "Project backlog", { status: "backlog", project_id: "unfiled-triage", area_id: null })
      const repo = new TaskRepository(getPersistenceClient(), resolved.scope)
      for (const [query, id] of [["area_id=yard", yard.id], ["project_id=unfiled-triage", unfiled.id]]) {
        const placement = await readBoardPagePlacement(resolved.scope, new URL(origin + "/triage?" + query))
        if (!placement.ok) throw new Error("Selected placement required")
        const backlog = await repo.findBacklogPage(1, placement.placement)
        expect(backlog?.total).toBe(1)
        expect(backlog?.tasks.map(task => task.id)).toEqual([id])
        const links = boardNavigationLinks({ boardId: board, ...(placement.area ? { area: placement.area.id } : {}), ...(placement.project ? { project: placement.project.id } : {}) })
        expect(new URL(links.tasks, origin).searchParams.get(query.split("=")[0]!.replace("_id", ""))).toBe(query.split("=")[1])
      }
    })
  })
}

test("Kanban refresh recovers the exact static status header in its original lane", async ({ page }) => {
  markup = `<div id="kanban-board"><section class="kanban-column" data-lane-id="first"><button class="kanban-column-header">First lane</button><div class="swimlane-group" data-swimlane-type="pending"><button class="swimlane-header">First pending</button></div></section><section class="kanban-column" data-lane-id="second"><button class="kanban-column-header">Second lane</button><div class="swimlane-group" data-swimlane-type="pending"><button class="swimlane-header">Second pending</button></div></section></div>`
  await browser(page, work)
  await page.evaluate(async () => {
    const url = "/lib/controllers/kanban-page-controller", { findGroupFocus } = await import(url)
    const board = document.getElementById("kanban-board")!, group = board.querySelector<HTMLElement>(".kanban-column[data-lane-id=second] .swimlane-group")!
    const target = findGroupFocus(board, group); target?.focus()
  })
  await expect(page.getByRole("button", { name: "Second pending" })).toBeFocused()
})
test("Kanban gives masked and unfiled Areas the same neutral group while retaining the real default Area", async ({ page }) => {
  markup = `<div id="kanban-board" data-group-by="area" data-no-area-label="No area"><section class="kanban-column"><div class="kanban-cards"><article class="flat-card" data-area="">Unfiled task</article><article class="flat-card" data-area="hidden-area">Masked task</article><article class="flat-card" data-area="default" data-area-name="My real Area">Real default ID task</article></div></section></div>`
  await browser(page, work)
  await page.evaluate(async () => { const url = "/lib/controllers/kanban-grouping"; (await import(url)).initKanbanGrouping(document.getElementById("kanban-board"), new AbortController().signal) })
  const neutral = page.locator(".swimlane-group").filter({ has: page.getByRole("button", { name: /No area/ }) })
  await expect(neutral).toContainText("Unfiled task"); await expect(neutral).toContainText("Masked task")
  await expect(page.locator(".swimlane-group").filter({ has: page.getByRole("button", { name: /My real Area/ }) })).toContainText("Real default ID task")
  await expect(page.locator(".swimlane-group")).toHaveCount(2)
})

test("Sidebar task shortcuts retain the server-admitted Board when the daily URL omits a Board selector", async ({ page }) => {
  markup = `<aside id="sidebar" class="sidebar"><a class="nav-link" data-task-view-link="table">Table</a></aside>`
  await browser(page, work)
  await page.evaluate(() => history.replaceState({}, "", "/today"))
  await page.evaluate(async () => { const url = "/components/layout/sidebar-nav-inline"; await import(url); document.dispatchEvent(new Event("astro:page-load")) })
  const href = new URL((await page.locator("[data-task-view-link=table]").getAttribute("href"))!, origin)
  expect(href.pathname).toBe(`/boards/${work}`)
  expect(href.searchParams.get("view")).toBe("table")
})
test("Table bulk deletion removes confirmed rows and retains a conflicted row with its loaded version", async ({ page }) => {
  const first = await makeTask(work, "Confirmed bulk deletion"), stale = await makeTask(work, "Unconfirmed bulk deletion")
  markup = tableMarkup([first, stale])
  await browser(page, work); await initTable(page)
  expect((await call(updateTask, "/api/tasks/" + stale.id, work, { title: "A newer saved title", updated_at: stale.task_version }, "PUT", { id: stale.id })).status).toBe(200)
  await page.locator("#select-all").check(); await page.locator("#bulk-delete").click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.locator("#table-pending-edits")).toContainText("Deletion not confirmed")
  await expect(page.locator(`.table-row[data-id="${first.id}"]`)).toHaveCount(0)
  await expect(page.locator(`.table-row[data-id="${stale.id}"]`)).toHaveCount(1)
  expect(calls.filter(call => call.method === "DELETE").map(call => call.body)).toEqual([{ version: first.task_version }, { version: stale.task_version }])
  expect((await load(stale.id, work)).title).toBe("A newer saved title")
})
test("Table successive edits advance the loaded version before the next canonical write", async ({ page }) => {
  const created = await makeTask(work, "Sequential row")
  markup = tableMarkup([created])
  await browser(page, work); await initTable(page)
  const title = page.locator(".editable-cell")
  const firstResponse = page.waitForResponse(response => response.request().method() === "PUT")
  await title.fill("First edit"); await title.press("Tab")
  const firstSaved = await (await firstResponse).json()
  await expect(title).toHaveAttribute("data-original", "First edit")
  const secondResponse = page.waitForResponse(response => response.request().method() === "PUT")
  await page.locator(".inline-select").selectOption("active")
  expect((await secondResponse).status()).toBe(200)
  expect(calls.filter(call => call.method === "PUT").map(call => (call.body as { updated_at: number }).updated_at)).toEqual([created.task_version, firstSaved.task_version])
  expect((await load(created.id, work)).status).toBe("active")
})
test("Eisenhower ambiguous persisted directory names require an exact identity and do not mutate Tasks", async ({ page }) => {
  const agents: Array<{ id: string }> = []
  for (const name of ["Garden one", "Garden two"]) {
    const response = await call(customUser, "/api/users/custom", work, { name, kind: "agent" })
    expect(response.status).toBe(201); agents.push(await response.json())
  }
  // A retained/imported catalog can contain duplicate display names even though creation prevents them.
  await getPersistenceClient().execute({ sql: "UPDATE custom_users SET name = ? WHERE id = ?", args: ["Garden one", agents[1]!.id] })
  const created = await makeTask(work, "Ambiguous delegate")
  markup = `<section id="eisenhower-shell"><section data-quadrant="delegate"><div data-drop-zone><article class="tli" data-id="${created.id}" data-status="pending"></article></div><div class="quadrant__action-bar"><button data-action="assign-q3">Assign delegate tasks</button></div></section></section>`
  await browser(page, work)
  await page.evaluate(async () => { const url = "/lib/eisenhower-controller"; (await import(url)).initEisenhowerPage({ signal: new AbortController().signal }) })
  await page.getByRole("button", { name: "Assign delegate tasks" }).click()
  await page.locator("#prompt-input").fill("Garden one"); await page.locator("#prompt-ok").click()
  await expect(page.locator("body")).toContainText("More than one assignee")
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(0)
  expect((await load(created.id, work)).assigned_to).toBeNull()
})
test("Kanban Project qualifiers reuse only the current safe inherited Area metadata", async () => {
  await runWithIngressTransport(transport, async () => {
    const resolved = await resolveBoardRequestScope(context(new Request(origin + "/boards/" + work)), { operation: { resource: "task", action: "read" }, boardId: work })
    if (!resolved.ok) throw new Error("Actual selected Board required")
    const repo = new HierarchyRepository(getPersistenceClient(), resolved.scope)
    await repo.createArea({ id: "yard-label", name: "Yard" })
    expect(await repo.createGoal({ id: "garden-goal", title: "Garden Goal", area_id: "yard-label" })).toBe(true)
    expect(await repo.createProject({ id: "garden-project", title: "Maintenance", area_id: null, goal_id: "garden-goal" })).toBe(true)
    expect(await repo.createProject({ id: "unfiled-project", title: "Maintenance", area_id: null })).toBe(true)
    const projects = await repo.findProjectGroups()
    const labels = getHouseholdProjectLabels(projects.map(project => ({ ...project, area_id: project.label_area_id })), { "yard-label": "Yard" })
    expect(labels["project-garden-project"]?.qualifier).toContain("Yard")
    expect(labels["project-unfiled-project"]?.qualifier).not.toContain("Yard")
  })
})
