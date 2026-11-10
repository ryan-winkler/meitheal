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
      a: ["href", "name", "target"],
      img: ["src", "alt", "title", "width", "height"],
      "*": ["class", "id", "style"], // Allow class/id/style for basic layout if copied from markdown
    },
    allowedSchemes: ["http", "https", "ftp", "mailto"],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: true,
  });
}
