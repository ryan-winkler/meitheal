/** Normalize imported provider summaries before the common scoped task command. */
export function sanitizeTodoTitle(summary: string, boardPrefix = "MTH"): string {
  let clean = summary
  // Emoji-marked wrappers are generated; a bare identifier must belong to this board.
  for (;;) {
    const prefix = /^(?:([📋🎯📖✅⚡])\s*)?(?:([A-Z0-9]{2,10})-[1-9]\d*|Task):\s*/iu.exec(clean)
    if (!prefix || (!prefix[1] && prefix[2]?.toUpperCase() !== boardPrefix.toUpperCase())) break
    clean = clean.slice(prefix[0].length)
  }
  // Strip trailing "— DUE" repetitions (iterative to avoid ReDoS)
  while (/\s*—\s*DUE\s*$/i.test(clean)) {
    clean = clean.replace(/\s*—\s*DUE\s*$/i, "")
  }
  // Strip "Task MTH-NN is due. Open in Meitheal:..." notification text from description leaking into title
  clean = clean.replace(/\s*Task (?:[A-Z0-9]{2,10}-[1-9]\d*|Task) is due\.\s*Open(?: (?:[A-Z0-9]{2,10}-[1-9]\d*|Task))? in Meitheal:?.*/i, "")
  return clean.trim() || summary
}
