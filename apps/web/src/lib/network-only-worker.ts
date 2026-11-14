export function workerAllowsNetworkOnly(worker: ServiceWorker, capability: string): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => finish(false), 2_500)
    function finish(ready: boolean) {
      window.clearTimeout(timer)
      channel.port1.close()
      resolve(ready)
    }
    channel.port1.onmessage = event => finish(event.data === true)
    try {
      worker.postMessage({ type: capability }, [channel.port2])
    } catch {
      finish(false)
    }
  })
}

export function privateIngressScope(): URL | null {
  const path = window.__ingress_path
  if (!window.isSecureContext || !path || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]{1,128}$/.test(path)) return null
  return new URL(path + "/", location.origin)
}

export async function canUsePrivateWorker(scope: URL, worker: ServiceWorker, capability: string): Promise<boolean> {
  const registration = await navigator.serviceWorker.getRegistration()
  return registration?.scope === scope.href && registration.active === worker &&
    worker.scriptURL === new URL("sw.js", scope).href && await workerAllowsNetworkOnly(worker, capability)
}

export async function activatePrivateWorkerUpdate(capability: string, signal: AbortSignal): Promise<boolean> {
  const scope = privateIngressScope()
  if (!scope || !navigator.serviceWorker) return false
  let registration = await navigator.serviceWorker.getRegistration()
  if (!registration || registration.scope !== scope.href) return false
  if (!registration.waiting && !registration.installing) void registration.update().catch(() => {})
  const deadline = performance.now() + 2_500
  while (!registration.waiting && !signal.aborted && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    registration = await navigator.serviceWorker.getRegistration()
    if (registration?.scope !== scope.href) return false
  }
  const waiting = registration.waiting
  if (signal.aborted || !waiting || waiting.scriptURL !== new URL("sw.js", scope).href ||
      !await workerAllowsNetworkOnly(waiting, capability)) return false
  const current = await navigator.serviceWorker.getRegistration()
  if (signal.aborted || current?.scope !== scope.href || current.waiting !== waiting || privateIngressScope()?.href !== scope.href) return false
  waiting.postMessage({ type: "SKIP_WAITING" })
  return true
}
