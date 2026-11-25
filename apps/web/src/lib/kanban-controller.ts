import { onTaskCompleted, type TaskCompletionResponse } from "@lib/gamification-hook"
// Extracted from kanban.astro is:inline script (PGD-01).
// DOM-heavy code uses eslint-disable for any casts on DOM Element access.
import { createClientLogger } from "@lib/client-logger";
// No direct safe-html imports — moved to extracted modules
import { initQuickActions } from "@lib/controllers/kanban-quick-actions";
import { initContextMenu } from "@lib/controllers/kanban-context-menu";
import { toggleCardPromotion } from "@lib/controllers/kanban-promotion";
import { initKeyboardAndSearch } from "@lib/controllers/kanban-keyboard";
import { initKanbanGrouping } from "@lib/controllers/kanban-grouping";
import { bumpKanbanMutationEpoch, type KanbanRefreshFocus } from "@lib/controllers/kanban-page-controller"
import { isDoneStatus } from "@lib/status-config"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { askAIForTask } from "@domains/ai/ai-context-service"
import { confirmDialog } from "@lib/confirm-dialog"
import { showToast } from "@lib/toast"

const log = createClientLogger("kanban");
/**
 * kanban-controller.ts — Kanban board interactive logic
 *
 * @domain kanban
 * @kcs Extracted from kanban.astro inline script (PGD-01).
 *      Contains drag-and-drop, quick actions, filters, inline-add,
 *      and touch drag handling. All DOM-based, no framework.
 *
 * Window globals used (set by Layout.astro):
 *   - window.showToast: Toast notification function
 *   - window.__featureFlags: Feature flag object
 *   - window.triggerConfetti: Confetti effect on task completion
 *
 * @important The signal parameter MUST come from pageLifecycle.onPageLoad()
 *            to ensure a fresh AbortSignal on each Astro navigation.
 *            DO NOT capture pageLifecycle.signal at module level — it freezes
 *            on first import and becomes stale after navigation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// Window globals (typed in types/window.d.ts):
//   showToast, __featureFlags, triggerConfetti, openTaskDetail

// LanePanelLane interface lives in @lib/controllers/kanban-lanes.ts


/**
 * Initialize all Kanban board interactivity.
 * Called from the pageLifecycle boot path in tasks.astro.
 * @param __signal - AbortSignal from pageLifecycle.onPageLoad for listener cleanup
 */
