import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError } from "@lib/api-response"
import { activeParticipantRequired, commentFailure, commentJson, hasCurrentTaskParticipant, readComment, resolveCommentAuthor } from "@lib/task-comment-request"

function parseCommentId(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export const GET: APIRoute = async ({ params }) => {
  const id = parseCommentId(params.commentId)
  if (id === null) return apiError("Comment not found", 404)

  try {
    await ensureSchema()
    const comment = await new TaskRepository(getPersistenceClient()).getComment(params.id!, id)
    return comment ? commentJson(comment) : apiError("Comment not found", 404)
  } catch {
    return commentFailure("get", "Failed to load comment")
  }
}

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const actor = resolveCommentAuthor(locals)
  if (!actor) return activeParticipantRequired()
  const { owner } = actor
  if (!owner) return apiError("Use a verified Home Assistant user or an automation credential to edit a comment", 403)

  const id = parseCommentId(params.commentId)
  if (id === null) return apiError("Comment not found", 404)
  const content = await readComment(request)
  if (content instanceof Response) return content

  try {
    await ensureSchema()
    if (!await hasCurrentTaskParticipant(locals, request.signal, true)) return activeParticipantRequired()
    const comment = await new TaskRepository(getPersistenceClient()).updateComment(params.id!, id, owner, content)
    return comment ? commentJson(comment) : apiError("Comment not found", 404)
  } catch {
    return commentFailure("patch", "Failed to update comment")
  }
}

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const actor = resolveCommentAuthor(locals)
  if (!actor) return activeParticipantRequired()
  const { owner } = actor
  if (!owner) return apiError("Use a verified Home Assistant user or an automation credential to delete a comment", 403)

  const id = parseCommentId(params.commentId)
  if (id === null) return apiError("Comment not found", 404)

  try {
    await ensureSchema()
    if (!await hasCurrentTaskParticipant(locals, request.signal, true)) return activeParticipantRequired()
    const deleted = await new TaskRepository(getPersistenceClient()).deleteComment(params.id!, id, owner)
    return deleted ? new Response(null, { status: 204 }) : apiError("Comment not found", 404)
  } catch {
    return commentFailure("delete", "Failed to delete comment")
  }
}
