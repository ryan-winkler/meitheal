/**
 * Kanban Lane Management Panel
 *
 * @domain kanban
 * @bounded-context kanban (view-layer controller)
 */

import { createClientLogger } from "@lib/client-logger"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { promptDialog } from "@lib/prompt-dialog"
import { safeFetch } from "@lib/safe-fetch"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { showToast } from "@lib/toast"

const log = createClientLogger("kanban-lanes")
const LANE_API_PATH_RE = /^\/api\/lanes(?:\/[A-Za-z0-9._-]+)?$/

interface LanePanelLane {
  id: string
  key: string
  label: string
  color?: string | null
  includes?: string[]
  builtIn: boolean
  position: number
  wip_limit: number
}

function laneHeaders(json = false): HeadersInit | undefined {
  const ctx = currentTaskApiContext()
  const extra = json ? { "content-type": "application/json" } : undefined
  return ctx ? taskApiHeaders(ctx, extra) : extra
}

function emitLanesChanged(action: string): void {
  document.dispatchEvent(new CustomEvent("meitheal:lanes-changed", { detail: { action } }))
  document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action } }))
}

export function initLaneManagementPanel(): void {
  const manageLanesBtn = document.getElementById("manage-lanes-btn")
  const laneMgmt = document.getElementById("lane-mgmt")
  const laneList = document.getElementById("lane-list")
  const newLaneInput = document.getElementById("new-lane-input") as HTMLInputElement | null
  const addLaneBtn = document.getElementById("add-lane-btn")
  const laneMgmtClose = document.getElementById("lane-mgmt-close")

  if (!manageLanesBtn || !laneMgmt || !laneList || !newLaneInput || !addLaneBtn) {
    log.warn("Lane management panel skipped due to missing DOM contract")
    return
  }

  let loadedLanes: LanePanelLane[] = []

  async function fetchLanes(): Promise<LanePanelLane[]> {
    try {
      const headers = laneHeaders(false)
      const res = await fetch("/api/lanes", headers ? { headers } : undefined)
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data?.lanes) ? data.lanes : []
    } catch (error) {
      log.warn("Failed to fetch lanes for management panel", error)
      return []
    }
  }

  function notify(message: string, variant: "error" | "success" | "warning" = "success") {
    showToast(message, variant)
  }

  async function mutateLane(
    url: string,
    method: "POST" | "PUT" | "DELETE",
    body: unknown,
    failMessage: string,
    eventAction: string,
    opts: { refreshList?: boolean; onSuccess?: () => void } = {},
  ): Promise<boolean> {
    if (!LANE_API_PATH_RE.test(url)) {
      log.warn("Blocked unexpected lane API path", { url })
      notify(failMessage, "error")
      return false
    }
    try {
      const res = await safeFetch(url, { method, headers: laneHeaders(true), body: JSON.stringify(body) })
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null
        notify(err?.error ?? failMessage, "error")
        return false
      }
      opts.onSuccess?.()
      if (opts.refreshList) await renderLaneList()
      emitLanesChanged(eventAction)
      return true
    } catch {
      notify(failMessage, "error")
      return false
    }
  }

  async function persistLaneOrder(): Promise<void> {
    const orderedIds = Array.from(laneList!.querySelectorAll<HTMLElement>(".lane-item[data-id]"))
      .map(el => el.dataset.id)
      .filter((id): id is string => Boolean(id))
    if (!orderedIds.length) return
    const ok = await mutateLane("/api/lanes", "PUT", { ordered_ids: orderedIds }, "Failed to reorder lanes", "kanban-lane-reorder")
    if (!ok) await renderLaneList()
  }

  const renderLaneList = async (): Promise<void> => {
    loadedLanes = await fetchLanes()
    laneList.replaceChildren(
      ...loadedLanes.map((lane) => {
        const item = document.createElement("div")
        item.className = "lane-item"
        item.dataset.id = lane.id
        item.dataset.position = String(lane.position)

        const dragHandle = document.createElement("button")
        dragHandle.type = "button"
        dragHandle.className = "lane-drag-handle btn-icon"
        dragHandle.title = "Drag or press Alt+Up/Down to reorder"
        dragHandle.setAttribute("aria-label", `Reorder ${lane.label}`)
        dragHandle.textContent = "⋮⋮"

        const labelSpan = document.createElement("span")
        labelSpan.className = "lane-item-label"
        labelSpan.textContent = `${lane.builtIn ? "🔒" : "📌"} ${lane.label}`

        const colorInput = document.createElement("input")
        colorInput.type = "color"
        colorInput.className = "lane-color-input"
        colorInput.dataset.id = lane.id
        colorInput.value = lane.color && /^#[0-9a-fA-F]{6}$/.test(lane.color) ? lane.color : "#64748b"
        colorInput.title = "Lane accent color"
        colorInput.setAttribute("aria-label", `Color for ${lane.label}`)

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

        item.append(dragHandle, labelSpan, colorInput, wipLabel)
        if (lane.builtIn) {
          const builtinSpan = document.createElement("span")
          builtinSpan.className = "lane-builtin-label"
          builtinSpan.textContent = "built-in"
          item.appendChild(builtinSpan)
        } else {
          const aliasesBtn = document.createElement("button")
          aliasesBtn.type = "button"
          aliasesBtn.className = "lane-action-btn lane-includes"
          aliasesBtn.dataset.id = lane.id
          aliasesBtn.title = "Mapped statuses"
          aliasesBtn.setAttribute("aria-label", "Edit mapped statuses")
          aliasesBtn.textContent = "⊞"

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
          removeBtn.dataset.label = lane.label
          removeBtn.title = "Remove"
          removeBtn.setAttribute("aria-label", "Remove lane")
          removeBtn.textContent = "×"

          item.append(aliasesBtn, editBtn, removeBtn)
        }
        return item
      }),
    )
  }

  let dragBound = false
  const ensureDragReorder = (): void => {
    if (dragBound) return
    dragBound = true
    void import("@lib/list-drag-reorder")
      .then(({ attachVerticalListDragReorder }) => {
        if (pageLifecycle.signal.aborted) return
        attachVerticalListDragReorder(laneList, {
          handle: ".lane-drag-handle",
          item: ".lane-item",
          ghostClass: "dragging",
          signal: pageLifecycle.signal,
          onEnd: () => { void persistLaneOrder() },
        })
      })
      .catch(() => { dragBound = false })
  }

  pageLifecycle.on(laneList, "keydown", (event) => {
    const e = event as KeyboardEvent
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
    const handle = (e.target as HTMLElement | null)?.closest<HTMLElement>(".lane-drag-handle")
    const item = handle?.closest<HTMLElement>(".lane-item")
    if (!handle || !item) return
    e.preventDefault()
    const sibling = e.key === "ArrowUp" ? item.previousElementSibling : item.nextElementSibling
    if (!sibling) return
    if (e.key === "ArrowUp") laneList.insertBefore(item, sibling)
    else laneList.insertBefore(sibling, item)
    handle.focus()
    void persistLaneOrder()
  })

  const closeLaneMgmt = (): void => {
    laneMgmt.classList.add("hidden")
    manageLanesBtn.setAttribute("aria-expanded", "false")
    manageLanesBtn.focus()
  }

  pageLifecycle.on(manageLanesBtn, "click", () => {
    const isOpen = !laneMgmt.classList.contains("hidden")
    if (isOpen) closeLaneMgmt()
    else {
      laneMgmt.classList.remove("hidden")
      manageLanesBtn.setAttribute("aria-expanded", "true")
      laneMgmtClose?.focus()
      ensureDragReorder()
      void renderLaneList()
    }
  })

  pageLifecycle.on(laneMgmt, "click", (event) => {
    if (event.target === laneMgmt) closeLaneMgmt()
  })

  pageLifecycle.on(document, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key === "Escape" && !laneMgmt.classList.contains("hidden")) closeLaneMgmt()
  })

  if (laneMgmtClose) pageLifecycle.on(laneMgmtClose, "click", closeLaneMgmt)

  pageLifecycle.on(laneList, "change", async (event) => {
    const target = event.target as HTMLElement
    const colorInput = target.closest<HTMLInputElement>(".lane-color-input")
    if (colorInput?.dataset.id) {
      await mutateLane(`/api/lanes/${encodeURIComponent(colorInput.dataset.id)}`, "PUT", { color: colorInput.value }, "Failed to update lane color", "kanban-lane-color")
      return
    }

    const input = target.closest<HTMLInputElement>(".lane-wip-input")
    if (!input?.dataset.id) return
    await mutateLane(`/api/lanes/${encodeURIComponent(input.dataset.id)}`, "PUT", { wip_limit: Math.max(0, Number.parseInt(input.value, 10) || 0) }, "Failed to update lane WIP limit", "kanban-wip-update")
  })

  pageLifecycle.on(laneList, "click", async (event) => {
    const target = event.target as HTMLElement

    const includesBtn = target.closest<HTMLElement>(".lane-includes")
    if (includesBtn?.dataset.id) {
      const lane = loadedLanes.find(l => l.id === includesBtn.dataset.id)
      const current = (lane?.includes ?? [lane?.key ?? "custom"]).join(", ")
      const next = await promptDialog({
        title: "Mapped status keys",
        message: "Comma-separated status keys mapped into this lane (lowercase letters, digits, underscores):",
        defaultValue: current,
        required: true,
      })
      if (!next) return
      const statuses = next.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
      await mutateLane(`/api/lanes/${encodeURIComponent(includesBtn.dataset.id)}`, "PUT", { includes: statuses }, "Failed to update mapped statuses", "kanban-lane-includes", { refreshList: true })
      return
    }

    const editButton = target.closest<HTMLElement>(".lane-edit")
    if (editButton?.dataset.id) {
      const laneId = editButton.dataset.id
      const currentLabel = editButton.dataset.label ?? ""
      const newName = await promptDialog({ title: "Rename Lane", placeholder: "Lane name", defaultValue: currentLabel, required: true })
      if (!newName) return
      await mutateLane(`/api/lanes/${encodeURIComponent(laneId)}`, "PUT", { label: newName.trim() }, "Failed to rename lane", "kanban-lane-rename", { refreshList: true })
      return
    }

    const removeButton = target.closest<HTMLElement>(".lane-remove")
    if (!removeButton?.dataset.id) return
    const laneId = removeButton.dataset.id
    const others = loadedLanes.filter(l => l.id !== laneId)
    const fallbackTarget = others.find(l => l.key === "pending") ?? others[0]
    const ok = await confirmDialog({
      message: fallbackTarget
        ? `Tasks in "${removeButton.dataset.label || "this lane"}" will move to "${fallbackTarget.label}".`
        : "Tasks in this lane will move to Pending.",
      variant: "warning",
      confirmText: "Delete Lane",
      title: "Delete Lane",
      signal: pageLifecycle.signal,
    })
    if (!ok) return
    await mutateLane(`/api/lanes/${encodeURIComponent(laneId)}`, "DELETE", fallbackTarget ? { target_lane_id: fallbackTarget.id } : {}, "Failed to remove lane", "kanban-lane-delete", { refreshList: true })
  })

  pageLifecycle.on(addLaneBtn, "click", async () => {
    const raw = newLaneInput.value.trim()
    const name = raw.replace(/[<>]/g, "")
    if (!name || name.length > 50) {
      notify("Lane name must be 1-50 characters", "error")
      return
    }
    await mutateLane("/api/lanes", "POST", { label: name }, "Failed to create lane", "kanban-lane-create", {
      refreshList: true,
      onSuccess: () => { newLaneInput.value = "" },
    })
  })
}
