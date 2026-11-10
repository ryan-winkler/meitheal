import type { APIRoute } from "astro"
import { z } from "zod"
import { feedbackProblem, readFeedbackJson, withFeedback } from "@lib/feedback-api"

const reviewBody = z.strictObject({
  state: z.enum(["in_progress", "resolved", "declined"]),
  disposition: z.string().optional(),
})

export const PATCH: APIRoute = context => withFeedback(context, "admin", 200, async (queue, actor) => {
  const input = await readFeedbackJson(context.request)
  if ("error" in input) return input.error

  const parsed = reviewBody.safeParse(input.body)
  if (!parsed.success) return feedbackProblem(400, "Choose a valid review state and provide any required disposition.")

  const { state, disposition } = parsed.data
  return queue.review(actor, context.params.id ?? "", state, disposition)
})

export const DELETE: APIRoute = context => withFeedback(context, "admin", 204, (queue, actor) =>
  queue.deleteClosed(actor, context.params.id ?? ""),
)
