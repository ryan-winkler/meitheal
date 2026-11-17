import type { Client, Transaction } from "@libsql/client"

export const ORGANIZATION_FEATURE_SCHEMA_VERSION: number
export const ORGANIZATION_FEATURE_MIGRATION: string

export function readOrganizationFeatureMigrationState(db: Pick<Client, "execute">): Promise<boolean>
export function applyOrganizationFeatureMigration(tx: Transaction): Promise<boolean>
