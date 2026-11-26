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
import { POST as createArea } from "../../apps/web/src/pages/api/areas/index"
import { POST as createProject } from "../../apps/web/src/pages/api/projects/index"
import { POST as manageRoutine } from "../../apps/web/src/pages/api/habits"
import { GET as routineLibrary } from "../../apps/web/src/pages/api/boards/routines"
import { POST as planning } from "../../apps/web/src/pages/api/boards/[id]/planning"
import { readBoardPagePlacement } from "../../apps/web/src/lib/board-page-placement"
import { boardNavigationLinks } from "../../apps/web/src/lib/board-workspace"

type APIContext = Parameters<typeof createTask>[0]
// These routed module origins use the browser Origin, not the unrelated App-server fixture Origin.
test.use({ extraHTTPHeaders: {} })

const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
const origin = "http://127.0.0.1:8930"
const source = resolve(import.meta.dirname, "../../apps/web/src")
const ts = createRequire(import.meta.url)("../../apps/web/node_modules/typescript/lib/typescript.js")
let directory: string, session: string, work: string
let previous: string | undefined
let beforeVerify: (() => Promise<void>) | undefined
let calls: Array<{ method: string; path: string; board: string | null; body: unknown }>
function context(request: Request, params = {}): APIContext {
  return { request, url: new URL(request.url), params, locals: {} } as APIContext
}
async function call(route: typeof createTask, path: string, board: string, body?: unknown, method = "POST", params = {}) {
  const request = new Request(origin + path, { method, headers: { "content-type": "application/json", "x-meitheal-board-id": board, "x-meitheal-board-session": session },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return runWithIngressTransport(transport, () => route(context(request, params)))
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
        : url.pathname === "/api/tasks" && request.method() === "POST" ? createTask
        : url.pathname === "/api/boards/routines" ? routineLibrary : boardMatch ? planning : verifyMatch ? verifyBoard : null
      if (!handler) return route.fulfill({ status: 404 })
      const response = await runWithIngressTransport(transport, () => handler(context(webRequest, { ...(taskMatch ? { id: taskMatch[1] } : {}), ...(boardMatch ? { id: boardMatch[1] } : {}), ...(verifyMatch ? { id: verifyMatch[1] } : {}) })))
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    }
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
    if (url.pathname.startsWith("/package-strategy/")) {
      const filename = url.pathname.slice("/package-strategy/".length)
      if (!/^[\w-]+$/.test(filename)) return route.fulfill({ status: 404 })
      const raw = await readFile(resolve(import.meta.dirname, "../../packages/domain-strategy/src", filename + ".ts"), "utf8")
      return route.fulfill({ contentType: "text/javascript", body: ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText })
    }
    if (url.pathname === "/sortablejs") return route.fulfill({
      contentType: "text/javascript",
      body: await readFile(resolve(source, "../node_modules/sortablejs/modular/sortable.esm.js"), "utf8"),
    })
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
        .replaceAll('"@meitheal/domain-strategy"', '"/package-strategy/index"')
        .replaceAll('"sortablejs"', '"/sortablejs"')
        .replaceAll('"@tabler/core/js/src/bootstrap/modal"', '"/tabler/modal"')
        .replaceAll("import.meta.env", '{ DEV: false, PROD: true }')
      return route.fulfill({ contentType: "text/javascript", body: compiled })
    }
    const placement = new URLSearchParams(query)
    placement.set("board_id", board)
    const markup = `<meta name="meitheal-work-board" content="${board}"><meta name="meitheal-work-session" content="${session}"><meta name="meitheal-work-actor" content="actual-fixture-actor"><textarea id="local-input">Retained local input</textarea>${widget ? `<section data-board-routine-checkins data-board-id="${board}" data-routine-query="${placement}" hidden><ul data-board-routine-list></ul><p data-board-routine-feedback></p><p data-board-routine-more hidden></p></section>` : ""}`
    return route.fulfill({ contentType: "text/html", body: markup })
  })
  await page.goto(origin + "/today?board_id=" + board + (query ? "&" + query : ""))
}
for (const encoding of ["legacy", "ordinary"] as const) {
  test(`shared browser writer keeps normalized ISO versions and stale input on ${encoding} storage`, async ({ page }) => {
    const board = encoding === "legacy" ? "household" : work
    const created = await task(board)
    const iso = "2026-11-18T12:34:56.789Z"
    await getPersistenceClient().execute({ sql: "UPDATE tasks SET updated_at=? WHERE id=?", args: [iso, created.id] })
    const readerA = await load(created.id, board)
    expect(readerA.task_version).toBe(Date.parse(iso))
    const readerB = await call(updateTask, "/api/tasks/" + created.id, board, { description: "Saved by another reader", updated_at: readerA.task_version }, "PUT", { id: created.id })
    expect(readerB.status).toBe(200)
    const current = await readerB.json()
    await browser(page, board)
    const stale = await page.evaluate(async ({ id, version }) => {
      const url = "/lib/task-api-client"
      const { saveVersionedTask } = await import(url)
      const fields = { description: document.querySelector<HTMLTextAreaElement>("#local-input")!.value }
      return saveVersionedTask(id, fields, version)
    }, { id: created.id, version: readerA.task_version })
    expect(stale).toEqual({
      ok: false, status: 409, errorCode: "conflict",
      message: "Conflict: task was modified since your last read",
    })
    await expect(page.locator("#local-input")).toHaveValue("Retained local input")
    expect((await load(created.id, board)).description).toBe("Saved by another reader")
    const saved = await page.evaluate(async ({ id, version }) => {
      const url = "/lib/task-api-client"
      const { saveVersionedTask } = await import(url)
      const first = await saveVersionedTask(id, { description: "Reviewed saved state" }, version)
      if (!first.ok) return first
      return saveVersionedTask(id, { title: "Next confirmed edit" }, first.version)
    }, { id: created.id, version: current.task_version })
    expect(saved.ok).toBe(true)
    expect((await load(created.id, board)).title).toBe("Next confirmed edit")
    expect(calls.every(call => call.board === board)).toBe(true)
  })
}

