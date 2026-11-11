import type { APIRoute } from "astro"
import { isCurrentActiveHAUser } from "@domains/ha/ha-users"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskPinRepository } from "@domains/tasks/persistence/task-pin-repository"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiProblem } from "@lib/api-response"
import { readWithinLimit } from "@lib/bounded-body"
import { normalizeStatus } from "@lib/status-config"
import { matchesTaskPinContext, taskPinContext, taskPinContextHeader } from "@lib/task-pin-context"
import { formatTicketKey, parseTicketKey } from "@lib/ticket-key"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const noStore = { "cache-control": "private, no-store" }
const maxBodyBytes = 1024

function problem(status: number, detail: string) {
  return apiProblem({ status, detail, extraHeaders: noStore })
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: noStore })
}

function validBrowserRequest(request: Request, ingressPath: string): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin" ||
      request.headers.get("sec-fetch-mode") !== "same-origin") return false

  const origin = request.headers.get("origin")
  const referer = request.headers.get("referer")
  if (!origin || !referer) return false
  try {
    const address = new URL(origin)
    const source = new URL(referer)
    return (address.protocol === "http:" || address.protocol === "https:") &&
      address.origin === origin && source.origin === origin &&
      source.pathname.startsWith(ingressPath + "/")
  } catch {
    return false
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") return problem(415, "Send pin requests as application/json.")
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return problem(413, "Pin requests are limited to 1 KiB.")
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
    const bytes = await readWithinLimit(request.body, maxBodyBytes, signal)
    if (!bytes) return problem(413, "Pin requests are limited to 1 KiB.")
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (body && typeof body === "object" && !Array.isArray(body)) return body
  } catch {
    // Pin payloads are private and must not enter error logs.
  }
  return problem(400, "Send a valid UTF-8 JSON object.")
}

function validTaskIdentifier(task: unknown): task is string {
  if (typeof task !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(task)) return false
  if (!/^MTH-/i.test(task)) return true
  const ticket = parseTicketKey(task)
  return ticket !== null && Number.isSafeInteger(ticket) && ticket > 0
}

function contextChanged() {
  return json({ error: "The Home Assistant pin session changed.", errorCode: "PIN_CONTEXT_CHANGED" }, 409)
}

export const ALL: APIRoute = () => new Response(null, {
  status: 405, headers: { ...noStore, allow: "POST, PUT, HEAD" },
})

export const HEAD: APIRoute = async ({ locals, request }) => {
  const owner = verifiedIngressUser(locals)
  if (!owner || !await isCurrentActiveHAUser(owner.id)) {
    return new Response(null, { status: 403, headers: noStore })
  }
  return new Response(null, {
    status: matchesTaskPinContext(owner.id, request.headers.get(taskPinContextHeader)) ? 204 : 409,
    headers: noStore,
  })
}

export const POST: APIRoute = async ({ locals, request }) => {
  const owner = verifiedIngressUser(locals)
  if (!owner || !locals.ingressPath || !validBrowserRequest(request, locals.ingressPath)) {
    return problem(403, "Open personal pins from your verified Home Assistant session.")
  }

  const body = await readBody(request)
  if (body instanceof Response) return body
  const isList = body.action === "list"
  const page = isList && !Object.hasOwn(body, "page") ? 1 : body.page
  if (isList ? (Object.keys(body).some(key => key !== "action" && key !== "page") ||
      typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) :
      (body.action !== "detail" || !validTaskIdentifier(body.task) || Object.keys(body).length !== 2)) {
    return problem(400, "Choose a page or provide a valid task identifier.")
  }
  if (!await isCurrentActiveHAUser(owner.id)) return problem(403, "Home Assistant could not verify this account.")

  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const pins = new TaskPinRepository(client)
    const context = taskPinContext(owner.id)
    if (isList && typeof page === "number") {
      const result = await pins.list(owner.id, page)
      const items = result.items.map(({ ticket_number, ...item }) => ({
        ...item, ticket_key: formatTicketKey(ticket_number), status: normalizeStatus(item.status),
      }))
      return json({ context, page: result.page, total: result.total, items })
    }
    const task = await new TaskRepository(client).resolveTaskId(String(body.task))
    const pin = task && await pins.get(owner.id, task.id)
    return pin ? json({ context, ...pin }) : problem(404, "Task not found.")
  } catch {
    return problem(500, "Could not read personal pins.")
  }
}

export const PUT: APIRoute = async ({ locals, request }) => {
  const owner = verifiedIngressUser(locals)
  if (!owner || !locals.ingressPath || !validBrowserRequest(request, locals.ingressPath)) {
    return problem(403, "Open personal pins from your verified Home Assistant session.")
  }
  const body = await readBody(request)
  if (body instanceof Response) return body
  if (!validTaskIdentifier(body.task) || typeof body.pinned !== "boolean" || Object.keys(body).length !== 2) {
    return problem(400, "Provide a valid task identifier and pin state.")
  }
  if (!await isCurrentActiveHAUser(owner.id)) return problem(403, "Home Assistant could not verify this account.")
  if (!matchesTaskPinContext(owner.id, request.headers.get(taskPinContextHeader))) return contextChanged()

  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const task = await new TaskRepository(client).resolveTaskId(body.task)
    const pin = task && await new TaskPinRepository(client).set(owner.id, task.id, body.pinned)
    return pin ? json(pin) : problem(404, "Task not found.")
  } catch {
    return problem(500, "Could not update the pin. Refresh its state before trying again.")
  }
}
