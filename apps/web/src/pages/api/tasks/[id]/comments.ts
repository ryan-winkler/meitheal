import type { APIRoute } from "astro"
import { hasScope } from "@meitheal/domain-auth"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { CommentMentionRepository } from "@domains/tasks/persistence/comment-mention-repository"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError } from "@lib/api-response"
import { checkCommentMentionWriteContext, commentAttempt, commentMentionProblem, prepareCommentMentions } from "@lib/comment-mention-request"
import { commentAttemptHorizonMs, commentMentions, hasCommentMentionSelector, redactCommentMentionSelectors } from "@lib/comment-mentions"
import { verifiedIngressUser } from "@lib/verified-ingress-user"
import { notifyAgentComment } from "@domains/notifications/agent-comment"
import { activeParticipantRequired, commentFailure, commentJson, hasCurrentTaskParticipant, readComment, resolveCommentAuthor } from "@lib/task-comment-request"
import { dispatchTaskEvent } from "@lib/webhook-dispatcher"

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const agent = locals.agentToken
    const owner = !agent || hasScope(agent.scopes, "tasks:write") ? resolveCommentAuthor(locals)?.owner ?? null : null
    const comments = await repo.getComments(params.id!, owner)
    const privateMentions = locals.behindIngress && !agent && comments.some(comment => hasCommentMentionSelector(comment.content))
    if ((owner || privateMentions) && !await hasCurrentTaskParticipant(locals, request.signal, privateMentions)) {
      return commentJson({ comments: comments.map(comment => ({ ...comment, can_manage: false,
        content: privateMentions ? redactCommentMentionSelectors(comment.content) : comment.content,
      })) })
    }
    return commentJson({ comments })
  } catch {
    return commentFailure("get", "Failed to load comments")
  }
}

function attemptResponse(result: Awaited<ReturnType<CommentMentionRepository["create"]>>): Response {
  if (result.state === "created" || result.state === "replayed") return commentJson(result.comment, 201)
  if (result.state === "gone") return commentMentionProblem("The original comment was deleted.", 410)
  if (result.state === "conflict") return commentMentionProblem("This comment attempt already used different text.")
  return apiError("Task not found", 404)
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  const actor = resolveCommentAuthor(locals)
  if (!actor) return activeParticipantRequired()

  const content = await readComment(request)
  if (content instanceof Response) return content

  const attempt = verifiedIngressUser(locals) ? commentAttempt(request) : null
  if (attempt instanceof Response) return attempt
  const parsedMentions = commentMentions(content)
  if (attempt || parsedMentions.length) {
    const wrongContext = checkCommentMentionWriteContext(request, locals)
    if (wrongContext) return wrongContext
  }

  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const mentions = new CommentMentionRepository(client)
    const taskId = params.id!

    const agentToken = locals.agentToken
    if (agentToken && agentToken.scopes.includes("tasks:write:assigned") && !agentToken.scopes.includes("tasks:write")) {
      const taskRepo = new TaskRepository(client)
      const task = await taskRepo.findById(taskId)
      if (!task || !agentToken.assigneeId || task.assigned_to !== agentToken.assigneeId) {
        return new Response(JSON.stringify({ error: "Agent can only comment on tasks assigned to it" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      }
    }
    if (attempt && actor.owner) {
      if (await mentions.replay(taskId, actor.owner, attempt.key, content)) {
        if (!await hasCurrentTaskParticipant(locals, request.signal, true)) return activeParticipantRequired()
        const prior = await mentions.replay(taskId, actor.owner, attempt.key, content)
        return attemptResponse(prior ?? { state: "gone" })
      }
    }
    const prepared = await prepareCommentMentions(content, parsedMentions, locals, request.signal)
    if (prepared instanceof Response) return prepared
    if (prepared.recipients.length && !attempt) return commentMentionProblem("Start this comment again to send its mentions.", 400)
    if (attempt && actor.owner) {
      return attemptResponse(await mentions.create(taskId, prepared.content, actor.author, actor.owner, prepared.recipients,
        { ...attempt, rawContent: content, cutoff: Date.now() - commentAttemptHorizonMs }, prepared.verifiedHuman))
    }
    const comment = await new TaskRepository(client).addComment(params.id!, prepared.content, actor.author, actor.owner, prepared.verifiedHuman)
    if (comment && locals.agentToken) notifyAgentComment(params.id!, actor.author, prepared.content).catch(() => {})
    return comment ? commentJson(comment, 201) : apiError("Task not found", 404)
  } catch {
    return commentFailure("post", "Failed to create comment")
  }
}
