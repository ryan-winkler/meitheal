import type { Client } from "@libsql/client"

export function reconcileTaskSchemaPrerequisites(client: Client): Promise<void>
export function validateTaskSchemaPrerequisites(db: Pick<Client, "execute">): Promise<void>
