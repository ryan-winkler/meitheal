import { onTaskCompleted, type TaskCompletionResponse } from "@lib/gamification-hook"
// Extracted from kanban.astro is:inline script (PGD-01).
// DOM-heavy code uses eslint-disable for any casts on DOM Element access.
import { createClientLogger } from "@lib/client-logger";
// No direct safe-html imports — moved to extracted modules
import { initTouchDrag } from "@lib/controllers/kanban-touch-drag";
import { initQuickActions } from "@lib/controllers/kanban-quick-actions";
import { initContextMenu } from "@lib/controllers/kanban-context-menu";
import { initKeyboardAndSearch } from "@lib/controllers/kanban-keyboard";
import { initKanbanGrouping } from "@lib/controllers/kanban-grouping";
import type { KanbanRefreshFocus } from "@lib/controllers/kanban-page-controller"
import { isDoneStatus } from "@lib/status-config"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
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
): void {
    const boardElement = document.querySelector<HTMLElement>("#kanban-board")
    if (!boardElement) return
    const board = boardElement
    const pendingMoves = new Map<HTMLElement, HTMLElement>()

    function buildTaskApiUrl(taskId: string | number | null, suffix = "") {
      const normalizedTaskId = String(taskId ?? "").trim()
      if (!/^[A-Za-z0-9_-]+$/.test(normalizedTaskId)) {
        throw new Error("Invalid task id")
      }
      return `/api/tasks/${encodeURIComponent(normalizedTaskId)}${suffix}`
    }

    initKanbanGrouping(board)

    async function moveTask(card: HTMLElement, lane: HTMLElement, dropGroup?: HTMLElement) {
      const taskId = card.dataset.id
      const status = lane.dataset.status
      const source = card.closest(".kanban-column")
      const typeGroup = dropGroup?.matches(".swimlane-group:not(.dynamic-group):not([hidden])") ? dropGroup : undefined
      const newType = typeGroup?.dataset.swimlaneType
      const typeChanged = Boolean(newType && newType !== card.dataset.taskType)
      if (!taskId || !status || pendingMoves.has(card) || (source === lane && !typeChanged)) return

      const laneName = lane.querySelector(".kanban-column-title")?.textContent?.trim() || status
      const limit = Number(lane.dataset.wipLimit) || 0
      const incoming = Array.from(pendingMoves.values()).filter(destination => destination === lane).length
      if (source !== lane && limit > 0 && Number(lane.dataset.total) + incoming >= limit) {
        const message = window.mI18n?.get("kanban.lane_full") ?? "{lane} has reached its work-in-progress limit ({limit})."
        showToast(message.replace("{limit}", String(limit)).replace("{lane}", laneName), "warning")
        return
      }

      const restoreFocus = card.contains(document.activeElement)
      const wasDone = isDoneStatus(card.dataset.status ?? "")
      pendingMoves.set(card, lane)
      card.setAttribute("aria-busy", "true")
      try {
        const res = await fetch(buildTaskApiUrl(taskId), { // nosemgrep
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status, task_type: typeChanged ? newType : undefined }),
        })
        if (__signal.aborted) return
        if (!res.ok) {
          const problem = res.status === 409 ? await res.json().catch(() => null) : null
          const message = problem?.blocked_by?.length
            ? window.mI18n?.get("kanban.move_blocked") ?? "Finish the blocking tasks before moving this one into progress."
            : window.mI18n?.get("kanban.move_failed") ?? "Couldn’t move the task. Try again."
          showToast(message, "error")
          return
        }

        const moved = window.mI18n?.get("kanban.moved_to") ?? "Moved to {lane}"
        showToast(moved.replace("{lane}", laneName))
        if (!wasDone && isDoneStatus(status)) recordCompletion(card, restoreFocus, await res.json())
        await refreshBoard(restoreFocus ? { taskId, lane: status } : undefined)
      } catch (error) {
        if (__signal.aborted) return
        log.warn("Could not update the Kanban lane", error)
        showToast(window.mI18n?.get("kanban.move_failed") ?? "Couldn’t move the task. Try again.", "error")
      } finally {
        pendingMoves.delete(card)
        card.removeAttribute("aria-busy")
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

    function handleDrop(event: DragEvent) {
      event.preventDefault()
      const lane = event.currentTarget as HTMLElement
      lane.classList.remove("drag-over")
      const id = event.dataTransfer?.getData("text/plain")
      if (!id) return
      const card = board.querySelector<HTMLElement>(`.kanban-card[data-id="${CSS.escape(id)}"]`)
      const targetGroup = (event.target as HTMLElement | null)?.closest<HTMLElement>(".swimlane-group") ?? undefined
      if (card) void moveTask(card, lane, targetGroup)
    }

    // ── Drag-and-drop event listeners (migrated from inline handlers for CSP) ──
    board.querySelectorAll<HTMLElement>(".kanban-column").forEach((col) => {
      // Column-level: drop, dragover, dragleave
      col.addEventListener("drop", handleDrop as unknown as EventListener, { signal: __signal });
      col.addEventListener("dragover", ((e: Event) => {
        e.preventDefault();
        (col as HTMLElement).classList.add("drag-over");
      }) as EventListener, { signal: __signal });
      col.addEventListener("dragleave", () => {
        col.classList.remove("drag-over");
      }, { signal: __signal });

      const cardsContainer = col.querySelector<HTMLElement>(".kanban-cards");
      if (!cardsContainer) return;

      // Card-level: dragstart, dragend (replaces inline handlers for CSP)
      cardsContainer.querySelectorAll<HTMLElement>(".kanban-card").forEach((card) => {
        card.addEventListener("dragstart", (e: DragEvent) => {
          if (pendingMoves.has(card)) {
            e.preventDefault()
            return
          }
          e.dataTransfer?.setData("text/plain", card.dataset.id ?? "");
          card.classList.add("dragging");
        }, { signal: __signal });
        card.addEventListener("dragend", () => {
          card.classList.remove("dragging");
          board.querySelector(".reorder-indicator")?.remove()
          document.querySelectorAll(".drag-ghost").forEach(g => g.remove());
          document.querySelectorAll(".drag-over").forEach(c => c.classList.remove("drag-over"));
        }, { signal: __signal });
      });

      const dropList = (event: DragEvent) =>
        (event.target as HTMLElement | null)?.closest<HTMLElement>(".swimlane-cards") ?? cardsContainer

      cardsContainer.addEventListener("dragover", event => {
        const drag = event as DragEvent
        drag.preventDefault()
        const dragging = col.querySelector<HTMLElement>(".kanban-card.dragging")
        const targetList = dropList(drag)
        cardsContainer.querySelector(".reorder-indicator")?.remove()
        if (!dragging || dragging.parentElement !== targetList) return
        const position = getReorderPosition(targetList, dragging, drag)
        if (!position) return

        const indicator = document.createElement("div")
        indicator.className = "reorder-indicator"
        targetList.insertBefore(indicator, position.before ? position.anchor : position.anchor.nextElementSibling)
      }, { signal: __signal })

      cardsContainer.addEventListener("dragleave", () => {
        cardsContainer.querySelector(".reorder-indicator")?.remove()
      }, { signal: __signal })

      cardsContainer.addEventListener("drop", async event => {
        const drag = event as DragEvent
        drag.preventDefault()
        cardsContainer.querySelector(".reorder-indicator")?.remove()

        const id = drag.dataTransfer?.getData("text/plain")
        const card = id ? col.querySelector<HTMLElement>(`.kanban-card[data-id="${CSS.escape(id)}"]`) : null
        const targetList = dropList(drag)
        if (!card || card.parentElement !== targetList || pendingMoves.has(card)) return

        drag.stopPropagation()
        col.classList.remove("drag-over")
        const position = getReorderPosition(targetList, card, drag)
        if (!id || !position?.anchor.dataset.id) return

        pendingMoves.set(card, col)
        try {
          const res = await fetch("/api/tasks/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task_id: id, anchor_id: position.anchor.dataset.id, lane: col.dataset.status, before: position.before }),
          })
          if (!res.ok) throw new Error("Reorder rejected")
          if (!__signal.aborted) await refreshBoard()
        } catch {
          if (!__signal.aborted) showToast(window.mI18n?.get("kanban.reorder_failed") ?? "Couldn’t save the card order. Try again.", "error")
        } finally {
          pendingMoves.delete(card)
        }
      }, { signal: __signal })
    });

    function getReorderPosition(container: HTMLElement, card: HTMLElement, event: DragEvent) {
      const hovered = (event.target as Element | null)?.closest<HTMLElement>(".kanban-card")
      if (hovered && hovered.dataset.promoted !== card.dataset.promoted) return
      const peers = Array.from(container.querySelectorAll<HTMLElement>(":scope > .kanban-card:not(.dragging)"))
        .filter(candidate => candidate !== card && candidate.dataset.promoted === card.dataset.promoted && candidate.getClientRects().length)
      const before = peers.find(peer => {
        const box = peer.getBoundingClientRect()
        return event.clientY < box.top + box.height / 2
      })
      const anchor = before ?? peers.at(-1)
      return anchor ? { anchor, before: Boolean(before) } : undefined
    }
    // Kanban card action handlers
    // T-1903: Edit button opens inline task detail panel (not redirect)
    board.querySelectorAll<HTMLButtonElement>(".card-open-btn, .card-edit-btn").forEach(btn => {
      btn.addEventListener("click", event => {
        if (event.defaultPrevented || btn instanceof HTMLAnchorElement) return
        event.stopPropagation()
        if (btn.dataset.id) openTaskDetailHandoff(btn.dataset.id)
      }, { signal: __signal })
    })

    // Card body click → open task detail (Teamhood parity)
    // Excludes: action buttons, inline-editing, checkbox clicks
    document.querySelectorAll<HTMLElement>(".kanban-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        // Skip if clicking action buttons, links, or inputs
        const target = e.target as HTMLElement | null
        if (target?.closest(".kanban-card-actions") ||
            target?.closest("button") ||
            target?.closest("a") ||
            target?.closest("input") ||
            target?.closest("[contenteditable='true']")) return

        const id = card.dataset.id
        if (!id) return

        // Debounce: skip if we just finished a drag
        if (card.classList.contains("dragging")) return

        openTaskDetailHandoff(id)
      }, { signal: __signal })
    })

    // Inline quick-edit: double-click card title to edit in place
    document.querySelectorAll<HTMLElement>(".kanban-title-text").forEach((titleSpan) => {
      titleSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation()
        e.preventDefault()
        if (titleSpan.contentEditable === "true") return

        const card = titleSpan.closest(".kanban-card")
        const taskId = titleSpan.dataset.taskId
        if (!taskId) return

        // Save original for revert
        const originalText = titleSpan.textContent

        // Enter edit mode
        titleSpan.contentEditable = "true"
        titleSpan.focus()

        // Select all text for easy replacement
        const range = document.createRange()
        range.selectNodeContents(titleSpan)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)

        // Prevent drag while editing
        if (card) card.setAttribute("draggable", "false")

        // Save handler
        async function saveEdit() {
          const newTitle = titleSpan.textContent?.trim() ?? ""
          titleSpan.contentEditable = "false"
          if (card) card.setAttribute("draggable", "true")

          // Remove listeners
          titleSpan.removeEventListener("blur", saveEdit)
          titleSpan.removeEventListener("keydown", handleKeys)

          if (!newTitle || newTitle === originalText) {
            titleSpan.textContent = originalText
            return
          }

          try {
            const res = await fetch(buildTaskApiUrl(taskId!), { // nosemgrep
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: newTitle }),
            })
            if (!res.ok) throw new Error("save failed")
            if (!__signal.aborted) await refreshBoard()
          } catch {
            titleSpan.textContent = originalText
            if (window.showToast) window.showToast("Failed to save title", "error")
          }
        }

        // Key handler
        function handleKeys(ev: KeyboardEvent) {
          if (ev.key === "Enter") {
            ev.preventDefault()
            titleSpan.blur()
          } else if (ev.key === "Escape") {
            titleSpan.textContent = originalText
            titleSpan.contentEditable = "false"
            if (card) card.setAttribute("draggable", "true")
            titleSpan.removeEventListener("blur", saveEdit)
            titleSpan.removeEventListener("keydown", handleKeys)
          }
        }

        titleSpan.addEventListener("blur", saveEdit)
        titleSpan.addEventListener("keydown", handleKeys)
      }, { signal: __signal })
    })

    // AI: open ChatGPT with task context prompt
    document.querySelectorAll<HTMLElement>(".card-ai-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const el = btn;
        const title = el.dataset.title ?? "";
        const desc = el.dataset.desc ?? "";
        const status = el.dataset.status ?? "pending";
        const priority = el.dataset.priority ?? "3";
        const prompt = `I have a task:\n\nTitle: ${title}\nStatus: ${status}\nPriority: ${priority}/5\n${desc ? `Description: ${desc}` : ""}\n\nCan you help me break this down, suggest next steps, estimate effort, or identify blockers?`;
        window.open(
          `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`,
          "_blank",
        );
      }, { signal: __signal });
    });

    // Duplicate: clone task via API
    document.querySelectorAll<HTMLButtonElement>(".card-dup-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!id) return;
        try {
          // P1-2: Double-submit prevention
          const dupBtn = btn;
          dupBtn.disabled = true;
          dupBtn.classList.add("btn-loading");
          const res = await fetch(buildTaskApiUrl(id)); // nosemgrep
          if (!res.ok) {
            dupBtn.disabled = false;
            dupBtn.classList.remove("btn-loading");
            return;
          }
          const task = await res.json();
          const dupRes = await fetch(
            "/api/tasks",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: `${task.title} (Copy)`,
                description: task.description ?? "",
                priority: task.priority ?? 3,
                status: "pending",
                due_date: task.due_date ?? null,
                labels: task.labels ?? "[]",
                framework_payload: task.framework_payload ?? "{}",
              }),
            },
          );
          if (dupRes.ok) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-duplicate" } }));
          else {
            dupBtn.disabled = false;
            dupBtn.classList.remove("btn-loading");
          }
        } catch (err) {
          log.warn("Duplicate task failed", err);
          btn.disabled = false;
          btn.classList.remove("btn-loading");
        }
      }, { signal: __signal });
    });

    // Quick actions: popover, child task, assign user, set color
    // Extracted to @lib/controllers/kanban-quick-actions.ts
    try { initQuickActions(buildTaskApiUrl, __signal, refreshBoard) } catch (e) { log.warn("Quick actions init failed", e) }

    // T-1903: Click anywhere on kanban card is natively handled by Layout.astro delegated click listener.

    // Context menu for the More button (delete/archive)
    // Extracted to @lib/controllers/kanban-context-menu.ts
    try { initContextMenu(board, buildTaskApiUrl, moveTask, refreshBoard, __signal) } catch (e) { log.warn("Context menu init failed", e) }

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

    // ─── Touch Drag Polyfill (Long-Press Paradigm) ─────────────
    // Extracted to @lib/controllers/kanban-touch-drag.ts
    try { initTouchDrag(handleDrop, __signal) } catch (e) { log.warn("Touch drag init failed", e) }
}
