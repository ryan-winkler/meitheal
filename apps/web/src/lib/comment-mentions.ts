// Stored mention text is portable and has no ingress URL or raw Core identity.
const mentionPattern = /(^|\s)@\{person:([a-f0-9]{32})\|([^\s{}|]{1,960})\}/g
const ignoredPattern = /\\[^\n]|(`+)[\s\S]*?\1|\[[^\]\n]*\]\([^\n)]*\)|<[^>\n]*>/g
export const commentAttemptHeader = "x-meitheal-comment-attempt"
export const commentAttemptHorizonMs = 48 * 60 * 60_000

export function commentMentionToken(key: string, label: string): string {
  return `@{person:${key}|${encodeURIComponent(Array.from(label).slice(0, 80).join("").replace(/[\uD800-\uDFFF]/gu, "�"))}}`
}

export function commentMentions(content: string) {
  if (!content.includes("@{person:")) return []
  const ignored = [...content.matchAll(ignoredPattern)]
  let index = 0
  return [...content.matchAll(mentionPattern)].flatMap(match => {
    const start = match.index + match[1]!.length
    const end = match.index + match[0].length
    while (ignored[index] && ignored[index]!.index + ignored[index]![0].length <= start) index++
    if (ignored[index] && ignored[index]!.index < end) return []
    try {
      const label = decodeURIComponent(match[3]!)
      const key = match[2]!
      if (!label || /[\u0000-\u001f\u007f]/u.test(label) || commentMentionToken(key, label) !== content.slice(start, end)) return []
      return [{ key, label, start, end }]
    } catch {
      return []
    }
  })
}
