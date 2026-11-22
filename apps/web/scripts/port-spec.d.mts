export declare const MAX_RESOLVED_PORTS: number
export declare const DEFAULT_WEBSERVER_PORT: number

export type PortSpecMode = "single" | "list" | "range" | "mixed"

export interface ParsedPortSpec {
  ok: true
  raw: string
  ports: number[]
  primaryPort: number
  mode: PortSpecMode
  hasPrivilegedPorts: boolean
  normalized: string
}

export interface PortSpecError {
  ok: false
  error: string
}

export type PortSpecResult = ParsedPortSpec | PortSpecError

export declare function formatPortSummary(ports: number[]): string
export declare function parsePortSpec(input: string | number | number[] | null | undefined): PortSpecResult
