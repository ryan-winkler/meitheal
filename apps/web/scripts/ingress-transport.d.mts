export interface IngressTransport {
  peer: string
  fromSupervisor: boolean
  identityHeadersSafe: boolean
  configuredPath: string | undefined
  sseSocket?: {
    readonly writableLength: number
    destroy(): void
  } | undefined
}

export function runWithIngressTransport<T>(context: IngressTransport, handle: () => T): T
export function getIngressTransport(): IngressTransport | undefined
