import type { Client, InStatement, ResultSet, Transaction } from "@libsql/client"

export const taskWriteTriggerMetadata: InStatement
export function validateExistingTaskWriteTriggers(metadata: ResultSet): void
export function installTaskActivityTriggers(tx: Transaction): Promise<void>
export function validateTaskActivityTriggers(db: Pick<Client, "execute">): Promise<void>
