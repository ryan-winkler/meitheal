import type { Client, Transaction } from "@libsql/client"

export const ORGANIZATION_LABEL_SCHEMA_VERSION: number
export const ORGANIZATION_LABEL_MIGRATION: string
export function readOrganizationLabelMigrationState(db: Pick<Client, "execute">): Promise<boolean>
export function applyOrganizationLabelMigration(tx: Transaction): Promise<boolean>
