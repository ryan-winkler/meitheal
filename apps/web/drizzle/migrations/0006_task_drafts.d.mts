import type { Client, Transaction } from "@libsql/client"

export function applyTaskDraftsMigration(tx: Transaction): Promise<void>
export function validateTaskDraftsSchema(db: Pick<Client, "execute">): Promise<void>
