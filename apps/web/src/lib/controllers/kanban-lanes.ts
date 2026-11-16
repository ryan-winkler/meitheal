/**
 * Kanban Lane Management Panel
 *
 * @domain kanban
 * @bounded-context kanban (view-layer controller)
 *
 * Handles the lane management overlay panel:
 * - CRUD operations for custom Kanban lanes via /api/lanes
 * - WIP limit editing per lane
 * - Lane rename and delete with confirmation dialog
 * - Open/close panel toggle with Escape key support
 */

import { createClientLogger } from "@lib/client-logger"
import { promptDialog } from "@lib/prompt-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"

const log = createClientLogger("kanban-lanes")

// ── Types ─────────────────────────────────────────────────────────────────

interface LanePanelLane {
  id: string
  label: string
  builtIn: boolean
  position: number
  wip_limit: number
}

// ── Public API ────────────────────────────────────────────────────────────

export function initLaneManagementPanel(): void {
  const manageLanesBtn = document.getElementById("manage-lanes-btn")
  const laneMgmt = document.getElementById("lane-mgmt")
  const laneList = document.getElementById("lane-list")
  const newLaneInput = document.getElementById("new-lane-input") as HTMLInputElement | null
  const addLaneBtn = document.getElementById("add-lane-btn")
  const laneMgmtClose = document.getElementById("lane-mgmt-close")

  if (!manageLanesBtn || !laneMgmt || !laneList || !newLaneInput || !addLaneBtn) {
    log.warn("Lane management panel skipped due to missing DOM contract", {
      hasManageLanesBtn: Boolean(manageLanesBtn),
      hasLaneMgmt: Boolean(laneMgmt),
      hasLaneList: Boolean(laneList),
      hasNewLaneInput: Boolean(newLaneInput),
      hasAddLaneBtn: Boolean(addLaneBtn),
    })
    return
  }

  log.debug("Lane management panel initialized")

  async function fetchLanes(): Promise<LanePanelLane[]> {
    try {
      const res = await fetch("/api/lanes")
      if (!res.ok) return []

      const data = await res.json()
      return Array.isArray(data?.lanes) ? data.lanes : []
    } catch (error) {
      log.warn("Failed to fetch lanes for management panel", error)
      return []
    }
  }

  function notify(message: string, variant: "error" | "success" | "warning" = "success") {
    if (window.showToast) {
      window.showToast(message, variant)
      return
    }

    const toast = document.createElement("div")
    toast.className = `toast ${variant}`
    toast.textContent = message
    document.getElementById("toast-container")?.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  }

  const renderLaneList = async (): Promise<void> => {
    const lanes = await fetchLanes()
    laneList.replaceChildren(
      ...lanes.map((lane) => {
        const item = document.createElement("div")
        item.className = "lane-item"
        item.dataset.id = lane.id
        item.dataset.position = String(lane.position)

        const labelSpan = document.createElement("span")
        labelSpan.className = "lane-item-label"
        labelSpan.textContent = `${lane.builtIn ? "🔒" : "📌"} ${lane.label}`

        const wipLabel = document.createElement("label")
        wipLabel.className = "lane-wip-label"
        wipLabel.title = "WIP limit (0 = unlimited)"
        const wipInput = document.createElement("input")
        wipInput.type = "number"
        wipInput.className = "lane-wip-input"
        wipInput.dataset.id = lane.id
        wipInput.value = String(lane.wip_limit)
        wipInput.min = "0"
        wipInput.max = "99"
        wipLabel.append(document.createTextNode("WIP: "), wipInput)

        item.append(labelSpan, wipLabel)
        if (lane.builtIn) {
          const builtinSpan = document.createElement("span")
          builtinSpan.className = "lane-builtin-label"
          builtinSpan.textContent = "built-in"
          item.appendChild(builtinSpan)
        } else {
          const editBtn = document.createElement("button")
          editBtn.type = "button"
          editBtn.className = "lane-action-btn edit lane-edit"
          editBtn.dataset.id = lane.id
          editBtn.dataset.label = lane.label
          editBtn.title = "Rename"
          editBtn.setAttribute("aria-label", "Rename lane")
          editBtn.textContent = "✎"

          const removeBtn = document.createElement("button")
          removeBtn.type = "button"
          removeBtn.className = "lane-action-btn remove lane-remove"
          removeBtn.dataset.id = lane.id
          removeBtn.title = "Remove"
          removeBtn.setAttribute("aria-label", "Remove lane")
          removeBtn.textContent = "×"

          item.append(editBtn, removeBtn)
        }
        return item
      }),
    )
  }

  const closeLaneMgmt = (): void => {
    laneMgmt.classList.add("hidden")
  }

  pageLifecycle.on(manageLanesBtn, "click", () => {
    const isOpen = !laneMgmt.classList.contains("hidden")
    log.debug("Toggling lane management panel", { isOpen })
    laneMgmt.classList.toggle("hidden", isOpen)

    if (!isOpen) {
      void renderLaneList()
    }
  })

  pageLifecycle.on(laneMgmt, "click", (event) => {
    if (event.target === laneMgmt) {
      closeLaneMgmt()
    }
  })

  pageLifecycle.on(document, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key === "Escape" && !laneMgmt.classList.contains("hidden")) {
      closeLaneMgmt()
    }
  })

  if (laneMgmtClose) {
    pageLifecycle.on(laneMgmtClose, "click", closeLaneMgmt)
  }

  pageLifecycle.on(laneList, "change", async (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>(".lane-wip-input")
    if (!input) return

    const laneId = input.dataset.id
    if (!laneId) return

    try {
      await fetch(`/api/lanes/${laneId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wip_limit: Math.max(0, Number.parseInt(input.value, 10) || 0) }),
      })
      document.dispatchEvent(
        new CustomEvent("meitheal:tasks-changed", {
          detail: { action: "kanban-wip-update" },
        }),
      )
    } catch (error) {
      log.warn("Failed to update lane WIP limit", error)
      notify("Failed to update lane WIP limit", "error")
    }
  })

  pageLifecycle.on(laneList, "click", async (event) => {
    const target = event.target as HTMLElement

    const editButton = target.closest<HTMLElement>(".lane-edit")
    if (editButton) {
      const laneId = editButton.dataset.id
      const currentLabel = editButton.dataset.label ?? ""
      if (!laneId) return

      const newName = await promptDialog({ title: "Rename Lane", placeholder: "Lane name", defaultValue: currentLabel, required: true })
      if (!newName) return

      try {
        await fetch(`/api/lanes/${laneId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: newName.trim() }),
        })
        await renderLaneList()
        document.dispatchEvent(
          new CustomEvent("meitheal:tasks-changed", {
            detail: { action: "kanban-lane-rename" },
          }),
        )
      } catch (error) {
        log.warn("Failed to rename lane", error)
        notify("Failed to rename lane", "error")
      }
      return
    }

    const removeButton = target.closest<HTMLElement>(".lane-remove")
    if (!removeButton) return

    const laneId = removeButton.dataset.id
    if (!laneId) return

    if (!window.confirmDialog) return

    const ok = await window.confirmDialog({
      message: "Tasks in this lane will move to Pending.",
      variant: "warning",
      confirmText: "Delete Lane",
      title: "Delete Lane",
    })
    if (!ok) return

    try {
      await fetch(`/api/lanes/${laneId}`, {
        method: "DELETE",
      })
      await renderLaneList()
      document.dispatchEvent(
        new CustomEvent("meitheal:tasks-changed", {
          detail: { action: "kanban-lane-delete" },
        }),
      )
    } catch (error) {
      log.warn("Failed to remove lane", error)
      notify("Failed to remove lane", "error")
    }
  })

  pageLifecycle.on(addLaneBtn, "click", async () => {
    const raw = newLaneInput.value.trim()
    const name = raw.replace(/[<>]/g, "")
    if (!name || name.length > 50) {
      notify("Lane name must be 1-50 characters", "error")
      return
    }

    try {
      const res = await fetch("/api/lanes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: name }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        notify(err.error || "Failed to create lane", "error")
        return
      }

      newLaneInput.value = ""
      await renderLaneList()
      document.dispatchEvent(
        new CustomEvent("meitheal:tasks-changed", {
          detail: { action: "kanban-lane-create" },
        }),
      )
    } catch (error) {
      log.warn("Failed to create lane", error)
      notify("Failed to create lane", "error")
    }
  })
}
