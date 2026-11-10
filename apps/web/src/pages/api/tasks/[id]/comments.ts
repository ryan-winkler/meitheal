import type { APIRoute } from "astro"
import { hasScope } from "@meitheal/domain-auth"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError } from "@lib/api-response"
import { activeParticipantRequired, commentFailure, commentJson, hasCurrentTaskParticipant, readComment, resolveCommentAuthor } from "@lib/task-comment-request"

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const agent = locals.agentToken
    const owner = (!agent || hasScope(agent.scopes, "tasks:write")) && await hasCurrentTaskParticipant(locals, request.signal)
      ? resolveCommentAuthor(locals)?.owner ?? null
      : null
    const comments = await repo.getComments(params.id!, owner)
    return commentJson({ comments })
  } catch {
    return commentFailure("get", "Failed to load comments")
  }
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  const actor = resolveCommentAuthor(locals)
  if (!actor) return activeParticipantRequired()

  const content = await readComment(request)
  if (content instanceof Response) return content

  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    if (!await hasCurrentTaskParticipant(locals, request.signal, true)) return activeParticipantRequired()
    const comment = await repo.addComment(params.id!, content, actor.author, actor.owner)
    return comment ? commentJson(comment, 201) : apiError("Task not found", 404)
  } catch {
    return commentFailure("post", "Failed to create comment")
  }
}
