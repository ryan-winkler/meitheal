import type { Client, Transaction } from "@libsql/client"

export const taskBoardHouseholdTriggerNames: readonly string[]
export const taskBoardHouseholdObjectNames: readonly string[]
export function applyTaskBoardHouseholdPhase(tx: Transaction): Promise<void>
export function validateTaskBoardHouseholdPhase(db: Pick<Client, "execute">): Promise<void>

export const lifecycleHouseholdIdentitySql: string
