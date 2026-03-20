// Extracted from kanban.astro is:inline script (PGD-01).
// DOM-heavy code uses eslint-disable for any casts on DOM Element access.
import { createClientLogger } from "@lib/client-logger";
// No direct safe-html imports — moved to extracted modules
import { initLaneManagementPanel } from "@lib/controllers/kanban-lanes";
import { initTouchDrag } from "@lib/controllers/kanban-touch-drag";
import { initQuickActions } from "@lib/controllers/kanban-quick-actions";
import { initContextMenu } from "@lib/controllers/kanban-context-menu";
import { initKeyboardAndSearch } from "@lib/controllers/kanban-keyboard";
import { initGroupingAndFilters } from "@lib/controllers/kanban-grouping";
import { initUserFilter } from "@lib/controllers/kanban-user-filter";

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
export function initKanbanArea(__signal: AbortSignal): void {
    const shell = document.getElementById("kanban-shell")
    if (shell?.dataset.kanbanBooted === "true") {
      return
    }
    if (shell) {
      shell.dataset.kanbanBooted = "true"
    }

    // Section navigation removed — IA flattened in Phase 16.1

    initLaneManagementPanel();

    function buildTaskApiUrl(taskId: string | number | null, suffix = "") {
      const normalizedTaskId = String(taskId ?? "").trim()
      if (!/^[A-Za-z0-9_-]+$/.test(normalizedTaskId)) {
        throw new Error("Invalid task id")
      }
      return `/api/tasks/${encodeURIComponent(normalizedTaskId)}${suffix}`
    }

    async function handleDrop(e: DragEvent) {
      e.preventDefault();
      const col = e.currentTarget as HTMLElement | null;
      if (!col) return;
      col.classList.remove("drag-over");
      if (!e.dataTransfer) return;
      const taskId = e.dataTransfer.getData("text/plain");
      const newStatus = (col as HTMLElement).dataset?.status;
      if (!taskId || !newStatus) return;

      // WIP Limit enforcement
      const wipLimit = parseInt(col.dataset.wipLimit || "0");
      const targetCardsContainer = col.querySelector(".kanban-cards");
      const currentCardCount = targetCardsContainer
        ? targetCardsContainer.querySelectorAll(".kanban-card").length
        : 0;

      const card = document.querySelector(`.kanban-card[data-id="${taskId}"]`);
      if (!card) return;

      const oldCol = card.closest(".kanban-column");
      if (oldCol !== col && wipLimit > 0 && currentCardCount >= wipLimit) {
        const wipToast = document.createElement("div");
        wipToast.className = "toast error kanban-contextual-toast";
        wipToast.textContent = `WIP limit of ${wipLimit} reached for this lane`;
        wipToast.style.cssText =
          "position:fixed;top:16px;right:16px;z-index:100;pointer-events:none;";
        document.body.appendChild(wipToast);
        setTimeout(() => wipToast.remove(), 3000);
        return;
      }

      // T-1902: Optimistic DOM update — no page reload
      // Phase 20: Detect drop into specific swimlane
      const dropTarget = e.target as HTMLElement | null;
      const targetSwimlane = dropTarget?.closest(".swimlane-group") ?? null;
      const targetCards = targetSwimlane
        ? targetSwimlane.querySelector(".swimlane-cards")
        : col.querySelector(".kanban-cards");

      if (targetCards) {
        // Remove empty state if present
        const empty = targetCards.querySelector(".kanban-empty");
        if (empty) empty.remove();

        // Remove ghost if present
        const ghost = targetCards.querySelector(".drag-ghost");
        if (ghost) ghost.remove();

        targetCards.appendChild(card);
        (card as HTMLElement).dataset.status = newStatus;
        if (targetSwimlane) {
          // Update the card's native dataset so filtering still works on reload
          (card as HTMLElement).dataset.taskType = (targetSwimlane as HTMLElement).dataset.swimlaneType;
          // Find the badge inside the card and update visually if possible - this requires a reload for full icon update, but we keep the structure
        }
      }

      // Update column counts
      [oldCol, col].forEach((c) => {
        if (!c) return;
        const count = c.querySelector(".kanban-count");
        const cards = c.querySelectorAll(".kanban-card");
        if (count) count.textContent = String(cards.length);
        // Show empty state if column is now empty
        if (cards.length === 0) {
          const cardsContainer = c.querySelector(".kanban-cards");
          if (
            cardsContainer &&
            !cardsContainer.querySelector(".kanban-empty")
          ) {
            const emptyDiv = document.createElement("div");
            emptyDiv.className = "kanban-empty";
            emptyDiv.textContent = "Drop tasks here";
            cardsContainer.appendChild(emptyDiv);
          }
        }
      });

      // Toast feedback — positioned near the dropped card
      const toast = document.createElement("div");
      toast.className = "toast success kanban-contextual-toast";
      toast.textContent = `Moved to ${newStatus}`;
      const cardRect = (card as HTMLElement).getBoundingClientRect();
      toast.style.cssText = `position:fixed;top:${Math.max(cardRect.top - 40, 8)}px;left:${cardRect.left}px;z-index:100;pointer-events:none;`;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2000);

      // Persist to API (background, no reload)
      try {
        const payload: Record<string, string | undefined> = { status: newStatus };
        if (targetSwimlane) {
          payload.task_type = (targetSwimlane as HTMLElement).dataset.swimlaneType;
        }
        await fetch(buildTaskApiUrl(taskId), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });

        // WIP limit warning toast (soft limit — allows drop but warns)
        const wipLimit = parseInt((col as HTMLElement).dataset?.wipLimit || "0", 10)
        if (wipLimit > 0) {
          const currentCount = col.querySelectorAll(".kanban-card").length
          if (currentCount > wipLimit) {
            const colTitle = col.querySelector(".kanban-column-title")?.textContent || "this column"
            if (window.showToast) window.showToast(`⚠️ WIP limit exceeded: ${currentCount}/${wipLimit} in ${colTitle}`, "warning")
          }
        }

        // Gamification: priority-aware celebrations + record completion when dropped to complete
        if (newStatus === "complete") {
          const ff = window.__featureFlags || {};
          if (ff.confetti !== false) {
            const cardPriority = parseInt((card as HTMLElement).dataset.priority ?? "3", 10) || 3;
            const cardTitle = card.querySelector(".kanban-title-text")?.textContent?.trim() || "Task";
            // Use celebrations module for priority-aware confetti
            import("@lib/celebrations").then(({ celebrateHighPriorityComplete, fireConfetti }) => {
              if (cardPriority <= 1) {
                celebrateHighPriorityComplete(cardTitle)
              } else {
                fireConfetti({ particleCount: 32, duration: 1200 })
              }
            }).catch(() => {
              // Fallback to window.triggerConfetti for legacy compat
              if (typeof window.triggerConfetti === "function") window.triggerConfetti()
            })
          }
          if (ff.gamification !== false) {
            const gamPriority = parseInt((card as HTMLElement).dataset.priority ?? "3", 10) || 3;
            fetch("/api/gamification", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ priority: gamPriority }),
            }).catch(function() {});
          }
        }
      } catch {
        // Show error feedback before reverting
        if (window.showToast) window.showToast("Failed to move task — reverting", "error")
        // Revert on failure — refresh to get server state
        setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-revert" } })), 800)
      }
    }

    // ── Drag-and-drop event listeners (migrated from inline handlers for CSP) ──
    document.querySelectorAll(".kanban-column").forEach((col) => {
      // Column-level: drop, dragover, dragleave
      col.addEventListener("drop", handleDrop as unknown as EventListener);
      col.addEventListener("dragover", ((e: Event) => {
        e.preventDefault();
        (col as HTMLElement).classList.add("drag-over");
      }) as EventListener);
      col.addEventListener("dragleave", () => {
        col.classList.remove("drag-over");
      });

      const cardsContainer = col.querySelector(".kanban-cards");
      if (!cardsContainer) return;

      // Card-level: dragstart, dragend (replaces inline handlers for CSP)
      cardsContainer.querySelectorAll<HTMLElement>(".kanban-card").forEach((card) => {
        card.addEventListener("dragstart", (e: DragEvent) => {
          e.dataTransfer?.setData("text/plain", card.dataset.id ?? "");
          card.classList.add("dragging");
        });
        card.addEventListener("dragend", () => {
          card.classList.remove("dragging");
          document.querySelectorAll(".drag-ghost").forEach(g => g.remove());
          document.querySelectorAll(".drag-over").forEach(c => c.classList.remove("drag-over"));
        });
      });

      cardsContainer.addEventListener("dragover", ((e: Event) => {
        e.preventDefault();
        const dragging = document.querySelector(".kanban-card.dragging");
        if (!dragging) return;

        // Only show reorder indicator if dragging within the SAME column
        const sourceCol = dragging.closest(".kanban-column");
        if (sourceCol !== col) return;

        // Remove existing drop indicators
        cardsContainer
          .querySelectorAll(".reorder-indicator")
          .forEach((i) => i.remove());

        const afterEl = getDragAfterElement(cardsContainer as HTMLElement, (e as DragEvent).clientY);
        const indicator = document.createElement("div");
        indicator.className = "reorder-indicator";

        if (afterEl) {
          cardsContainer.insertBefore(indicator, afterEl);
        } else {
          cardsContainer.appendChild(indicator);
        }
      }) as EventListener);

      cardsContainer.addEventListener("dragleave", () => {
        cardsContainer
          .querySelectorAll(".reorder-indicator")
          .forEach((i) => i.remove());
      });

      cardsContainer.addEventListener("drop", (async (e: Event) => {
        e.preventDefault();
        cardsContainer
          .querySelectorAll(".reorder-indicator")
          .forEach((i) => i.remove());

        const taskId = (e as DragEvent).dataTransfer?.getData("text/plain");
        const card = document.querySelector(
          `.kanban-card[data-id="${taskId}"]`,
        );
        if (!card) return;

        const sourceCol = card.closest(".kanban-column");
        // Only handle same-lane reorder here; cross-lane handled by handleDrop
        if (sourceCol !== col) return;

        // Stop propagation so the column-level handleDrop doesn't also fire
        e.stopPropagation();

        const afterEl = getDragAfterElement(cardsContainer as HTMLElement, (e as DragEvent).clientY);
        if (afterEl) {
          cardsContainer.insertBefore(card, afterEl);
        } else {
          cardsContainer.appendChild(card);
        }

        // Persist new order
        const orderedIds = Array.from(
          cardsContainer.querySelectorAll(".kanban-card"),
        )
          .map((c) => (c as HTMLElement).dataset.id)
          .filter(Boolean);

        try {
          await fetch("/api/tasks/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ordered_ids: orderedIds }),
          });
        } catch {
          // Silent fail — order will revert on next load
        }
      }) as EventListener);
    });

    /**
     * Get the element after which the dragged card should be inserted,
     * based on the Y position of the mouse during the drag event.
     */
    function getDragAfterElement(container: HTMLElement, y: number) {
      const cards = [
        ...container.querySelectorAll(".kanban-card:not(.dragging)"),
      ];
      return cards.reduce<{ offset: number; element: Element | null }>(
        (closest, child) => {
          const box = child.getBoundingClientRect();
          const offset = y - box.top - box.height / 2;
          if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
          }
          return closest;
        },
        { offset: Number.NEGATIVE_INFINITY, element: null },
      ).element;
    }
    // Kanban card action handlers
    // T-1903: Edit button opens inline task detail panel (not redirect)
    document.querySelectorAll<HTMLElement>(".card-edit-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!id) return;
        // openTaskDetail may not be available immediately (Layout script loads async)
        // Retry briefly before falling back
        let attempts = 0;
        function tryOpen() {
          if (typeof window.openTaskDetail === "function") {
            window.openTaskDetail(id!);
          } else if (attempts < 10) {
            attempts++;
            setTimeout(tryOpen, 50);
          }
        }
        tryOpen();
      });
    });

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

        let attempts = 0
        function tryOpen() {
          if (typeof window.openTaskDetail === "function") {
            window.openTaskDetail(id!)
          } else if (attempts < 10) {
            attempts++
            setTimeout(tryOpen, 50)
          }
        }
        tryOpen()
      })
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
            const res = await fetch(buildTaskApiUrl(taskId!), {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: newTitle }),
            })
            if (!res.ok) throw new Error("save failed")
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
      })
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
      });
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
          const res = await fetch(buildTaskApiUrl(id));
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
      });
    });

    // Quick actions: popover, child task, assign user, set color
    // Extracted to @lib/controllers/kanban-quick-actions.ts
    const _qa = initQuickActions(buildTaskApiUrl, __signal);


    // T-1903: Click anywhere on kanban card is natively handled by Layout.astro delegated click listener.

    // Context menu for the More button (delete/archive)
    // Extracted to @lib/controllers/kanban-context-menu.ts
    initContextMenu(buildTaskApiUrl, __signal);

    // Keyboard shortcuts, WIP limits, quick-add, search, board navigation
    // Extracted to @lib/controllers/kanban-keyboard.ts
    initKeyboardAndSearch(__signal);

    // Group-by/swimlane logic, filter integration, counts
    // Extracted to @lib/controllers/kanban-grouping.ts
    initGroupingAndFilters();

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

    // User filter: Jira-style assignee pills
    // Extracted to @lib/controllers/kanban-user-filter.ts
    initUserFilter();

    // ─── Touch Drag Polyfill (Long-Press Paradigm) ─────────────
    // Extracted to @lib/controllers/kanban-touch-drag.ts
    initTouchDrag(handleDrop, __signal);
}
