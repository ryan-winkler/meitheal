import type { Client, Transaction } from "@libsql/client"

export const BOARD_ACCESS_SCHEMA_VERSION: 21
export const BOARD_ACCESS_MIGRATION: "0011_board_access.mjs"
export function readBoardAccessMigrationState(db: Pick<Client, "execute">): Promise<boolean>
export function applyBoardAccessMigration(tx: Transaction): Promise<boolean>
