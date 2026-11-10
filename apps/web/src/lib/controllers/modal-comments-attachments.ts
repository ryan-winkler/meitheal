/**
 * modal-comments-attachments.ts — Comments and image attachments loader
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Pure data loaders with DOM rendering for comments list and attachment thumbnails.
 */
import {
  getAttachmentsByTaskId,
  deleteAttachment,
} from "@domains/offline/offline-store"
import { confirmDialog } from "@lib/confirm-dialog"
import { createClientLogger } from "@lib/client-logger"

const log = createClientLogger("tasks", "comments-attachments")

/**
 * Load and render comments for a task.
 */
export async function loadComments(taskId: string, signal: AbortSignal): Promise<void> {
  const container = document.getElementById("td-comments")
  if (!container) return
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/comments`, { signal })
    if (!res.ok) return
    const data = (await res.json()) as {
      comments: Array<{
        content: string
        author: string
        created_at: string
      }>
    }
    if (signal.aborted) return
    container.replaceChildren()
    for (const c of data.comments || []) {
      const wrapper = document.createElement("div")
      wrapper.className =
        "bg-bg-card rounded-md p-3 border border-border"

      const meta = document.createElement("div")
      meta.className =
        "flex justify-between text-xs text-text-muted mb-1"
      const authorSpan = document.createElement("span")
      authorSpan.textContent = c.author
      const dateSpan = document.createElement("span")
      dateSpan.textContent = new Date(c.created_at).toLocaleString()
      meta.appendChild(authorSpan)
      meta.appendChild(dateSpan)

      const body = document.createElement("div")
      body.className = "text-sm text-text-primary"
      body.textContent = c.content

      wrapper.appendChild(meta)
      wrapper.appendChild(body)
      container.appendChild(wrapper)
    }
  } catch {
    // Closing or switching tasks cancels the read.
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
