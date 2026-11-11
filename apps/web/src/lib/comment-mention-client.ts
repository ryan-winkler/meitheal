import { commentMentionContextHeader, commentMentionContextProblemType, commentMentionProblemType, commentMentions } from "./comment-mentions"
import { canUsePrivateWorker, privateIngressScope } from "./network-only-worker"

export async function fetchCommentPrivate(endpoint: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
  const scope = privateIngressScope()
  const worker = navigator.serviceWorker?.controller
  if (!navigator.onLine || !scope || (worker && !await canUsePrivateWorker(scope, worker, "COMMENT_MENTIONS_NETWORK_ONLY"))) {
    throw new Error("Private inbox requires a current Home Assistant session and service worker.")
  }
  if (signal.aborted || navigator.serviceWorker?.controller !== worker) throw new Error("App session changed.")
  const response = await fetch("/" + endpoint, {
    ...init, signal, cache: "no-store", redirect: "error", mode: "same-origin", referrerPolicy: "same-origin",
  })
  const policy = response.headers.get("cache-control")?.split(",").map(value => value.trim().toLowerCase())
  if (!navigator.onLine || navigator.serviceWorker?.controller !== worker || response.url !== new URL(endpoint, scope).href ||
      !policy?.includes("private") || !policy.includes("no-store")) {
    void response.body?.cancel()
    throw new Error("Could not verify the private response.")
  }
  return response
}

export function commentMentionWriteHeaders(content: string): Record<string, string> {
  const context = document.querySelector<HTMLElement>("#td-task-reference-picker")?.dataset.personContext
  return context && commentMentions(content).length ? { [commentMentionContextHeader]: context } : {}
}

export async function readCommentMentionProblem(response: Response): Promise<"context" | "mention" | undefined> {
  if (![400, 409, 410].includes(response.status) || !response.headers.get("content-type")?.includes("application/problem+json")) return
  try {
    const { type } = await response.json()
    if (type === commentMentionContextProblemType) return "context"
    if (type === commentMentionProblemType) return "mention"
  } catch {
    // A failed request can still use the editor's generic error message.
  }
}
