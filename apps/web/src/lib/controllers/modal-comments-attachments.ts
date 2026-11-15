/**
 * modal-comments-attachments.ts — Comments and image attachments loader
 *
 * @domain tasks
 * @kcs Renders the comments and attachment sections of the task detail panel.
 */
import {
  getAttachmentsByTaskId,
  deleteAttachment,
} from "@domains/offline/offline-store"
import { confirmDialog } from "@lib/confirm-dialog"
import { createClientLogger } from "@lib/client-logger"
import { notifyInactivityTaskChanged } from "@lib/inactivity-client"
import { buildTaskPermalink } from "@lib/task-detail-handoff"
import { isActiveParticipantProblem } from "@lib/task-participant-problem"
import { commentMentionWriteHeaders, readCommentMentionProblem } from "@lib/comment-mention-client"
import { renderCommentTaskReferences } from "@lib/task-references"
import { mountReactions } from "./modal-reactions"

const log = createClientLogger("tasks", "comments-attachments")

function attachCommentManagement(
  wrapper: HTMLElement, body: HTMLElement, content: string, taskLabel: string, taskId: string, url: string, signal: AbortSignal,
): void {
  const template = document.querySelector<HTMLTemplateElement>("#td-comment-management")
  if (!template) return
  const controls = template.content.cloneNode(true) as DocumentFragment
  const actions = controls.querySelector<HTMLElement>("[data-comment-actions]")!
  const edit = controls.querySelector<HTMLButtonElement>("[data-comment-edit]")!
  const remove = controls.querySelector<HTMLButtonElement>("[data-comment-delete]")!
  const form = controls.querySelector<HTMLFormElement>("form")!
  const input = form.querySelector("textarea")!
  const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const cancel = form.querySelector<HTMLButtonElement>("[data-comment-cancel]")!
  const error = controls.querySelector<HTMLElement>('[role="alert"]')!
  const hint = controls.querySelector<HTMLElement>("[data-reference-hint]")!
  error.id = `${wrapper.id}-error`
  hint.id = `${wrapper.id}-reference-hint`
  input.setAttribute("aria-describedby", `${error.id} ${hint.id}`)
  wrapper.append(controls)

  const isCurrent = () => !signal.aborted && wrapper.isConnected
  function endEdit() {
    form.hidden = true
    actions.hidden = false
    body.hidden = false
    error.textContent = ""
    edit.focus()
  }

  edit.addEventListener("click", () => {
    input.value = content
    error.textContent = ""
    body.hidden = true
    actions.hidden = true
    form.hidden = false
    input.focus()
  }, { signal })
  cancel.addEventListener("click", endEdit, { signal })
  form.addEventListener("submit", async event => {
    event.preventDefault()
    if (save.disabled) return
    error.textContent = ""
    input.readOnly = true
    save.disabled = true
    cancel.disabled = true
    try {
      const response = await fetch(url, { // nosemgrep
        method: "PATCH",
        headers: { "content-type": "application/json", ...commentMentionWriteHeaders(input.value) },
        body: JSON.stringify({ content: input.value }),
        signal,
      })
      if (!response.ok) {
        const participantDenied = await isActiveParticipantProblem(response)
        const mentionFailure = await readCommentMentionProblem(response)
        if (isCurrent()) error.textContent = (participantDenied ? template.dataset.participantRequired
          : mentionFailure === "context" ? template.dataset.mentionContextChanged
          : mentionFailure ? template.dataset.mentionFailed : template.dataset.editFailed) ?? ""
        throw new Error("Comment edit failed")
      }
      notifyInactivityTaskChanged(taskId)
      const updated = await response.json() as { content: string }
      if (!isCurrent()) return
      content = updated.content
      renderCommentTaskReferences(body, content, taskLabel)
      endEdit()
    } catch {
      if (isCurrent()) {
        error.textContent ||= template.dataset.editFailed ?? ""
        input.focus()
      }
    } finally {
      input.readOnly = false
      save.disabled = false
      cancel.disabled = false
    }
  }, { signal })
  remove.addEventListener("click", async () => {
    error.textContent = ""
    remove.focus()
    const confirmed = await confirmDialog({
      title: remove.textContent ?? undefined,
      message: template.dataset.deletePrompt ?? "",
      confirmText: remove.textContent ?? undefined,
      cancelText: cancel.textContent ?? undefined,
      variant: "danger",
      signal,
    })
    if (!confirmed || !isCurrent()) return
    edit.disabled = true
    remove.disabled = true
    try {
      const response = await fetch(url, { method: "DELETE", signal }) // nosemgrep
      if (!response.ok) {
        const participantDenied = await isActiveParticipantProblem(response)
        if (isCurrent() && participantDenied) error.textContent = template.dataset.participantRequired ?? ""
        throw new Error("Comment deletion failed")
      }
      notifyInactivityTaskChanged(taskId)
      if (!isCurrent()) return
      const next = wrapper.nextElementSibling ?? wrapper.previousElementSibling
      wrapper.remove()
      const focusTarget = next instanceof HTMLElement ? next : document.getElementById("td-comment-input")
      focusTarget?.focus()
    } catch {
      if (isCurrent()) {
        error.textContent ||= template.dataset.deleteFailed ?? ""
        remove.disabled = false
        remove.focus()
      }
    } finally {
      edit.disabled = false
      remove.disabled = false
    }
  }, { signal })
}

/**
 * Load and render comments for a task.
 */
