import { canUsePrivateWorker, privateIngressScope } from "./network-only-worker"

export async function fetchCommentPrivate(endpoint: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
  const scope = privateIngressScope()
  const worker = navigator.serviceWorker?.controller
  if (!scope || (worker && !await canUsePrivateWorker(scope, worker, "COMMENT_MENTIONS_NETWORK_ONLY"))) {
    throw new Error("Private inbox requires a current Home Assistant session and service worker.")
  }
  if (signal.aborted || navigator.serviceWorker?.controller !== worker) throw new Error("App session changed.")
  const response = await fetch("/" + endpoint, {
    ...init, signal, cache: "no-store", redirect: "error", mode: "same-origin", referrerPolicy: "same-origin",
  })
  const policy = response.headers.get("cache-control")?.split(",").map(value => value.trim().toLowerCase())
  if (navigator.serviceWorker?.controller !== worker || response.url !== new URL(endpoint, scope).href ||
      !policy?.includes("private") || !policy.includes("no-store")) {
    void response.body?.cancel()
    throw new Error("Could not verify the private response.")
  }
  return response
}

export async function isCommentMentionProblem(response: Response): Promise<boolean> {
  if (![400, 409, 410].includes(response.status) || !response.headers.get("content-type")?.includes("application/problem+json")) return false
  try {
    return (await response.json()).type === "https://meitheal.local/problems/comment-mention"
  } catch {
    return false
  }
}
