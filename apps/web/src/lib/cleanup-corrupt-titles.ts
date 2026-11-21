/** Normalize imported provider summaries before the common scoped task command. */
export function sanitizeTodoTitle(summary: string): string {
  // Strip recursive "📋 MTH-NN: ", "HOME-12: ", or "📋 Task: " prefixes (including mixed nested forms)
  let clean = summary.replace(/^(?:(?:[📋🎯📖✅⚡]\s*)?(?:[A-Z0-9]{2,10}-[1-9]\d*|Task):\s*)+/iu, "")
  // Strip trailing "— DUE" repetitions (iterative to avoid ReDoS)
  while (/\s*—\s*DUE\s*$/i.test(clean)) {
    clean = clean.replace(/\s*—\s*DUE\s*$/i, "")
  }
  // Strip "Task MTH-NN is due. Open in Meitheal:..." notification text from description leaking into title
  clean = clean.replace(/\s*Task (?:[A-Z0-9]{2,10}-[1-9]\d*|Task) is due\.\s*Open(?: (?:[A-Z0-9]{2,10}-[1-9]\d*|Task))? in Meitheal:?.*/i, "")
  return clean.trim() || summary
}