export async function loadComments(
  taskId: string, signal: AbortSignal, commentTarget: string | null = null, postedCommentId?: number,
): Promise<void> {
  const container = document.getElementById("td-comments")
  const status = document.getElementById("td-comment-link-status")
  if (!container) return
  const taskLabel = container.dataset.taskLabel ?? "Task"
  if (postedCommentId !== undefined && document.getElementById(`td-comment-${postedCommentId}`)) return
  const url = `/api/tasks/${encodeURIComponent(taskId)}/comments`

  function showLinkStatus(message: string | undefined) {
    if (signal.aborted || commentTarget === null || !status || !message) return
    status.textContent = message
    status.focus()
  }

  try {
    const res = await fetch(url, { signal, cache: "no-store" }) // nosemgrep
    if (!res.ok) {
      showLinkStatus(status?.dataset.loadFailed)
      return
    }
    const data = (await res.json()) as {
      comments: Array<{
        id: number
        content: string
        author: string
        created_at: string
        can_manage: boolean
      }>
    }
    if (signal.aborted) return
    let linkedComment: HTMLElement | undefined
    for (const c of data.comments || []) {
      if (postedCommentId !== undefined && c.id !== postedCommentId) continue
      const wrapper = document.createElement("article")
      wrapper.className = "bg-bg-card rounded-md p-3 border border-border focus:outline-2 focus:outline-accent"

      const meta = document.createElement("div")
      meta.className = "flex flex-wrap justify-between gap-1 text-xs text-text-muted mb-1"
      const authorSpan = document.createElement("span")
      authorSpan.textContent = c.author
      const dateLink = document.createElement("a")
      const timestamp = new Date(c.created_at).toLocaleString()
      dateLink.textContent = timestamp
      dateLink.href = buildTaskPermalink(taskId, c.id)
      dateLink.className = "underline underline-offset-2 hover:text-accent"
      const linkLabel = container.dataset.linkLabel
      if (linkLabel) {
        dateLink.title = linkLabel
        dateLink.setAttribute("aria-label", `${linkLabel}, ${c.author}, ${timestamp}`)
      }
      meta.append(authorSpan, dateLink)

      const body = document.createElement("div")
      body.className = "text-sm text-text-primary whitespace-pre-wrap break-words"
      renderCommentTaskReferences(body, c.content, taskLabel)

      wrapper.id = `td-comment-${c.id}`
      wrapper.tabIndex = -1
      body.id = `td-comment-body-${c.id}`
      wrapper.setAttribute("aria-label", `${c.author}, ${timestamp}`)
      wrapper.setAttribute("aria-describedby", body.id)
      wrapper.append(meta, body)
      if (c.can_manage === true) attachCommentManagement(wrapper, body, c.content, taskLabel, taskId, `${url}/${c.id}`, signal)
      mountReactions(wrapper, `${url}/${c.id}/reactions`, signal)
      container.appendChild(wrapper)
      if (String(c.id) === commentTarget) linkedComment = wrapper
    }
    if (linkedComment) linkedComment.focus()
    else showLinkStatus(status?.dataset.unavailable)
  } catch {
    showLinkStatus(status?.dataset.loadFailed)
  }
}

/**
 * Load and render image attachment thumbnails for a task.
 */
export async function loadAttachments(taskId: string): Promise<void> {
  const container = document.getElementById(
    "td-attachments",
  ) as HTMLElement
  if (!container) return
  container.replaceChildren()

  try {
    const attachments = await getAttachmentsByTaskId(taskId)
    if (attachments.length === 0) {
      const emptyLabel = document.createElement("span")
      emptyLabel.className = "text-[10px] text-text-muted italic"
      emptyLabel.textContent = "No attachments."
      container.appendChild(emptyLabel)
      return
    }

    attachments.forEach((att) => {
      const thumb = document.createElement("div")
      thumb.className =
        "relative group cursor-pointer border border-border rounded-md overflow-hidden hover:border-accent transition-colors"
      thumb.style.width = "64px"
      thumb.style.height = "64px"

      const img = document.createElement("img")
      img.src = att.base64Data
      img.className = "w-full h-full object-cover"
      img.title = att.filename

      // Delete overlay
      const delOverlay = document.createElement("div")
      delOverlay.className =
        "absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
      const delBtn = document.createElement("button")
      delBtn.className = "text-white text-xs hover:text-danger p-2"
      delBtn.textContent = "🗑"
      delBtn.onclick = async (e) => {
        e.stopPropagation()
        const ok = await confirmDialog({
          message: "Delete this attachment?",
          variant: "danger",
          confirmText: "Delete",
          title: "Delete Attachment",
        })
        if (ok) {
          await deleteAttachment(att.id)
          loadAttachments(taskId)
        }
      }
      delOverlay.appendChild(delBtn)

      // Lightbox view on click
      thumb.onclick = () => {
        const html = `<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;"><img src="${att.base64Data}" style="max-width:100%;max-height:100vh;" /></body></html>`
        const blob = new Blob([html], { type: "text/html" })
        window.open(URL.createObjectURL(blob), "_blank")
      }

      thumb.appendChild(img)
      thumb.appendChild(delOverlay)
      container.appendChild(thumb)
    })
  } catch (e) {
    log.error("Failed to load attachments", e)
    const errLabel = document.createElement("span")
    errLabel.className = "text-xs text-danger"
    errLabel.textContent = "Failed to load attachments"
    container.appendChild(errLabel)
  }
}
