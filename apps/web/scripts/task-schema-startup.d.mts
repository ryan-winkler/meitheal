import type { Transaction } from "@libsql/client"

export function applyStartupTaskSchema(
  tx: Transaction,
  prepareRuntime?: (tx: Transaction) => Promise<void>,
): Promise<string[]>
export function validateStartupTaskSchema(tx: Pick<import("@libsql/client").Client, "execute">, options?: { allowPending?: boolean }): Promise<void>
export function applyStartupBoardSchema(
  client: import("@libsql/client").Client,
  tx: Transaction,
  prepareRuntime?: (tx: Transaction) => Promise<void>,
  options?: { operatorAdmission?: object },
): Promise<{ applied: string[], state: "ready" | "continuity_locked", pending: string[], revision: string | null }>
