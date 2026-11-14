// Stored mention text is portable and has no ingress URL or raw Core identity.
const mentionPattern = /(^|\s)@\{person:([a-f0-9]{32})\|([^\s{}|]{1,960})\}/g
const redactPattern = /@\{person:([a-f0-9]{32})\|([^\s{}|]{1,960})\}/g
const ignoredPattern = /\\[^\n]|(`+)[\s\S]*?\1|\[[^\]\n]*\]\([^\n)]*\)|<(pre|code)\b[^>]*>[\s\S]*?<\/\2\s*>|<[^>\n]*>/gi
export const commentMentionContextHeader = "X-Meitheal-Mention-Context"
export const commentMentionProblemType = "https://meitheal.local/problems/comment-mention"
export const commentMentionContextProblemType = "https://meitheal.local/problems/comment-mention-context"
export const commentAttemptHeader = "x-meitheal-comment-attempt"
export const commentAttemptHorizonMs = 48 * 60 * 60_000

export function commentMentionToken(key: string, label: string): string {
  return `@{person:${key}|${encodeURIComponent(Array.from(label).slice(0, 80).join("").replace(/[\uD800-\uDFFF]/gu, "�"))}}`
}

export function hasCommentMentionSelector(content: string): boolean {
  return content.includes("@{person:")
}

export function redactCommentMentionSelectors(content: string): string {
  return hasCommentMentionSelector(content) ? content.replace(redactPattern, "@…") : content
}

export function isIndentedCommentCode(line: string): boolean {
  return /^(?: {4}| {0,3}\t)/.test(line)
}

function ignoredCommentRanges(content: string): { start: number, end: number }[] {
  const ignored: { start: number, end: number }[] = []
  let fence: { marker: string, start: number } | undefined
  let offset = 0
  let textStart = 0

  function scanInline(end: number) {
    for (const match of content.slice(textStart, end).matchAll(ignoredPattern)) {
      const start = textStart + match.index
      ignored.push({ start, end: start + match[0].length })
    }
  }

  for (const line of content.split("\n")) {
    const end = Math.min(content.length, offset + line.length + 1)
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    const marker = fenceLine?.[1]
    const info = fenceLine?.[2] ?? ""
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !info.trim()) {
        ignored.push({ start: fence.start, end })
        fence = undefined
        textStart = end
      }
    } else if (marker && (marker[0] === "~" || !info.includes("`"))) {
      scanInline(offset)
      fence = { marker, start: offset }
    } else if (isIndentedCommentCode(line)) {
      scanInline(offset)
      ignored.push({ start: offset, end })
      textStart = end
    }
    offset = end
  }
  if (fence) ignored.push({ start: fence.start, end: content.length })
  else scanInline(content.length)
  return ignored
}

export function commentMentions(content: string) {
  if (!hasCommentMentionSelector(content)) return []
  const ignored = ignoredCommentRanges(content)
  let index = 0
  return [...content.matchAll(mentionPattern)].flatMap(match => {
    const start = match.index + match[1]!.length
    const end = match.index + match[0].length
    while (ignored[index] && ignored[index]!.end <= start) index++
    if (ignored[index] && ignored[index]!.start < end) return []
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
