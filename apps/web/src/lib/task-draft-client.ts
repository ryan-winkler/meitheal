import { activatePrivateWorkerUpdate, canUsePrivateWorker, privateIngressScope } from "./network-only-worker"
import type { SavedTaskDraft, TaskDraftRead, TaskDraftReceipt, TaskDraftWrite } from "./task-draft-state"

export { privateIngressScope }

export const draftLeaseDuration = 10_000
export const draftRenewAfter = 5_000

type DraftReply = {
  draft?: SavedTaskDraft | null
  latestReceipt?: TaskDraftReceipt | null
  receipt?: TaskDraftReceipt | null
  resolution?: { state: "saved" | "open" | "unavailable" } | { state: "published"; receipt: TaskDraftReceipt }
}

export class DraftAccessError extends Error {
  constructor(readonly kind: "account" | "update" | "conflict" | "invalid" | "busy" | "network") {
    super(kind)
  }
}

export type DraftLease = {
  context: string
  verifiedAt: number
  scope: URL
  worker: ServiceWorker | null
}

export function activateDraftUpdate(signal: AbortSignal) {
  return activatePrivateWorkerUpdate("TASK_DRAFTS_IMPLEMENTED", signal)
}

function currentWorker() {
  return navigator.serviceWorker?.controller ?? null
}

function requireSameTransport(scope: URL, worker: ServiceWorker | null) {
  if (!navigator.onLine || scope.href !== privateIngressScope()?.href || worker !== currentWorker()) {
    throw new DraftAccessError("network")
  }
}

async function request(
  { scope, worker, context }: DraftLease,
  method: "HEAD" | "POST" | "PUT", signal: AbortSignal,
  data?: TaskDraftRead | TaskDraftWrite,
): Promise<Response> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  requireSameTransport(scope, worker)
  if (worker && !await canUsePrivateWorker(scope, worker, "TASK_DRAFTS_NETWORK_ONLY")) throw new DraftAccessError("update")
  deadline.throwIfAborted()
  requireSameTransport(scope, worker)
  const url = new URL("api/task-drafts", scope)
  const response = await fetch(url.href, { // nosemgrep
    method, mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "same-origin", signal: deadline,
    headers: {
      ...(data ? { "content-type": "application/json" } : {}),
      ...(context && method !== "POST" ? { "X-Meitheal-Draft-Context": context } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
  deadline.throwIfAborted()
  requireSameTransport(scope, worker)
  if (response.url !== url.href) throw new DraftAccessError("network")
  if (response.status === 401 || response.status === 403) throw new DraftAccessError("account")
  if (!response.headers.get("cache-control")?.includes("no-store")) throw new DraftAccessError("network")
  if (response.status === 409) {
    if (method === "HEAD") throw new DraftAccessError("account")
    const code = (await response.json().catch(() => null))?.errorCode
    throw new DraftAccessError(code === "ACCOUNT_CHANGED" ? "account" : code === "REVISION_CONFLICT" ? "conflict" : "network")
  }
  if (response.status === 400 || response.status === 413 || response.status === 422) throw new DraftAccessError("invalid")
  if (response.status === 503 && response.headers.has("retry-after")) throw new DraftAccessError("busy")
  if (method === "HEAD" ? response.status !== 204 : ![200, 201].includes(response.status)) throw new DraftAccessError("network")
  return response
}

export async function verifyDraftLease(lease: DraftLease, signal: AbortSignal): Promise<DraftLease> {
  const verifiedAt = performance.now()
  await request(lease, "HEAD", signal)
  return { ...lease, verifiedAt }
}

export async function readDraft(action: TaskDraftRead, signal: AbortSignal, prior?: DraftLease) {
  const scope = privateIngressScope()
  if (!scope) throw new DraftAccessError("account")
  const unverified = prior ?? { scope, worker: currentWorker(), context: "", verifiedAt: 0 }
  const response = await request(unverified, "POST", signal, action)
  const data: DraftReply & { context?: string } = await response.json()
  signal.throwIfAborted()
  if (!data.context || !/^[a-zA-Z0-9_-]{43}$/.test(data.context)) throw new DraftAccessError("network")
  if (prior && data.context !== prior.context) throw new DraftAccessError("account")
  const lease = await verifyDraftLease({ ...unverified, context: data.context }, signal)
  return { data, lease }
}

export async function writeDraft(action: TaskDraftWrite, current: DraftLease, signal: AbortSignal) {
  if (performance.now() - current.verifiedAt >= draftLeaseDuration) throw new DraftAccessError("account")
  const response = await request(current, "PUT", signal, action)
  const data: DraftReply = await response.json()
  signal.throwIfAborted()
  const lease = await verifyDraftLease(current, signal)
  return { data, lease }
}
