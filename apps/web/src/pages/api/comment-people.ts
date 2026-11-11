import type { APIRoute } from "astro"
import { readWithinLimit } from "@lib/bounded-body"
import { commentMentionProblem, commentPeople, isSameIngressMentionRequest } from "@lib/comment-mention-request"
import { matchesMentionInboxContext, mentionInboxContextHeader } from "@lib/mention-inbox-context"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const headers = { "Cache-Control": "private, no-store" }
const maxBodyBytes = 1024

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } })

export const POST: APIRoute = async ({ locals, request, url }) => {
  const user = verifiedIngressUser(locals)
  if (!user || !isSameIngressMentionRequest(request, locals.ingressPath) ||
      !matchesMentionInboxContext(user.id, request.headers.get(mentionInboxContextHeader))) {
    return commentMentionProblem("Reopen the comment editor through Home Assistant.", 403)
  }
  if (url.search) return commentMentionProblem("Send the person search term in the request body.", 400)
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return commentMentionProblem("Send the person search as JSON.", 415)
  }
  const tooLarge = () => commentMentionProblem("The person search request exceeds 1 KiB.", 413)
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return tooLarge()
  let body: unknown
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
    const bytes = await readWithinLimit(request.body, maxBodyBytes, signal)
    if (!bytes) return tooLarge()
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return commentMentionProblem("Send a valid UTF-8 JSON object.", 400)
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !("q" in body) || typeof body.q !== "string" || body.q.length > 40) {
    return commentMentionProblem("Send one person search term of at most 40 characters.", 400)
  }
  const people = await commentPeople(locals, request.signal)
  if (!people) return commentMentionProblem("Open mentions through Home Assistant with an active account.", 403)
  const needle = body.q.trim().toLowerCase()
  const matches = [...people.recipients].filter(([, label]) => label.toLowerCase().includes(needle))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, 5).map(([key, label]) => ({ key, label }))
  return Response.json({ matches }, { headers })
}