export function initKanbanArea(
  __signal: AbortSignal,
  refreshBoard: (focus?: KanbanRefreshFocus) => Promise<void>,
  queueMoveRefresh: (focus?: KanbanRefreshFocus) => void,
): void {
    const boardElement = document.querySelector<HTMLElement>("#kanban-board")
    if (!boardElement) return
    const board = boardElement
    const pendingMoves = new Map<HTMLElement, HTMLElement>()
    const pendingPromotions = new Set<string>()
    let hoveredLane: HTMLElement | null = null

    function setHoveredLane(lane: HTMLElement | null) {
      if (hoveredLane === lane) return
      hoveredLane?.classList.remove("drag-over")
      lane?.classList.add("drag-over")
      hoveredLane = lane
    }

    function syncMoveStatus(lane: HTMLElement) {
      const status = lane.querySelector<HTMLElement>("[data-kanban-move-status]")
      if (!status) return
      const pending = !__signal.aborted && [...pendingMoves].some(([card, destination]) =>
        destination === lane && card.getAttribute("aria-busy") === "true")
      const message = pending ? board.dataset.kanbanMoving ?? "" : ""
      if (status.textContent !== message) status.textContent = message
    }

    function buildTaskApiUrl(taskId: string | number | null, suffix = "") {
      const normalizedTaskId = String(taskId ?? "").trim()
      if (!/^[A-Za-z0-9_-]+$/.test(normalizedTaskId)) {
        throw new Error("Invalid task id")
      }
      return `/api/tasks/${encodeURIComponent(normalizedTaskId)}${suffix}`
    }

    initKanbanGrouping(board, __signal)

    function adjustLaneCount(col: Element | null, delta: number) {
      if (!(col instanceof HTMLElement)) return
      const nextTotal = Math.max(0, (Number(col.dataset.total) || 0) + delta)
      col.dataset.total = String(nextTotal)
      const badge = col.querySelector(".kanban-count")
      if (badge && /^\d+$/.test(badge.textContent?.trim() ?? "")) badge.textContent = String(nextTotal)
      const list = col.querySelector<HTMLElement>(".kanban-cards")
      if (!list) return
      const hasCards = list.querySelectorAll(".kanban-card").length > 0
      const emptyEl = list.querySelector<HTMLElement>(".kanban-empty")
      if (hasCards && emptyEl) {
        emptyEl.hidden = true
      } else if (!hasCards && emptyEl) {
        emptyEl.hidden = false
      }
    }

    function playSettleMotion(card: HTMLElement) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
      card.classList.remove("kanban-card--settled")
      void card.offsetWidth
      card.classList.add("kanban-card--settled")
      card.addEventListener("animationend", () => card.classList.remove("kanban-card--settled"), { once: true })
    }

    function findAnchorForCard(container: HTMLElement, card: HTMLElement): { anchorId: string; before: boolean } | null {
      const peers = Array.from(container.querySelectorAll<HTMLElement>(":scope > .kanban-card"))
        .filter((el) => el.dataset.promoted === card.dataset.promoted)
      const idx = peers.indexOf(card)
      if (idx < 0 || peers.length <= 1) return null
      const next = peers[idx + 1]
      if (next?.dataset.id) return { anchorId: next.dataset.id, before: true }
      const prev = peers[idx - 1]
      if (prev?.dataset.id) return { anchorId: prev.dataset.id, before: false }
      return null
    }

    async function persistRelativeOrder(
      card: HTMLElement,
      container: HTMLElement,
      laneStatus: string,
    ): Promise<boolean> {
      const taskId = card.dataset.id
      if (!taskId) return true
      const anchor = findAnchorForCard(container, card)
      const ctx = currentTaskApiContext()
      const headers = ctx ? taskApiHeaders(ctx, { "content-type": "application/json" }) : { "content-type": "application/json" }
      if (!anchor) return true
      const res = await fetch("/api/tasks/reorder", {
        method: "POST",
        headers,
        body: JSON.stringify({ task_id: taskId, anchor_id: anchor.anchorId, lane: laneStatus, before: anchor.before }),
      })
      return res.ok
    }

    async function moveTask(
      card: HTMLElement,
      lane: HTMLElement,
      dropGroup?: HTMLElement,
      alreadyPlaced?: {
        fromContainer: HTMLElement
        oldIndex: number
        sourceLane: HTMLElement | null
        toContainer: HTMLElement
      },
    ) {
      const taskId = card.dataset.id
      const status = lane.dataset.status
      const source = alreadyPlaced ? alreadyPlaced.sourceLane : card.closest<HTMLElement>(".kanban-column")
      const typeGroup = dropGroup?.matches(".swimlane-group:not(.dynamic-group):not([hidden])") ? dropGroup : undefined
      const newType = typeGroup?.dataset.swimlaneType
      const typeChanged = Boolean(newType && newType !== card.dataset.taskType)
      if (!taskId || !status || pendingMoves.has(card) || (source === lane && !typeChanged)) return

      const laneName = lane.querySelector(".kanban-column-title")?.textContent?.trim() || status
      const limit = Number(lane.dataset.wipLimit) || 0
      const incoming = [...pendingMoves].filter(([movingCard, destination]) =>
        destination === lane && movingCard.closest(".kanban-column") !== lane).length
      if (source !== lane && limit > 0 && Number(lane.dataset.total) + incoming >= limit) {
        if (alreadyPlaced) {
          const fromCards = alreadyPlaced.fromContainer.querySelectorAll<HTMLElement>(":scope > .kanban-card")
          const refNode = fromCards[alreadyPlaced.oldIndex] ?? null
          alreadyPlaced.fromContainer.insertBefore(card, refNode)
        }
        const message = window.mI18n?.get("kanban.lane_full") ?? "{lane} has reached its work-in-progress limit ({limit})."
        showToast(message.replace("{limit}", String(limit)).replace("{lane}", laneName), "warning")
        return
      }

      const restoreFocus = card.contains(document.activeElement)
      const wasDone = isDoneStatus(card.dataset.status ?? "")
      const prevParent = alreadyPlaced ? alreadyPlaced.fromContainer : card.parentElement
      const prevNext = alreadyPlaced
        ? (alreadyPlaced.fromContainer.querySelectorAll<HTMLElement>(":scope > .kanban-card")[alreadyPlaced.oldIndex] ?? null)
        : card.nextElementSibling
      const prevStatus = card.dataset.status ?? ""
      const prevType = card.dataset.taskType ?? ""
      const targetContainer = alreadyPlaced
        ? alreadyPlaced.toContainer
        : (typeGroup?.querySelector<HTMLElement>(".swimlane-cards") ?? lane.querySelector<HTMLElement>(".kanban-cards"))

      pendingMoves.set(card, lane)
      card.setAttribute("aria-busy", "true")
      bumpKanbanMutationEpoch()
      if (!alreadyPlaced && targetContainer && prevParent !== targetContainer) {
        if (typeGroup) typeGroup.hidden = false
        targetContainer.append(card)
      }
      card.dataset.status = status
      if (typeChanged && newType) card.dataset.taskType = newType
      if (source !== lane) {
        adjustLaneCount(source, -1)
        adjustLaneCount(lane, 1)
      }
      playSettleMotion(card)
      syncMoveStatus(lane)

      const rollbackMove = () => {
        if (prevParent?.isConnected) prevParent.insertBefore(card, prevNext?.parentNode === prevParent ? prevNext : null)
        card.dataset.status = prevStatus
        card.dataset.taskType = prevType
        if (source !== lane) {
          adjustLaneCount(source, 1)
          adjustLaneCount(lane, -1)
        }
      }

      try {
        const ctx = currentTaskApiContext()
        const res = await fetch(buildTaskApiUrl(taskId), { // nosemgrep
          method: "PUT",
          headers: ctx ? taskApiHeaders(ctx, { "content-type": "application/json" }) : { "content-type": "application/json" },
          body: JSON.stringify({ status, task_type: typeChanged ? newType : undefined }),
        })
        if (__signal.aborted) {
          if (res.ok) queueMoveRefresh()
          return
        }
        if (!res.ok) {
          rollbackMove()
          const problem = res.status === 409 ? await res.json().catch(() => null) : null
          const message = problem?.blocked_by?.length
            ? window.mI18n?.get("kanban.move_blocked") ?? "Finish the blocking tasks before moving this one into progress."
            : problem?.error ?? window.mI18n?.get("kanban.move_failed") ?? "Couldn’t move the task. Try again."
          showToast(message, "error")
          return
        }

        // The lane change is durable even if the separate order write is rejected.
        const orderSaved = !targetContainer || await persistRelativeOrder(card, targetContainer, status).catch(() => false)
        queueMoveRefresh(restoreFocus && !__signal.aborted ? { taskId, lane: status } : undefined)
        if (__signal.aborted) return
        if (orderSaved) {
          const moved = window.mI18n?.get("kanban.moved_to") ?? "Moved to {lane}"
          showToast(moved.replace("{lane}", laneName))
        } else {
          showToast(window.mI18n?.get("kanban.reorder_failed") ?? "Couldn’t save the card order. Try again.", "warning")
        }
        if (!wasDone && isDoneStatus(status)) {
          const completed = await res.json().catch(() => null)
          if (completed && !__signal.aborted) recordCompletion(card, restoreFocus, completed)
        }
      } catch (error) {
        if (__signal.aborted) return
        rollbackMove()
        log.warn("Could not update the Kanban lane", error)
        showToast(window.mI18n?.get("kanban.move_failed") ?? "Couldn’t move the task. Try again.", "error")
      } finally {
        pendingMoves.delete(card)
        card.removeAttribute("aria-busy")
        syncMoveStatus(lane)
      }
    }

    function recordCompletion(card: HTMLElement, keyboardOrMenu: boolean, completed: TaskCompletionResponse) {
      if (!completed.gamification) return
      onTaskCompleted({ gamification: { ...completed.gamification, confetti: false } })
      const flags = window.__featureFlags || {}
      const priority = Number(card.dataset.priority) || 3
      if (completed.gamification.confetti && !completed.gamification.error && !keyboardOrMenu && flags.confetti !== false && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        import("@lib/celebrations").then(({ celebrateHighPriorityComplete, fireConfetti }) => {
          if (priority <= 1) celebrateHighPriorityComplete(card.dataset.title || "Task")
          else fireConfetti({ particleCount: 32, duration: 1200 })
        }).catch(() => window.triggerConfetti?.())
      }
    }

    // Mount SortableJS on visible Kanban card containers (.swimlane-cards when grouped, otherwise .kanban-cards)
    const canEditBoard = board.closest<HTMLElement>("[data-task-workspace]")?.dataset.canEdit !== "false"
    const sortableInstances: Array<{ destroy: () => void }> = []
    let justDragged = false
    let dragGuardTimer: ReturnType<typeof setTimeout> | undefined

    if (canEditBoard) {
      // Prevent native HTML5 dragstart (e.g. from links/images/text inside a card) from hijacking SortableJS pointer drag
      board.addEventListener("dragstart", (e) => {
        if ((e.target as HTMLElement | null)?.closest(".kanban-card")) {
          e.preventDefault()
        }
      }, { signal: __signal })

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const groupMode = board.dataset.groupBy ?? "none"
      const lists: HTMLElement[] = []
      board.querySelectorAll<HTMLElement>(".kanban-column").forEach((col) => {
        const visibleSwimlaneLists = groupMode !== "none"
          ? Array.from(col.querySelectorAll<HTMLElement>(".swimlane-group:not([hidden]) > .swimlane-cards"))
          : []
        if (visibleSwimlaneLists.length > 0) {
          lists.push(...visibleSwimlaneLists)
        } else {
          const list = col.querySelector<HTMLElement>(".kanban-cards")
          if (list) lists.push(list)
        }
      })

      void import("sortablejs").then(({ default: Sortable }) => {
        if (__signal.aborted) return
        for (const list of lists) {
          const instance = Sortable.create(list, {
            group: "kanban-cards",
            draggable: ".kanban-card",
            filter: "button, a, input, textarea, select, [contenteditable='true'], .kanban-empty, .kanban-inline-add",
            preventOnFilter: false,
            forceFallback: true,
            fallbackOnBody: true,
            fallbackTolerance: 3,
            touchStartThreshold: 4,
            delayOnTouchOnly: true,
            delay: 140,
            invertSwap: true,
            animation: reducedMotion ? 0 : 180,
            easing: "cubic-bezier(0.23, 1, 0.32, 1)",
            ghostClass: "kanban-sortable-ghost",
            chosenClass: "kanban-sortable-chosen",
            dragClass: "kanban-sortable-drag",
            fallbackClass: "kanban-sortable-fallback",
            swapThreshold: 0.65,
            emptyInsertThreshold: 44,
            onStart: () => {
              justDragged = true
              clearTimeout(dragGuardTimer)
              document.body.classList.add("kanban-dragging")
            },
            onMove: (evt) => {
              const dragged = evt.dragged as HTMLElement
              const related = evt.related as HTMLElement | null
              const targetCol = evt.to.closest<HTMLElement>(".kanban-column")
              setHoveredLane(targetCol)
              if (pendingMoves.has(dragged)) return false
              if (related?.classList.contains("swimlane-group")) return false
              const from = evt.from.closest<HTMLElement>(".dynamic-group")
              const to = evt.to.closest<HTMLElement>(".dynamic-group")
              if (evt.from !== evt.to && (from || to) &&
                (!from || !to || from.dataset.swimlaneType !== to.dataset.swimlaneType || groupMode === "status")) return false
              if (evt.from === evt.to && related?.classList.contains("kanban-card")) {
                // Keep promoted cards grouped above regular cards inside the same lane
                if (dragged.dataset.promoted !== related.dataset.promoted) return false
              }
              return true
            },
            onEnd: async (evt) => {
              document.body.classList.remove("kanban-dragging")
              setHoveredLane(null)
              clearTimeout(dragGuardTimer)
              dragGuardTimer = setTimeout(() => { justDragged = false }, 120)

              const card = evt.item as HTMLElement
              const fromList = evt.from as HTMLElement
              const toList = evt.to as HTMLElement
              const sourceLane = fromList.closest<HTMLElement>(".kanban-column")
              const targetLane = toList.closest<HTMLElement>(".kanban-column")
              const oldIndex = evt.oldDraggableIndex ?? evt.oldIndex ?? 0
              const newIndex = evt.newDraggableIndex ?? evt.newIndex ?? 0
              if (!targetLane || !card.dataset.id) return

              if (fromList === toList) {
                if (oldIndex === newIndex || pendingMoves.has(card)) return
                const laneStatus = targetLane.dataset.status
                if (!laneStatus) return
                pendingMoves.set(card, targetLane)
                bumpKanbanMutationEpoch()
                playSettleMotion(card)
                try {
                  const ok = await persistRelativeOrder(card, toList, laneStatus)
                  if (!ok) throw new Error("Reorder rejected")
                } catch {
                  // Rollback DOM order smoothly without board reload flash
                  const cards = Array.from(toList.querySelectorAll<HTMLElement>(":scope > .kanban-card"))
                  const targetRef = cards[oldIndex] ?? null
                  if (oldIndex < newIndex) toList.insertBefore(card, targetRef)
                  else toList.insertBefore(card, targetRef ? targetRef.nextElementSibling : null)
                  if (!__signal.aborted) {
                    showToast(window.mI18n?.get("kanban.reorder_failed") ?? "Couldn’t save the card order. Try again.", "error")
                  }
                } finally {
                  pendingMoves.delete(card)
                }
                return
              }

              const targetGroup = toList.closest<HTMLElement>(".swimlane-group") ?? undefined
              await moveTask(card, targetLane, targetGroup, {
                fromContainer: fromList,
                oldIndex,
                sourceLane,
                toContainer: toList,
              })
            },
          })
          sortableInstances.push(instance)
        }
        board.dataset.sortingReady = "true"
      }).catch((err) => {
        log.warn("SortableJS init failed on Kanban", err)
      })
    }

    __signal.addEventListener("abort", () => {
      clearTimeout(dragGuardTimer)
      document.body.classList.remove("kanban-dragging")
      setHoveredLane(null)
      for (const inst of sortableInstances) {
        try { inst.destroy() } catch { /* already destroyed */ }
      }
      sortableInstances.length = 0
      for (const status of board.querySelectorAll("[data-kanban-move-status]")) status.textContent = ""
    }, { once: true })
    // O(1) delegated Kanban card interactions (1-click Tabler Star promote, open/edit, AI, duplicate, body click)
    board.addEventListener("click", async (event) => {
      if (justDragged) return
      const target = event.target instanceof Element ? event.target : null
      if (!target) return

      const starBtn = target.closest<HTMLButtonElement>(".kanban-promote-star")
      if (starBtn) {
        event.stopPropagation()
        const card = starBtn.closest<HTMLElement>(".kanban-card")
        if (card) void toggleCardPromotion({ card, buildTaskApiUrl, refreshBoard, pendingPromotions, signal: __signal })
        return
      }

      const openOrEdit = target.closest<HTMLElement>(".card-open-btn, .card-edit-btn")
      if (openOrEdit) {
        if (event.defaultPrevented || openOrEdit instanceof HTMLAnchorElement) return
        event.stopPropagation()
        if (openOrEdit.dataset.id) openTaskDetailHandoff(openOrEdit.dataset.id)
        return
      }

      const aiBtn = target.closest<HTMLButtonElement>(".card-ai-btn")
      if (aiBtn) {
        event.stopPropagation()
        const id = aiBtn.dataset.id ?? aiBtn.closest<HTMLElement>(".kanban-card")?.dataset.id
        if (!id || aiBtn.getAttribute("aria-busy") === "true" || __signal.aborted) return
        aiBtn.setAttribute("aria-busy", "true")
        aiBtn.disabled = true
        try {
          const result = await askAIForTask(id, __signal)
          if (__signal.aborted) return
          if (result.source === "ha-assist") {
            await confirmDialog({
              title: "AI Assistant",
              message: result.response,
              confirmText: "Done",
              cancelText: "Close",
              copyPrompt: {
                text: result.response,
                label: "Copy response",
                success: "Copied",
                failure: "Copy failed",
              },
              signal: __signal,
            })
          }
        } catch {
          if (!__signal.aborted) showToast("settings.ai_handoff_context_failed", "error")
        } finally {
          aiBtn.removeAttribute("aria-busy")
          aiBtn.disabled = false
        }
        return
      }

      const dupBtn = target.closest<HTMLButtonElement>(".card-dup-btn")
      if (dupBtn) {
        event.stopPropagation()
        const id = dupBtn.dataset.id
        if (!id || dupBtn.disabled || __signal.aborted) return
        dupBtn.disabled = true
        dupBtn.classList.add("btn-loading")
        try {
          const ctx = currentTaskApiContext()
          const dupRes = await fetch(`/api/tasks/${encodeURIComponent(id)}/duplicate`, {
            method: "POST",
            ...(ctx ? { headers: taskApiHeaders(ctx) } : {}),
            signal: __signal,
          })
          if (__signal.aborted) return
          if (!dupRes.ok) {
            showToast("Failed to duplicate", "error")
            return
          }
          const dupData = await dupRes.json().catch(() => null) as { id?: string; title?: string } | null
          showToast(dupData?.title ? `Duplicated → ${dupData.title}` : "Task duplicated", "success")
          document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", {
            detail: { id: dupData?.id, action: "kanban-duplicate" },
          }))
        } catch (err) {
          if (!__signal.aborted) {
            log.warn("Duplicate task failed", err)
            showToast("Failed to duplicate", "error")
          }
        } finally {
          dupBtn.disabled = false
          dupBtn.classList.remove("btn-loading")
        }
        return
      }

      const card = target.closest<HTMLElement>(".kanban-card")
      if (!card || card.classList.contains("dragging")) return
      if (target.closest(".kanban-card-actions") ||
          target.closest("button") ||
          target.closest("a") ||
          target.closest("input") ||
          target.closest("[contenteditable='true']")) return
      if (card.dataset.id) openTaskDetailHandoff(card.dataset.id)
    }, { signal: __signal })

    // O(1) delegated inline title double-click edit
    board.addEventListener("dblclick", (e) => {
      if (board.closest<HTMLElement>("[data-task-workspace]")?.dataset.canEdit === "false") return
      const titleSpan = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(".kanban-title-text")
      if (!titleSpan || titleSpan.contentEditable === "true") return
      e.stopPropagation()
      e.preventDefault()

      const card = titleSpan.closest<HTMLElement>(".kanban-card")
      const taskId = titleSpan.dataset.taskId
      if (!taskId || card?.hasAttribute("data-title-saving")) return

      const originalText = titleSpan.textContent
      titleSpan.contentEditable = "true"
      titleSpan.focus()

      const range = document.createRange()
      range.selectNodeContents(titleSpan)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)

      async function saveEdit() {
        const newTitle = titleSpan!.textContent?.trim() ?? ""
        titleSpan!.contentEditable = "false"

        titleSpan!.removeEventListener("blur", saveEdit)
        titleSpan!.removeEventListener("keydown", handleKeys)

        if (!newTitle || newTitle === originalText) {
          titleSpan!.textContent = originalText
          return
        }

        card?.setAttribute("data-title-saving", "")
        try {
          const ctx = currentTaskApiContext()
          const version = Number(card?.dataset.version)
          const res = await fetch(buildTaskApiUrl(taskId!), { // nosemgrep
            method: "PUT",
            headers: ctx ? taskApiHeaders(ctx, { "content-type": "application/json" }) : { "content-type": "application/json" },
            body: JSON.stringify({
              title: newTitle,
              ...(Number.isSafeInteger(version) && version >= 0 ? { updated_at: version } : {}),
            }),
          })
          if (res.status === 409) {
            titleSpan!.textContent = originalText
            showToast("Task was updated elsewhere. Refreshing board.", "warning")
            if (!__signal.aborted) await refreshBoard()
            return
          }
          if (!res.ok) throw new Error("save failed")
          const saved = await res.json().catch(() => null) as { task_version?: unknown; updated_at?: unknown } | null
          const nextVersion = Number(saved?.task_version ?? saved?.updated_at)
          if (card && Number.isSafeInteger(nextVersion) && nextVersion >= 0) {
            card.dataset.version = String(nextVersion)
          }
          if (!__signal.aborted) await refreshBoard()
        } catch {
          titleSpan!.textContent = originalText
          showToast("Failed to save title", "error")
        } finally {
          card?.removeAttribute("data-title-saving")
        }
      }

      function handleKeys(ev: KeyboardEvent) {
        if (ev.key === "Enter") {
          ev.preventDefault()
          titleSpan!.blur()
        } else if (ev.key === "Escape") {
          titleSpan!.textContent = originalText
          titleSpan!.contentEditable = "false"
          titleSpan!.removeEventListener("blur", saveEdit)
          titleSpan!.removeEventListener("keydown", handleKeys)
        }
      }

      titleSpan.addEventListener("blur", saveEdit)
      titleSpan.addEventListener("keydown", handleKeys)
    }, { signal: __signal })

    // Quick actions: popover, child task, assign user, set color
    // Extracted to @lib/controllers/kanban-quick-actions.ts
    try { initQuickActions(buildTaskApiUrl, __signal, refreshBoard) } catch (e) { log.warn("Quick actions init failed", e) }

    // Context menu for the More button (delete/archive)
    // Extracted to @lib/controllers/kanban-context-menu.ts
    try { initContextMenu(board, buildTaskApiUrl, moveTask, refreshBoard, __signal, pendingPromotions) } catch (e) { log.warn("Context menu init failed", e) }

    // Keyboard shortcuts, WIP limits, quick-add, search, board navigation
    // Extracted to @lib/controllers/kanban-keyboard.ts
    try { initKeyboardAndSearch(__signal) } catch (e) { log.warn("Keyboard/search init failed", e) }

    // T-1915: Column collapse toggle (REMOVED — clicking lane headers to collapse
    // was unintuitive UX and caused visual breakage, per user feedback).

    // --- Offline Attachments Feature (Phase 23) ---
    (async function renderThumbnails() {
      if (!window.indexedDB) return;
      // Only attempt module load if there are attachment slots in the DOM
      const slots = document.querySelectorAll("img.kanban-attachment");
      if (!slots.length) return;
      try {
        // Dynamic import — Vite resolves this at build time into the
        // bundled chunk. No @vite-ignore needed since path is static.
        const mod = await import("@domains/offline/offline-store").catch(
          function () {
            return null; // Silently skip if module not available
          },
        );
        if (!mod || !mod.getAttachmentsByTaskId) return;
        const getAttachmentsByTaskId = mod.getAttachmentsByTaskId;
        slots.forEach(async (img) => {
          const taskId = img.getAttribute("data-task-id");
          if (!taskId) return;
          const attachments = await getAttachmentsByTaskId(taskId);
          if (attachments.length > 0) {
            // Get the first image
            const cover = attachments.find((a) =>
              a.mimeType.startsWith("image/"),
            );
            if (cover) {
              img.setAttribute("src", cover.base64Data);
              img.classList.remove("hidden");
            }
          }
        });
      } catch (_) {
        /* Offline attachments unavailable — non-critical */
      }
    })();
}
