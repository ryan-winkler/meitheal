import type { Client, Row, Transaction } from "@libsql/client"

export const taskDeferralTriggerName: string
export function validateExistingTaskDeferralTrigger(object: Row | undefined): void
export function applyTaskDeferralMigration(tx: Transaction): Promise<void>
export function validateTaskDeferralSchema(db: Pick<Client, "execute">): Promise<void>
