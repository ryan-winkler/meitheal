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
  if (request.headers.get("sec-fetch-site") !== "same-origin" ||
      request.headers.get("sec-fetch-mode") !== "same-origin") return false
  const origin = request.headers.get("origin")
  const referer = request.headers.get("referer")
  if (!origin || !referer) return false
  try {
    const source = new URL(referer)
    return (source.protocol === "http:" || source.protocol === "https:") && source.origin === origin &&
      (ingress ? source.pathname.startsWith(ingress + "/") : source.origin === new URL(request.url).origin)
  } catch {
    return false
  }
}

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { ...headers, allow: "POST" } })

export const POST: APIRoute = async ({ locals, request }) => {
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

  const admin = canManageSystemSettings(request, locals)
  if (action.action === "save") {
    if (!admin || (ha && !user?.isAdmin)) return problem(403, "Only an administrator can change inactivity policies.")
    if (user) {
      const current = await verifyCurrentHAAdministrator(user.id, request.signal)
      if (current === "unavailable") return problem(503, "Home Assistant could not verify current administrator access.")
      if (current !== "allowed") return problem(403, "Only an active Home Assistant administrator can change inactivity policies.")
    }
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
    const repo = new TaskInactivityRepository(getPersistenceClient())
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
