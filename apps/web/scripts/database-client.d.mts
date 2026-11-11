import type { Client, InStatement, ResultSet } from "@libsql/client"

export function openDatabase(url: string): Client
export function runWriteTransaction<T>(
  client: Client,
  steps: () => Generator<InStatement[], T, ResultSet[]>,
): Promise<T>
