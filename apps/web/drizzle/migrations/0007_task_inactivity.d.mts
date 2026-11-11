import type { Client, Transaction } from "@libsql/client"

export const taskInactivityTriggerDefinitions: string[][]
export function applyTaskInactivityMigration(tx: Transaction): Promise<void>
export function validateTaskInactivitySchema(db: Client | Transaction): Promise<void>
export function installTaskInactivityTriggers(tx: Transaction): Promise<void>
export function validateTaskInactivityTriggers(db: Pick<Client, "execute">): Promise<void>
