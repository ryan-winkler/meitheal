import { buildTaskPath, buildTaskPermalink } from "@lib/task-detail-handoff"

function getReferenceTaskId(path: string): string | null {
  const prefix = "/tasks?open="
  if (!path.startsWith(prefix)) return null
  const id = new URLSearchParams(path.slice("/tasks?".length)).get("open")
  return id && path === buildTaskPath(id) ? id : null
}

export function resolveDescriptionTaskReferences(description: HTMLElement): void {
  for (const link of description.querySelectorAll<HTMLAnchorElement>('a[href^="/tasks?open="]')) {
    const id = getReferenceTaskId(link.getAttribute("href") ?? "")
    if (id) link.href = buildTaskPermalink(id)
  }
}

export function renderCommentTaskReferences(body: HTMLElement, content: string, taskLabel: string): void {
  body.textContent = ""
  let offset = 0
  for (const match of content.matchAll(/\[(MTH-[0-9]+|Task)\]\((\/tasks\?open=[^\s)]+)\)/g)) {
    const id = getReferenceTaskId(match[2] ?? "")
    if (!id) continue
    const link = document.createElement("a")
    link.href = buildTaskPermalink(id)
    link.textContent = match[1] === "Task" ? taskLabel : match[1] ?? ""
    link.className = "underline underline-offset-2 hover:text-accent"
    body.append(content.slice(offset, match.index), link)
    offset = match.index + match[0].length
  }
  body.append(content.slice(offset))
}
