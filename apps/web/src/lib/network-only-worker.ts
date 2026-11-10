export function workerAllowsNetworkOnly(worker: ServiceWorker, capability: string): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => finish(false), 500)
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
