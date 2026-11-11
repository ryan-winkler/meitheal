import type { Client, Transaction } from "@libsql/client"

export function applyTaskPinsMigration(tx: Transaction): Promise<void>
export function validateTaskPinsSchema(db: Pick<Client, "execute">): Promise<void>
