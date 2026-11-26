/**
 * Lightweight, lossless CSS minifier for raw inline stylesheet imports.
 * Runs once per module import on the server to shrink SSR HTML payloads
 * without increasing client `_astro/` bundle bytes.
 */
export function minifyInlineCss(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>~])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim()
}
