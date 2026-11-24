/**
 * Agent comment notifications
 *
 * An agent answers through task comments. Nobody is watching the task when it
 * does, so the household is told through Home Assistant and outbound webhooks.
 *
 * @domain notifications
 * @bounded-context task-notifications
 */
import sanitizeHtml from "sanitize-html"
import {
  TaskRepository, getPersistenceClient, readWorkDestinations, resolveIntegrationScope, validateBoardScope,
  type BoardScope,
} from "@domains/tasks"
import { formatTicketKey } from "@lib/ticket-key"
import { dispatchTaskEvent } from "@lib/webhook-dispatcher"
import { sendTaskNotification } from "./task-notifications"

const EXCERPT_LENGTH = 280

function excerpt(content: string): string {
  const plain = sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim()
  return plain.length > EXCERPT_LENGTH ? `${plain.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : plain
}

/** Tell the household that an agent commented on a task. Never throws. */
export async function notifyAgentComment(
  taskId: string,
  authorOrComment: string | { id?: unknown; author: string; content: string },
  scope: BoardScope,
  contentArg?: string,
): Promise<void> {
  try {
    const rawId = typeof authorOrComment === "object" ? authorOrComment.id : undefined
    const commentId = typeof rawId === "number" || typeof rawId === "string" ? rawId : undefined
    const author = typeof authorOrComment === "object" ? authorOrComment.author : authorOrComment
    const content = typeof authorOrComment === "object" ? authorOrComment.content : (contentArg ?? "")

    const db = getPersistenceClient()
    if (!(await validateBoardScope(scope, db, { resource: "task", action: "edit" })).ok) return
    // A write-only commenter never receives task content. Build outgoing content
    // only through an independently approved channel's current read ceiling.
    let reader: BoardScope | undefined
    const configuration = await readWorkDestinations(db)
    for (const binding of configuration?.bindings ?? []) {
      if (binding.destination.boardId !== scope.boardId || !["notification", "webhook", "ha_events"].includes(binding.integration)) continue
      const result = await resolveIntegrationScope(db, binding.id, binding.generation, { resource: "task", action: "read" })
      if (result.ok) { reader = result.value.scope; break }
    }
    if (!reader) return
    const repo = new TaskRepository(db, reader)
    const task = await repo.findById(taskId)
    if (!task) return
    const ticketKey = typeof task.ticket_key === "string" ? task.ticket_key : formatTicketKey(task.ticket_number != null ? Number(task.ticket_number) : null)
    const agentName = author.replace(/^Automation:\s*/, "") || "An agent"
    const summary = excerpt(content)

    try {
      await dispatchTaskEvent("task.commented", {
        id: task.id,
        ...(commentId !== undefined ? { comment_id: commentId } : {}),
        author,
        content,
        title: task.title,
        ticket_key: ticketKey,
        status: task.status,
        assigned_to: task.assigned_to ?? null,
        comment: { ...(commentId !== undefined ? { id: commentId } : {}), author, excerpt: summary, by_agent: true },
      }, undefined, undefined, undefined, undefined, scope)
    } catch {
      // Outbound webhook failures must not suppress household notifications.
    }

    const prefs = await repo.getNotificationPreferences()
    if (!prefs.enabled) return
    const { homeAssistantWorkLink } = await import("@lib/ha-app-link")
    const href = await homeAssistantWorkLink(scope.boardId, String(task.id))
    const link = href ? `\n\n[Open ${ticketKey ?? "the task"} in Meitheal →](${href})` : ""
    await sendTaskNotification(prefs, {
      title: `💬 ${agentName} commented: ${String(task.title)}`,
      message: `${summary}${link}`,
      // One notification per task: a newer comment replaces the older one.
      notificationId: `meitheal_agent_comment_${task.id}`,
      ingress: null,
      taskId: String(task.id),
      ...(typeof task.task_version === "number" ? { taskVersion: task.task_version } : {}),
    }, scope, { resource: "task", action: "edit" })
  } catch {
    // The comment is saved. A failed notification must not fail the request.
  }
}
