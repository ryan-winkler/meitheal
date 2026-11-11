import type { APIRoute } from "astro"
import { isCurrentActiveHAUser } from "@domains/ha/ha-users"
import { CommentMentionRepository } from "@domains/tasks/persistence/comment-mention-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { readWithinLimit } from "@lib/bounded-body"
import { commentMentionProblem, commentPersonKey, isSameIngressMentionRequest } from "@lib/comment-mention-request"
import { matchesMentionInboxContext, mentionInboxContextHeader } from "@lib/mention-inbox-context"
import { buildTaskPath } from "@lib/task-detail-handoff"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export const POST: APIRoute = async ({ locals, request, url }) => {
  const user = verifiedIngressUser(locals)
  if (!user || !isSameIngressMentionRequest(request, locals.ingressPath)) {
    return commentMentionProblem("Open the inbox through your verified Home Assistant session.", 403)
  }
  if (!matchesMentionInboxContext(user.id, request.headers.get(mentionInboxContextHeader))) {
    return commentMentionProblem("Your Home Assistant session changed. Reopen the inbox.")
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return commentMentionProblem("Send an inbox action as JSON.", 415)
  }
  let action: Record<string, unknown>
  try {
    const bytes = await readWithinLimit(request.body, 1024, AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]))
    if (!bytes) return commentMentionProblem("The inbox request exceeds 1 KiB.", 413)
    action = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("object required")
  } catch {
    return commentMentionProblem("Send a valid inbox action.", 400)
  }
  if (url.search) return commentMentionProblem("Send inbox filters in the request body.", 400)
  const { before, id, read } = action
  const list = action.action === "list" && (before === null || validId(before))
  const mark = action.action === "mark" && (validId(id) || (id === null && read === true)) && typeof read === "boolean"
  if (!list && !mark) return commentMentionProblem("Choose a valid page or read action.", 400)
  if (!await isCurrentActiveHAUser(user.id, { fresh: true, signal: request.signal })) {
    return commentMentionProblem("Home Assistant could not verify this account.", 403)
  }

  try {
    await ensureSchema()
    const repo = new CommentMentionRepository(getPersistenceClient())
    const recipient = commentPersonKey(user.id)
    if (mark) {
      if (!await repo.mark(recipient, id, read)) return commentMentionProblem("This notification is unavailable.", 404)
      return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } })
    }
    const { rows, ...state } = await repo.page(recipient, before as number | null)
    return Response.json({ ...state, items: rows.map(row => ({
      id: Number(row.id), title: String(row.title), href: buildTaskPath(String(row.task_id), Number(row.comment_id)),
      read: row.read_at !== null, createdAt: Number(row.created_at),
    })) }, { headers: { "Cache-Control": "private, no-store" } })
  } catch {
    return commentMentionProblem("Could not load or update the inbox. Try again.", 503)
  }
}
