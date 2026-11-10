import type { Client, Transaction } from "@libsql/client"

export function applyTaskStallMigration(tx: Transaction): Promise<void>
export function validateTaskStallSchema(db: Client | Transaction): Promise<void>
export function installTaskStallTriggers(tx: Transaction, expressions: {
  newTaskDays: string
  storedTaskDays: string
  openStatuses: string
  completeStatuses: string
  commentClock: string
}): Promise<void>
