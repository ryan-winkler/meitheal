import type { Client } from "@libsql/client"
export const boardGrantPath: string
export const boardGrantRevisionQuery: string
export function registerBoardGrantContext(client: object, context?: { markerPath?: string; created?: boolean }): void
export function getBoardGrantPath(client: object): string
export function unwrapBoardGrantClient<T extends object>(client: T): T
export function consumeDatabaseCreation(client: object): boolean
