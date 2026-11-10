import type { ServerResponse } from "node:http"

export interface IngressTransport {
  peer: string
  fromSupervisor: boolean
  identityHeadersSafe: boolean
  configuredPath: string | undefined
  sseSocket?: {
    readonly writableLength: number
    destroy(): void
  } | undefined
  waitForDatabaseDownloadDrain?: ((signal: AbortSignal) => boolean | Promise<boolean>) | undefined
}

export function runWithIngressTransport<T>(context: IngressTransport, handle: () => T): T
export function getIngressTransport(): IngressTransport | undefined
export function waitForDownloadDrain(response: ServerResponse, signal: AbortSignal): boolean | Promise<boolean>
