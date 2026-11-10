import { workerAllowsNetworkOnly } from "./network-only-worker"

export const DEFERRAL_TIMEOUT_MS = 8000
export const TASK_COUNTS_CHANGED = "meitheal:task-counts-changed"
export const DEFERRAL_RECONCILED = "meitheal:deferral-reconciled"

export interface DeferralReconciliation {
  taskId?: string
  changedIds?: string[]
  dataOnly?: boolean
}

export interface DeferralGuard {
  updated_at: number
  deferral_revision: string | null
}

export interface DeferralState extends DeferralGuard {
  id: string
  status: string
  deferred_at: number | null
}

type DeferralOutcome =
  | { kind: "saved"; task: DeferralState }
  | { kind: "blocked"; blockers: string[] }
  | { kind: "changed" | "failed" | "uncertain" }

export async function allowsDeferral(worker = navigator.serviceWorker?.controller ?? null): Promise<boolean> {
  return (!worker || await workerAllowsNetworkOnly(worker, "DEFERRED_NETWORK_ONLY")) &&
    (navigator.serviceWorker?.controller ?? null) === worker
}

export function readDeferralGuard(version: unknown, revision: unknown): DeferralGuard | null {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 ||
      (revision !== null && (typeof revision !== "string" || !/^[a-f0-9]{32}$/.test(revision)))) return null
  return { updated_at: version, deferral_revision: revision }
}

function validateState(raw: unknown, id: string, detail: boolean): DeferralState | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as Record<string, unknown>
  const guard = readDeferralGuard(detail ? body.task_version : body.updated_at, body.deferral_revision)
  const marker = body.deferred_at
  if (!guard || body.id !== id || typeof body.status !== "string" ||
      (marker !== null && (typeof marker !== "number" || !Number.isSafeInteger(marker) || marker < 0))) return null
  return { ...guard, id, status: body.status, deferred_at: marker }
}

let nonce = 0

export async function readFreshDeferral(id: string, signal: AbortSignal): Promise<DeferralState> {
  const worker = navigator.serviceWorker?.controller ?? null
  if (!await allowsDeferral(worker)) throw new Error("The current worker needs an update")
  const path = `/api/tasks/${encodeURIComponent(id)}?deferralRead=${performance.timeOrigin}-${++nonce}`
  const expected = new URL((window.__ingress_path?.replace(/\/+$/, "") ?? "") + path, location.origin)
  const response = await fetch(path, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(DEFERRAL_TIMEOUT_MS)]),
  })
  if (!response.ok || response.url !== expected.href || !response.headers.get("cache-control")?.includes("no-store")) {
    void response.body?.cancel()
    throw new Error("Fresh task details are unavailable")
  }
  const task = validateState(await response.json(), id, true)
  if (!task || signal.aborted || (navigator.serviceWorker?.controller ?? null) !== worker) {
    throw new Error("Task details changed before verification")
  }
  return task
}

export async function writeDeferral(id: string, deferred: boolean, guard: DeferralGuard, signal: AbortSignal): Promise<DeferralOutcome> {
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/deferral`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "X-Meitheal-Local-Conflict": "1" },
      body: JSON.stringify({ deferred, ...guard }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(DEFERRAL_TIMEOUT_MS)]),
    })
    if (response.status >= 500) {
      void response.body?.cancel()
      return { kind: "uncertain" }
    }
    const body = await response.json()
    if (response.ok) {
      const task = validateState(body, id, false)
      return task && (task.deferred_at !== null) === deferred ? { kind: "saved", task } : { kind: "uncertain" }
    }
    if (response.status === 409 && body?.errorCode === "TASK_BLOCKED" && Array.isArray(body.blocked_by)) {
      const blockers = body.blocked_by.map((item: { ticket_key?: unknown; title?: unknown } | null) => item?.ticket_key || item?.title)
        .filter((label: unknown): label is string => typeof label === "string")
      return { kind: "blocked", blockers }
    }
    if (response.status === 409) return { kind: "changed" }
    return { kind: "failed" }
  } catch {
    return { kind: "uncertain" }
  }
}

export function notifyTaskCountsChanged(...projectIds: Array<string | null | undefined>): void {
  const ids = [...new Set(projectIds.filter((id): id is string => Boolean(id)))]
  window.dispatchEvent(new CustomEvent(TASK_COUNTS_CHANGED, { detail: { projectIds: ids } }))
}
