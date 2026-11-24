import type { Client, Transaction } from "@libsql/client"

export const TASK_EXPERIENCE_SCHEMA_VERSION: number
export const TASK_EXPERIENCE_MIGRATION: string

export function readTaskExperienceMigrationState(db: Pick<Client, "execute">): Promise<boolean>
export function applyTaskExperienceMigration(tx: Transaction): Promise<boolean>