test("a Board switch withholds a confirmed browser save from the previous context", async ({ page }) => {
  const created = await task(work)
  await browser(page, work)
  const result = await page.evaluate(async ({ id, version }) => {
    const url = "/lib/task-api-client"
    const { saveVersionedTask } = await import(url)
    const original = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const response = await original(...args)
      document.querySelector<HTMLMetaElement>('[name="meitheal-work-board"]')!.content = "household"
      return response
    }
    return saveVersionedTask(id, { title: "Committed only to original Board" }, version)
  }, { id: created.id, version: created.task_version })
  expect(result).toEqual({ ok: false, status: 200, errorCode: "unavailable" })
  expect(calls[0]?.board).toBe(work)
  expect((await load(created.id, work)).title).toBe("Committed only to original Board")
})

test("selected Project Routine check-ins use the selected Board and real current human proof", async ({ page }) => {
  const project = await call(createProject, "/api/projects", work, { title: "Unfiled Project" })
  expect(project.status).toBe(201)
  const projectId = (await project.json()).id
  let selectedTaskId: string | undefined
  for (const [board, name, selectedProject] of [["household", "Capture default routine", null], [work, "Work other routine", null], [work, "Selected Project routine", projectId]]) {
    const result = await call(manageRoutine, "/api/habits", board!, { action: "create", name, project_id: selectedProject })
    expect(result.status, await result.clone().text()).toBe(201)
    if (selectedProject) selectedTaskId = (await result.json()).taskId
  }
  await browser(page, work, "project_id=" + projectId, true)
  await page.evaluate(async () => {
    const url = "/lib/controllers/board-routine-checkins"
    const { setupBoardRoutineCheckins } = await import(url)
    setupBoardRoutineCheckins(new AbortController().signal)
  })
  const section = page.locator("[data-board-routine-checkins]")
  await expect(section).toContainText("Selected Project routine")
  await expect(section).not.toContainText("Capture default routine")
  await expect(section).not.toContainText("Work other routine")
  await section.getByRole("button", { name: "Mark Selected Project routine done", exact: true }).click()
  await expect(section).toContainText("Done")
  expect(calls.filter(call => call.path.includes("/api/boards/")).every(call => call.board === work)).toBe(true)
  expect(calls.some(call => call.method === "POST" && call.path === `/api/boards/${work}/planning`)).toBe(true)
  const occurrences = (await getPersistenceClient().execute(
    "SELECT id, status FROM tasks WHERE source_template_id IS NOT NULL",
  )).rows
  expect(occurrences).toHaveLength(3)
  expect(occurrences.filter(row => row.status !== "pending")).toEqual([
    { id: selectedTaskId, status: "complete" },
  ])
  expect(await load(selectedTaskId!, work)).toMatchObject({ project_id: projectId })
})

