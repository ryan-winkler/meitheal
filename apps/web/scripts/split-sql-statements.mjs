export function splitSqlStatements(sql) {
  const statements = [];
  let buffer = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";

    if (inLineComment) {
      buffer += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      buffer += char;
      if (char === "*" && next === "/") {
        buffer += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        buffer += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
        continue;
      }
      buffer += char;
      continue;
    }

    if (inSingleQuote) {
      buffer += char;
      if (char === "'" && next === "'") {
        buffer += next;
        index += 1;
        continue;
      }
      if (char === "'" && next !== "'") {
        inSingleQuote = false;
        continue;
      }
      if (char === "\\" && next) {
        buffer += next;
        index += 1;
      }
      continue;
    }

    if (inDoubleQuote) {
      buffer += char;
      if (char === "\"" && next === "\"") {
        buffer += next;
        index += 1;
        continue;
      }
      if (char === "\"" && next !== "\"") {
        inDoubleQuote = false;
        continue;
      }
      if (char === "\\" && next) {
        buffer += next;
        index += 1;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      buffer += char + next;
      index += 1;
      inLineComment = true;
      continue;
    }

    if (char === "/" && next === "*") {
      buffer += char + next;
      index += 1;
      inBlockComment = true;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      buffer += char;
      continue;
    }

    if (char === "\"") {
      inDoubleQuote = true;
      buffer += char;
      continue;
    }

    if (char === "$") {
      const tail = sql.slice(index);
      const dollarTagMatch = tail.match(/^\$\$/) ?? tail.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
      if (dollarTagMatch) {
        dollarQuoteTag = dollarTagMatch[0];
        buffer += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        continue;
      }
    }

    if (char === ";") {
      const statement = buffer.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      buffer = "";
      continue;
    }

    buffer += char;
  }

  const tail = buffer.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }

  return statements;
}
