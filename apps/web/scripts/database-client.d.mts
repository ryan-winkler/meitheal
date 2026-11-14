import type { Client, InArgs, InStatement, ResultSet } from "@libsql/client"

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