test("unfiled Project links, receiving placement validation and capture retain the original Project", async ({ page }) => {
  const created = await call(createProject, "/api/projects", work, { title: "Unfiled Project" })
  expect(created.status).toBe(201)
  const project = await created.json()
  const links = boardNavigationLinks({ boardId: work, project: project.id })
  for (const path of [links.pillars, links.today, links.dashboard, links.upcoming]) {
    const selected = new URL(path, origin)
    expect(selected.searchParams.get("project_id")).toBe(project.id)
    const result = await runWithIngressTransport(transport, async () => {
      const request = new Request(selected, { headers: { "x-meitheal-board-id": work } })
      const resolved = await resolveBoardRequestScope(context(request), { operation: { resource: "task", action: "read" } })
      if (!resolved.ok) throw new Error("Current selected Board scope required")
      return readBoardPagePlacement(resolved.scope, selected)
    })
    expect(result).toMatchObject({ ok: true, placement: { projectId: project.id }, project: { id: project.id } })
    expect(result.ok && result.area).toBeUndefined()
  }
  expect(new URL(links.tasks, origin).searchParams.get("project")).toBe(project.id)
  await browser(page, work, "project_id=" + project.id)
  const placement = await page.evaluate(async () => {
    const url = "/lib/task-capture-placement"
    return (await import(url)).taskCapturePlacement()
  })
  expect(placement).toEqual({ areaId: null, projectId: project.id })
})

for (const encoding of ["legacy", "ordinary"] as const) {
  test(`browser deletion protects a changed task and only deletes its reviewed version on ${encoding} storage`, async ({ page }) => {
    const board = encoding === "legacy" ? "household" : work
    const created = await task(board)
    await browser(page, board)
    const changed = await call(updateTask, "/api/tasks/" + created.id, board, { title: "Someone else updated this task", updated_at: created.task_version }, "PUT", { id: created.id })
    expect(changed.status).toBe(200)
    const stale = await page.evaluate(async ({ id, version }) => {
      const url = "/lib/task-api-client"
      return (await import(url)).deleteVersionedTask(id, version)
    }, { id: created.id, version: created.task_version })
    expect(stale).toEqual({ ok: false, status: 409, errorCode: "conflict" })
    await expect(page.locator("#local-input")).toHaveValue("Retained local input")
    expect((await load(created.id, board)).title).toBe("Someone else updated this task")
    const forbidden = await call(deleteTask, "/api/tasks/" + created.id, board, { version: (await load(created.id, board)).task_version, board_id: "household" }, "DELETE", { id: created.id })
    expect(forbidden.status).toBe(404)
    const current = await load(created.id, board)
    const deleted = await page.evaluate(async ({ id, version }) => {
      const url = "/lib/task-api-client"
      return (await import(url)).deleteVersionedTask(id, version)
    }, { id: created.id, version: current.task_version })
    expect(deleted).toEqual({ ok: true })
    expect(calls.filter(call => call.method === "DELETE").map(call => call.body)).toEqual([{ version: created.task_version }, { version: current.task_version }])
    const absent = await call(readTask, "/api/tasks/" + created.id, board, undefined, "GET", { id: created.id })
    expect(absent.status).toBe(404)
  })
}

