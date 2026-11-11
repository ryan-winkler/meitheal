import type { Client, Transaction } from "@libsql/client"

export function applyTaskDeferralMigration(tx: Transaction): Promise<void>
export function validateTaskDeferralSchema(db: Pick<Client, "execute">): Promise<void>
