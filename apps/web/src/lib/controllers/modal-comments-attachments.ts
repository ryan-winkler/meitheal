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
  wrapper: HTMLElement, bubble: HTMLElement, body: HTMLElement, content: string, taskLabel: string, taskId: string, url: string, signal: AbortSignal,
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
  bubble.append(controls)

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
  task: { id: string, ticket_key: string | null }, signal: AbortSignal, commentTarget: string | null = null, postedCommentId?: number,
): Promise<void> {
  const taskId = task.id
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
    const comments = data.comments || []
    if (comments.length === 0 && postedCommentId === undefined) {
      const empty = document.createElement("div")
      empty.className = "td-chat-empty"
      empty.textContent = "No comments yet. Start the conversation below or add a reaction."
      container.replaceChildren(empty)
      showLinkStatus(status?.dataset.unavailable)
      return
    }
    container.querySelector(".td-chat-empty")?.remove()

    const authorInitials = (name: string): string => {
      const parts = name.trim().split(/\s+/).filter(Boolean)
      if (parts.length === 0) return "?"
      if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
      return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
    }

    let linkedComment: HTMLElement | undefined
    for (const c of comments) {
      if (postedCommentId !== undefined && c.id !== postedCommentId) continue
      const isMine = c.can_manage === true

      const wrapper = document.createElement("article")
      wrapper.className = `chat-item${isMine ? " chat-item--me" : ""}`
      wrapper.id = `td-comment-${c.id}`
      wrapper.tabIndex = -1

      const avatar = document.createElement("span")
      avatar.className = "td-chat-avatar"
      avatar.setAttribute("aria-hidden", "true")
      avatar.textContent = authorInitials(c.author || "U")

      const bubble = document.createElement("div")
      bubble.className = `chat-bubble${isMine ? " chat-bubble-me" : ""}`

      const title = document.createElement("div")
      title.className = "chat-bubble-title"
      const authorSpan = document.createElement("div")
      authorSpan.className = "chat-bubble-author"
      authorSpan.textContent = c.author
      const dateWrap = document.createElement("div")
      dateWrap.className = "chat-bubble-date"
      const dateLink = document.createElement("a")
      const timestamp = new Date(c.created_at).toLocaleString()
      dateLink.textContent = timestamp
      dateLink.href = buildTaskPermalink(task, c.id)
      dateLink.className = "td-chat-date-link"
      const linkLabel = container.dataset.linkLabel
      if (linkLabel) {
        dateLink.title = linkLabel
        dateLink.setAttribute("aria-label", `${linkLabel}, ${c.author}, ${timestamp}`)
      }
      dateWrap.appendChild(dateLink)
      title.append(authorSpan, dateWrap)

      const body = document.createElement("div")
      body.className = "chat-bubble-body whitespace-pre-wrap break-words"
      body.id = `td-comment-body-${c.id}`
      renderCommentTaskReferences(body, c.content, taskLabel)

      const footer = document.createElement("div")
      footer.className = "td-chat-bubble-footer"

      wrapper.setAttribute("aria-label", `${c.author}, ${timestamp}`)
      wrapper.setAttribute("aria-describedby", body.id)
      bubble.append(title, body, footer)
      if (isMine) attachCommentManagement(wrapper, bubble, body, c.content, taskLabel, taskId, `${url}/${c.id}`, signal)
      mountReactions(footer, `${url}/${c.id}/reactions`, signal)

      if (isMine) {
        wrapper.append(bubble, avatar)
      } else {
        wrapper.append(avatar, bubble)
      }
      container.appendChild(wrapper)
      if (String(c.id) === commentTarget) linkedComment = wrapper
    }
    if (linkedComment) linkedComment.focus()
    else showLinkStatus(status?.dataset.unavailable)
  } catch {
    showLinkStatus(status?.dataset.loadFailed)
  }
}

let attachmentsLoadSeq = 0

function replaceAttachmentContents(container: HTMLElement, contents: Node, anchor?: HTMLElement): void {
  const scroller = anchor ? container.closest<HTMLElement>(".td-scroller") : null
  const bounds = anchor && scroller?.contains(anchor) ? anchor.getBoundingClientRect() : undefined
  const viewport = bounds ? scroller?.getBoundingClientRect() : undefined
  const top = bounds && viewport && bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom
    ? bounds.top
    : undefined

  container.replaceChildren(contents)

  // Keep the visible trigger at its current position when Attachments grows above it.
  if (anchor && scroller && top !== undefined) {
    const shift = anchor.getBoundingClientRect().top - top
    if (shift) scroller.scrollTop += shift
  }
}