const quickModal = `<template id="preferred-quick-add-template"><div><div class="modal" id="workspace-quick-add" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><form id="workspace-quick-add-form"><input name="title"><p data-quick-add-error data-rejected="Rejected" data-uncertain="Unconfirmed" hidden></p><p data-quick-add-saving hidden>Saving</p><button type="submit">Save quick task</button><button type="button" data-quick-add-full>Full form</button></form></div></div></div></div></template>`

for (const alias of ["", "project", "project_id"] as const) {
  test(`preferred quick capture preserves ordinary Board and ${alias || "unfiled"} placement`, async ({ page }) => {
    const project = await call(createProject, "/api/projects", work, { title: "Unfiled quick Project" })
    expect(project.status).toBe(201)
    const projectId = (await project.json()).id
    await browser(page, work, alias ? alias + "=" + projectId : "")
    await page.evaluate(markup => {
      document.documentElement.dataset.workspaceScope = "browser"
      localStorage.setItem("meitheal-workspace-v1:browser", JSON.stringify({ capture: "quick" }))
      document.body.insertAdjacentHTML("beforeend", markup)
    }, quickModal)
    expect(await page.evaluate(async () => {
      const url = "/lib/open-workspace-capture"
      return (await import(url)).openWorkspaceQuickAdd(undefined, () => { throw new Error("Quick capture unexpectedly fell back") })
    })).toBe(true)
    const modal = page.locator("#workspace-quick-add.show")
    await expect(modal).toBeVisible()
    await modal.locator("input").fill("Ordinary quick task")
    await modal.getByRole("button", { name: "Save quick task" }).click()
    await expect(modal).toHaveCount(0)
    const posted = calls.find(call => call.method === "POST" && call.path === "/api/tasks")
    expect(posted).toMatchObject({ board: work, body: { title: "Ordinary quick task", area_id: null, project_id: alias ? projectId : null } })
    const rows = (await getPersistenceClient().execute("SELECT id,title FROM tasks")).rows
    expect(rows).toHaveLength(1)
    expect(await load(String(rows[0]!.id), work)).toMatchObject({ title: "Ordinary quick task", area_id: null, project_id: alias ? projectId : null })
  })
}

test("Dashboard quick capture and queue navigation retain the selected unfiled Project", async ({ page }) => {
  const created = await call(createProject, "/api/projects", work, { title: "Focused Project" })
  const project = (await created.json()).id
  await browser(page, work, "project_id=" + project)
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", `<main id="dashboard-shell"><section data-dashboard-section><form id="quick-add-form"><input id="quick-title"><button type="submit">Quick task</button></form><div id="task-list"></div><select id="my-open-user-filter"><option value="all">All</option><option value="__unassigned__">Unassigned</option></select><div id="my-open-list" data-available="true"></div><a id="kanban-link" href="/tasks">Kanban</a></section></main>`)
  })
  await page.evaluate(async () => { const url = "/lib/dashboard-controller"; await import(url) })
  await page.locator("#my-open-user-filter").selectOption("__unassigned__")
  const href = new URL(await page.locator("#kanban-link").getAttribute("href") || "", origin)
  expect(href.pathname).toBe("/boards/" + work)
  expect(href.searchParams.get("project")).toBe(project)
  expect(href.searchParams.get("user")).toBe("__unassigned__")
  await page.locator("#quick-title").fill("Dashboard Project task")
  await page.getByRole("button", { name: "Quick task", exact: true }).click()
  await expect.poll(() => calls.filter(call => call.method === "POST").length).toBe(1)
  await expect.poll(async () => Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(1)
  expect(calls.find(call => call.method === "POST")).toMatchObject({ board: work, body: { area_id: null, project_id: project } })
})

for (const key of ["d", "y", "u"] as const) {
  test(`keyboard ${key} retains selected Board and unfiled Project`, async ({ page }) => {
    const created = await call(createProject, "/api/projects", work, { title: "Keyboard Project" })
    const projectId = (await created.json()).id
    await browser(page, work, "project_id=" + projectId)
    await page.evaluate(async () => {
      const url = "/lib/layout-controller"
      await import(url)
      document.dispatchEvent(new Event("astro:page-load"))
    })
    await page.keyboard.press(key)
    await expect(page).toHaveURL(url => url.pathname === ({ d: "/", y: "/today", u: "/upcoming" }[key]) && url.searchParams.get("board_id") === work && url.searchParams.get("project_id") === projectId)
  })
}

