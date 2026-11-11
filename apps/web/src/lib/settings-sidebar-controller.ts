/**
 * Sidebar settings controller.
 *
 * Handles sidebar ordering (drag-drop + touch), custom links,
 * visibility toggles, save, and reset.
 */
import { withAsyncButton } from "@lib/async-button"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { saveSetting, showSettingsSaveError, log } from "@lib/settings-utils"
import { settingsStore } from "@lib/settings-store"
import { escapeHtml } from "@lib/safe-html"

// ───── Constants ─────

const DEFAULT_SIDEBAR = ["dashboard", "today", "upcoming", "tasks", "activity", "mentionInbox", "progress", "planning", "areas"]

const SIDEBAR_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  tasks: "Tasks",
  table: "Table",
  today: "Today",
  upcoming: "Upcoming",
  calendar: "Calendar",
  progress: "Progress & Growth",
  planning: "Planning",
  areas: "Areas",
  activity: "Recent activity",
  mentionInbox: "Mentions",
}

function customLinkId(): string {
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, "0")).join("")
  return `custom-${id}`
}

// ───── Init ─────

export function initSidebarSettings(): void {
  // Save sidebar config
  const saveSidebarBtn = document.getElementById("save-sidebar") as HTMLButtonElement
  if (saveSidebarBtn) {
    pageLifecycle.on(saveSidebarBtn, "click", withAsyncButton(saveSidebarBtn, async () => {
    const list = document.getElementById("sidebar-item-list")
    if (!list) return

    const config: Record<string, unknown> = {}
    const order: string[] = []
    const labels: Record<string, string> = {}

    list.querySelectorAll(".sidebar-visible-cb").forEach((cb) => {
      const key = (cb as HTMLElement).dataset.key!
      config[key] = (cb as HTMLInputElement).checked
      order.push(key)
    })

    list.querySelectorAll(".sidebar-label-input").forEach((input) => {
      const key = (input as HTMLElement).dataset.key!
      const val = (input as HTMLInputElement).value.trim()
      if (val) labels[key] = val
    })

    // Parse custom links
    const finalCustomItems: { id: string; label: string; href: string; icon: string }[] = []
    document.querySelectorAll("#custom-links-list > div").forEach((row) => {
      const label = (row.querySelector(".custom-item-label") as HTMLInputElement).value
      const href = (row.querySelector(".custom-item-href") as HTMLInputElement).value
      if (label || href) {
        finalCustomItems.push({
          id: (row as HTMLElement).dataset.customId || customLinkId(),
          label: label || "Link",
          href: href || "/",
          icon: "link",
        })
      }
    })

    config.order = order
    config.labels = labels
    config.customItems = finalCustomItems

    await saveSetting("sidebar_config", config)
    showToast("settings.sidebar_saved")
    settingsStore.invalidate()
    window.location.reload()
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }

  // Reset sidebar to defaults
  const resetSidebarBtn = document.getElementById("reset-sidebar")
  if (resetSidebarBtn) {
    pageLifecycle.on(resetSidebarBtn, "click", withAsyncButton(resetSidebarBtn as HTMLButtonElement, async () => {
    const confirmed = await confirmDialog({
      message: "Reset sidebar to default configuration? Custom links and reordering will be lost.",
      variant: "warning",
    })
    if (!confirmed) return
    await saveSetting("sidebar_config", null)
    showToast("Sidebar reset to defaults")
    settingsStore.invalidate()
    window.location.reload()
    }, { onError: showSettingsSaveError }))
  }

  // Add custom link
  const addCustomBtn = document.getElementById("add-custom-link-btn")
  if (addCustomBtn) {
    pageLifecycle.on(addCustomBtn, "click", () => {
    // The custom link is added through the restore flow — this appends a new item
    // and re-renders the sidebar list. Since we need the full render context,
    // we dispatch a custom event that the restore handler picks up.
    window.dispatchEvent(new CustomEvent("meitheal:sidebar-add-custom-link"))
    })
  }
}

// ───── Restore ─────

/** Restore sidebar configuration from loaded settings object */
export function restoreSidebarSettings(settings: Record<string, unknown>): void {
  try {
    const signal = pageLifecycle.signal
    let sidebarConfig: Record<string, unknown> = {}
    try {
      const raw = settings.sidebar_config
      if (raw) {
        sidebarConfig = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>)
      }
    } catch { /* non-fatal */ }

    let orderItems = Array.isArray(sidebarConfig.order) && (sidebarConfig.order as string[]).length > 0
      ? [...(sidebarConfig.order as string[])]
      : [...DEFAULT_SIDEBAR]
    DEFAULT_SIDEBAR.forEach((k) => {
      if (!orderItems.includes(k)) orderItems.push(k)
    })

    const customItems: { id: string; label: string; href: string; icon: string }[] =
      Array.isArray(sidebarConfig.customItems) ? (sidebarConfig.customItems as typeof customItems) : []

    let dragSrcIndex: number | null = null

    // Create a 1x1 transparent image for custom drag ghost
    const dragGhost = document.createElement("canvas")
    dragGhost.width = 1
    dragGhost.height = 1

    function clearDropIndicators(list: HTMLElement) {
      list.querySelectorAll(".sidebar-config-row").forEach((r) => {
        const el = r as HTMLElement
        el.style.borderTopColor = "var(--border)"
        el.style.borderBottomColor = "var(--border)"
        el.style.borderTopWidth = "1px"
        el.style.borderBottomWidth = "1px"
      })
    }

    function renderSidebarList() {
      const list = document.getElementById("sidebar-item-list")!
      list.replaceChildren()
      orderItems.forEach((key: string, index: number) => {
        const isVisible = sidebarConfig[key] !== false
        const defaultLabel = SIDEBAR_LABELS[key] || key
        const labelStr =
          ((sidebarConfig.labels as Record<string, string> | undefined)?.[key]) ||
          defaultLabel

        const row = document.createElement("div")
        row.className = "sidebar-config-row"
        row.draggable = true
        row.dataset.index = String(index)
        row.innerHTML = `
          <span class="drag-handle" title="Drag to reorder" aria-hidden="true">☰</span>
          <label class="sidebar-config-row__visibility">
            <input type="checkbox" class="sidebar-visible-cb" data-key="${escapeHtml(key)}" aria-label="Show ${escapeHtml(defaultLabel)} in sidebar" ${isVisible ? "checked" : ""} />
            <span>${escapeHtml(defaultLabel)}</span>
          </label>
          <input type="text" class="form-input sidebar-label-input" data-key="${escapeHtml(key)}" aria-label="Custom label for ${escapeHtml(defaultLabel)}" value="${escapeHtml(labelStr)}" placeholder="Custom label" />
          <div class="sidebar-config-row__moves">
            <button type="button" class="btn btn-ghost sidebar-order-up" aria-label="Move ${escapeHtml(defaultLabel)} up" ${index === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="btn btn-ghost sidebar-order-down" aria-label="Move ${escapeHtml(defaultLabel)} down" ${index === orderItems.length - 1 ? "disabled" : ""}>↓</button>
          </div>
        `

        row.querySelector<HTMLInputElement>(".sidebar-visible-cb")?.addEventListener("change", event => {
          sidebarConfig[key] = (event.currentTarget as HTMLInputElement).checked
        }, { signal })
        row.querySelector<HTMLInputElement>(".sidebar-label-input")?.addEventListener("input", event => {
          const labels = sidebarConfig.labels as Record<string, string> | undefined
          sidebarConfig.labels = { ...labels, [key]: (event.currentTarget as HTMLInputElement).value }
        }, { signal })

        for (const [selector, direction] of [[".sidebar-order-up", -1], [".sidebar-order-down", 1]] as const) {
          row.querySelector<HTMLButtonElement>(selector)?.addEventListener("click", () => {
            const target = index + direction
            if (target < 0 || target >= orderItems.length) return
            orderItems.splice(index, 1)
            orderItems.splice(target, 0, key)
            renderSidebarList()
            list.querySelector<HTMLElement>(`[data-index="${target}"] ${selector}`)?.focus()
          }, { signal })
        }

        // Drag events
        row.addEventListener("dragstart", (e) => {
          dragSrcIndex = index
          row.style.opacity = "0.3"
          row.style.background = "var(--bg-tertiary)"
          e.dataTransfer!.effectAllowed = "move"
          e.dataTransfer!.setData("text/plain", String(index))
          e.dataTransfer!.setDragImage(dragGhost, 0, 0)
        }, { signal })

        row.addEventListener("dragend", () => {
          row.style.opacity = "1"
          row.style.background = "var(--bg-secondary)"
          clearDropIndicators(list)
        }, { signal })

        row.addEventListener("dragover", (e) => {
          e.preventDefault()
          e.dataTransfer!.dropEffect = "move"
          if (dragSrcIndex === null || dragSrcIndex === index) return
          clearDropIndicators(list)
          const rect = row.getBoundingClientRect()
          const midY = rect.top + rect.height / 2
          if (e.clientY < midY) {
            row.style.borderTopColor = "var(--accent)"
            row.style.borderTopWidth = "3px"
          } else {
            row.style.borderBottomColor = "var(--accent)"
            row.style.borderBottomWidth = "3px"
          }
        }, { signal })

        row.addEventListener("dragleave", () => {
          row.style.borderTopColor = "var(--border)"
          row.style.borderBottomColor = "var(--border)"
          row.style.borderTopWidth = "1px"
          row.style.borderBottomWidth = "1px"
        }, { signal })

        row.addEventListener("drop", (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (dragSrcIndex === null || dragSrcIndex === index) return
          const rect = row.getBoundingClientRect()
          const midY = rect.top + rect.height / 2
          let targetIndex = index
          if (e.clientY >= midY && dragSrcIndex < index) {
            targetIndex = index
          } else if (e.clientY < midY && dragSrcIndex > index) {
            targetIndex = index
          }
          const [movedItem] = orderItems.splice(dragSrcIndex, 1)
          if (movedItem) orderItems.splice(targetIndex, 0, movedItem)
          clearDropIndicators(list)
          renderSidebarList()
        }, { signal })

        // Touch drag support
        let touchStartY = 0
        let touchDragging = false
        row.addEventListener("touchstart", (e) => {
          const handle = (e.target as HTMLElement).closest(".drag-handle")
          if (!handle) return
          const t0 = e.touches[0]
          if (!t0) return
          dragSrcIndex = index
          touchStartY = t0.clientY
          touchDragging = false
          row.style.opacity = "0.3"
        }, { passive: true, signal })

        row.addEventListener("touchmove", (e) => {
          if (dragSrcIndex !== index) return
          const t0 = e.touches[0]
          if (!t0) return
          const dy = Math.abs(t0.clientY - touchStartY)
          if (dy > 10) {
            touchDragging = true
            e.preventDefault()
          }
          if (!touchDragging) return
          clearDropIndicators(list)
          const el = document.elementFromPoint(t0.clientX, t0.clientY)
          const targetRow = el?.closest(".sidebar-config-row") as HTMLElement | null
          if (targetRow && targetRow !== row) {
            targetRow.style.borderTopColor = "var(--accent)"
            targetRow.style.borderTopWidth = "3px"
          }
        }, { passive: false, signal })

        row.addEventListener("touchend", (e) => {
          if (dragSrcIndex !== index) return
          row.style.opacity = "1"
          clearDropIndicators(list)
          if (!touchDragging) {
            dragSrcIndex = null
            return
          }
          const touch = e.changedTouches[0]
          if (!touch) {
            dragSrcIndex = null
            return
          }
          const el = document.elementFromPoint(touch.clientX, touch.clientY)
          const targetRow = el?.closest(".sidebar-config-row") as HTMLElement | null
          if (targetRow && targetRow !== row) {
            const targetIdx = Number(targetRow.dataset.index)
            if (!isNaN(targetIdx) && dragSrcIndex !== null && dragSrcIndex !== targetIdx) {
              const [movedItem] = orderItems.splice(dragSrcIndex, 1)
              if (movedItem) orderItems.splice(targetIdx, 0, movedItem)
              renderSidebarList()
            }
          }
          dragSrcIndex = null
          touchDragging = false
        }, { passive: true, signal })

        list.appendChild(row)
      })

      // Custom links rendering
      const customList = document.getElementById("custom-links-list")!
      customList.replaceChildren()
      customItems.forEach((item, index) => {
        const row = document.createElement("div")
        row.className = "sidebar-custom-link"
        row.dataset.customId = item.id
        row.innerHTML = `
          <input type="text" class="form-input custom-item-label" aria-label="Custom link label" placeholder="Label" value="${escapeHtml(item.label)}" />
          <input type="text" class="form-input custom-item-href" aria-label="Custom link URL" placeholder="URL (e.g. /notes)" value="${escapeHtml(item.href)}" />
          <button type="button" class="btn btn-ghost text-danger remove-custom-link" aria-label="Remove custom link ${escapeHtml(item.label)}" data-index="${index}">×</button>
        `
        row.querySelector<HTMLInputElement>(".custom-item-label")?.addEventListener("input", event => {
          item.label = (event.currentTarget as HTMLInputElement).value
        }, { signal })
        row.querySelector<HTMLInputElement>(".custom-item-href")?.addEventListener("input", event => {
          item.href = (event.currentTarget as HTMLInputElement).value
        }, { signal })
        customList.appendChild(row)
      })

      document.querySelectorAll(".remove-custom-link").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const idx = Number((e.currentTarget as HTMLElement).dataset.index)
          customItems.splice(idx, 1)
          renderSidebarList()
        }, { signal })
      })
    }

    // Wire up "Add Custom Link" button locally
    pageLifecycle.on(window, "meitheal:sidebar-add-custom-link", () => {
      customItems.push({ id: customLinkId(), label: "New Link", href: "/", icon: "link" })
      renderSidebarList()
    })

    renderSidebarList()
  } catch (e) {
    log.error("Sidebar/custom fields error", e)
  }
}
