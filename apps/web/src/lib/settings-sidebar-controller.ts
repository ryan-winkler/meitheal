/**
 * Sidebar settings controller.
 *
 * Handles sidebar ordering (drag-drop + touch), custom links,
 * visibility toggles, save, and reset.
 */
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { saveSetting, log } from "@lib/settings-utils"
import { settingsStore } from "@lib/settings-store"

// ───── Constants ─────

const DEFAULT_SIDEBAR = ["dashboard", "kanban", "tasks", "today", "upcoming", "calendar"]

const SIDEBAR_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  kanban: "Kanban Area",
  tasks: "Tasks List",
  table: "Table",
  today: "Today",
  upcoming: "Upcoming",
  calendar: "Calendar",
}

// ───── Init ─────

export function initSidebarSettings(): void {
  // Save sidebar config
  const saveSidebarBtn = document.getElementById("save-sidebar")
  if (saveSidebarBtn) {
    pageLifecycle.on(saveSidebarBtn, "click", async () => {
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
          id: `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          label: label || "Link",
          href: href || "/",
          icon: "link",
        })
      }
    })

    config.order = order
    config.labels = labels
    config.customItems = finalCustomItems

    const btn = document.getElementById("save-sidebar") as HTMLButtonElement
    if (!btn) return
    const oText = btn.textContent
    btn.textContent = "Saving..."
    btn.disabled = true

    await saveSetting("sidebar_config", config)

    btn.textContent = oText
    btn.disabled = false
    showToast("settings.sidebar_saved")
    settingsStore.invalidate()
    // Dispatch event so Layout can reactively update sidebar without full reload
    window.dispatchEvent(new CustomEvent("meitheal:sidebar-config-changed"))
    })
  }

  // Reset sidebar to defaults
  const resetSidebarBtn = document.getElementById("reset-sidebar")
  if (resetSidebarBtn) {
    pageLifecycle.on(resetSidebarBtn, "click", async () => {
    const confirmed = await confirmDialog({
      message: "Reset sidebar to default configuration? Custom links and reordering will be lost.",
      variant: "warning",
    })
    if (!confirmed) return
    await fetch(
      (window.__ingress_path || "") + "/api/settings?key=sidebar_config",
      { method: "DELETE", signal: pageLifecycle.signal },
    ).catch(() => {})
    await saveSetting("sidebar_config", null)
    showToast("Sidebar reset to defaults")
    settingsStore.invalidate()
    window.dispatchEvent(new CustomEvent("meitheal:sidebar-config-changed"))
    })
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
      list.innerHTML = ""
      orderItems.forEach((key: string, index: number) => {
        const isVisible = sidebarConfig[key] !== false
        const labelStr =
          ((sidebarConfig.labels as Record<string, string> | undefined)?.[key]) ||
          SIDEBAR_LABELS[key] || key

        const row = document.createElement("div")
        row.className = "sidebar-config-row"
        row.draggable = true
        row.dataset.index = String(index)
        row.style.cssText =
          "display: flex; gap: 8px; align-items: center; background: var(--bg-secondary); padding: 8px; border-radius: 4px; border: 1px solid var(--border); margin-bottom: 4px;"

        row.innerHTML = `
          <div class="drag-handle" title="Drag to reorder" style="cursor: grab; color: var(--text-muted); padding: 4px 8px; user-select: none; border-radius: 4px; transition: color 0.15s, background 0.15s; display: flex; align-items: center; justify-content: center;" onmouseover="this.style.color='var(--text-primary)'; this.style.background='var(--bg-hover)'" onmouseout="this.style.color='var(--text-muted)'; this.style.background='transparent'">☰</div>
          <input type="checkbox" class="sidebar-visible-cb" data-key="${key}" ${isVisible ? "checked" : ""} />
          <span style="min-width: 100px; font-weight: 500;">${SIDEBAR_LABELS[key] || key}</span>
          <input type="text" class="form-input sidebar-label-input" data-key="${key}" value="${labelStr}" placeholder="Custom Label" style="flex: 1; max-width: 240px;" />
        `

        // Drag events
        row.addEventListener("dragstart", (e) => {
          dragSrcIndex = index
          row.style.opacity = "0.3"
          row.style.background = "var(--bg-tertiary)"
          e.dataTransfer!.effectAllowed = "move"
          e.dataTransfer!.setData("text/plain", String(index))
          e.dataTransfer!.setDragImage(dragGhost, 0, 0)
        })

        row.addEventListener("dragend", () => {
          row.style.opacity = "1"
          row.style.background = "var(--bg-secondary)"
          clearDropIndicators(list)
        })

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
        })

        row.addEventListener("dragleave", () => {
          row.style.borderTopColor = "var(--border)"
          row.style.borderBottomColor = "var(--border)"
          row.style.borderTopWidth = "1px"
          row.style.borderBottomWidth = "1px"
        })

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
        })

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
        }, { passive: true })

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
        }, { passive: false })

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
        }, { passive: true })

        list.appendChild(row)
      })

      // Custom links rendering
      const customList = document.getElementById("custom-links-list")!
      customList.innerHTML = ""
      customItems.forEach((item, index) => {
        const row = document.createElement("div")
        row.style.cssText =
          "display: flex; gap: 8px; align-items: center; background: var(--bg-secondary); padding: 8px; border-radius: 4px; border: 1px solid var(--border);"
        row.innerHTML = `
          <input type="text" class="form-input custom-item-label" placeholder="Label" value="${item.label.replace(/"/g, "&quot;")}" style="flex: 1;" />
          <input type="text" class="form-input custom-item-href" placeholder="URL (e.g. /notes)" value="${item.href.replace(/"/g, "&quot;")}" style="flex: 2;" />
          <button type="button" class="btn-icon text-danger remove-custom-link" data-index="${index}" style="font-size: 16px;">×</button>
        `
        customList.appendChild(row)
      })

      document.querySelectorAll(".remove-custom-link").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const idx = Number((e.currentTarget as HTMLElement).dataset.index)
          customItems.splice(idx, 1)
          renderSidebarList()
        })
      })
    }

    // Wire up "Add Custom Link" button locally
    pageLifecycle.on(window, "meitheal:sidebar-add-custom-link", () => {
      customItems.push({ id: `custom-${Date.now()}`, label: "New Link", href: "/", icon: "link" })
      renderSidebarList()
    })

    // Also bind directly to the button in case the event approach isn't needed
    const addBtnRestore = document.getElementById("add-custom-link-btn")
    if (addBtnRestore) {
      pageLifecycle.on(addBtnRestore, "click", () => {
        customItems.push({ id: `custom-${Date.now()}`, label: "New Link", href: "/", icon: "link" })
        renderSidebarList()
      })
    }

    renderSidebarList()
  } catch (e) {
    log.error("Sidebar/custom fields error", e)
  }
}
