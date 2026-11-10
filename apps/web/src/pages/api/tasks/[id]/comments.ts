import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError } from "@lib/api-response"
import { commentFailure, commentJson, readComment, resolveCommentAuthor } from "@lib/task-comment-request"

export const GET: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const comments = await repo.getComments(params.id!)
    return commentJson({ comments })
  } catch {
    return commentFailure("get", "Failed to load comments")
  }
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  const actor = resolveCommentAuthor(locals)
  if (!actor) return apiError("Open Meitheal from Home Assistant with a verified user to post a comment", 403)

  const content = await readComment(request)
  if (content instanceof Response) return content

  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const comment = await repo.addComment(params.id!, content, actor.author, actor.owner)
    return comment ? commentJson(comment, 201) : apiError("Task not found", 404)
  } catch {
    return commentFailure("post", "Failed to create comment")
  }
}