test("Timeline proposed dates survive reconnection verification and clear on proven revocation", async ({ page }) => {
  const created = await task(work)
  const authority = await call(verifyBoard, `/api/boards/${work}?view=authority`, work, undefined, "HEAD", { id: work })
  expect(authority.status).toBe(200)
  const key = authority.headers.get("x-meitheal-board-authority")
  expect(key).toBeTruthy()
  await browser(page, work)
  await page.evaluate(({ task, board, session, key }) => {
    const root = document.createElement("main")
    root.id = "actual-board"
    Object.assign(root.dataset, { boardKey: key, boardAuthority: key, boardVerify: `/api/boards/${board}?view=authority`, boardSession: session, boardId: board })
    root.innerHTML = `<div id="gantt-chart" style="height:500px;width:1000px"></div><script id="timeline-data" type="application/json"></script>`
    root.querySelector("#timeline-data")!.textContent = JSON.stringify([task])
    document.body.append(root)
    const status = document.createElement("div")
    status.dataset.layoutBoardExpired = ""
    status.hidden = true
    status.textContent = "This Board is unavailable."
    document.body.append(status)
  }, { task: created, board: work, session, key: key! })
  await page.evaluate(async () => {
    const timeline = "/lib/timeline-controller", verifier = "/lib/boards-page"
    const signal = new AbortController().signal
    ;(await import(timeline)).initTimelineController(signal)
    ;(await import(verifier)).bindBoardPage(signal, document.getElementById("actual-board"))
  })
  const concurrent = await call(updateTask, "/api/tasks/" + created.id, work, { title: "Concurrent Timeline change", updated_at: created.task_version }, "PUT", { id: created.id })
  expect(concurrent.status).toBe(200)
  await page.locator(".gantt-vrow .idp-container").first().click()
  await page.getByRole("dialog", { name: "Choose date" }).getByRole("button", { name: /Tomorrow/ }).click()
  const proposed = page.locator("#timeline-pending-edits")
  await expect(proposed).toContainText("Concurrent task")
  const dates = await proposed.textContent()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  beforeVerify = () => held
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"))
    window.dispatchEvent(new Event("online"))
  })
  await expect(page.locator("#actual-board")).toHaveCount(0)
  await expect(proposed).toHaveCount(0)
  release()
  beforeVerify = undefined
  await expect(page.locator("#actual-board")).toHaveCount(1)
  await expect(proposed).toHaveText(dates!)
  expect((await load(created.id, work)).title).toBe("Concurrent Timeline change")
  const currentBoard = await call(verifyBoard, `/api/boards/${work}`, work, undefined, "GET", { id: work })
  expect(currentBoard.status).toBe(200)
  const revision = (await currentBoard.json()).board.revision
  const retired = await call(updateBoard, `/api/boards/${work}`, work, { action: "retire", revision }, "PATCH", { id: work })
  expect(retired.status, await retired.clone().text()).toBe(200)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.locator("[data-layout-board-expired]")).toBeVisible()
  await expect(proposed).toHaveCount(0)
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<div id="gantt-chart"></div>')
    document.dispatchEvent(new Event("meitheal:board-verified"))
  })
  await expect(proposed).toHaveCount(0)
})

