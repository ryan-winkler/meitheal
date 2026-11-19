import type { Client, Transaction } from "@libsql/client"
export { boardGrantPath, getBoardGrantPath } from "./board-grant-context.mjs"
export function pendingFile(path: string, revision: string): string
export function syncDirectory(path: string): Promise<void>
export function readBoardGrantRevision(path?: string): Promise<string | null>
export function databaseRevision(db: Pick<Client, "execute">): Promise<string | null>
export function prepareGrantMarker(path: string, revision: string): Promise<void>
export function publishCommittedMarker(path: string, revision: string): Promise<boolean>
export function boardGrantStillCurrent(db: Pick<Client, "execute">, revision: string, path?: string): Promise<boolean>
export function currentBoardGrantRevision(db: Pick<Client, "execute" | "transaction">, path?: string): Promise<string | null>
export function initializeBoardGrantContinuity(client: Client, tx: Transaction): Promise<string | null>
export function prepareInitialBoardGrant(tx: Transaction, markerPath: string): Promise<string>
export function finalizeStartupBoardGrant(client: Client, revision: string | null): Promise<void>
export function admitStartupBoardTransition(client: Client, tx: Transaction, operatorAdmission?: object): Promise<{ admission: object, revision: string } | null>
