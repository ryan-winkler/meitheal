import type { Client, InStatement, ResultSet, Transaction } from "@libsql/client"

type BoardMigrationState = "predecessor" | "household-v19"

export const TASK_BOARD_SCHEMA_VERSION: 19
export const TASK_BOARD_MIGRATION: "0009_task_boards.mjs"
export function taskBoardMigrationStateSteps(): Generator<[InStatement], BoardMigrationState, ResultSet[]>
export function readTaskBoardMigrationState(db: Pick<Client, "execute">): Promise<BoardMigrationState>
export function validateTaskBoardUpgrade(db: Pick<Client, "execute">): Promise<void>
export function applyTaskBoardUpgrade(tx: Transaction, predecessorMigrationNames: readonly string[]): Promise<void>
