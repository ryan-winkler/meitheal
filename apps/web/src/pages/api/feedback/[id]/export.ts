import type { APIRoute } from "astro"
import { z } from "zod"
import { feedbackProblem, readFeedbackJson, withFeedback } from "@lib/feedback-api"

const exportBody = z.strictObject({ reviewedMessage: z.string() })

export const POST: APIRoute = context => withFeedback(context, "admin", 200, async (queue, actor) => {
  const input = await readFeedbackJson(context.request)
  if ("error" in input) return input.error

  const parsed = exportBody.safeParse(input.body)
  if (!parsed.success) return feedbackProblem(400, "Enter the text you have reviewed for sharing.")

  return queue.prepareExport(actor, context.params.id ?? "", parsed.data.reviewedMessage)
})
