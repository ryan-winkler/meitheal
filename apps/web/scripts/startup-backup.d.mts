import type { Client } from "@libsql/client"

export function autoBackupDb(client: Client): Promise<void>
