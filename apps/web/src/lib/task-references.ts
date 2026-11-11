import { commentMentions } from "@lib/comment-mentions"
import { buildTaskPath, buildTaskPermalink } from "@lib/task-detail-handoff"
import { ticketIdFromPath } from "@lib/task-page-url"

function getReferenceTaskId(path: string): string | null {
  const prefix = "/tasks?open="
  if (path.startsWith(prefix)) {
    const id = new URLSearchParams(path.slice("/tasks?".length)).get("open")
    return id && path === `/tasks?${new URLSearchParams({ open: id })}` ? id : null
  }
  const id = ticketIdFromPath(path)
  return id && path === buildTaskPath(id) ? id : null
}

export function resolveDescriptionTaskReferences(description: HTMLElement): void {
  for (const link of description.querySelectorAll<HTMLAnchorElement>('a[href^="/tasks?open="], a[href^="/tickets/"]')) {
    const id = getReferenceTaskId(link.getAttribute("href") ?? "")
    if (id) link.href = buildTaskPermalink(id)
  }
}

export function renderCommentTaskReferences(body: HTMLElement, content: string, taskLabel: string): void {
  const references = commentMentions(content).map(({ label, start, end }) => {
    const mention = document.createElement("span")
    mention.className = "font-semibold"
    mention.textContent = "@" + label
    return { start, end, element: mention as HTMLElement }
  })
  for (const match of content.matchAll(/\[(MTH-[0-9]+|Task)\]\((\/(?:tasks\?open=|tickets\/)[^\s)]+)\)/g)) {
    const id = getReferenceTaskId(match[2] ?? "")
    if (!id) continue
    const link = document.createElement("a")
    link.href = buildTaskPermalink(id)
    link.textContent = match[1] === "Task" ? taskLabel : match[1] ?? ""
    link.className = "underline underline-offset-2 hover:text-accent"
    references.push({ start: match.index, end: match.index + match[0].length, element: link })
  }
  body.textContent = ""
  let offset = 0
  for (const { start, end, element } of references.sort((a, b) => a.start - b.start)) {
    if (start < offset) continue
    body.append(content.slice(offset, start), element)
    offset = end
  }
  body.append(content.slice(offset))
}
