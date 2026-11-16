export interface RuntimeCounters {
  sseClientsActive: number
  sseBackpressureDropsTotal: number
  ingressStreamAbortsTotal: number
}

export function getRuntimeCounters(): RuntimeCounters
export function recordIngressStreamAbort(): void
export function recordSseClientConnected(): void
export function recordSseClientDisconnected(): void
export function recordSseBackpressureDrop(): void
