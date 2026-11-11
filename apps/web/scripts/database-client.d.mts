import type { Client, InStatement, ResultSet } from "@libsql/client"

export const DATABASE_SCHEMA_VERSION: number
export function databaseSchemaCheckSteps(): Generator<[string], void, ResultSet[]>
export function assertSupportedDatabaseSchema(client: Pick<Client, "execute">): Promise<void>
export function openDatabase(url: string, options?: { readOnly?: boolean }): Client
export function runWriteTransaction<T>(
  client: Client,
  steps: () => Generator<InStatement[], T, ResultSet[]>,
): Promise<T>
