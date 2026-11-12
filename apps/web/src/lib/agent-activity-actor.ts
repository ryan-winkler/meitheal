import sanitizeHtml from "sanitize-html"

/**
 * Activity-log attribution for a change made with an agent token, so the task
 * history names the agent in place of the generic "user". Undefined for people.
 */
export function agentActivityActor(locals: App.Locals): { actor: string; actor_type: "agent" } | undefined {
  const agent = locals.agentToken
  if (!agent) return undefined
  const name = sanitizeHtml(agent.tokenName, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 80)
  return { actor: name || "Agent", actor_type: "agent" }
}
