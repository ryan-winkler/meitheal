import { createHash } from "node:crypto"
import { getCurrentHAUserRoster } from "@domains/ha/ha-users"
import { apiProblem } from "./api-response"
import { commentAttemptHeader, commentAttemptHorizonMs, commentMentionContextHeader, commentMentionContextProblemType, commentMentionProblemType, commentMentions, commentMentionToken } from "./comment-mentions"
import { matchesMentionInboxContext } from "./mention-inbox-context"
import { activeParticipantRequired, hasCurrentTaskParticipant } from "./task-participant"
import { verifiedIngressUser } from "./verified-ingress-user"

export function commentPersonKey(id: string): string {
  return createHash("sha256").update(`comment-mention:${id}`).digest("hex").slice(0, 32)
}

export async function commentPeople(locals: App.Locals, signal: AbortSignal) {
  const actor = verifiedIngressUser(locals)
  if (!actor) return
  const roster = await getCurrentHAUserRoster(actor.id, signal)
  if (!roster) return
  const names = new Map<string, number>()
  const members = [...roster].map(([id, name]) => {
    const label = Array.from(name.replace(/[\u0000-\u001f\u007f]/gu, "").trim() || "Home Assistant member").slice(0, 64).join("")
    names.set(label, (names.get(label) ?? 0) + 1)
    return { id, key: commentPersonKey(id), label }
  })
  const recipients = new Map(members.filter(member => member.id !== actor.id).map(({ key, label }) =>
    [key, (names.get(label) ?? 0) > 1 ? `${label} · ${key.slice(-6)}` : label]))
  return { recipients, self: commentPersonKey(actor.id) }
}

const headers = { "Cache-Control": "private, no-store" }

export function commentMentionProblem(detail: string, status = 409) {
  return apiProblem({ status, type: commentMentionProblemType, detail, extraHeaders: headers })
}

export function isSameIngressMentionRequest(request: Request, path: string | undefined): boolean {
  if (!path || request.headers.get("sec-fetch-site") !== "same-origin" ||
      request.headers.get("sec-fetch-mode") !== "same-origin") return false
  try {
    const referer = new URL(request.headers.get("referer") ?? "")
    return (referer.protocol === "http:" || referer.protocol === "https:") &&
      referer.origin === request.headers.get("origin") && referer.pathname.startsWith(path + "/")
  } catch {
    return false
  }
}

export function checkCommentMentionWriteContext(request: Request, locals: App.Locals): Response | undefined {
  const user = verifiedIngressUser(locals)
  if (!user || matchesMentionInboxContext(user.id, request.headers.get(commentMentionContextHeader))) return
  return apiProblem({ status: 409, type: commentMentionContextProblemType, extraHeaders: headers,
    detail: "Your Home Assistant session changed. Copy your draft before reopening Meitheal under the original account." })
}

export function commentAttempt(request: Request) {
  const key = request.headers.get(commentAttemptHeader)
  if (key === null) return null
  const match = /^(\d{13})\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(key)
  const now = Date.now()
  const issuedAt = Number(match?.[1])
  if (!match || issuedAt > now + 60_000 || issuedAt <= now - commentAttemptHorizonMs) {
    return commentMentionProblem("This comment attempt expired. Copy the text before starting a new comment.", 400)
  }
  return { key, issuedAt }
}

export async function prepareCommentMentions(
  content: string, mentions: ReturnType<typeof commentMentions>, locals: App.Locals, signal: AbortSignal,
) {
  const verifiedHuman = Boolean(verifiedIngressUser(locals))
  if (!mentions.length || !verifiedHuman) {
    if (!await hasCurrentTaskParticipant(locals, signal, true)) return activeParticipantRequired()
    return { content, recipients: [] as string[], verifiedHuman }
  }
  const people = await commentPeople(locals, signal)
  if (!people) return activeParticipantRequired()
  const recipients = new Set<string>()
  let canonical = ""
  let offset = 0
  for (const { key, start, end } of mentions) {
    const label = people.recipients.get(key)
    if (!label && key !== people.self) return commentMentionProblem("A selected person is unavailable. Remove that mention or select someone else.")
    if (label) recipients.add(key)
    canonical += content.slice(offset, start) + (label ? commentMentionToken(key, label) : "@you")
    offset = end
  }
  if (recipients.size > 10) return commentMentionProblem("A comment can mention at most ten people.", 400)
  canonical += content.slice(offset)
  if (canonical.length > 5000) return commentMentionProblem("The comment exceeds 5000 characters with the selected names.", 400)
  return { content: canonical, recipients: [...recipients], verifiedHuman }
}
