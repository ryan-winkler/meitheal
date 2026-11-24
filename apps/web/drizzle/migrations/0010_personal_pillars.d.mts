import type { Client, Transaction } from "@libsql/client"

export const PERSONAL_PILLAR_SCHEMA_VERSION: 20
export const PERSONAL_PILLAR_MIGRATION: "0010_personal_pillars.mjs"
export function readPersonalPillarMigrationState(db: Pick<Client, "execute">): Promise<boolean>
export function applyPersonalPillarMigration(tx: Transaction): Promise<boolean>
