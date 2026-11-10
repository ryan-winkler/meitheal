import { createRequire } from "node:module"
import { createClient as createSQLiteClient } from "@libsql/client/sqlite3"

// Keep remote transport dependencies out of the default local SQLite runtime.
export function openDatabase(url) {
  if (url.startsWith("file:") || url === ":memory:") {
    return createSQLiteClient({ url })
  }

  const require = createRequire(import.meta.url)
  const { createClient } = require("@libsql/client")
  return createClient({ url })
}
