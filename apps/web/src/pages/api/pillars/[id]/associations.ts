import type { APIRoute } from "astro"
import { getVisiblePillar, readPillarBody } from "@lib/personal-pillar-access"
import { resolveBoardRequestScope } from "@lib/board-request-context"
import { boardScopeResponse } from "@lib/board-http"
import { apiJson, apiError } from "@lib/api-response"
import { isPersonalPillarScope, linkEntity, unlinkEntity, getAssociationsForPillar, VALID_PILLAR_ENTITY_TYPES, type PillarEntityType } from "@domains/pillars"

export const GET: APIRoute = async context => {
  const id = context.params.id
  if (!id) return apiError("Pillar unavailable", 404)
  const visible = await getVisiblePillar(id, context)
  if (visible instanceof Response) return visible
  if (!visible) return apiError("Pillar unavailable", 404)
  const selected = isPersonalPillarScope(visible.ownerScope)
    ? await resolveBoardRequestScope(context, { operation: { resource: "task", action: "read" } }) : { ok: true as const, scope: visible.ownerScope }
  if (!selected.ok) return boardScopeResponse(selected.errorCode)
  const associations = await getAssociationsForPillar(visible.ownerScope, id, selected.scope)
  return apiJson({ associations })
}

export const POST: APIRoute = async context => {
  const id = context.params.id
  if (!id) return apiError("Pillar unavailable", 404)
  const visible = await getVisiblePillar(id, context, "edit")
  if (visible instanceof Response) return visible
  if (!visible) return apiError("Pillar unavailable", 404)
  const body = await readPillarBody(context.request)
  if (body instanceof Response) return body
  const kind = body.entityType as PillarEntityType
  if (!VALID_PILLAR_ENTITY_TYPES.includes(kind) || typeof body.entityId !== "string" || !body.entityId || !["link", "unlink"].includes(String(body.action ?? "link"))) return apiError("Choose an existing target and a link action.", 400)
  const selected = await resolveBoardRequestScope(context, { operation: { resource: kind, action: "edit" }, record: { resource: kind, id: body.entityId }, write: true })
  if (!selected.ok) return boardScopeResponse(selected.errorCode)
  if (body.action === "unlink") {
    const removed = await unlinkEntity(visible.ownerScope, id, kind, body.entityId, selected.scope)
    return removed ? apiJson({ ok: true }) : apiError("Association unavailable", 404)
  }
  const association = await linkEntity(visible.ownerScope, id, kind, body.entityId, selected.scope)
  return association ? apiJson({ association }, 201) : apiError("Association target unavailable", 404)
}
