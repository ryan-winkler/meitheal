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
import { GET as readTask, PUT as updateTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { POST as createProject } from "../../apps/web/src/pages/api/projects/index"
import { POST as manageRoutine } from "../../apps/web/src/pages/api/habits"
import { GET as routineLibrary } from "../../apps/web/src/pages/api/boards/routines"
import { POST as planning } from "../../apps/web/src/pages/api/boards/[id]/planning"
import { readBoardPagePlacement } from "../../apps/web/src/lib/board-page-placement"
import { boardNavigationLinks } from "../../apps/web/src/lib/board-workspace"

type APIContext = Parameters<typeof createTask>[0]
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
const origin = "http://127.0.0.1:8930"
const source = resolve(import.meta.dirname, "../../apps/web/src")
const ts = createRequire(import.meta.url)("../../apps/web/node_modules/typescript/lib/typescript.js")
let directory: string, session: string, work: string
let previous: string | undefined
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
      const handler = taskMatch ? request.method() === "GET" ? readTask : updateTask
        : url.pathname === "/api/boards/routines" ? routineLibrary : boardMatch ? planning : null
      if (!handler) return route.fulfill({ status: 404 })
      const response = await runWithIngressTransport(transport, () => handler(context(webRequest, { ...(taskMatch ? { id: taskMatch[1] } : {}), ...(boardMatch ? { id: boardMatch[1] } : {}) })))
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
    if (url.pathname.startsWith("/lib/") || url.pathname.startsWith("/generated/")) {
      if (!/^\/(lib|generated)\/[\w/-]+$/.test(url.pathname)) return route.fulfill({ status: 404 })
      const raw = await readFile(resolve(source, url.pathname.slice(1) + ".ts"), "utf8")
      const compiled = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        .replaceAll('"@lib/', '"/lib/').replaceAll('"@domains/', '"/domains/')
        .replaceAll('"@meitheal/domain-tasks/status-values"', '"/package-task/status-values"')
        .replaceAll('"@meitheal/domain-tasks"', '"/package-task/browser-values"')
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
    expect(stale).toEqual({ ok: false, status: 409, errorCode: "conflict" })
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
  for (const [board, name, selectedProject] of [["household", "Capture default routine", null], [work, "Work other routine", null], [work, "Selected Project routine", projectId]]) {
    const result = await call(manageRoutine, "/api/habits", board!, { action: "create", name, project_id: selectedProject })
    expect(result.status, await result.clone().text()).toBe(201)
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
  expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks WHERE source_template_id IS NOT NULL")).rows[0]?.count)).toBe(1)
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
