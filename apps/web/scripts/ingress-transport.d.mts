import type { ServerResponse } from "node:http"

export type WaitForResponseDrain = (signal: AbortSignal) => boolean | Promise<boolean>

export interface IngressTransport {
  peer: string
  fromSupervisor: boolean
  identityHeadersSafe: boolean
  configuredPath: string | undefined
  sseSocket?: {
    readonly writableLength: number
    destroy(): void
  } | undefined
  waitForDatabaseDownloadDrain?: WaitForResponseDrain | undefined
  waitForHtmlDrain?: WaitForResponseDrain | undefined
}

export function runWithIngressTransport<T>(context: IngressTransport, handle: () => T): T
export function getIngressTransport(): IngressTransport | undefined
export function waitForDownloadDrain(response: ServerResponse, signal: AbortSignal): boolean | Promise<boolean>
