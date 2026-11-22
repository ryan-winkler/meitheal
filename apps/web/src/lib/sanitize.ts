import sanitizeHtml from "sanitize-html";

/**
 * Sanitizes input text/HTML from users.
 * Strips potentially dangerous tags (script, style, iframe, object, etc.)
 * but preserves safe formatting (b, i, strong, em, a, p, br, ul, ol, li).
 */
export function sanitize(input: string): string {
  if (!input) return "";

  return sanitizeHtml(input, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol",
      "nl", "li", "b", "i", "strong", "em", "strike", "abbr", "code", "hr",
      "br", "div", "table", "thead", "caption", "tbody", "tr", "th", "td",
      "pre", "del", "span", "details", "summary",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      "*": ["class"],
    },
    allowedSchemes: ["http", "https", "ftp", "mailto"],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
  });
}

const RAW_BLOCK_RE = /^(```+|~~~+)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm
const INLINE_CODE_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1/g
const DANGEROUS_CONTAINER_RE = /<(script|style|iframe|object|applet|noscript|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const DANGEROUS_VOID_TAG_RE = /<\/?(?:script|style|iframe|object|embed|applet|base|meta|link|form|svg|math)\b[^>]*>/gi
const DANGEROUS_ATTR_RE = /\s(?:on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)|style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))/gi

/**
 * Sanitize raw Markdown on write without escaping Markdown punctuation
 * (`>`, `&`, `<`, quotes) or altering code fences/inline code spans.
 * Strips executable raw HTML blocks and inline event handlers outside code.
 */
export function sanitizeMarkdownInput(raw: string): string {
  if (!raw) return ""
  const normalized = raw.replace(/\r\n?/g, "\n")
  const tokens: string[] = []
  const stash = (value: string) => {
    const idx = tokens.push(value) - 1
    return `\u0000MD${idx}\u0000`
  }

  let text = normalized.replace(RAW_BLOCK_RE, (m) => stash(m))
  text = text.replace(INLINE_CODE_RE, (m) => stash(m))
  for (let pass = 0; pass < 3; pass++) {
    const next = text
      .replace(DANGEROUS_CONTAINER_RE, "")
      .replace(DANGEROUS_VOID_TAG_RE, "")
    if (next === text) break
    text = next
  }
  text = text.replace(/<([a-z][a-z0-9-]*)(\b[^>]*?)>/gi, (_m, tag: string, attrs: string) => {
    const cleaned = attrs
      .replace(DANGEROUS_ATTR_RE, "")
      .replace(/\b(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data):[^"']*\2/gi, "")
    return `<${tag}${cleaned}>`
  })
  text = text.replace(/(\[[^\]]*\]\(\s*)(?:javascript|vbscript|data):[^)]*(\))/gi, "$1#$2")

  return text.replace(/\u0000MD(\d+)\u0000/g, (_m, idx: string) => tokens[Number(idx)] ?? "")
}
