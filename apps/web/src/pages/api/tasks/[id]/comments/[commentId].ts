import type { APIRoute } from "astro"
import { rejectBoardSelectionInJson } from "@domains/tasks/board-availability"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { CommentMentionRepository } from "@domains/tasks/persistence/comment-mention-repository"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError } from "@lib/api-response"
import { requireAssignedTaskWriteAccess, restrictedAssigneeId } from "@lib/agent-token-guard"
import { checkCommentMentionWriteContext, prepareCommentMentions } from "@lib/comment-mention-request"
import { commentMentions, hasCommentMentionSelector, redactCommentMentionSelectors } from "@lib/comment-mentions"
import { activeParticipantRequired, commentFailure, commentJson, hasCurrentTaskParticipant, readComment, resolveCommentAuthor } from "@lib/task-comment-request"

function parseCommentId(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export const GET: APIRoute = async ({ params, locals, request }) => {
  const id = parseCommentId(params.commentId)
  if (id === null) return apiError("Comment not found", 404)

  try {
    await ensureSchema()
    const comment = await new TaskRepository(getPersistenceClient()).getComment(params.id!, id)
    if (!comment) return apiError("Comment not found", 404)
    const content = String(comment.content)
    if (locals.behindIngress && !locals.agentToken && hasCommentMentionSelector(content) &&
        !await hasCurrentTaskParticipant(locals, request.signal, true)) {
      return commentJson({ ...comment, content: redactCommentMentionSelectors(content) })
    }
    return commentJson(comment)
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
  const parsedMentions = commentMentions(content)
  if (parsedMentions.length) {
    const wrongContext = checkCommentMentionWriteContext(request, locals)
    if (wrongContext) return wrongContext
  }

  try {
    const prepared = await prepareCommentMentions(content, parsedMentions, locals, request.signal)
    if (prepared instanceof Response) return prepared
    await ensureSchema()
    const client = getPersistenceClient()
    const repo = new TaskRepository(client)
    const resolved = await repo.resolveTaskId(params.id!)
    if (!resolved) return apiError("Task not found", 404)
    const taskId = resolved.id
    const denied = await requireAssignedTaskWriteAccess(
      locals.agentToken,
      (targetId) => repo.findById(targetId),
      [taskId],
      "Agent can only comment on tasks assigned to it",
    )
    if (denied) return denied
    const edited = await new CommentMentionRepository(client).editChecked(
      taskId, id, owner, prepared.content, prepared.recipients, restrictedAssigneeId(locals.agentToken),
    )
    if (edited.state === "assignee_mismatch") return apiError("Agent can only comment on tasks assigned to it", 403)
    return edited.state === "ok" ? commentJson(edited.comment) : apiError("Comment not found", 404)
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
    const boardSelection = await rejectBoardSelectionInJson(request)
    if (boardSelection) return boardSelection
    if (!await hasCurrentTaskParticipant(locals, request.signal, true)) return activeParticipantRequired()
    const repo = new TaskRepository(getPersistenceClient())
    const resolved = await repo.resolveTaskId(params.id!)
    if (!resolved) return apiError("Comment not found", 404)
    const deleted = await repo.deleteComment(resolved.id, id, owner)
    return deleted ? new Response(null, { status: 204 }) : apiError("Comment not found", 404)
  } catch {
    return commentFailure("delete", "Failed to delete comment")
  }
}
