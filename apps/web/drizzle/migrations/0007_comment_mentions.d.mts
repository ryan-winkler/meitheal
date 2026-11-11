import type { Client, Transaction } from "@libsql/client"

export function applyCommentMentionsMigration(tx: Transaction): Promise<void>
export function validateCommentMentionsSchema(db: Pick<Client, "execute">): Promise<void>
