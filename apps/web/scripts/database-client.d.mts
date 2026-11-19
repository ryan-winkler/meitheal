import type { Client, InArgs, InStatement, ResultSet, Transaction } from "@libsql/client"

export interface DatabaseDiagnostics {
  sqliteBusyRetriesTotal: number
  sqliteBusyExhaustedTotal: number
  readPoolHitsTotal: number
  readPoolOverflowTotal: number
  readLeaseSlowWarningsTotal: number
}

export interface WriteExecutionOptions {
  signal?: AbortSignal | undefined
}

export const DATABASE_SCHEMA_VERSION: number
export function getDatabaseDiagnostics(): DatabaseDiagnostics
export function resetDatabaseDiagnosticsForTests(): void
export function databaseSchemaCheckSteps(): Generator<[string], void, ResultSet[]>
export function assertSupportedDatabaseSchema(client: Pick<Client, "execute">): Promise<void>
export function openDatabase(url: string, options?: { readOnly?: boolean }): Client
export function isMemoryDatabase(url: string): boolean
export function isLocalReadSnapshot(transaction: Transaction): boolean
export interface DatabaseStartupOptions {
  readOnly?: boolean
  markerPath?: string | undefined
  trustedInitialization?: { kind: "isolated-memory" }
}
export function openDatabaseForStartup(url: string, options?: DatabaseStartupOptions): Promise<Client>
export function enableStartupWal(client: Client): Promise<ResultSet>
export function withStartupWriteTransaction<T>(client: Client, apply: (tx: Transaction) => Promise<T>): Promise<T>
export function acquireWriteTransaction(client: Pick<Client, "transaction">, options?: WriteExecutionOptions): Promise<Transaction>
export function runWriteTransaction<T>(
  client: Client,
  steps: () => Generator<InStatement[], T, ResultSet[]>,
  options?: WriteExecutionOptions,
): Promise<T>
export function executeWriteWithRetry(
  client: Client,
  statement: InStatement,
  options?: WriteExecutionOptions,
): Promise<ResultSet>
export function executeWriteWithRetry(
  client: Client,
  statements: Array<InStatement | [string, InArgs?]>,
  options?: WriteExecutionOptions,
): Promise<ResultSet[]>
