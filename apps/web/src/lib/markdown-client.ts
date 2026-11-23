/**
 * Lightweight zero-dependency Markdown-to-HTML renderer for browser task descriptions.
 * Replaces the ~50 KB client-side `marked` bundle while supporting the full formatting
 * subset allowed by `sanitizeClient` (headings, lists, checklists, blockquotes,
 * fenced/inline code, pipe tables, links, bold/italic/strikethrough, and rules).
 *
 * Output is escaped by default and always passed through `sanitizeClient` before DOM insertion.
 */

const SAFE_URL_RE = /^(?:https?:\/\/|mailto:|\/(?!\/)|#)/i

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function renderInline(raw: string): string {
  const codeSpans: string[] = []
  let text = escapeHtml(raw).replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSpans.push(`<code>${code}</code>`) - 1
    return `\u0000C${idx}\u0000`
  })

  // Markdown links: [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const decoded = url.replace(/&amp;/g, "&")
    if (!SAFE_URL_RE.test(decoded)) return label
    const external = /^https?:\/\//i.test(decoded)
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : ""
    return `<a href="${url}"${attrs}>${label}</a>`
  })

  // Bare http(s) URLs not already inside an anchor tag
  text = text.replace(/(^|[\s(>])(https?:\/\/[^\s<)]+)/g, (_m, prefix: string, url: string) => {
    const cleaned = url.replace(/[.,!?;:]+$/, "")
    const trailing = url.slice(cleaned.length)
    return `${prefix}<a href="${cleaned}" target="_blank" rel="noopener noreferrer">${cleaned}</a>${trailing}`
  })

  // Bold, strikethrough, italic
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>")

  return text.replace(/\u0000C(\d+)\u0000/g, (_m, idx: string) => codeSpans[Number(idx)] ?? "")
}

function splitTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim())
}

function isTableSeparatorCell(cell: string): boolean {
  let s = cell.trim()
  if (s.startsWith(":")) s = s.slice(1)
  if (s.endsWith(":")) s = s.slice(0, -1)
  if (s.length < 3) return false
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== "-") return false
  }
  return true
}

function isTableSeparator(line: string): boolean {
  let s = line.trim()
  if (!s.includes("|") || !s.includes("-")) return false
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|")) s = s.slice(0, -1)
  const cells = s.split("|")
  if (cells.length < 2) return false
  return cells.every(isTableSeparatorCell)
}

function isHorizontalRule(line: string): boolean {
  let count = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === " " || ch === "\t" || ch === "\r") continue
    if (ch === "-" || ch === "*" || ch === "_") count += 1
    else return false
  }
  return count >= 3
}

export function renderMarkdownToHtml(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  const blocks: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""
    if (!line.trim()) {
      i += 1
      continue
    }

    // Fenced code block
    const fence = line.match(/^```([^\s`]*)\s*$/)
    if (fence) {
      i += 1
      const codeLines: string[] = []
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "")
        i += 1
      }
      if (i < lines.length) i += 1
      const lang = fence[1]?.replace(/[^a-z0-9_-]/gi, "")
      const cls = lang ? ` class="language-${lang}"` : ""
      blocks.push(`<pre><code${cls}>${escapeHtml(codeLines.join("\n"))}</code></pre>`)
      continue
    }

    // ATX Heading
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i += 1
      continue
    }

    // Horizontal rule
    if (isHorizontalRule(line)) {
      blocks.push("<hr>")
      i += 1
      continue
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quoteLines.push((lines[i] ?? "").replace(/^\s*>\s?/, ""))
        i += 1
      }
      blocks.push(`<blockquote>${renderMarkdownToHtml(quoteLines.join("\n"))}</blockquote>`)
      continue
    }

    // Pipe table
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      const headers = splitTableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] ?? "").trim() && (lines[i] ?? "").includes("|")) {
        rows.push(splitTableCells(lines[i] ?? ""))
        i += 1
      }
      const thead = `<thead><tr>${headers.map(h => `<th>${renderInline(h)}</th>`).join("")}</tr></thead>`
      const tbody = rows.length
        ? `<tbody>${rows.map(row => `<tr>${headers.map((_h, idx) => `<td>${renderInline(row[idx] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`
        : ""
      blocks.push(`<table>${thead}${tbody}</table>`)
      continue
    }

    // Unordered list (including task checkboxes)
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        let content = (lines[i] ?? "").replace(/^\s*[-*+]\s+/, "")
        const check = content.match(/^\[( |x|X)\]\s+(.*)$/)
        if (check) {
          const checked = check[1].toLowerCase() === "x"
          content = `<span class="md-check">${checked ? "☑" : "☐"}</span> ${renderInline(check[2])}`
        } else {
          content = renderInline(content)
        }
        items.push(`<li>${content}</li>`)
        i += 1
      }
      blocks.push(`<ul>${items.join("")}</ul>`)
      continue
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? "")) {
        const content = (lines[i] ?? "").replace(/^\s*\d+[.)]\s+/, "")
        items.push(`<li>${renderInline(content)}</li>`)
        i += 1
      }
      blocks.push(`<ol>${items.join("")}</ol>`)
      continue
    }

    // Paragraph (consume until blank line or next block opener)
    const paraLines: string[] = []
    while (i < lines.length) {
      const cur = lines[i] ?? ""
      if (!cur.trim()) break
      if (
        paraLines.length > 0 && (
          /^```/.test(cur) ||
          /^#{1,6}\s+/.test(cur) ||
          /^\s*>\s?/.test(cur) ||
          /^\s*[-*+]\s+/.test(cur) ||
          /^\s*\d+[.)]\s+/.test(cur) ||
          isHorizontalRule(cur)
        )
      ) {
        break
      }
      paraLines.push(cur)
      i += 1
    }
    blocks.push(`<p>${paraLines.map(renderInline).join("<br>")}</p>`)
  }

  return blocks.join("\n")
}
