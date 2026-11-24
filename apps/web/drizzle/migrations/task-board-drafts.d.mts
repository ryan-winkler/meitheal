import type { Client, Transaction } from "@libsql/client"

export const taskBoardDraftStagingNames: readonly string[]
export function applyTaskBoardDraftStorage(tx: Transaction): Promise<void>
export function validateTaskBoardDraftStorage(db: Pick<Client, "execute">, allowedObjects?: readonly string[]): Promise<void>
