import type { Client, InStatement, Row } from "@libsql/client"

export type TaskClockColumn = "tasks.created_at" | "comment.created_at" | "created_at" | "updated_at" | "t.updated_at" | "task.updated_at" | "tasks.updated_at" | "confirmation.updated_at"

export const activeStatuses: string
export const openStatuses: string
export const completeStatuses: string
export const validInactivityRevisionSql: string
export function inactivityDaysSql(simulate?: boolean, area?: string): string
export function taskTimestampMs(column: TaskClockColumn): string
export function activityTriggerCatalogQuery(names: string[]): InStatement
export function findActivityTrigger(rows: Row[], name: string): Row | undefined
export function reconcileActivityTriggerDefinitions(
  db: Pick<Client, "execute">,
  definitions: string[][],
  family: string,
  createMissing: boolean,
): Promise<void>
export function validateActivityTriggerDefinition(object: Row | undefined, definition: string[], family: string): void
