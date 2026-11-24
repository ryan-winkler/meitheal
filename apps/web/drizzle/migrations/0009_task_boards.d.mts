import type { Client, Transaction } from "@libsql/client"

export const taskBoardStorageObjectNames: readonly string[]
export function applyTaskBoardStorage(tx: Transaction): Promise<void>
export function validateTaskBoardStorage(db: Pick<Client, "execute">, allowedObjects?: readonly string[]): Promise<void>
