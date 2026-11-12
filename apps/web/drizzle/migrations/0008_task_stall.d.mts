import type { Client, Transaction } from "@libsql/client"

export function applyTaskStallMigration(tx: Transaction): Promise<void>
export function validateTaskStallSchema(db: Client | Transaction): Promise<void>

interface StallExpressions {
  newTaskDays: string
  storedTaskDays: string
  openStatuses: string
  completeStatuses: string
  commentClock: string
}

export function installTaskStallTriggers(tx: Transaction, expressions: StallExpressions): Promise<void>
export function validateTaskStallTriggers(db: Pick<Client, "execute">, expressions: StallExpressions): Promise<void>
export function taskStallTriggerDefinitions(expressions: StallExpressions): string[][]
