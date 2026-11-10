/** Resolve an external provider link before opening it in a browser. */
export function parseAiHandoffUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value.trim())
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url
  } catch {
    return null
  }
  return null
}
