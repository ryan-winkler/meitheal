/**
 * Client-safe HTML sanitizer using the browser-native DOMParser.
 *
 * This is the browser-side counterpart to `sanitize.ts` (which uses the
 * Node-only `sanitize-html` package). Using `sanitize-html` in client code
 * pulls postcss/fs/path/source-map-js into the bundle via its transitive
 * dependency on postcss, flooding the console with "Module externalized
 * for browser compatibility" warnings.
 *
 * @domain tasks
 * @bounded-context ui
 */

/** Tags allowed in user-generated HTML (mirrors server-side allowlist). */
const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol",
  "li", "b", "i", "strong", "em", "strike", "abbr", "code", "hr",
  "br", "div", "table", "thead", "caption", "tbody", "tr", "th", "td",
  "pre", "del", "span", "details", "summary",
])

/** Attributes allowed per-tag. `*` applies to all tags. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "name", "target"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  "*": new Set(["class", "id", "style"]),
}

/** Allowed URL schemes for href/src. */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "mailto:"])

/** Dangerous URI schemes to block (case-insensitive). */
const BLOCKED_SCHEMES = /^\s*(javascript|vbscript|data|blob):/i

function isAllowedUrl(value: string): boolean {
  // Block dangerous schemes first (case-insensitive to prevent bypass)
  if (BLOCKED_SCHEMES.test(value)) return false
  try {
    const url = new URL(value, window.location.origin)
    return ALLOWED_SCHEMES.has(url.protocol)
  } catch {
    // Relative URLs that didn't parse are fine (e.g. "#anchor", "/path")
    return true
  }
}

function sanitizeNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(true)

  if (node.nodeType !== Node.ELEMENT_NODE) return null

  const el = node as Element
  const tag = el.tagName.toLowerCase()

  if (!ALLOWED_TAGS.has(tag)) {
    // Strip the tag but keep safe children
    const frag = document.createDocumentFragment()
    for (const child of Array.from(el.childNodes)) {
      const clean = sanitizeNode(child)
      if (clean) frag.appendChild(clean)
    }
    return frag
  }

  const clone = document.createElement(tag)

  // Copy allowed attributes
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    const tagAllowed = ALLOWED_ATTRS[tag]
    const globalAllowed = ALLOWED_ATTRS["*"]
    if (tagAllowed?.has(name) || globalAllowed?.has(name)) {
      // Validate URL attributes
      if ((name === "href" || name === "src") && !isAllowedUrl(attr.value)) {
        continue
      }
      clone.setAttribute(name, attr.value)
    }
  }

  // Recursively sanitize children
  for (const child of Array.from(el.childNodes)) {
    const clean = sanitizeNode(child)
    if (clean) clone.appendChild(clean)
  }

  return clone
}

/**
 * Sanitizes HTML for safe rendering in the browser.
 * Strips dangerous tags (script, style, iframe, etc.) and attributes
 * while preserving safe formatting markup.
 */
export function sanitizeClient(input: string): string {
  if (!input) return ""

  const parser = new DOMParser()
  const doc = parser.parseFromString(input, "text/html")
  const frag = document.createDocumentFragment()

  for (const child of Array.from(doc.body.childNodes)) {
    const clean = sanitizeNode(child)
    if (clean) frag.appendChild(clean)
  }

  const wrapper = document.createElement("div")
  wrapper.appendChild(frag)
  return wrapper.innerHTML
}
