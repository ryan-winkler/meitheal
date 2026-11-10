import type { APIRoute } from "astro"
import { matchesMentionInboxContext, mentionInboxContextHeader } from "@lib/mention-inbox-context"
import { verifiedIngressUser } from "@lib/verified-ingress-user"
import { commentMentionProblem, commentPeople } from "@lib/comment-mention-request"

export const GET: APIRoute = async ({ locals, request, url }) => {
  const user = verifiedIngressUser(locals)
  if (!user || !matchesMentionInboxContext(user.id, request.headers.get(mentionInboxContextHeader))) {
    return commentMentionProblem("Reopen the comment editor through Home Assistant.", 403)
  }
  if ([...url.searchParams.keys()].some(key => key !== "q") || url.searchParams.getAll("q").length > 1) {
    return commentMentionProblem("Send one person search term.", 400)
  }
  const query = (url.searchParams.get("q") ?? "").trim()
  if (query.length > 40) return commentMentionProblem("Search with at most 40 characters.", 400)
  const people = await commentPeople(locals, request.signal)
  if (!people) return commentMentionProblem("Open mentions through Home Assistant with an active account.", 403)
  const needle = query.toLowerCase()
  const matches = [...people.recipients].filter(([, label]) => label.toLowerCase().includes(needle))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, 5).map(([key, label]) => ({ key, label }))
  return Response.json({ matches }, { headers: { "Cache-Control": "private, no-store" } })
}
