// SQLite uses ASCII whitespace and ends a line comment at LF.
const sqlTokens = sql => (sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w\u0080-\uFFFF]+|[^ \t\r\n\f\v]/g) ?? [])
  .filter(token => !token.startsWith("--") && !token.startsWith("/*"))
  .map(token => /^\w+$/.test(token) ? token.toLowerCase() : token)

export const normalizeSql = sql => sqlTokens(sql).join(" ")

export const matchesSql = (actual, expected) => typeof actual === "string" && normalizeSql(actual) === normalizeSql(expected)

export function tableDefinitions(sql) {
  const tokens = sqlTokens(sql)
  const start = tokens.indexOf("(")
  if (start < 0) return []
  const definitions = []
  let depth = 0
  let definitionStart = start + 1
  for (let index = definitionStart; index < tokens.length; index++) {
    const part = tokens[index]
    if (depth === 0 && (part === "," || part === ")")) {
      definitions.push(tokens.slice(definitionStart, index).join(" "))
      definitionStart = index + 1
      if (part === ")") break
    } else if (part === "(") {
      depth++
    } else if (part === ")") {
      depth--
    }
  }
  return definitions
}

const placeholders = values => values.map(() => "?").join(", ")
const identifier = name => `"${name.replaceAll('"', '""')}"`

export async function assertBoardStorageWriter(tx, tables) {
  if (typeof tx.commit !== "function" || tx.closed) throw new Error("Board storage requires a write transaction")
  const { rows: [settings] } = await tx.execute("PRAGMA foreign_keys")
  if (Number(settings?.foreign_keys) !== 1) throw new Error("Board storage requires SQLite foreign keys")
  const { rows: shadowed } = await tx.execute({
    sql: `SELECT 1 FROM temp.sqlite_schema WHERE type IN ('table', 'view')
      AND name COLLATE NOCASE IN (${placeholders(tables)}) LIMIT 1`,
    args: tables,
  })
  if (shadowed.length > 0) throw new Error("Cannot migrate Board storage with a temporary object shadowing an App table")
}

export async function assertNoInboundReferences(tx, tables) {
  const { rows } = await tx.execute({
    sql: `SELECT schema.name FROM main.sqlite_schema AS schema
      JOIN pragma_foreign_key_list(schema.name, 'main') AS foreign_key
      WHERE schema.type = 'table' AND foreign_key."table" COLLATE NOCASE IN (${placeholders(tables)}) LIMIT 1`,
    args: tables,
  })
  if (rows.length > 0) throw new Error(`Cannot replace ${tables.join(", ")} with existing foreign key references`)
}

const externalSchema = tables => ({
  sql: `SELECT 'main' AS schema_name, name, type, tbl_name, sql FROM main.sqlite_schema
    WHERE tbl_name COLLATE NOCASE NOT IN (${placeholders(tables)}) AND sql IS NOT NULL
    UNION ALL SELECT 'temp', name, type, tbl_name, sql FROM temp.sqlite_schema
    WHERE sql IS NOT NULL ORDER BY schema_name, name, type`,
  args: tables,
})

export async function moveBoardStorageTables(tx, names) {
  const { rows: [settings] } = await tx.execute("PRAGMA legacy_alter_table")
  if (Number(settings?.legacy_alter_table) !== 0) throw new Error("Board storage requires SQLite schema dependency checks")
  const tables = Object.keys(names)
  const { rows: before } = await tx.execute(externalSchema(tables))
  // SQLite resolves references in views and triggers during rename.
  for (const [name, staging] of Object.entries(names)) {
    await tx.execute(`ALTER TABLE main.${identifier(name)} RENAME TO ${identifier(staging)}`)
  }
  const { rows: after } = await tx.execute(externalSchema(Object.values(names)))
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`Cannot replace ${tables.join(", ")} with existing schema dependencies`)
  }
}
