/** Normalize imported provider summaries before the common scoped task command. */
export function sanitizeTodoTitle(summary: string): string {
  // Strip recursive "📋 MTH-NN: " or "🎯 MTH-NN: " or "📖 MTH-NN: " prefixes
  let clean = summary.replace(/^([📋🎯📖✅⚡]\s*MTH-\d+:\s*)+/gu, "")
  // Also handle plain "MTH-NN: MTH-NN: " without emoji
  clean = clean.replace(/^(MTH-\d+:\s*)+/g, "")
  // Strip trailing "— DUE" repetitions (iterative to avoid ReDoS)
  while (/\s*—\s*DUE\s*$/i.test(clean)) {
    clean = clean.replace(/\s*—\s*DUE\s*$/i, "")
  }
  // Strip "Task MTH-NN is due. Open in Meitheal:..." notification text from description leaking into title
  clean = clean.replace(/\s*Task MTH-\d+ is due\.\s*Open in Meitheal:?.*/i, "")
  return clean.trim() || summary
}
