import sanitizeHtml from "sanitize-html"

/**
 * Sanitizes input text/HTML from users.
 * Strips potentially dangerous tags (script, style, iframe, object, etc.)
 * but preserves safe formatting (b, i, strong, em, a, p, br, ul, ol, li).
 */
export function sanitize(input: string): string {
  if (!input) return ""

  return sanitizeHtml(input, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol",
      "nl", "li", "b", "i", "strong", "em", "strike", "abbr", "code", "hr",
      "br", "div", "table", "thead", "caption", "tbody", "tr", "th", "td",
      "pre", "del", "span", "details", "summary",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      "*": ["class"],
    },
    allowedSchemes: ["http", "https", "ftp", "mailto"],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
  })
}

const RAW_BLOCK_RE = /^(```+|~~~+)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm
const SAFE_RELATIVE_MD_URL = /^(?:#|\/(?!\/)|\.\.?\/)/
const SAFE_MD_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

function stashInlineCodeSpans(text: string, stash: (value: string) => string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    if (text[i] === "`") {
      let runEnd = i + 1
      while (runEnd < text.length && text[runEnd] === "`") runEnd++
      const fenceLen = runEnd - i
      const lineEnd = text.indexOf("\n", runEnd)
      const searchEnd = lineEnd === -1 ? text.length : lineEnd
      let closeStart = -1
      let j = runEnd
      while (j < searchEnd) {
        if (text[j] === "`") {
          let k = j + 1
          while (k < searchEnd && text[k] === "`") k++
          if (k - j === fenceLen) {
            closeStart = j
            break
          }
          j = k
          continue
        }
        j++
      }
      if (closeStart !== -1 && closeStart > runEnd) {
        const closeEnd = closeStart + fenceLen
        out += stash(text.slice(i, closeEnd))
        i = closeEnd
        continue
      }
      out += text.slice(i, runEnd)
      i = runEnd
      continue
    }
    out += text[i++]!
  }
  return out
}

function safeFromCodePoint(cp: number): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

function decodeHtmlEntitiesQuick(value: string): string {
  return value
    .replace(/&#(\d+);?/g, (_m, n: string) => safeFromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);?/gi, (_m, n: string) => safeFromCodePoint(parseInt(n, 16)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
}

function isSafeMarkdownHref(rawHref: string): boolean {
  const cleaned = decodeHtmlEntitiesQuick(rawHref).replace(/[\u0000-\u0020\u007f]+/g, "").trim()
  if (!cleaned) return false
  if (SAFE_RELATIVE_MD_URL.test(cleaned)) return true
  try {
    const parsed = new URL(cleaned)
    return SAFE_MD_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

function sanitizeHtmlRegions(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    if (text[i] === "<" && i + 1 < text.length && /[a-zA-Z!?/]/.test(text[i + 1]!)) {
      let j = i + 1
      let quote = ""
      while (j < text.length) {
        const ch = text[j]!
        if (quote) {
          if (ch === quote) quote = ""
        } else if (ch === "\"" || ch === "'") {
          quote = ch
        } else if (ch === ">") {
          j++
          break
        }
        j++
      }
      const openTag = text.slice(i, j)
      const tagMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(openTag)
      if (tagMatch && !openTag.endsWith("/>")) {
        const tag = tagMatch[1]!.toLowerCase()
        const lowerRest = text.slice(j).toLowerCase()
        const closeIdx = lowerRest.indexOf(`</${tag}>`)
        if (closeIdx !== -1) {
          const endIdx = j + closeIdx + tag.length + 3
          out += sanitize(text.slice(i, endIdx))
          i = endIdx
          continue
        }
      }
      out += sanitize(openTag)
      i = j
      continue
    }
    out += text[i++]!
  }
  return out
}

function sanitizeMarkdownLinks(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    if (text[i] === "[" && (i === 0 || text[i - 1] !== "\\")) {
      const closeBracket = text.indexOf("]", i + 1)
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        let depth = 1
        let k = closeBracket + 2
        while (k < text.length && depth > 0) {
          if (text[k] === "(" && text[k - 1] !== "\\") depth++
          else if (text[k] === ")" && text[k - 1] !== "\\") depth--
          k++
        }
        if (depth === 0) {
          const rawTarget = text.slice(closeBracket + 2, k - 1).trim()
          const hrefToken = rawTarget.startsWith("<") && rawTarget.includes(">")
            ? rawTarget.slice(1, rawTarget.indexOf(">"))
            : rawTarget.split(/\s+/)[0] ?? ""
          if (!isSafeMarkdownHref(hrefToken)) {
            out += `${text.slice(i, closeBracket + 2)}#)`
            i = k
            continue
          }
        }
      }
    }
    out += text[i++]!
  }
  return out
}

/**
 * Sanitize raw Markdown on write without escaping Markdown punctuation
 * (`>`, `&`, `<`, quotes) or altering code fences/inline code spans.
 * Strips executable raw HTML tags and unsafe link schemes outside code.
 */
export function sanitizeMarkdownInput(raw: string): string {
  if (!raw) return ""
  const normalized = raw.replace(/\u0000/g, "").replace(/\r\n?/g, "\n")
  const tokens: string[] = []
  const stash = (value: string) => {
    const idx = tokens.push(value) - 1
    return `\u0000MD${idx}\u0000`
  }

  let text = normalized.replace(RAW_BLOCK_RE, m => stash(m))
  text = stashInlineCodeSpans(text, stash)
  text = sanitizeHtmlRegions(text)
  text = sanitizeMarkdownLinks(text)

  return text.replace(/\u0000MD(\d+)\u0000/g, (_m, idx: string) => tokens[Number(idx)] ?? "")
}
