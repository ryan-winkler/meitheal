import { AsyncLocalStorage } from "node:async_hooks"

// The standalone wrapper and Astro's bundled middleware may load separate
// copies of this module. They share one in-process, request-local store.
const key = Symbol.for("meitheal.ingress.transport")
const transport = globalThis[key] ??= new AsyncLocalStorage()

export function runWithIngressTransport(context, handle) {
  context.behindIngress ??= false
  context.streamingIngressHtml ??= false
  context.abortRecorded ??= false
  return transport.run(context, handle)
}

export function getIngressTransport() {
  return transport.getStore()
}

// Astro's Node adapter writes each chunk without waiting for the socket.
export function waitForDownloadDrain(response, signal) {
  if (signal.aborted || response.destroyed || response.writableEnded) return false
  if (!response.writableNeedDrain) return true

  return new Promise(resolve => {
    const drained = () => finish(true)
    const closed = () => finish(false)
    function finish(ready) {
      response.off("drain", drained)
      response.off("close", closed)
      response.off("error", closed)
      signal.removeEventListener("abort", closed)
      resolve(ready)
    }
    response.once("drain", drained)
    response.once("close", closed)
    response.once("error", closed)
    signal.addEventListener("abort", closed, { once: true })
  })
}
