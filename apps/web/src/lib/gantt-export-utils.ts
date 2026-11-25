/**
 * Pure utilities for resolving CSS custom properties inside SVG trees
 * prior to rasterizing Gantt/Timeline charts onto an HTMLCanvasElement.
 *
 * Standalone SVG blobs rendered into <img> do NOT inherit document CSS
 * custom properties (`var(--...)`), which causes fills/strokes to fall back
 * to solid black unless resolved beforehand.
 *
 * @domain tasks/timeline
 */

const SVG_COLOR_ATTRS = ["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"] as const

/**
 * Resolve all `var(--token, fallback)` expressions in a CSS value string,
 * including nested fallbacks such as `var(--a, var(--b, #111))`.
 */
export function resolveCssVarExpression(
  value: string,
  getVar: (name: string) => string,
  maxDepth = 8,
): string {
  if (!value || !value.includes("var(")) return value

  let current = value
  for (let depth = 0; depth < maxDepth && current.includes("var("); depth++) {
    let out = ""
    let cursor = 0
    while (cursor < current.length) {
      const start = current.indexOf("var(", cursor)
      if (start === -1) {
        out += current.slice(cursor)
        break
      }
      out += current.slice(cursor, start)

      // Walk matching parentheses so nested var(..., var(...)) resolves cleanly
      let i = start + 4
      let parenDepth = 1
      let commaIdx = -1
      while (i < current.length && parenDepth > 0) {
        const ch = current[i]
        if (ch === "(") parenDepth++
        else if (ch === ")") parenDepth--
        else if (ch === "," && parenDepth === 1 && commaIdx === -1) commaIdx = i
        i++
      }

      if (parenDepth !== 0) {
        // Malformed var( — preserve remainder verbatim
        out += current.slice(start)
        break
      }

      const rawName = (commaIdx === -1 ? current.slice(start + 4, i - 1) : current.slice(start + 4, commaIdx)).trim()
      const fallback = commaIdx === -1 ? "" : current.slice(commaIdx + 1, i - 1).trim()
      const resolved = rawName.startsWith("--") ? getVar(rawName).trim() : ""
      out += resolved || fallback || "currentColor"
      cursor = i
    }
    if (out === current) break
    current = out
  }
  return current
}

/**
 * Walk an SVG subtree and inline all `var(--...)` references in presentation
 * attributes and inline style strings using computed root styles.
 */
export function inlineSvgCssVariables(
  svgRoot: Element,
  getVar: (name: string) => string,
  fallbackTextColor = "#e2e8f0",
): void {
  const resolveValue = (raw: string): string => {
    const resolved = resolveCssVarExpression(raw, getVar)
    return resolved === "currentColor" ? fallbackTextColor : resolved
  }

  const processNode = (node: Element) => {
    for (const attr of SVG_COLOR_ATTRS) {
      const raw = node.getAttribute(attr)
      if (raw && (raw.includes("var(") || raw === "currentColor")) {
        node.setAttribute(attr, resolveValue(raw))
      }
    }
    const styleAttr = node.getAttribute("style")
    if (styleAttr && styleAttr.includes("var(")) {
      node.setAttribute("style", resolveCssVarExpression(styleAttr, getVar))
    }
  }

  processNode(svgRoot)
  const descendants = svgRoot.querySelectorAll("*")
  for (let i = 0; i < descendants.length; i++) {
    processNode(descendants[i]!)
  }
}

/**
 * Sanitize a timeline title for PNG filename export.
 */
export function buildTimelineExportFilename(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `meitheal-timeline-${y}-${m}-${d}.png`
}
