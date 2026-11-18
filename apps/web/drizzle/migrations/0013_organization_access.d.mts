import type { Client, Transaction } from "@libsql/client"

export const ORGANIZATION_ACCESS_SCHEMA_VERSION: number
export const ORGANIZATION_ACCESS_MIGRATION: string

export function readOrganizationAccessMigrationState(db: Pick<Client, "execute">): Promise<boolean>
export function applyOrganizationAccessMigration(tx: Transaction): Promise<boolean>
