import { boardScopeErrorResponse } from "@lib/board-http"
import { scopePermits } from "@domains/tasks/board-scope"
import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { z } from "zod"
import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
import { isCurrentActiveHAUser } from "@domains/ha/ha-users"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskInactivityRepository } from "@domains/tasks/persistence/task-inactivity-repository"
import { apiProblem } from "@lib/api-response"
import { readWithinLimit } from "@lib/bounded-body"
import { canManageSystemSettings } from "@lib/settings-security"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const headers = { "cache-control": "private, no-store" }
const areaId = z.string().min(1).max(128).nullable()
const days = z.number().int().min(-1).max(365)
const revision = z.string().regex(/^[a-f0-9]{32}$/).nullable()
const actions = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("preview"), areaId, days: days.optional(),
    page: z.number().int().min(1).max(100_000), filter: z.enum(["all", "ready", "upcoming", "stalled"]),
  }),
  z.strictObject({
    action: z.literal("save"), areaId, days,
    expectedRevision: revision, expectedDefaultRevision: revision,
    areaGeneration: revision, expectedAreaCatalogRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }),
  z.strictObject({
    action: z.literal("board"), ids: z.array(z.string().min(1).max(128)).min(1).max(100),
  }),
])

function problem(status: number, detail: string) {
  return apiProblem({ status, detail, extraHeaders: headers })
}

function sameOrigin(request: Request, ingress: string | undefined): boolean {
  const site = request.headers.get("sec-fetch-site")
  const mode = request.headers.get("sec-fetch-mode")
  if (site !== "same-origin" || (mode !== "same-origin" && mode !== "cors")) return false
  const origin = request.headers.get("origin")
  const referer = request.headers.get("referer")
  if (!origin || !referer) return false
  try {
    const source = new URL(referer)
    if ((source.protocol !== "http:" && source.protocol !== "https:") || source.origin !== origin) return false
    if (ingress) return source.pathname.startsWith(ingress + "/")
    return source.origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { ...headers, allow: "POST" } })

const handleInactivity: Parameters<typeof withBoardScope>[1] = async ({ locals, request }, scope) => {
  const ha = Boolean(process.env.SUPERVISOR_TOKEN)
  const user = verifiedIngressUser(locals)
  if (locals.agentToken || (ha && (!user || !locals.ingressPath)) || !sameOrigin(request, locals.ingressPath)) {
    return problem(403, "Open Inactivity in a verified browser session.")
  }
  const media = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (media !== "application/json") return problem(415, "Send inactivity requests as application/json.")
  const maxBody = 16 * 1024
  if (Number(request.headers.get("content-length")) > maxBody) return problem(413, "The inactivity request is too large.")

  let body: Buffer
  let parsed
  try {
    const bytes = await readWithinLimit(request.body, maxBody, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]))
    if (!bytes) return problem(413, "The inactivity request is too large.")
    body = bytes
    parsed = actions.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)))
  } catch {
    return problem(400, "Send a valid UTF-8 JSON object.")
  }
  if (!parsed.success) return problem(400, "Choose a valid inactivity action and scope.")
  const action = parsed.data
  if (action.action !== "board" && body.byteLength > 2048) return problem(413, "The inactivity request is too large.")
  if (action.action !== "board" && action.areaId === null && action.days === -1) {
    return problem(400, "The shared default cannot inherit another policy.")
  }

  const admin = scopePermits(scope, { resource: "board", action: "manage" })
  if (action.action === "save") {
    if (!admin) return problem(403, "Manage this Board to change its inactivity policies.")
    const allAreas = action.areaId === null
    if (allAreas !== (action.areaGeneration === null) || allAreas === (action.expectedAreaCatalogRevision === null)) {
      return problem(400, "Preview the policy scope before saving.")
    }
  } else if (user && !await isCurrentActiveHAUser(user.id, { fresh: true, signal: request.signal })) {
    return problem(403, "Home Assistant could not verify this browser account.")
  }

  if (request.signal.aborted) return problem(499, "The inactivity request was cancelled.")
  try {
    await ensureSchema()
    if (request.signal.aborted) return problem(499, "The inactivity request was cancelled.")
    const repo = new TaskInactivityRepository(getPersistenceClient(), scope)
    const now = Date.now()
    if (action.action === "board") {
      const { cues, stalled } = await repo.boardCues([...new Set(action.ids)], now)
      return Response.json({ now, cues: Object.fromEntries(cues), stalled: Object.fromEntries(stalled) }, { headers })
    }
    if (action.action === "save") {
      const saved = await repo.savePolicy(action)
      if (saved.status === "missing") return problem(404, "This Area no longer exists.")
      if (saved.status === "stale") return problem(409, "The policy or Area changed. Preview the current scope before saving.")
      return Response.json({ policy: saved.policy }, { headers })
    }
    const preview = await repo.preview({
      areaId: action.areaId, page: action.page, filter: action.filter, now,
      ...(action.days === undefined ? {} : { proposed: action.days }),
    })
    if (!preview.areaExists) return problem(404, "This Area no longer exists.")
    return Response.json({ ...preview, now, canSave: admin }, { headers })
  } catch {
    return problem(503, "Could not load inactivity data. Try again.")
  }
 }

export const POST: APIRoute = async context => {
  let input: Record<string, unknown> | null = null
  try {
    const bytes = await readWithinLimit(context.request.clone().body, 16 * 1024, AbortSignal.any([context.request.signal, AbortSignal.timeout(5000)]))
    if (!bytes) return problem(413, "The inactivity request is too large.")
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch { return problem(400, "Send a valid inactivity action.") }
  const operation = input?.action === "save" ? { resource: "board", action: "manage" } as const : { resource: "task", action: "read" } as const
  return withBoardScope(operation, handleInactivity, { write: true })(context)
}
