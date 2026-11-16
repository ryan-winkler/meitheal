import type { Client, Transaction } from "@libsql/client"

export const nextHouseholdTicketNumberSql: string
export const taskBoardTicketTriggerNames: readonly string[]
export function applyTaskBoardTicketAllocator(tx: Transaction): Promise<void>
export function validateTaskBoardTicketAllocator(db: Pick<Client, "execute">): Promise<void>
