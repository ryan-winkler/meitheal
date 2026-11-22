/**
 * modal-related-links.ts — Jira-style issue linking (related, blocked, duplicates)
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Manages link CRUD, search, inbound/outbound rendering with accessibility.
 */

import { notifyInactivityTaskChanged } from "@lib/inactivity-client"

export interface RelatedLinksDeps {
  getCurrentTaskId: () => string | null
  openTaskDetail: (id: string) => void
  saveTD: (field: string, value: unknown) => Promise<void>
  signal?: AbortSignal
}

const LINK_TYPE_LABELS: Record<string, string> = {
  related_to: "Related to",
  blocked_by: "Blocked by",
  blocks: "Blocks",
  duplicates: "Duplicates",
  duplicated_by: "Duplicated by",
}
// Inverse labels for inbound links (when *other* task has the link pointing at *this* task)
const INVERSE_LABELS: Record<string, string> = {
  related_to: "Related to",
  blocked_by: "Blocks",
  blocks: "Blocked by",
  duplicates: "Duplicated by",
  duplicated_by: "Duplicates",
}

/**
 * Initialise Jira-style related links panel + search.
 */
export function initRelatedLinks({ getCurrentTaskId, openTaskDetail, signal }: RelatedLinksDeps): {
  loadRelatedLinks: (taskId: string) => Promise<void>
} {
  const opts = signal ? { signal } : undefined

  const renderRetryError = (container: HTMLElement, countEl: HTMLElement | null, taskId: string) => {
    const errDiv = document.createElement("div")
    errDiv.className = "text-xs text-text-muted italic py-1 cursor-pointer hover:text-accent"
    errDiv.textContent = "Failed to load links. Tap to retry."
    errDiv.addEventListener("click", () => loadRelatedLinks(taskId), opts)
    container.replaceChildren(errDiv)
    if (countEl) countEl.textContent = ""
  }

  async function loadRelatedLinks(taskId: string) {
    const container = document.getElementById("td-related-links")
    const countEl = document.getElementById("td-link-count")
    const liveRegion = document.getElementById("td-link-live")
    const emptyState = document.getElementById("td-links-empty")
    if (!container) return

    const loading = document.createElement("span")
    loading.className = "text-xs text-text-muted italic"
    loading.textContent = "Loading…"
    container.replaceChildren(loading)
    if (emptyState) emptyState.style.display = "none"

    const encodedTaskId = encodeURIComponent(taskId)
    try {
      const res = await fetch(`/api/tasks/${encodedTaskId}/links`, { signal }) // nosemgrep
      if (!res.ok) {
        renderRetryError(container, countEl, taskId)
        return
      }
      const data = await res.json()
      const outbound = data.outbound ?? []
      const inbound = data.inbound ?? []
      const totalLinks = outbound.length + inbound.length

      if (countEl) countEl.textContent = totalLinks > 0 ? `(${totalLinks})` : ""

      if (totalLinks === 0) {
        container.replaceChildren()
        if (emptyState) {
          emptyState.style.display = ""
          container.appendChild(emptyState)
        }
        return
      }

      container.replaceChildren()

      function createLinkRow(
        label: string,
        linkedTaskId: string,
        ticketKey: string,
        title: string,
        linkId: string,
      ) {
        const el = document.createElement("div")
        el.className = "flex items-center gap-1 text-xs py-0.5 td-link-row"

        const labelSpan = document.createElement("span")
        labelSpan.className = "text-text-muted shrink-0 truncate"
        labelSpan.style.minWidth = "86px"
        labelSpan.style.maxWidth = "116px"
        labelSpan.textContent = label

        const titleSpan = document.createElement("span")
        titleSpan.className = "text-accent cursor-pointer hover:underline td-link-goto truncate"
        titleSpan.dataset.id = linkedTaskId
        titleSpan.title = "Open task"
        titleSpan.textContent = (ticketKey ? ticketKey + " " : "") + String(title || "").slice(0, 40)

        const removeBtn = document.createElement("button")
        removeBtn.type = "button"
        removeBtn.className = "td-link-remove ml-auto shrink-0 cursor-pointer border-0 bg-transparent px-0.5 text-sm text-danger"
        removeBtn.dataset.linkId = linkId
        removeBtn.title = "Remove link"
        removeBtn.textContent = "×"
        removeBtn.setAttribute("aria-label", `Remove ${label} link to ${String(title || "").slice(0, 30)}`)

        el.append(labelSpan, titleSpan, removeBtn)
        return el
      }

      for (const link of outbound) {
        const label = LINK_TYPE_LABELS[link.link_type] || link.link_type
        const ticketKey =
          (link as { target_ticket_key?: string | null }).target_ticket_key ||
          (link.target_ticket_number ? `MTH-${link.target_ticket_number}` : "")
        container.appendChild(createLinkRow(label, link.target_task_id, ticketKey, link.target_title, link.id))
      }

      for (const link of inbound) {
        const label = INVERSE_LABELS[link.link_type] || link.link_type
        const ticketKey =
          (link as { source_ticket_key?: string | null }).source_ticket_key ||
          (link.source_ticket_number ? `MTH-${link.source_ticket_number}` : "")
        container.appendChild(createLinkRow(label, link.source_task_id, ticketKey, link.source_title, link.id))
      }

      container.querySelectorAll(".td-link-goto").forEach((el) => {
        el.addEventListener("click", () => {
          const tid = (el as HTMLElement).dataset.id
          if (tid) openTaskDetail(tid)
        }, opts)
      })

      const capturedTaskId = taskId
      const encodedCapturedId = encodeURIComponent(capturedTaskId)
      container.querySelectorAll(".td-link-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const linkId = (btn as HTMLElement).dataset.linkId
          if (!linkId) return
          try {
            const response = await fetch( // nosemgrep
              `/api/tasks/${encodedCapturedId}/links?link_id=${encodeURIComponent(linkId)}`,
              { method: "DELETE", signal },
            )
            if (!response.ok) throw new Error("Link removal failed")
            notifyInactivityTaskChanged()
            if (liveRegion) liveRegion.textContent = "Link removed"
            loadRelatedLinks(capturedTaskId)
          } catch {
            if (liveRegion) liveRegion.textContent = "Failed to remove link"
          }
        }, opts)
      })
    } catch {
      renderRetryError(container, countEl, taskId)
    }
  }

  // Related link search — debounced
  let linkSearchTimer: ReturnType<typeof setTimeout>
  const linkSearchInput = document.getElementById("td-link-search") as HTMLInputElement | null
  const linkSearchResults = document.getElementById("td-link-search-results")

  linkSearchInput?.addEventListener("input", () => {
    clearTimeout(linkSearchTimer)
    const q = linkSearchInput.value.trim()
    if (q.length < 2) {
      if (linkSearchResults) linkSearchResults.style.display = "none"
      return
    }
    linkSearchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tasks?q=${encodeURIComponent(q)}&limit=10`, { signal }) // nosemgrep
        if (!res.ok || !linkSearchResults) return
        const data = await res.json()
        if (linkSearchInput.value.trim() !== q) return
        const currentId = getCurrentTaskId()
        const tasks = (data.tasks ?? []).filter((t: Record<string, unknown>) => t.id !== currentId)
        if (tasks.length === 0) {
          const noMatch = document.createElement("div")
          noMatch.className = "px-3 py-2 text-xs text-text-muted italic"
          noMatch.textContent = "No matches"
          linkSearchResults.replaceChildren(noMatch)
        } else {
          linkSearchResults.replaceChildren()
          for (const t of tasks as Record<string, unknown>[]) {
            const resolvedLinkKey =
              typeof t.ticket_key === "string" && t.ticket_key
                ? t.ticket_key
                : typeof t.ticket_ref === "string" && t.ticket_ref
                  ? t.ticket_ref
                  : t.ticket_number
                    ? `MTH-${t.ticket_number}`
                    : ""
            const ticketKey = resolvedLinkKey ? `${resolvedLinkKey} ` : ""

            const resultEl = document.createElement("div")
            resultEl.className = "td-link-result px-3 py-1.5 text-xs cursor-pointer hover:bg-bg-hover flex items-center gap-2"
            resultEl.dataset.id = String(t.id)
            resultEl.setAttribute("role", "option")

            const titleSpan = document.createElement("span")
            titleSpan.className = "truncate"
            titleSpan.textContent = ticketKey + String(t.title).slice(0, 50)

            resultEl.appendChild(titleSpan)
            linkSearchResults.appendChild(resultEl)
          }
          linkSearchResults.querySelectorAll(".td-link-result").forEach((el) => {
            el.addEventListener("click", async () => {
              const targetId = (el as HTMLElement).dataset.id
              const linkType = (document.getElementById("td-link-type-select") as HTMLSelectElement)?.value || "related_to"
              const currentId = getCurrentTaskId()
              if (targetId && currentId) {
                try {
                  const response = await fetch( // nosemgrep
                    `/api/tasks/${encodeURIComponent(currentId)}/links`,
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ target_task_id: targetId, link_type: linkType }),
                      signal,
                    },
                  )
                  if (!response.ok) throw new Error("Link creation failed")
                  if (linkType === "blocks" || linkType === "blocked_by") notifyInactivityTaskChanged()
                  linkSearchInput.value = ""
                  linkSearchResults.style.display = "none"
                  linkSearchInput.setAttribute("aria-expanded", "false")
                  const liveRegion = document.getElementById("td-link-live")
                  if (liveRegion) liveRegion.textContent = "Link created"
                  linkSearchInput.focus()
                  loadRelatedLinks(currentId)
                } catch {
                  /* silent */
                }
              }
            }, opts)
          })
        }
        linkSearchResults.style.display = "block"
        linkSearchInput?.setAttribute("aria-expanded", "true")
      } catch {
        /* silent */
      }
    }, 300)
  }, opts)

  linkSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && linkSearchResults?.style.display === "block") {
      e.preventDefault()
      clearTimeout(linkSearchTimer)
      linkSearchResults.style.display = "none"
      linkSearchInput.setAttribute("aria-expanded", "false")
      linkSearchInput.value = ""
    }
  }, opts)

  // Close link search results on outside click
  document.addEventListener("click", (e) => {
    if (
      !(e.target as Element)?.closest("#td-link-search") &&
      !(e.target as Element)?.closest("#td-link-search-results")
    ) {
      if (linkSearchResults) linkSearchResults.style.display = "none"
    }
  }, opts)

  return { loadRelatedLinks }
}
