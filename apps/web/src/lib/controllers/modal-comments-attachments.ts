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
import { byId, domEl, qs, setAttr } from "@lib/dom-helpers"

const log = createClientLogger("tasks", "comments-attachments")

function attachCommentManagement(
  wrapper: HTMLElement, body: HTMLElement, content: string, taskLabel: string, taskId: string, url: string, signal: AbortSignal,
): void {
  const template = document.querySelector<HTMLTemplateElement>("#td-comment-management")
  if (!template) return
  const controls = template.content.cloneNode(true) as DocumentFragment
  const actions = qs<HTMLElement>(controls, "[data-comment-actions]")!
  const edit = qs<HTMLButtonElement>(controls, "[data-comment-edit]")!
  const remove = qs<HTMLButtonElement>(controls, "[data-comment-delete]")!
  const form = qs<HTMLFormElement>(controls, "form")!
  const input = form.querySelector("textarea")!
  const save = qs<HTMLButtonElement>(form, 'button[type="submit"]')!
  const cancel = qs<HTMLButtonElement>(form, "[data-comment-cancel]")!
  const error = qs<HTMLElement>(controls, '[role="alert"]')!
  const hint = qs<HTMLElement>(controls, "[data-reference-hint]")!
  error.id = `${wrapper.id}-error`
  hint.id = `${wrapper.id}-reference-hint`
  setAttr(input, "aria-describedby", `${error.id} ${hint.id}`)
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
      const focusTarget = next instanceof HTMLElement ? next : byId("td-comment-input")
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
  const container = byId("td-comments")
  const status = byId("td-comment-link-status")
  if (!container) return
  const taskLabel = container.dataset.taskLabel ?? "Task"
  if (postedCommentId !== undefined && byId(`td-comment-${postedCommentId}`)) return
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
      const wrapper = domEl("article", "bg-bg-card rounded-md p-3 border border-border focus:outline-2 focus:outline-accent")

      const meta = domEl("div", "flex flex-wrap justify-between gap-1 text-xs text-text-muted mb-1")
      const authorSpan = domEl("span")
      authorSpan.textContent = c.author
      const dateLink = domEl("a")
      const timestamp = new Date(c.created_at).toLocaleString()
      dateLink.textContent = timestamp
      dateLink.href = buildTaskPermalink(task, c.id)
      dateLink.className = "underline underline-offset-2 hover:text-accent"
      const linkLabel = container.dataset.linkLabel
      if (linkLabel) {
        dateLink.title = linkLabel
        setAttr(dateLink, "aria-label", `${linkLabel}, ${c.author}, ${timestamp}`)
      }
      meta.append(authorSpan, dateLink)

      const body = domEl("div", "text-sm text-text-primary whitespace-pre-wrap break-words")
      renderCommentTaskReferences(body, c.content, taskLabel)

      wrapper.id = `td-comment-${c.id}`
      wrapper.tabIndex = -1
      body.id = `td-comment-body-${c.id}`
      setAttr(wrapper, "aria-label", `${c.author}, ${timestamp}`)
      setAttr(wrapper, "aria-describedby", body.id)
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

let attachmentsLoadSeq = 0

/**
 * Load and render image attachment thumbnails for a task.
 */
export async function loadAttachments(taskId: string): Promise<void> {
  const container = byId(
    "td-attachments",
  ) as HTMLElement
  if (!container) return
  const seq = ++attachmentsLoadSeq
  container.dataset.activeTaskId = taskId
  container.replaceChildren()

  try {
    const attachments = await getAttachmentsByTaskId(taskId)
    if (seq !== attachmentsLoadSeq || container.dataset.activeTaskId !== taskId || !container.isConnected) return
    if (attachments.length === 0) {
      const emptyLabel = domEl("span", "text-[10px] text-text-muted italic", "No attachments.")
      container.appendChild(emptyLabel)
      return
    }

    const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i

    attachments.forEach((att) => {
      const safeSrc = typeof att.base64Data === "string" && SAFE_IMAGE_DATA_URL_RE.test(att.base64Data.trim())
        ? att.base64Data.trim()
        : null
      if (!safeSrc) return

      const thumb = domEl("div", "relative group cursor-pointer border border-border rounded-md overflow-hidden hover:border-accent transition-colors focus-visible:outline-2 focus-visible:outline-accent")
      thumb.style.width = "64px"
      thumb.style.height = "64px"
      thumb.tabIndex = 0
      setAttr(thumb, "role", "button")
      setAttr(thumb, "aria-label", `Preview ${att.filename || "attachment"}`)

      const img = domEl("img")
      img.src = safeSrc
      img.alt = att.filename || "Attachment"
      img.className = "w-full h-full object-cover"
      img.title = att.filename

      // Delete overlay
      const delOverlay = domEl("div", "absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity")
      const delBtn = domEl("button")
      delBtn.type = "button"
      delBtn.className = "text-white text-sm font-semibold hover:text-danger p-2"
      setAttr(delBtn, "aria-label", `Delete ${att.filename || "attachment"}`)
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
        const dialog = domEl("dialog", "m-attachment-lightbox")
        dialog.style.cssText = "padding:0;border:none;background:transparent;max-width:92vw;max-height:92vh;overflow:visible;"
        const fullImg = domEl("img")
        fullImg.src = safeSrc
        fullImg.alt = att.filename || "Attachment preview"
        fullImg.style.cssText = "display:block;max-width:90vw;max-height:86vh;border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,0.6);"
        const closeBtn = domEl("button")
        closeBtn.type = "button"
        closeBtn.textContent = "×"
        setAttr(closeBtn, "aria-label", "Close attachment preview")
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
      container.appendChild(thumb)
    })
  } catch (e) {
    log.error("Failed to load attachments", e)
    const errLabel = domEl("span", "text-xs text-danger", "Failed to load attachments")
    container.appendChild(errLabel)
  }
}
