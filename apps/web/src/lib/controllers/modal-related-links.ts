/**
 * modal-related-links.ts — Jira-style issue linking (related, blocked, duplicates)
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Manages link CRUD, search, inbound/outbound rendering with accessibility.
 */

export interface RelatedLinksDeps {
  getCurrentTaskId: () => string | null
  openTaskDetail: (id: string) => void
  saveTD: (field: string, value: unknown) => Promise<void>
  signal?: AbortSignal
}

const LINK_TYPE_LABELS: Record<string, string> = {
  related_to: "🔗 Related to",
  blocked_by: "🚫 Blocked by",
  blocks: "⛔ Blocks",
  duplicates: "📋 Duplicates",
  duplicated_by: "📋 Duplicated by",
}
// Inverse labels for inbound links (when *other* task has the link pointing at *this* task)
const INVERSE_LABELS: Record<string, string> = {
  related_to: "🔗 Related to",
  blocked_by: "⛔ Blocks",
  blocks: "🚫 Blocked by",
  duplicates: "📋 Duplicated by",
  duplicated_by: "📋 Duplicates",
}

/**
 * Initialise Jira-style related links panel + search.
 */
export function initRelatedLinks({ getCurrentTaskId, openTaskDetail, saveTD, signal }: RelatedLinksDeps): {
  loadRelatedLinks: (taskId: string) => Promise<void>
} {
  const opts = signal ? { signal } : undefined

  async function loadRelatedLinks(taskId: string) {
    const container = document.getElementById("td-related-links")
    const countEl = document.getElementById("td-link-count")
    const liveRegion = document.getElementById("td-link-live")
    const emptyState = document.getElementById("td-links-empty")
    if (!container) return

    // Show loading
    container.innerHTML =
      '<span class="text-xs text-text-muted italic">Loading…</span>'
    if (emptyState) emptyState.style.display = "none"

    try {
      const res = await fetch(
        `${window.__ingress_path || ""}/api/tasks/${taskId}/links`,
      )
      if (!res.ok) {
        // Error boundary (#18): show retry option
        container.innerHTML = ""
        const errDiv = document.createElement("div")
        errDiv.className =
          "text-xs text-text-muted italic py-1 cursor-pointer hover:text-accent"
        errDiv.textContent = "Failed to load links. Tap to retry."
        errDiv.addEventListener("click", () => loadRelatedLinks(taskId), opts)
        container.appendChild(errDiv)
        if (countEl) countEl.textContent = ""
        return
      }
      const data = await res.json()
      const outbound = data.outbound ?? []
      const inbound = data.inbound ?? []
      const totalLinks = outbound.length + inbound.length

      // Count badge (#2)
      if (countEl)
        countEl.textContent = totalLinks > 0 ? `(${totalLinks})` : ""

      if (totalLinks === 0) {
        container.innerHTML = ""
        if (emptyState) {
          emptyState.style.display = ""
          container.appendChild(emptyState)
        }
        return
      }

      container.innerHTML = ""

      // Helper: create a link row using DOM API (XSS-safe)
      function createLinkRow(
        label: string,
        linkedTaskId: string,
        ticketKey: string,
        title: string,
        linkId: string,
      ) {
        const el = document.createElement("div")
        el.className =
          "flex items-center gap-1 text-xs py-0.5 td-link-row"
        el.style.cssText = "animation: fadeIn 0.2s ease-in;"

        const labelSpan = document.createElement("span")
        labelSpan.className = "text-text-muted"
        labelSpan.style.cssText =
          "min-width:90px;flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        labelSpan.textContent = label

        const titleSpan = document.createElement("span")
        titleSpan.className =
          "text-accent cursor-pointer hover:underline td-link-goto truncate"
        titleSpan.dataset.id = linkedTaskId
        titleSpan.title = "Open task"
        titleSpan.textContent =
          (ticketKey ? ticketKey + " " : "") +
          String(title || "").slice(0, 40)

        const removeBtn = document.createElement("button")
        removeBtn.type = "button"
        removeBtn.className = "td-link-remove"
        removeBtn.dataset.linkId = linkId
        removeBtn.style.cssText =
          "color:var(--danger);font-size:14px;cursor:pointer;background:none;border:none;padding:0 2px;margin-left:auto;flex-shrink:0;"
        removeBtn.title = "Remove link"
        removeBtn.textContent = "×"
        // Accessibility (#26): descriptive aria-label
        removeBtn.setAttribute(
          "aria-label",
          `Remove ${label} link to ${String(title || "").slice(0, 30)}`,
        )

        el.appendChild(labelSpan)
        el.appendChild(titleSpan)
        el.appendChild(removeBtn)
        return el
      }

      // Render outbound links (this task → other task)
      for (const link of outbound) {
        const label = LINK_TYPE_LABELS[link.link_type] || link.link_type
        const ticketKey = link.target_ticket_number
          ? `MTH-${link.target_ticket_number}`
          : ""
        container.appendChild(
          createLinkRow(
            label,
            link.target_task_id,
            ticketKey,
            link.target_title,
            link.id,
          ),
        )
      }

      // Render inbound links (other task → this task)
      for (const link of inbound) {
        const label = INVERSE_LABELS[link.link_type] || link.link_type
        const ticketKey = link.source_ticket_number
          ? `MTH-${link.source_ticket_number}`
          : ""
        container.appendChild(
          createLinkRow(
            label,
            link.source_task_id,
            ticketKey,
            link.source_title,
            link.id,
          ),
        )
      }

      // Navigate to linked task on click
      container.querySelectorAll(".td-link-goto").forEach((el) => {
        el.addEventListener("click", () => {
          const tid = (el as HTMLElement).dataset.id
          if (tid) openTaskDetail(tid)
        }, opts)
      })

      // Remove link on click — captures taskId in closure (#20 race guard)
      const capturedTaskId = taskId
      container.querySelectorAll(".td-link-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const linkId = (btn as HTMLElement).dataset.linkId
          if (!linkId) return
          try {
            await fetch(
              `${window.__ingress_path || ""}/api/tasks/${capturedTaskId}/links?link_id=${encodeURIComponent(linkId)}`,
              { method: "DELETE" },
            )
            // ARIA announcement (#30)
            if (liveRegion) liveRegion.textContent = "Link removed"
            loadRelatedLinks(capturedTaskId)
          } catch {
            if (liveRegion)
              liveRegion.textContent = "Failed to remove link"
          }
        }, opts)
      })
    } catch {
      // Error boundary (#18)
      container.innerHTML = ""
      const errDiv = document.createElement("div")
      errDiv.className =
        "text-xs text-text-muted italic py-1 cursor-pointer hover:text-accent"
      errDiv.textContent = "Failed to load links. Tap to retry."
      errDiv.addEventListener("click", () => loadRelatedLinks(taskId), opts)
      container.appendChild(errDiv)
      if (countEl) countEl.textContent = ""
    }
  }

  // Related link search — debounced
  let linkSearchTimer: ReturnType<typeof setTimeout>
  const linkSearchInput = document.getElementById(
    "td-link-search",
  ) as HTMLInputElement | null
  const linkSearchResults = document.getElementById(
    "td-link-search-results",
  )

  linkSearchInput?.addEventListener("input", () => {
    clearTimeout(linkSearchTimer)
    const q = linkSearchInput.value.trim()
    if (q.length < 2) {
      if (linkSearchResults) linkSearchResults.style.display = "none"
      return
    }
    linkSearchTimer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${window.__ingress_path || ""}/api/tasks?q=${encodeURIComponent(q)}&limit=10`,
        )
        if (!res.ok || !linkSearchResults) return
        const data = await res.json()
        const currentId = getCurrentTaskId()
        const tasks = (data.tasks ?? []).filter(
          (t: Record<string, unknown>) => t.id !== currentId,
        )
        if (tasks.length === 0) {
          const noMatch = document.createElement("div")
          noMatch.className = "px-3 py-2 text-xs text-text-muted italic"
          noMatch.textContent = "No matches"
          linkSearchResults.innerHTML = ""
          linkSearchResults.appendChild(noMatch)
        } else {
          linkSearchResults.innerHTML = ""
          for (const t of tasks as Record<string, unknown>[]) {
            const typeIcon =
              t.task_type === "epic"
                ? "🎯"
                : t.task_type === "story"
                  ? "📖"
                  : "✅"
            const ticketKey = t.ticket_number
              ? `MTH-${t.ticket_number} `
              : ""

            const resultEl = document.createElement("div")
            resultEl.className =
              "td-link-result px-3 py-1.5 text-xs cursor-pointer hover:bg-bg-hover flex items-center gap-2"
            resultEl.dataset.id = String(t.id)
            resultEl.setAttribute("role", "option")

            const iconSpan = document.createElement("span")
            iconSpan.textContent = typeIcon

            const titleSpan = document.createElement("span")
            titleSpan.className = "truncate"
            titleSpan.textContent =
              ticketKey + String(t.title).slice(0, 50)

            resultEl.appendChild(iconSpan)
            resultEl.appendChild(titleSpan)
            linkSearchResults.appendChild(resultEl)
          }
          linkSearchResults
            .querySelectorAll(".td-link-result")
            .forEach((el) => {
              el.addEventListener("click", async () => {
                const targetId = (el as HTMLElement).dataset.id
                const linkType =
                  (
                    document.getElementById(
                      "td-link-type-select",
                    ) as HTMLSelectElement
                  )?.value || "related_to"
                const currentId = getCurrentTaskId()
                if (targetId && currentId) {
                  try {
                    await fetch(
                      `${window.__ingress_path || ""}/api/tasks/${currentId}/links`,
                      {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          target_task_id: targetId,
                          link_type: linkType,
                        }),
                      },
                    )
                    linkSearchInput.value = ""
                    linkSearchResults.style.display = "none"
                    linkSearchInput.setAttribute(
                      "aria-expanded",
                      "false",
                    )
                    // ARIA announcement (#30) and focus management (#29)
                    const liveRegion =
                      document.getElementById("td-link-live")
                    if (liveRegion)
                      liveRegion.textContent = "Link created"
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
    if (e.key === "Escape" && linkSearchResults) {
      linkSearchResults.style.display = "none"
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
