import { AsyncLocalStorage } from "node:async_hooks"

// The standalone wrapper and Astro's bundled middleware may load separate
// copies of this module. They share one in-process, request-local store.
const key = Symbol.for("meitheal.ingress.transport")
const transport = globalThis[key] ??= new AsyncLocalStorage()

export function runWithIngressTransport(context, handle) {
  return transport.run(context, handle)
}

export function getIngressTransport() {
  return transport.getStore()
}