/**
 * Load and render image attachment thumbnails for a task.
 */
export async function loadAttachments(taskId: string, anchor?: HTMLElement): Promise<void> {
  const container = document.getElementById(
    "td-attachments",
  ) as HTMLElement
  if (!container) return
  const seq = ++attachmentsLoadSeq
  if (!anchor || container.dataset.activeTaskId !== taskId) container.replaceChildren()
  container.dataset.activeTaskId = taskId
  const isCurrent = () => seq === attachmentsLoadSeq && container.dataset.activeTaskId === taskId && container.isConnected

  try {
    const attachments = await getAttachmentsByTaskId(taskId)
    if (!isCurrent()) return
    const contents = document.createDocumentFragment()
    const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i

    attachments.forEach((att) => {
      const safeSrc = typeof att.base64Data === "string" && SAFE_IMAGE_DATA_URL_RE.test(att.base64Data.trim())
        ? att.base64Data.trim()
        : null
      if (!safeSrc) return

      const thumb = document.createElement("div")
      thumb.className =
        "relative group cursor-pointer border border-border rounded-md overflow-hidden hover:border-accent transition-colors focus-visible:outline-2 focus-visible:outline-accent"
      thumb.style.width = "64px"
      thumb.style.height = "64px"
      thumb.tabIndex = 0
      thumb.dataset.attachmentId = att.id
      thumb.setAttribute("role", "button")
      thumb.setAttribute("aria-label", `Preview ${att.filename || "attachment"}`)

      const img = document.createElement("img")
      img.src = safeSrc
      img.alt = att.filename || "Attachment"
      img.className = "w-full h-full object-cover"
      img.title = att.filename

      // Delete overlay
      const delOverlay = document.createElement("div")
      delOverlay.className =
        "absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
      const delBtn = document.createElement("button")
      delBtn.type = "button"
      delBtn.className = "text-white text-sm font-semibold hover:text-danger p-2"
      delBtn.setAttribute("aria-label", `Delete ${att.filename || "attachment"}`)
      delBtn.textContent = "×"
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

      // Safe in-page lightbox dialog (no raw HTML blob or window.open)
      const openLightbox = () => {
        const dialog = document.createElement("dialog")
        dialog.className = "m-attachment-lightbox"
        dialog.setAttribute("aria-label", "Image preview")
        dialog.style.cssText = "padding:0;border:none;background:transparent;max-width:92vw;max-height:92vh;overflow:visible;"
        const fullImg = document.createElement("img")
        fullImg.src = safeSrc
        fullImg.alt = att.filename || "Attachment preview"
        fullImg.style.cssText = "display:block;max-width:90vw;max-height:86vh;border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,0.6);"
        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "×"
        closeBtn.setAttribute("aria-label", "Close attachment preview")
        closeBtn.style.cssText = "position:absolute;top:-14px;right:-14px;width:32px;height:32px;border-radius:999px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:18px;cursor:pointer;"
        const dismiss = () => { dialog.close(); dialog.remove() }
        closeBtn.addEventListener("click", dismiss)
        dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dismiss() })
        dialog.addEventListener("close", () => dialog.remove(), { once: true })
        dialog.append(fullImg, closeBtn)
        document.body.appendChild(dialog)
        dialog.showModal()
      }
      thumb.onclick = openLightbox
      thumb.addEventListener("keydown", (ev) => {
        if (ev.target !== thumb) return
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault()
          openLightbox()
        }
      })

      thumb.appendChild(img)
      thumb.appendChild(delOverlay)
      contents.appendChild(thumb)
    })
    if (!contents.childElementCount) {
      const emptyLabel = document.createElement("span")
      emptyLabel.className = "text-[10px] text-text-muted italic"
      emptyLabel.textContent = attachments.length ? "There is no preview for the saved image format." : "No attachments."
      contents.appendChild(emptyLabel)
    }
    replaceAttachmentContents(container, contents, anchor)
  } catch (e) {
    if (!isCurrent()) return
    log.error("Failed to load attachments", e)
    const errLabel = document.createElement("span")
    errLabel.className = "text-xs text-danger"
    errLabel.textContent = "Failed to load attachments"
    replaceAttachmentContents(container, errLabel, anchor)
  }
}