test("the actual inspector keeps stale deletion input and sends its loaded version", async ({ page }) => {
  const created = await task(work)
  await browser(page, work)
  const inspector = await readFile(resolve(source, "components/tasks/TaskDetailModal.astro"), "utf8")
  const inspectorElements = [...inspector.matchAll(/<([\w-]+)\b[^>]*\bid="(td-[^"]+)"/g)].map(match => [match[1]!, match[2]!] as const)
  await page.evaluate(elements => {
    document.body.insertAdjacentHTML("beforeend", `<div id="task-detail-overlay"><section id="task-detail-panel"><div id="td-loaded-content"><textarea id="td-title"></textarea><textarea id="td-description"></textarea><select id="td-status"></select><div id="td-sections"></div><div id="td-labels"></div><div id="td-cf-list"></div><button id="td-delete">Delete task</button></div><p id="td-load-error"></p></section></div>`)
    for (const [tag, id] of elements) {
      // Reactions render a separate component with its own markup; this fixture exercises deletion.
      if (id === "td-task-reactions" || document.getElementById(id)) continue
      const node = document.createElement(tag)
      node.id = id
      document.getElementById("td-sections")!.append(node)
    }
  }, inspectorElements)
  await page.evaluate(async id => {
    const url = "/lib/task-modal-controller"
    await import(url)
    document.dispatchEvent(new Event("astro:page-load"))
    await window.openTaskDetail?.(id)
  }, created.id)
  await expect(page.locator("#td-title")).toHaveValue("Concurrent task")
  const changed = await call(updateTask, "/api/tasks/" + created.id, work, { title: "Newer shared work", updated_at: created.task_version }, "PUT", { id: created.id })
  expect(changed.status).toBe(200)
  await page.locator("#td-description").evaluate((input: HTMLTextAreaElement) => { input.value = "Unsaved description retained" })
  await page.locator("#td-delete").click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete Task", exact: true }).click()
  await expect(page.locator("#td-write-conflict")).toBeVisible()
  await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
  await expect(page.locator("#td-description")).toHaveValue("Unsaved description retained")
  expect(calls.find(call => call.method === "DELETE")?.body).toEqual({ version: created.task_version })
  expect((await load(created.id, work)).title).toBe("Newer shared work")
})

test("Sidebar Project selection ignores incidental Area aliases and still requires the exact Board and Project", async ({ page }) => {
  const areaResponse = await call(createArea, "/api/areas", work, { name: "Sidebar Area" })
  expect(areaResponse.status).toBe(201)
  const area = (await areaResponse.json()).id
  const projectResponse = await call(createProject, "/api/projects", work, { title: "Selected sidebar Project", area_id: area })
  expect(projectResponse.status).toBe(201)
  const project = (await projectResponse.json()).id
  await browser(page, work)
  await page.evaluate(({ board, area, project }) => {
    history.replaceState({}, "", `/boards/${board}?project=${project}&from=${area}&area=${area}#kanban`)
    document.body.insertAdjacentHTML("beforeend", `<aside id="sidebar" class="sidebar"><div data-sidebar-board-children><a id="selected-project" class="nav-link" href="/boards/${board}?project=${project}&from=${area}">Selected Project</a><a id="selected-area" class="nav-link" href="/boards/${board}?area=${area}">Area</a><a id="other-project" class="nav-link" href="/boards/${board}?project=other-project&from=${area}">Other Project</a><a id="other-board" class="nav-link" href="/boards/household?project=${project}&from=${area}">Other Board</a></div></aside>`)
  }, { board: work, area, project })
  await page.evaluate(async () => {
    const url = "/components/layout/sidebar-nav-inline"
    await import(url)
    document.dispatchEvent(new Event("astro:page-load"))
  })
  await expect(page.locator("#selected-project")).toHaveAttribute("aria-current", "page")
  await expect(page.locator('#selected-area[aria-current="page"], #other-project[aria-current="page"], #other-board[aria-current="page"]')).toHaveCount(0)
  expect(await page.locator("#sidebar [aria-current=page]").count()).toBe(1)
  await page.evaluate(({ board, area }) => {
    history.replaceState({}, "", `/boards/${board}?area=${area}#kanban`)
    document.dispatchEvent(new Event("meitheal:task-view-location-changed"))
  }, { board: work, area })
  await expect(page.locator("#selected-area")).toHaveAttribute("aria-current", "page")
  await expect(page.locator("#selected-project")).not.toHaveAttribute("aria-current", "page")
  expect(await page.locator("#sidebar [aria-current=page]").count()).toBe(1)
})
