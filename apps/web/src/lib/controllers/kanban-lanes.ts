/**
 * Kanban Lane Management Panel (Tabler Sortable Table)
 *
 * @domain kanban
 * @bounded-context kanban (view-layer controller)
 */

import { createClientLogger } from "@lib/client-logger"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { promptDialog } from "@lib/prompt-dialog"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { showToast } from "@lib/toast"
import { createSpriteIconElement } from "../../generated/icon-registry"

const log = createClientLogger("kanban-lanes")

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

const BUILTIN_DEFAULT_LABELS: Record<string, string> = {
  backlog: "Backlog",
  pending: "Todo",
  active: "In Progress",
  complete: "Done",
}

const DEFAULT_LANE_COLORS: Record<string, string> = {
  backlog: "#9ca3af",
  pending: "#3b82f6",
  active: "#f59e0b",
  complete: "#22c55e",
}

function laneHeaders(json = false): HeadersInit | undefined {
  const ctx = currentTaskApiContext()
  const extra = json ? { "content-type": "application/json" } : undefined
  return ctx ? taskApiHeaders(ctx, extra) : extra
}

function emitLanesChanged(action: string): void {
  document.dispatchEvent(new CustomEvent("meitheal:lanes-changed", { detail: { action } }))
  document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action, dataOnly: true } }))
}

function resolveLaneColor(lane: LanePanelLane): string {
  return lane.color && /^#[0-9a-fA-F]{6}$/.test(lane.color)
    ? lane.color
    : (DEFAULT_LANE_COLORS[lane.key] ?? "#64748b")
}

