import { activatePrivateWorkerUpdate, canUsePrivateWorker, privateIngressScope } from "./network-only-worker"

const activeCapability = "TASK_PINS_NETWORK_ONLY"
const waitingCapability = "TASK_PINS_IMPLEMENTED"
const contextHeader = "X-Meitheal-Pin-Context"
const contextPattern = /^[A-Za-z0-9_-]{43}$/
const leaseDurationMs = 10_000
const renewalDelayMs = 5_000
const idleDurationMs = 60_000
export const pinsInvalidated = "meitheal:task-pins-invalidated"

export class PinAccessError extends Error {
  constructor(readonly kind: "account" | "update" | "network") {
    super(kind)
  }
}

export interface PinTask {
  id: string
  title: string
  ticket_key: string | null
  status: string
  deferred_at: number | null
  pinned_at: number
}

interface PinDetail {
  id: string
  pinned: boolean
  pinned_at: number | null
}

interface PinPage {
  page: number
  total: number
  items: PinTask[]
}

export interface PinLease {
  context: string
  verifiedAt: number
  transport: PinTransport
}

interface PinTransport {
  scope: URL
  controller: ServiceWorker | null
}

export function supportsPersonalPins(): boolean {
  return privateIngressScope() !== null
}

function captureTransport(): PinTransport {
  const scope = privateIngressScope()
  if (!scope) throw new PinAccessError("account")
  return { scope, controller: navigator.serviceWorker?.controller ?? null }
}

function isCurrent({ scope, controller }: PinTransport) {
  return privateIngressScope()?.href === scope.href && (navigator.serviceWorker?.controller ?? null) === controller
}

async function checkWorker(transport: PinTransport, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!isCurrent(transport)) throw new PinAccessError("account")
  const worker = transport.controller
  if (!worker) return
  if (!await canUsePrivateWorker(transport.scope, worker, activeCapability)) {
    throw new PinAccessError("update")
  }
  signal.throwIfAborted()
  if (!isCurrent(transport)) throw new PinAccessError("account")
}

export function activatePinUpdate(signal: AbortSignal): Promise<boolean> {
  return activatePrivateWorkerUpdate(waitingCapability, signal)
}

async function request(
  transport: PinTransport, method: "POST" | "PUT" | "HEAD", signal: AbortSignal, body?: object, context?: string,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(4_000)])
  await checkWorker(transport, deadline)
  const url = new URL("api/task-pins", transport.scope)
  const response = await fetch(url.href, {
    method, mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "same-origin", signal: deadline,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(context ? { [contextHeader]: context } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!isCurrent(transport)) throw new PinAccessError("account")
  if ([401, 403, 409].includes(response.status)) throw new PinAccessError("account")
  if (response.url !== url.href || !response.headers.get("cache-control")?.includes("no-store") ||
      response.status !== (method === "HEAD" ? 204 : 200)) throw new PinAccessError("network")
  const value = method === "HEAD" ? undefined : await response.json()
  deadline.throwIfAborted()
  if (!isCurrent(transport)) throw new PinAccessError("account")
  return value
}

export async function verifyPinLease(lease: PinLease, signal: AbortSignal): Promise<PinLease> {
  const verifiedAt = performance.now()
  await request(lease.transport, "HEAD", signal, undefined, lease.context)
  return { ...lease, verifiedAt }
}

async function verifiedRead<T>(body: object, signal: AbortSignal, expected?: PinLease): Promise<{ value: T; lease: PinLease }> {
  const transport = expected?.transport ?? captureTransport()
  const value = await request(transport, "POST", signal, body)
  if (!value || typeof value.context !== "string" || !contextPattern.test(value.context)) throw new PinAccessError("network")
  if (expected && value.context !== expected.context) throw new PinAccessError("account")
  const lease = await verifyPinLease({ context: value.context, transport, verifiedAt: 0 }, signal)
  return { value, lease }
}

export function readPinPage(page: number, signal: AbortSignal, expected?: PinLease) {
  return verifiedRead<PinPage>({ action: "list", page }, signal, expected)
}

export function readTaskPin(task: string, signal: AbortSignal, expected?: PinLease) {
  return verifiedRead<PinDetail>({ action: "detail", task }, signal, expected)
}

export async function setTaskPin(task: string, pinned: boolean, lease: PinLease, signal: AbortSignal) {
  if (performance.now() >= lease.verifiedAt + leaseDurationMs) throw new PinAccessError("account")
  await request(lease.transport, "PUT", signal, { task, pinned }, lease.context)
}

/** Keep only a verified foreground lease. The deadline is measured from HEAD dispatch. */
export function watchPinLease(
  initial: PinLease, signal: AbortSignal, lastInteraction: () => number,
  refreshed: (lease: PinLease) => void, expired: (error?: unknown) => void,
): () => void {
  const controller = new AbortController()
  const active = AbortSignal.any([signal, controller.signal])
  let expiryTimer: number | undefined
  let renewalTimer: number | undefined
  const clear = () => { window.clearTimeout(expiryTimer); window.clearTimeout(renewalTimer) }
  active.addEventListener("abort", clear, { once: true })

  function end(error?: unknown) {
    if (active.aborted) return
    controller.abort()
    expired(error)
  }

  function arm(lease: PinLease) {
    clear()
    expiryTimer = window.setTimeout(() => end(), Math.max(0, lease.verifiedAt + leaseDurationMs - performance.now()))
    renewalTimer = window.setTimeout(async () => {
      if (active.aborted || document.visibilityState === "hidden" || performance.now() - lastInteraction() >= idleDurationMs) return
      try {
        const result = await verifyPinLease(lease, active)
        if (!active.aborted) {
          refreshed(result)
          arm(result)
        }
      } catch (error) {
        end(error)
      }
    }, Math.max(0, lease.verifiedAt + renewalDelayMs - performance.now()))
  }

  if (!active.aborted) arm(initial)
  return () => controller.abort()
}
