import type { APIRoute } from "astro"
import { z } from "zod"
import { feedbackProblem, withFeedback } from "@lib/feedback-api"

const listQuery = z.object({
  state: z.enum(["open", "in_progress", "resolved", "declined"]).optional(),
  before: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()).optional(),
  beforeId: z.uuidv4().optional(),
})

export const GET: APIRoute = context => withFeedback(context, "admin", 200, async (queue, actor) => {
  const query = listQuery.safeParse(Object.fromEntries(context.url.searchParams))
  if (!query.success || (query.data.before === undefined) !== (query.data.beforeId === undefined)) {
    return feedbackProblem(400, "Choose a valid state and provide both parts of the pagination cursor.")
  }

  const { state, before, beforeId } = query.data
  return queue.list(actor, {
    ...(state ? { state } : {}),
    ...(before !== undefined && beforeId ? { cursor: { receivedAt: before, id: beforeId } } : {}),
  })
})

export const POST: APIRoute = context => withFeedback(context, "member", 201, (queue, actor, body) =>
  queue.submit(actor, body),
)