export function initLaneManagementPanel(): void {
  const manageLanesBtn = document.getElementById("manage-lanes-btn")
  const laneMgmt = document.getElementById("lane-mgmt")
  const laneList = document.getElementById("lane-list")
  const newLaneInput = document.getElementById("new-lane-input") as HTMLInputElement | null
  const addLaneBtn = document.getElementById("add-lane-btn")
  const laneMgmtClose = document.getElementById("lane-mgmt-close")
  const helpBtn = document.getElementById("lane-mgmt-help-btn")
  const helpPopover = document.getElementById("lane-mgmt-help-popover")

  if (!manageLanesBtn || !laneMgmt || !laneList || !newLaneInput || !addLaneBtn) {
    log.warn("Lane management panel skipped due to missing DOM contract")
    return
  }

  let loadedLanes: LanePanelLane[] = []

  if (helpBtn && helpPopover) {
    pageLifecycle.on(helpBtn, "click", () => {
      const nextOpen = helpPopover.hidden
      helpPopover.hidden = !nextOpen
      helpBtn.setAttribute("aria-expanded", String(nextOpen))
    })
  }

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
    try {
      const res = await fetch(url, { method, headers: laneHeaders(true), body: JSON.stringify(body) })
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
    const orderedIds = Array.from(laneList!.querySelectorAll<HTMLElement>("tr.lane-item"))
      .map(el => el.dataset.laneId)
      .filter((id): id is string => Boolean(id))
    if (!orderedIds.length) return
    const ok = await mutateLane("/api/lanes", "PUT", { ordered_ids: orderedIds }, "Failed to reorder lanes", "kanban-lane-reorder")
    if (!ok) await renderLaneList()
  }

  const renderLaneList = async (): Promise<void> => {
    loadedLanes = await fetchLanes()
    laneList.replaceChildren(
      ...loadedLanes.map((lane) => {
        const row = document.createElement("tr")
        row.className = "lane-item"
        row.dataset.laneId = lane.id
        row.dataset.position = String(lane.position)

        // Column 1: Single centered Tabler drag handle (no competing second icon)
        const dragCell = document.createElement("td")
        dragCell.className = "lane-cell-drag"
        const dragHandle = document.createElement("button")
        dragHandle.type = "button"
        dragHandle.className = "lane-drag-handle"
        dragHandle.title = "Drag or press Alt+Up/Down to reorder"
        dragHandle.setAttribute("aria-label", `Reorder ${lane.label}`)
        dragHandle.appendChild(createSpriteIconElement("grip-vertical", { size: 15 }))
        dragCell.appendChild(dragHandle)

        // Column 2: Color dot + visual label + (system name) when built-in is aliased
        const nameCell = document.createElement("td")
        const nameWrap = document.createElement("div")
        nameWrap.className = "lane-name-cell"

        const primaryLine = document.createElement("div")
        primaryLine.className = "lane-name-primary"

        const colorHex = resolveLaneColor(lane)
        const colorDot = document.createElement("span")
        colorDot.className = "lane-color-dot"
        colorDot.style.background = colorHex
        colorDot.setAttribute("aria-hidden", "true")

        const visualLabel = document.createElement("span")
        visualLabel.className = "lane-visual-label"
        visualLabel.textContent = lane.label
        primaryLine.append(colorDot, visualLabel)

        if (lane.builtIn) {
          const defaultName = BUILTIN_DEFAULT_LABELS[lane.key] ?? lane.key
          if (lane.label.trim().toLowerCase() !== defaultName.toLowerCase()) {
            const sysName = document.createElement("span")
            sysName.className = "lane-system-name"
            sysName.textContent = `(${defaultName})`
            sysName.title = `System swimlane: ${defaultName} (status key: ${lane.key})`
            primaryLine.appendChild(sysName)
          }
        }
        nameWrap.appendChild(primaryLine)

        const metaLine = document.createElement("div")
        metaLine.className = "lane-status-meta"
        const mappedKeys = lane.includes && lane.includes.length > 0 ? lane.includes : [lane.key]
        const statusCode = document.createElement("span")
        statusCode.className = "lane-status-code"
        statusCode.textContent = `status: ${mappedKeys.join(", ")}`
        metaLine.appendChild(statusCode)
        nameWrap.appendChild(metaLine)
        nameCell.appendChild(nameWrap)

        // Column 3: Color picker
        const colorCell = document.createElement("td")
        colorCell.className = "lane-cell-color"
        const colorInput = document.createElement("input")
        colorInput.type = "color"
        colorInput.className = "lane-color-input"
        colorInput.dataset.id = lane.id
        colorInput.value = colorHex
        colorInput.title = "Lane accent color"
        colorInput.setAttribute("aria-label", `Color for ${lane.label}`)
        colorCell.appendChild(colorInput)

        // Column 4: WIP limit
        const wipCell = document.createElement("td")
        wipCell.className = "lane-cell-wip"
        const wipInput = document.createElement("input")
        wipInput.type = "number"
        wipInput.className = "lane-wip-input"
        wipInput.dataset.id = lane.id
        wipInput.value = String(lane.wip_limit)
        wipInput.min = "0"
        wipInput.max = "99"
        wipInput.title = "WIP limit (0 = unlimited)"
        wipInput.setAttribute("aria-label", `WIP limit for ${lane.label}`)
        wipCell.appendChild(wipInput)

        // Column 5: Peer-weighted Tabler actions
        const actionsCell = document.createElement("td")
        actionsCell.className = "lane-cell-actions"
        const actionsGroup = document.createElement("div")
        actionsGroup.className = "lane-actions-group"

        const editBtn = document.createElement("button")
        editBtn.type = "button"
        editBtn.className = "lane-action-btn edit lane-edit"
        editBtn.dataset.id = lane.id
        editBtn.dataset.label = lane.label
        editBtn.dataset.builtin = String(lane.builtIn)
        editBtn.title = lane.builtIn ? "Alias / rename built-in lane" : "Rename lane"
        editBtn.setAttribute("aria-label", `Rename ${lane.label}`)
        editBtn.appendChild(createSpriteIconElement("pencil", { size: 14 }))

        if (lane.builtIn) {
          const builtinBadge = document.createElement("span")
          builtinBadge.className = "lane-builtin-badge"
          builtinBadge.textContent = "Built-in"
          builtinBadge.title = `Built-in system status (${lane.key})`
          actionsGroup.append(builtinBadge, editBtn)
        } else {
          const aliasesBtn = document.createElement("button")
          aliasesBtn.type = "button"
          aliasesBtn.className = "lane-action-btn lane-includes"
          aliasesBtn.dataset.id = lane.id
          aliasesBtn.title = "Edit mapped status keys"
          aliasesBtn.setAttribute("aria-label", `Edit mapped statuses for ${lane.label}`)
          aliasesBtn.appendChild(createSpriteIconElement("tag", { size: 14 }))

          const removeBtn = document.createElement("button")
          removeBtn.type = "button"
          removeBtn.className = "lane-action-btn remove lane-remove"
          removeBtn.dataset.id = lane.id
          removeBtn.dataset.label = lane.label
          removeBtn.title = "Delete lane"
          removeBtn.setAttribute("aria-label", `Delete ${lane.label}`)
          removeBtn.appendChild(createSpriteIconElement("trash", { size: 14 }))

          actionsGroup.append(aliasesBtn, editBtn, removeBtn)
        }

        actionsCell.appendChild(actionsGroup)
        row.append(dragCell, nameCell, colorCell, wipCell, actionsCell)
        return row
      }),
    )
  }

  let sortableMounted = false
  let sortableInstance: { destroy(): void } | null = null
  const ensureDragReorder = (): void => {
    if (sortableMounted) return
    sortableMounted = true
    void import("sortablejs")
      .then(({ default: Sortable }) => {
        if (pageLifecycle.signal.aborted) return
        sortableInstance = Sortable.create(laneList, {
          handle: ".lane-drag-handle",
          draggable: "tr.lane-item",
          animation: 160,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
          forceFallback: true,
          fallbackOnBody: true,
          fallbackTolerance: 3,
          ghostClass: "lane-item--ghost",
          chosenClass: "lane-item--chosen",
          fallbackClass: "lane-item--fallback",
          onEnd: (evt) => {
            if (evt.oldIndex !== evt.newIndex) {
              void persistLaneOrder()
            }
          },
        })
        pageLifecycle.signal.addEventListener("abort", () => {
          sortableInstance?.destroy()
          sortableInstance = null
        }, { once: true })
      })
      .catch(() => { sortableMounted = false })
  }

  pageLifecycle.on(laneList, "keydown", (event) => {
    const e = event as KeyboardEvent
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
    const handle = (e.target as HTMLElement | null)?.closest<HTMLElement>(".lane-drag-handle")
    const item = handle?.closest<HTMLElement>("tr.lane-item")
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
      const dot = colorInput.closest("tr")?.querySelector<HTMLElement>(".lane-color-dot")
      if (dot) dot.style.background = colorInput.value
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
      const isBuiltIn = editButton.dataset.builtin === "true"
      const newName = await promptDialog({
        title: isBuiltIn ? "Alias Built-in Lane" : "Rename Lane",
        message: isBuiltIn ? "Set a display alias for this swimlane. Its underlying system status stays unchanged." : undefined,
        placeholder: "Lane name",
        defaultValue: currentLabel,
        required: true,
      })
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

  pageLifecycle.on(newLaneInput, "keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") {
      event.preventDefault()
      addLaneBtn.click()
    }
  })
}
