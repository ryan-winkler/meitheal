// Extracted from kanban.astro is:inline script (PGD-01).
// DOM-heavy code uses eslint-disable for any casts on DOM Element access.
import { createClientLogger } from "@lib/client-logger";
import { escapeHtml } from "@lib/safe-html";
import { initLaneManagementPanel } from "@lib/controllers/kanban-lanes";
import { initTouchDrag } from "@lib/controllers/kanban-touch-drag";
import { initQuickActions } from "@lib/controllers/kanban-quick-actions";

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
      return cards.reduce(
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
            window.openTaskDetail(id);
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
            window.openTaskDetail(id)
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
            const res = await fetch(buildTaskApiUrl(taskId), {
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

    // Context menu for the "More" (⋯) button
    (() => {
      let activeMenu: HTMLElement | null = null;

      function closeMenu() {
        if (activeMenu) { activeMenu.remove(); activeMenu = null; }
      }

      document.addEventListener("click", (e) => {
        if (activeMenu && !activeMenu.contains(e.target as Node)) closeMenu();
      }, { signal: __signal });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
      }, { signal: __signal });

      document.querySelectorAll<HTMLElement>(".card-more-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();

          const id = btn.dataset.id;
          if (!id) return;

          const menu = document.createElement("div");
          menu.className = "kanban-context-menu";
          menu.innerHTML = `
            <button class="ctx-item ctx-delete" data-action="delete">🗑 Delete</button>
            <button class="ctx-item ctx-archive" data-action="archive">📦 Archive</button>
          `;

          // Position near button
          const rect = btn.getBoundingClientRect();
          menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left - 80}px;z-index:200;`;
          document.body.appendChild(menu);
          activeMenu = menu;

          menu.addEventListener("click", async (ev) => {
            const action = (ev.target as HTMLElement)?.closest("[data-action]")?.getAttribute("data-action");
            if (!action) return;
            closeMenu();

            if (action === "delete") {
              if (!confirm("Delete this task permanently?")) return;
              try {
                const res = await fetch(buildTaskApiUrl(id), { method: "DELETE" });
                if (res.ok) {
                  const card = document.querySelector(`.kanban-card[data-id="${id}"]`) as HTMLElement | null;
                  if (card) {
                    card.style.transition = "opacity 0.2s ease, transform 0.2s ease";
                    card.style.opacity = "0";
                    card.style.transform = "scale(0.95)";
                    setTimeout(() => { card.remove(); if (typeof window.updateAllCounts === "function") window.updateAllCounts(); }, 200);
                  }
                  if (window.showToast) window.showToast("Task deleted", "info");
                } else {
                  if (window.showToast) window.showToast("Failed to delete task", "error");
                }
              } catch {
                if (window.showToast) window.showToast("Failed to delete task", "error");
              }
            } else if (action === "archive") {
              try {
                const res = await fetch(buildTaskApiUrl(id), {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ status: "complete" }),
                });
                if (res.ok) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-archive" } }));
                else if (window.showToast) window.showToast("Failed to archive task", "error");
              } catch {
                if (window.showToast) window.showToast("Failed to archive task", "error");
              }
            }
          });
        });
      });
    })();

    // Keyboard shortcuts for kanban (N = new task, C = collapse all swimlanes)
    document.addEventListener("keydown", (e) => {
      // Skip if user is typing in an input, textarea, or contenteditable
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (document.activeElement?.getAttribute("contenteditable") === "true") return;

      // N = open quick-add in first visible column
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        const firstBtn = document.querySelector(".kanban-add-btn");
        if (firstBtn) (firstBtn as HTMLElement).click();
      }

      // C = toggle collapse all swimlane groups
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        const toggles = document.querySelectorAll(".swimlane-toggle");
        if (toggles.length === 0) return;
        // Determine action: if most are open, collapse all; else expand all
        const openCount = document.querySelectorAll(".swimlane-group:not(.collapsed)").length;
        const shouldCollapse = openCount > toggles.length / 2;
        toggles.forEach((btn) => {
          const group = btn.closest(".swimlane-group");
          if (shouldCollapse && !group?.classList.contains("collapsed")) (btn as HTMLElement).click();
          if (!shouldCollapse && group?.classList.contains("collapsed")) (btn as HTMLElement).click();
        });
      }
    }, { signal: __signal });

    // WIP limit visual indicator on column badge counts
    document.querySelectorAll<HTMLElement>(".kanban-column").forEach((col) => {
      const wipLimit = parseInt(col.dataset.wipLimit || "0", 10);
      if (wipLimit <= 0) return;
      const countBadge = col.querySelector(".kanban-count");
      if (!countBadge) return;
      const count = parseInt(countBadge.textContent || "0", 10);
      if (count >= wipLimit) {
        countBadge.classList.add("wip-over");
      } else if (count >= wipLimit * 0.8) {
        countBadge.classList.add("wip-warning");
      }
    });

    // Quick add from kanban column — uses inline form, not prompt()
    document.querySelectorAll<HTMLElement>(".kanban-add-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        // If inline form already exists, focus it
        const existing = btn.parentElement?.querySelector(".kanban-inline-add");
        if (existing) {
          existing.querySelector("input")?.focus();
          return;
        }

        const status = btn.dataset.status;
        const taskType = btn.dataset.taskType;
        const form = document.createElement("div");
        form.className = "kanban-inline-add";
        form.innerHTML = `
          <input type="text" class="form-input quick-add-input" placeholder="Task title..." aria-label="New task title" autofocus />
          <button type="button" class="btn btn-primary quick-add-btn">Add</button>
        `;
        btn.parentElement?.insertBefore(form, btn);
        btn.classList.add("hidden");

        const input = form.querySelector<HTMLInputElement>("input");
        const addBtn = form.querySelector<HTMLButtonElement>("button");
        input?.focus();

        async function submitTask() {
          const title = input!.value.trim();
          if (!title) {
            cleanup();
            return;
          }
          try {
            // P1-2: Double-submit prevention
            addBtn!.disabled = true;
            addBtn!.classList.add("btn-loading");
            const payload: Record<string, string | undefined> = { title, status };
            if (taskType) payload.task_type = taskType;
            const res = await fetch(
              "/api/tasks",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              },
            );
            if (res.ok) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-lane-add" } }));
            else {
              addBtn!.disabled = false;
              addBtn!.classList.remove("btn-loading");
            }
          } catch (err) {
            log.warn("Quick-add task failed", err);
            addBtn!.disabled = false;
            addBtn!.classList.remove("btn-loading");
          }
        }

        function cleanup() {
          form.remove();
          btn.classList.remove("hidden");
        }

        addBtn?.addEventListener("click", submitTask);
        input?.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitTask();
          }
          if (e.key === "Escape") {
            cleanup();
          }
        });
        input?.addEventListener("blur", () => {
          // Delay to allow button click
          setTimeout(() => {
            if (!form.contains(document.activeElement)) cleanup();
          }, 200);
        });
      });
    });

    // Header "+ New Task" button → open the full New Task modal dialog
    document
      .getElementById("kanban-new-task-btn")
      ?.addEventListener("click", () => {
        if (typeof window.openNewTaskModal === "function") {
          window.openNewTaskModal();
        }
      });

    // T-1907: Search filters Kanban cards in real-time
    (() => {
      const searchInput = document.querySelector(".search-input");
      if (!searchInput) return;

      searchInput.addEventListener("input", () => {
        const query = (searchInput as HTMLInputElement).value.toLowerCase().trim();
        const cards = document.querySelectorAll(".kanban-card");

        cards.forEach((card) => {
          const title = ((card as HTMLElement).dataset.title || "").toLowerCase();
          const desc = ((card as HTMLElement).dataset.desc || "").toLowerCase();
          const match = !query || title.includes(query) || desc.includes(query);
          (card as HTMLElement).style.display = match ? "" : "none";

          // Highlight matching text in title
          const titleEl = card.querySelector(".kanban-card-title .kanban-title-text");
          if (titleEl && !titleEl.hasAttribute("contenteditable")) {
            const originalTitle = (card as HTMLElement).dataset.title || "";
            if (query && match && title.includes(query)) {
              const idx = title.indexOf(query);
              const before = originalTitle.substring(0, idx);
              const matched = originalTitle.substring(idx, idx + query.length);
              const after = originalTitle.substring(idx + query.length);
              titleEl.innerHTML = `${escapeHtml(before)}<mark class="search-highlight">${escapeHtml(matched)}</mark>${escapeHtml(after)}`;
            } else {
              titleEl.textContent = originalTitle;
            }
          }
        });

        window.updateAllCounts?.();
      });
    })();

    // T-1914: Keyboard navigation for kanban board
    (() => {
      const board = document.querySelector(".kanban-board");
      if (!board) return;

      // Swimlane collapse event delegation
      board.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        const header = target.closest(".swimlane-header");
        if (header && !target.closest("button")) {
          const group = header.closest(".swimlane-group");
          if (!group) return;
          const cardsEl = group.querySelector(".swimlane-cards");
          const toggle = header.querySelector(".swimlane-toggle");
          if (!cardsEl) return;
          const isCollapsed = cardsEl.classList.toggle("collapsed");
          if (toggle) {
            toggle.classList.toggle("collapsed", isCollapsed);
            toggle.textContent = isCollapsed ? "▶" : "▼";
          }
          group.classList.toggle("swimlane-collapsed", isCollapsed);
          const type = (group as HTMLElement).dataset.swimlaneType || (group as HTMLElement).dataset.swimlaneValue || "dynamic";
          localStorage.setItem(`meitheal-swimlane-${type}`, isCollapsed ? "collapsed" : "expanded");
        }
      });

      let focusedCard: HTMLElement | null = null;

      board.addEventListener("keydown", (e) => {
        const cards = Array.from(board.querySelectorAll(".kanban-card"));
        if (!cards.length) return;

        if (!focusedCard || !document.contains(focusedCard)) {
          focusedCard = cards[0];
        }

        const currentCol = focusedCard.closest(".kanban-column");
        const colCards = Array.from(
          currentCol.querySelectorAll(".kanban-card"),
        );
        const colIdx = colCards.indexOf(focusedCard);
        const columns = Array.from(board.querySelectorAll(".kanban-column"));
        const colPos = columns.indexOf(currentCol);

        let nextCard = null;

        switch ((e as KeyboardEvent).key) {
          case "ArrowDown":
            e.preventDefault();
            nextCard = colCards[colIdx + 1] || colCards[0];
            break;
          case "ArrowUp":
            e.preventDefault();
            nextCard = colCards[colIdx - 1] || colCards[colCards.length - 1];
            break;
          case "ArrowRight":
            e.preventDefault();
            const nextCol = columns[colPos + 1] || columns[0];
            const nextColCards = nextCol?.querySelectorAll(".kanban-card");
            nextCard = nextColCards[0] || null;
            break;
          case "ArrowLeft":
            e.preventDefault();
            const prevCol = columns[colPos - 1] || columns[columns.length - 1];
            const prevColCards = prevCol?.querySelectorAll(".kanban-card");
            nextCard = prevColCards[0] || null;
            break;
          case "Enter":
            e.preventDefault();
            const id = focusedCard.dataset.id;
            if (id && typeof window.openTaskDetail === "function") {
              window.openTaskDetail(id);
            }
            return;
        }

        if (nextCard) {
          focusedCard.classList.remove("kb-focused");
          focusedCard = nextCard;
          focusedCard.classList.add("kb-focused");
          focusedCard.scrollIntoView({ block: "nearest" });
        }
      });

      // Area-level tabindex removed — it causes drag ghost artifacts and
      // makes the entire board draggable. Keyboard nav works via individual
      // card tabindex/focus instead.

      // Focus first card when board gets focus
      board.addEventListener("focus", () => {
        const firstCard = board.querySelector(".kanban-card");
        if (firstCard) {
          focusedCard = firstCard;
          focusedCard.classList.add("kb-focused");
        }
      });

      board.addEventListener("blur", () => {
        if (focusedCard) focusedCard.classList.remove("kb-focused");
      });
    })();

    // Phase 20 (Refactored): Unified filtering via FilterToolbar + filter-state
    (() => {
      // Restore group-by state
      const groupBySelect = document.getElementById("kanban-group-by");
      const savedGroupBy = localStorage.getItem("meitheal-kanban-group-by") || "none";
      if (groupBySelect && savedGroupBy !== "none") {
        (groupBySelect as HTMLInputElement).value = savedGroupBy;
        // Don't auto-dispatch here; FilterToolbar handles initialization and emits meitheal:filter-change
      }

      // We share isCardVisible with the global scope for updateAllCounts
      let currentFilterState = {};

      window.isCardVisible = function (card: HTMLElement) {
        if (!window.__filterStateLoaded) return true; // Show all before first filter event
        // We need to dynamically import the filter logic or assume it is bundled
        // Since isTaskVisible is in @lib/filter-state, we can import it dynamically
        // But table-controller.ts uses it directly. Wait, kanban is an inline script.
        // Let's implement a lighter standalone visibility check, OR import it.
        // Given we are in a module-like block:
        if (typeof window.__isTaskVisible === "function") {
          return window.__isTaskVisible!(card, currentFilterState);
        }
        return true;
      }

      // Listen for unified filter events from FilterToolbar
      document.addEventListener("meitheal:filter-change", (e) => {
        if ((e as CustomEvent).detail?.view !== "kanban") return;
        currentFilterState = (e as CustomEvent).detail;

        // Apply groupBy
          const mode = (currentFilterState as any).groupBy || "none";
          if (mode !== (localStorage.getItem("meitheal-kanban-group-by") || "none")) {
            // Sync select element if needed
            if (groupBySelect && (groupBySelect as HTMLInputElement).value !== mode) (groupBySelect as HTMLInputElement).value = mode;
          applyGroupBy(mode);
        }

        // Apply visibility to all cards
        if (typeof window.__isTaskVisible === "function") {
          document.querySelectorAll(".kanban-card").forEach(card => {
            if (window.__isTaskVisible!(card as HTMLElement, currentFilterState)) {
               (card as HTMLElement).style.display = "";
            } else {
               (card as HTMLElement).style.display = "none";
            }
          });
        }
        
        window.updateAllCounts?.();
      });

      // Unified count updater — column headers + swimlane badges
      window.updateAllCounts = function () {
        // 1. Column header counts
        document.querySelectorAll(".kanban-column").forEach((col) => {
          const count = col.querySelector(".kanban-count")
          const visible = Array.from(
            col.querySelectorAll(".kanban-card"),
          ).filter(c => (c as HTMLElement).style.display !== "none")
          if (count) count.textContent = String(visible.length)
        })

        // 2. Swimlane group counts (both static + dynamic)
        document.querySelectorAll(".swimlane-group").forEach((group) => {
          const countEl = group.querySelector(".swimlane-count-val") || group.querySelector(".swimlane-count")
          if (!countEl) return
          const visible = Array.from(
            group.querySelectorAll(".kanban-card"),
          ).filter(c => (c as HTMLElement).style.display !== "none")
          countEl.textContent = String(visible.length)
        })

        // Hide clear button (handled internally by FilterToolbar UI, but we can sync)
        const filterClearBtn = document.getElementById("kanban-clear-filters")
        if (filterClearBtn) {
           filterClearBtn.classList.toggle("hidden", 
             Object.values(currentFilterState).every(v => v === "" || v === "none" || (Array.isArray(v) && v.length === 0))
           )
        }
      }

      // Group-by implementation
      async function applyGroupBy(mode: string) {
        localStorage.setItem("meitheal-kanban-group-by", mode);

        let areaTitleMap: Record<string, string> = {};
        if (mode === "area") {
          try {
            const res = await fetch("/api/areas");
            if (res.ok) {
              const data = await res.json();
              (data.areas || []).forEach((b: any) => { areaTitleMap[b.id] = `${b.icon || '📋'} ${b.name}`; });
            }
          } catch { /* use raw IDs as fallback */ }
          areaTitleMap["default"] = "📋 Default";
        }

        // Ungroup everything first
        document.querySelectorAll(".kanban-column").forEach((col) => {
          const cardsContainer = col.querySelector(".kanban-cards");
          if (!cardsContainer) return;

          // Move all cards back to flat
          cardsContainer
            .querySelectorAll(".swimlane-group")
            .forEach((group) => {
              const swimlaneCards = group.querySelector(".swimlane-cards");
              if (swimlaneCards) {
                swimlaneCards
                  .querySelectorAll(".kanban-card")
                  .forEach((card) => {
                    card.classList.remove("grouped-card");
                    card.classList.add("flat-card");
                    cardsContainer.insertBefore(card, group);
                  });
              }
            });

          // Remove dynamic swimlane groups
          cardsContainer
            .querySelectorAll(".swimlane-group.dynamic-group")
            .forEach((g) => g.remove());
          // Hide static type swimlane groups
          cardsContainer
            .querySelectorAll(".swimlane-group:not(.dynamic-group)")
            .forEach((g) => {
              (g as HTMLElement).style.display = "none";
            });
        });

        if (mode === "none") {
          window.updateAllCounts?.();
          return;
        }

        if (mode === "type") {
          // Use the pre-rendered type swimlane groups
          document.querySelectorAll(".kanban-column").forEach((col) => {
            const cardsContainer = col.querySelector(".kanban-cards");
            if (!cardsContainer) return;
             cardsContainer.querySelectorAll<HTMLElement>(".flat-card").forEach((card) => {
              const type = card.dataset.taskType || "task";
              const swimlane = cardsContainer.querySelector(
                `.swimlane-group[data-swimlane-type="${type}"] .swimlane-cards`,
              );
              if (swimlane) {
                card.classList.remove("flat-card");
                card.classList.add("grouped-card");
                swimlane.appendChild(card);
              }
            });
            cardsContainer
              .querySelectorAll(".swimlane-group:not(.dynamic-group)")
              .forEach((group) => {
                const groupType = (group as HTMLElement).dataset.swimlaneType;
                (group as HTMLElement).style.display = ""; // Show all type swimlanes — visibility filtering handled by isTaskVisible
                const countEl = group.querySelector(".swimlane-count");
                const cards = group.querySelectorAll(".kanban-card");
                if (countEl) countEl.textContent = String(Array.from(cards).filter(c => window.isCardVisible?.(c as HTMLElement) ?? true).length);
              });
          });
        } else if (mode === "area" || mode === "priority") {
          // Dynamic swimlane generation for board/priority
          const dataAttr = mode === "area" ? "area" : "priority";
          const icons =
            mode === "priority"
              ? {
                  "1": "🔴 P1 — Critical",
                  "2": "🟠 P2 — High",
                  "3": "🟡 P3 — Medium",
                  "4": "🟢 P4 — Low",
                  "5": "⚪ P5 — Minimal",
                }
              : {};
           const defaultLabel =
            mode === "priority" ? "🟡 P3 — Medium" : "📋 Default";

          // O1: Hoist getComputedStyle outside column loop
          const cs = getComputedStyle(document.documentElement);
          const colorMap = mode === "priority"
            ? {
                "1": cs.getPropertyValue("--prio-critical").trim() || "#ef4444",
                "2": cs.getPropertyValue("--prio-high").trim() || "#f97316",
                "3": cs.getPropertyValue("--prio-medium").trim() || "#eab308",
                "4": cs.getPropertyValue("--prio-low").trim() || "#22c55e",
                "5": cs.getPropertyValue("--prio-none").trim() || "#64748b",
              }
            : {};
          const defaultAccent = cs.getPropertyValue("--accent").trim() || "#6366F1";

          document.querySelectorAll(".kanban-column").forEach((col) => {
            const cardsContainer = col.querySelector(".kanban-cards");
            if (!cardsContainer) return;
            const flatCards = Array.from(
              cardsContainer.querySelectorAll(".flat-card"),
            );

            // Collect unique values
            const groups = new Map();
             flatCards.forEach((card) => {
              const val =
                (card as HTMLElement).dataset[dataAttr] ||
                (mode === "priority" ? "3" : "default");
              if (!groups.has(val)) groups.set(val, []);
              groups.get(val).push(card);
            });

            // Sort: priority by number, board alphabetically
            const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
              if (mode === "priority") return Number(a) - Number(b);
              return a.localeCompare(b);
            });

            sortedKeys.forEach((key) => {
              const cards = groups.get(key);
              const group = document.createElement("div");
              group.className = "swimlane-group dynamic-group";
              group.dataset.swimlaneType = key;

              const accentColor = (colorMap as any)[key] || defaultAccent;
              group.style.borderTop = `3px solid ${accentColor}`;

              const header = document.createElement("div");
              header.className = "swimlane-header";
              const label =
                (icons as any)[key] || (mode === "area" ? ((areaTitleMap as any)[key] || `📋 ${key}`) : defaultLabel);
              const toggleSpan = document.createElement("span");
              toggleSpan.className = "swimlane-toggle";
              toggleSpan.textContent = "▼";

              // Color dot (matches static .swimlane-type-dot)
              const dotSpan = document.createElement("span");
              dotSpan.className = "swimlane-type-dot";
              dotSpan.style.background = accentColor;

              const labelSpan = document.createElement("span");
              labelSpan.className = "swimlane-label";
              labelSpan.textContent = label;
              const countSpan = document.createElement("span");
              countSpan.className = "swimlane-count";
              countSpan.textContent = String(cards.filter((card: any) => window.isCardVisible?.(card) ?? true).length);
              header.append(toggleSpan, dotSpan, labelSpan, countSpan);

              // Collapse toggle — matches static swimlane CSS class pattern
              header.style.cursor = "pointer"
              // Add a generic collapse listener to the kanban board instead of here

              const swimlaneCards = document.createElement("div");
              swimlaneCards.className = "swimlane-cards";
              cards.forEach((card: any) => {
                card.classList.remove("flat-card");
                card.classList.add("grouped-card");
                swimlaneCards.appendChild(card);
              });

              group.appendChild(header);
              group.appendChild(swimlaneCards);
              cardsContainer.appendChild(group);

              // Restore saved collapse state for dynamic swimlane
              const collapseKey = `meitheal-swimlane-${key}`;
              if (localStorage.getItem(collapseKey) === "collapsed") {
                swimlaneCards.classList.add("collapsed");
                toggleSpan.classList.add("collapsed");
                toggleSpan.textContent = "▶";
                group.classList.add("swimlane-collapsed");
              }
            }); // end sortedKeys.forEach
          }); // end col.forEach
        } // end else if
      } // end applyGroupBy
      // Swimlane header collapse toggle — CSS animation + localStorage persistence
      // Note: cursor:pointer set via CSS (.swimlane-header rule)
      document.querySelectorAll(".swimlane-header").forEach((header) => {
        const group = header.closest(".swimlane-group");
        if (!group) return;
        const cards = group.querySelector(".swimlane-cards");
        const toggle = header.querySelector(".swimlane-toggle");
        const type = (header as HTMLElement).dataset.type || "unknown";
        const storageKey = `meitheal-swimlane-${type}`;

        // Restore saved collapse state
        const saved = localStorage.getItem(storageKey);
        if (saved === "collapsed" && cards) {
          cards.classList.add("collapsed");
          if (toggle) {
            toggle.classList.add("collapsed");
            toggle.textContent = "▶";
          }
          group.classList.add("swimlane-collapsed");
        }
      });
    })();

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

    // Phase 32: User filter — Jira-style assignee pills
    (async function initUserFilter() {
      const container = document.getElementById("kanban-user-filters");
      if (!container) return;

      try {
        const res = await fetch("/api/users");
        if (!res.ok) return;
        const data = await res.json();
        const users = data.users || [];

        // Render user pills dynamically
        users.forEach((u: any) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "user-filter-btn";
          btn.dataset.user = u.id;
          btn.title = u.display_name || u.name || u.id;

          const avatar = document.createElement("span");
          avatar.className = "user-avatar-pill";
          avatar.style.background = u.color || "var(--accent)";
          avatar.textContent = (u.display_name || u.name || "?")
            .slice(0, 2)
            .toUpperCase();
          btn.appendChild(avatar);
          // No text label — initials avatar + title tooltip is sufficient
          // (matches Teamhood/Jira/Linear initials-only pattern)

          container.appendChild(btn);
        });
      } catch {
        /* users API unavailable — filter stays with All/Unassigned */
      }

      // Restore saved filter
      const saved =
        localStorage.getItem("meitheal-kanban-user-filter") || "all";
      const savedBtn = container.querySelector(
        `[data-user="${CSS.escape(saved)}"]`,
      );
      if (savedBtn) {
        container
          .querySelector(".filter-toolbar__user-btn.active")
          ?.classList.remove("active");
        savedBtn.classList.add("active");
      }

      // Apply filter
      function applyUserFilter() {
        const activeBtn = container!.querySelector(".filter-toolbar__user-btn.active") as HTMLElement | null;
        const userId = activeBtn?.dataset.user || "all";
        localStorage.setItem("meitheal-kanban-user-filter", userId);

        document
          .querySelectorAll(".kanban-card[data-assigned]")
          .forEach((el) => {
            const card = el as HTMLElement;
            const assigned = card.dataset.assigned || "";

            if (userId === "all") {
              card.classList.remove("user-filtered-out");
            } else if (userId === "unassigned") {
              card.classList.toggle("user-filtered-out", assigned !== "");
            } else {
              card.classList.toggle("user-filtered-out", assigned !== userId);
            }
          });

        window.updateAllCounts?.()
      }

      // Click handlers
      container.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest(".filter-toolbar__user-btn");
        if (!btn) return;
        container
          .querySelectorAll(".filter-toolbar__user-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyUserFilter();
      });

      // Apply on load
      applyUserFilter();
    })();

    // ─── Touch Drag Polyfill (Long-Press Paradigm) ─────────────
    // Extracted to @lib/controllers/kanban-touch-drag.ts
    initTouchDrag(handleDrop, __signal);
}
