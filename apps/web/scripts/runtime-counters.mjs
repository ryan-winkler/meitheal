// Shared cross-bundle in-process runtime counters (unbundled serve.mjs + bundled Astro routes).
const key = Symbol.for("meitheal.runtime.counters")
const state = (globalThis[key] ??= {
  sseClientsActive: 0,
  sseBackpressureDropsTotal: 0,
  ingressStreamAbortsTotal: 0,
})

export function getRuntimeCounters() {
  return {
    sseClientsActive: state.sseClientsActive,
    sseBackpressureDropsTotal: state.sseBackpressureDropsTotal,
    ingressStreamAbortsTotal: state.ingressStreamAbortsTotal,
  }
}

export function recordIngressStreamAbort() {
  state.ingressStreamAbortsTotal += 1
}

export function recordSseClientConnected() {
  state.sseClientsActive += 1
}

export function recordSseClientDisconnected() {
  state.sseClientsActive = Math.max(0, state.sseClientsActive - 1)
}

export function recordSseBackpressureDrop() {
  state.sseBackpressureDropsTotal += 1
}
