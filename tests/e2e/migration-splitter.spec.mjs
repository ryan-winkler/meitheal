import { expect, test } from "@playwright/test";
import { splitSqlStatements } from "../../apps/web/scripts/split-sql-statements.mjs";

test("splitSqlStatements preserves semicolons inside quotes and comments", () => {
  const sql = `
    -- semicolon in line comment ; should not split
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    INSERT INTO tasks(id, title) VALUES('1', 'Cook; dinner');
    /* semicolon in block comment ; should not split */
    INSERT INTO tasks(id, title) VALUES('2', "Quoted; title");
  `;

  const statements = splitSqlStatements(sql);
  expect(statements).toHaveLength(3);
  expect(statements[0]).toContain("CREATE TABLE tasks");
  expect(statements[1]).toContain("'Cook; dinner'");
  expect(statements[2]).toContain('"Quoted; title"');
});

test("splitSqlStatements handles dollar-quoted bodies as one statement", () => {
  const sql = `
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    INSERT INTO audit_log(payload)
    VALUES($tag$line 1;
line 2; -- still in literal
$tag$);
    INSERT INTO audit_log(payload) VALUES('done');
  `;

  const statements = splitSqlStatements(sql);
  expect(statements).toHaveLength(3);
  expect(statements[1]).toContain("$tag$line 1;");
  expect(statements[2]).toContain("VALUES('done')");
});

test("splitSqlStatements skips empty statements around repeated delimiters", () => {
  const statements = splitSqlStatements(" ; ; SELECT 1;; ");
  expect(statements).toEqual(["SELECT 1"]);
});
