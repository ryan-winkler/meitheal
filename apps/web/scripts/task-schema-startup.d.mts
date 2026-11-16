import type { Transaction } from "@libsql/client"

export function applyStartupTaskSchema(
  tx: Transaction,
  prepareRuntime?: (tx: Transaction) => Promise<void>,
): Promise<string[]>
export function validateStartupTaskSchema(tx: Transaction, options?: { allowPendingPersonal?: boolean }): Promise<void>
