import { createHash } from "node:crypto"
import sanitizeHtml from "sanitize-html"
import { getCachedHAUserName, isCurrentActiveHAUser } from "@domains/ha/ha-users"
import { apiProblem } from "./api-response"
import { activeParticipantMessage, activeParticipantProblemType } from "./task-participant-problem"
import { verifiedIngressUser } from "./verified-ingress-user"

function plainName(name: string): string {
  return sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 80)
}

function ownerKey(kind: "automation" | "home-assistant", id: string): string {
  return createHash("sha256").update(`comment-owner:${kind}:${id}`).digest("hex")
}

export function resolveTaskAuthor(locals: App.Locals): { author: string, owner: string | null } | null {
  if (locals.agentToken) {
    const name = plainName(locals.agentToken.tokenName)
    return {
      author: name ? `Automation: ${name}` : "Automation",
      owner: ownerKey("automation", locals.agentToken.tokenId),
    }
  }
  if (!locals.behindIngress) return { author: "Local user", owner: null }

  const user = verifiedIngressUser(locals)
  if (!user) return null
  const name = plainName(getCachedHAUserName(user.id) ?? "")
  const owner = ownerKey("home-assistant", user.id)
  if (name) return { author: name, owner }
  const reference = createHash("sha256").update(`comment-author:${user.id}`).digest("hex").slice(0, 10)
  return { author: `Home Assistant member · ${reference}`, owner }
}

/** Standalone comments and scoped automation keep their existing actor rules. */
export async function hasCurrentTaskParticipant(locals: App.Locals, signal: AbortSignal, fresh = false): Promise<boolean> {
  if (signal.aborted) return false
  if (!locals.behindIngress || locals.agentToken) return true
  const user = verifiedIngressUser(locals)
  return Boolean(user && await isCurrentActiveHAUser(user.id, { fresh, signal }))
}

export function activeParticipantRequired(): Response {
  return apiProblem({
    status: 403,
    type: activeParticipantProblemType,
    detail: activeParticipantMessage,
    extraHeaders: { "Cache-Control": "private, no-store" },
  })
}

export function taskParticipantBodySignal(request: Request): AbortSignal {
  return AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
}

export function taskParticipantBodyTimeout(): Response {
  return apiProblem({
    status: 408,
    type: "https://meitheal.local/problems/request-timeout",
    title: "Request Timeout",
    detail: "The request body did not arrive in time. Try again.",
    extraHeaders: { "Cache-Control": "private, no-store" },
  })
}
