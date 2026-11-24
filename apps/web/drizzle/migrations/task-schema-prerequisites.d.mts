import type { Client, Transaction } from "@libsql/client"

export function reconcileTaskSchemaPrerequisites(client: Client): Promise<void>
export function applyTaskSchemaPrerequisites(tx: Transaction): Promise<void>
export function seedHouseholdTaskPrerequisites(tx: Transaction): Promise<void>
export function validateTaskSchemaPrerequisites(
  db: Pick<Client, "execute">,
  options?: { boardScopedLanes?: boolean },
): Promise<void>
