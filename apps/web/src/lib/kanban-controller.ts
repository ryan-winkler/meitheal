// @ts-nocheck — Extracted from kanban.astro is:inline script (PGD-01).
// Progressive typing tracked as future work. All code is working production JS.
/**
 * kanban-controller.ts — Kanban board interactive logic
 *
 * @domain kanban
 * @kcs Extracted from kanban.astro inline script (PGD-01).
 *      Contains drag-and-drop, quick actions, filters, inline-add,
 *      and touch drag handling. All DOM-based, no framework.
 *
 * Window globals used (set by Layout.astro):
 *   - window.__ingress_path: HA ingress path prefix
 *   - window.showToast: Toast notification function
 *   - window.__featureFlags: Feature flag object
 *   - window.triggerConfetti: Confetti effect on task completion
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __ingress_path?: string
    showToast?: (msg: string, type?: string) => void
    __featureFlags?: Record<string, boolean>
    triggerConfetti?: () => void
    openTaskModal?: (id: string) => void
  }
}

/**
 * Initialize all Kanban board interactivity.
 * Called on `astro:page-load` from kanban.astro.
 */
export function initKanbanBoard(): void {
    async function handleDrop(e) {
      e.preventDefault();
      const col = e.currentTarget;
      col.classList.remove("drag-over");
      const taskId = e.dataTransfer.getData("text/plain");
      const newStatus = col.dataset.status;
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
      const targetSwimlane = e.target.closest(".swimlane-group");
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
        card.dataset.status = newStatus;
        if (targetSwimlane) {
          // Update the card's native dataset so filtering still works on reload
          card.dataset.taskType = targetSwimlane.dataset.swimlaneType;
          // Find the badge inside the card and update visually if possible - this requires a reload for full icon update, but we keep the structure
        }
      }

      // Update column counts
      [oldCol, col].forEach((c) => {
        if (!c) return;
        const count = c.querySelector(".kanban-count");
        const cards = c.querySelectorAll(".kanban-card");
        if (count) count.textContent = cards.length;
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
      const cardRect = card.getBoundingClientRect();
      toast.style.cssText = `position:fixed;top:${Math.max(cardRect.top - 40, 8)}px;left:${cardRect.left}px;z-index:100;pointer-events:none;`;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2000);

      // Persist to API (background, no reload)
      try {
        const payload = { status: newStatus };
        if (targetSwimlane) {
          payload.task_type = targetSwimlane.dataset.swimlaneType;
        }
        await fetch(`${window.__ingress_path || ""}/api/tasks/${taskId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });

        // WIP limit warning toast (soft limit — allows drop but warns)
        const wipLimit = parseInt(targetCol.dataset.wipLimit || "0", 10)
        if (wipLimit > 0) {
          const currentCount = targetCol.querySelectorAll(".kanban-card").length
          if (currentCount > wipLimit) {
            const colTitle = targetCol.querySelector(".kanban-column-title")?.textContent || "this column"
            if (window.showToast) window.showToast(`⚠️ WIP limit exceeded: ${currentCount}/${wipLimit} in ${colTitle}`, "warning")
          }
        }

        // Gamification: confetti + record completion when dropped to complete
        if (newStatus === "complete") {
          var ff = window.__featureFlags || {};
          if (ff.confetti !== false && typeof window.triggerConfetti === "function") window.triggerConfetti();
          if (ff.gamification !== false) {
            var cardPriority = parseInt(card.dataset.priority ?? "3", 10) || 3;
            fetch("/api/gamification", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ priority: cardPriority }),
            }).catch(function() {});
          }
        }
      } catch {
        // Show error feedback before reverting
        if (window.showToast) window.showToast("Failed to move task — reverting", "error")
        // Revert on failure — reload to get server state
        setTimeout(() => window.location.reload(), 800)
      }
    }

    // ── Drag-and-drop event listeners (migrated from inline handlers for CSP) ──
    document.querySelectorAll(".kanban-column").forEach((col) => {
      // Column-level: drop, dragover, dragleave
      col.addEventListener("drop", handleDrop);
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("drag-over");
      });
      col.addEventListener("dragleave", () => {
        col.classList.remove("drag-over");
      });

      const cardsContainer = col.querySelector(".kanban-cards");
      if (!cardsContainer) return;

      // Card-level: dragstart, dragend (replaces inline handlers for CSP)
      cardsContainer.querySelectorAll(".kanban-card").forEach((card) => {
        card.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", card.dataset.id);
          card.classList.add("dragging");
        });
        card.addEventListener("dragend", () => {
          card.classList.remove("dragging");
          document.querySelectorAll(".drag-ghost").forEach(g => g.remove());
          document.querySelectorAll(".drag-over").forEach(c => c.classList.remove("drag-over"));
        });
      });

      cardsContainer.addEventListener("dragover", (e) => {
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

        const afterEl = getDragAfterElement(cardsContainer, e.clientY);
        const indicator = document.createElement("div");
        indicator.className = "reorder-indicator";

        if (afterEl) {
          cardsContainer.insertBefore(indicator, afterEl);
        } else {
          cardsContainer.appendChild(indicator);
        }
      });

      cardsContainer.addEventListener("dragleave", () => {
        cardsContainer
          .querySelectorAll(".reorder-indicator")
          .forEach((i) => i.remove());
      });

      cardsContainer.addEventListener("drop", async (e) => {
        e.preventDefault();
        cardsContainer
          .querySelectorAll(".reorder-indicator")
          .forEach((i) => i.remove());

        const taskId = e.dataTransfer.getData("text/plain");
        const card = document.querySelector(
          `.kanban-card[data-id="${taskId}"]`,
        );
        if (!card) return;

        const sourceCol = card.closest(".kanban-column");
        // Only handle same-lane reorder here; cross-lane handled by handleDrop
        if (sourceCol !== col) return;

        // Stop propagation so the column-level handleDrop doesn't also fire
        e.stopPropagation();

        const afterEl = getDragAfterElement(cardsContainer, e.clientY);
        if (afterEl) {
          cardsContainer.insertBefore(card, afterEl);
        } else {
          cardsContainer.appendChild(card);
        }

        // Persist new order
        const orderedIds = Array.from(
          cardsContainer.querySelectorAll(".kanban-card"),
        )
          .map((c) => c.dataset.id)
          .filter(Boolean);

        try {
          await fetch((window.__ingress_path || "") + "/api/tasks/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ordered_ids: orderedIds }),
          });
        } catch {
          // Silent fail — order will revert on next load
        }
      });
    });

    /**
     * Get the element after which the dragged card should be inserted,
     * based on the Y position of the mouse during the drag event.
     */
    function getDragAfterElement(container, y) {
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
    document.querySelectorAll(".card-edit-btn").forEach((btn) => {
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
    document.querySelectorAll(".kanban-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        // Skip if clicking action buttons, links, or inputs
        const target = e.target
        if (target.closest(".kanban-card-actions") ||
            target.closest("button") ||
            target.closest("a") ||
            target.closest("input") ||
            target.closest("[contenteditable='true']")) return

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
    document.querySelectorAll(".kanban-title-text").forEach((titleSpan) => {
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
        sel.removeAllRanges()
        sel.addRange(range)

        // Prevent drag while editing
        if (card) card.setAttribute("draggable", "false")

        // Save handler
        async function saveEdit() {
          const newTitle = titleSpan.textContent.trim()
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
            const res = await fetch(`${window.__ingress_path || ""}/api/tasks/${taskId}`, {
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
        function handleKeys(ev) {
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
    document.querySelectorAll(".card-ai-btn").forEach((btn) => {
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
    document.querySelectorAll(".card-dup-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!id) return;
        try {
          // P1-2: Double-submit prevention
          const dupBtn = btn;
          dupBtn.disabled = true;
          dupBtn.classList.add("btn-loading");
          const res = await fetch(
            `${window.__ingress_path || ""}/api/tasks/${id}`,
          );
          if (!res.ok) {
            dupBtn.disabled = false;
            dupBtn.classList.remove("btn-loading");
            return;
          }
          const task = await res.json();
          const dupRes = await fetch(
            (window.__ingress_path || "") + "/api/tasks",
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
          if (dupRes.ok) window.location.reload();
          else {
            dupBtn.disabled = false;
            dupBtn.classList.remove("btn-loading");
          }
        } catch (err) {
          console.warn("[Meitheal] Duplicate task failed:", err);
          btn.disabled = false;
          btn.classList.remove("btn-loading");
        }
      });
    });

    // =============================================
    // Quick Actions: Shared Popover Utility (P4-1)
    // =============================================
    const _qa = (() => {
      let activePopover = null;
      let _scrollCleanup = null;

      /** Close any open quick-action popover with exit animation (P3-5) */
      function close() {
        if (!activePopover) return;
        const el = activePopover;
        activePopover = null;
        el.classList.add("popover-exiting");
        setTimeout(() => el.remove(), 150);
        if (_scrollCleanup) { _scrollCleanup(); _scrollCleanup = null; }
      }

      /** Reusable toast with fallback (P2-6) */
      function toast(msg, type = "success") {
        if (window.showToast) window.showToast(msg, type);
        else console.log(`[Meitheal] ${type}: ${msg}`);
      }

      /**
       * Open a popover near a trigger button (P1-4 scroll-aware, P3-5 animation)
       * @param {HTMLElement} btn - trigger button
       * @param {HTMLElement} content - popover content element
       * @param {string} title - popover header text
       * @returns {HTMLElement} the popover element
       */
      function open(btn, content, title) {
        close();
        const popover = document.createElement("div");
        popover.className = "quick-action-popover";
        popover.setAttribute("role", "dialog");
        popover.setAttribute("aria-label", title);

        const header = document.createElement("div");
        header.className = "popover-title";
        header.id = "qa-popover-title-" + Date.now();
        header.textContent = title;
        popover.setAttribute("aria-labelledby", header.id);
        popover.appendChild(header);
        popover.appendChild(content);

        // Position near button
        const rect = btn.getBoundingClientRect();
        popover.style.position = "fixed";
        popover.style.top = `${rect.bottom + 4}px`;
        
        // P6-1: Use CSS logical properties for popover positioning
        const INLINE_START_PROP = "insetInlineStart" in popover.style ? "insetInlineStart" : "left";
        popover.style[INLINE_START_PROP] = `${rect.left}px`;
        popover.style.zIndex = "9999";
        document.body.appendChild(popover);
        activePopover = popover;

        // Keep in viewport (P1-4)
        requestAnimationFrame(() => {
          const popRect = popover.getBoundingClientRect();
          if (popRect.right > window.innerWidth) {
            popover.style[INLINE_START_PROP] = `${window.innerWidth - popRect.width - 8}px`;
          }
          if (popRect.bottom > window.innerHeight) {
            popover.style.top = `${rect.top - popRect.height - 4}px`;
          }
        });

        // Close on scroll (P1-4)
        const board = document.querySelector(".kanban-scroll-area, .kanban-board");
        const onScroll = () => close();
        board?.addEventListener("scroll", onScroll, { once: true });
        window.addEventListener("scroll", onScroll, { once: true });
        _scrollCleanup = () => {
          board?.removeEventListener("scroll", onScroll);
          window.removeEventListener("scroll", onScroll);
        };

        // Focus first interactive element (P1-1)
        requestAnimationFrame(() => {
          const first = popover.querySelector("button, [tabindex]");
          if (first) first.focus();
        });

        return popover;
      }

      // P0-3: Single consolidated document listener for all popovers
      document.addEventListener("click", (e) => {
        if (activePopover && !activePopover.contains(e.target) &&
            !e.target.closest(".card-assign-btn, .card-color-btn")) {
          close();
        }
      });
      document.addEventListener("keydown", (e) => {
        if (!activePopover) return;
        if (e.key === "Escape") { close(); return; }
        // Arrow key navigation within popover items (P1-1)
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = [...activePopover.querySelectorAll("button.popover-item, button.color-swatch")];
          if (!items.length) return;
          const idx = items.indexOf(document.activeElement);
          const next = e.key === "ArrowDown"
            ? items[(idx + 1) % items.length]
            : items[(idx - 1 + items.length) % items.length];
          next?.focus();
        }
      });

      // P2-4: Cleanup listeners on Astro navigation
      document.addEventListener("astro:before-swap", () => close(), { once: true });

      return { close, toast, open };
    })();

    // =============================================
    // Quick Action: Add Child Task (P1-3, P1-6, P3-6)
    // =============================================
    document.querySelectorAll(".card-child-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const parentId = btn.dataset.id;
        const parentTitle = btn.dataset.title || "Task";
        const parentPriority = btn.dataset.priority || "3";
        if (!parentId) return;

        const card = btn.closest(".kanban-card");
        const boardId = card?.dataset.board || "";

        btn.disabled = true;
        btn.classList.add("btn-loading");
        try {
          const res = await fetch((window.__ingress_path || "") + "/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: `${parentTitle.slice(0, 80)} — Subtask`,
              parent_id: parentId,
              status: "pending",
              priority: Number(parentPriority),
              board_id: boardId || undefined,
              task_type: "task",
            }),
          });
          if (res.ok) {
            _qa.toast("Child task created", "success");
            // P1-6: Reload to show new card (DOM insertion would require full card template)
            const scrollLeft = document.querySelector(".kanban-scroll-area")?.scrollLeft || 0;
            sessionStorage.setItem("meitheal-kanban-scroll", String(scrollLeft));
            window.location.reload();
          } else {
            _qa.toast("Failed to create child task", "error");
          }
        } catch (err) {
          console.warn("[Meitheal] Add child failed:", err);
          _qa.toast("Failed to create child task", "error");
        } finally {
          btn.disabled = false;
          btn.classList.remove("btn-loading");
        }
      });
    });

    // Restore scroll position after child task reload (P1-6)
    const savedScroll = sessionStorage.getItem("meitheal-kanban-scroll");
    if (savedScroll) {
      sessionStorage.removeItem("meitheal-kanban-scroll");
      requestAnimationFrame(() => {
        const scrollArea = document.querySelector(".kanban-scroll-area");
        if (scrollArea) scrollArea.scrollLeft = Number(savedScroll);
      });
    }

    // =============================================
    // Quick Action: Assign User (P1-5 skeleton, P2-7 colors, P3-4 optimistic)
    // =============================================
    document.querySelectorAll(".card-assign-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();

        const taskId = btn.dataset.id;
        const currentAssigned = btn.dataset.assigned || "";
        if (!taskId) return;

        // P1-5: Show popover immediately with loading skeleton
        const content = document.createElement("div");
        content.innerHTML = `
          <div class="popover-item skeleton" style="height:28px;border-radius:var(--radius-sm);background:var(--bg-hover);animation:pulse 1.5s infinite"></div>
          <div class="popover-item skeleton" style="height:28px;border-radius:var(--radius-sm);background:var(--bg-hover);animation:pulse 1.5s infinite;animation-delay:0.3s"></div>
        `;
        const popover = _qa.open(btn, content, "Assign User");

        // Fetch users
        let users = [];
        try {
          const res = await fetch((window.__ingress_path || "") + "/api/users");
          if (res.ok) {
            const data = await res.json();
            users = data.users || [];
          }
        } catch { /* fallback to empty */ }

        // Replace skeleton with real content
        if (!popover.parentNode) return; // popover was closed during fetch
        content.innerHTML = "";

        // Unassign option
        const unassignItem = document.createElement("button");
        unassignItem.className = "popover-item" + (!currentAssigned ? " active" : "");
        unassignItem.setAttribute("role", "menuitem");
        unassignItem.textContent = "∅ Unassigned";
        unassignItem.addEventListener("click", async () => {
          // P3-4: Optimistic update
          btn.dataset.assigned = "";
          const card = btn.closest(".kanban-card");
          if (card) card.dataset.assigned = "";
          _qa.close();
          try {
            const res = await fetch(`${window.__ingress_path || ""}/api/tasks/${taskId}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ assigned_to: null }),
            });
            if (res.ok) _qa.toast("Unassigned", "success");
            else { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to unassign", "error"); }
          } catch { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to unassign", "error"); }
        });
        content.appendChild(unassignItem);

        // User list with colored dots (P2-7)
        users.forEach((user) => {
          const userId = user.id || user.name;
          const item = document.createElement("button");
          item.className = "popover-item" + (currentAssigned === userId ? " active" : "");
          item.setAttribute("role", "menuitem");
          // P2-7: Colored dot for user recognition
          const dot = user.color ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${user.color};margin-right:6px;vertical-align:middle"></span>` : "👤 ";
          item.innerHTML = `${dot}${user.name || user.id}`;
          item.addEventListener("click", async () => {
            // P3-4: Optimistic update
            btn.dataset.assigned = userId;
            const card = btn.closest(".kanban-card");
            if (card) card.dataset.assigned = userId;
            _qa.close();
            try {
              const res = await fetch(`${window.__ingress_path || ""}/api/tasks/${taskId}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ assigned_to: userId }),
              });
              if (res.ok) _qa.toast(`Assigned to ${(user.name || userId).replace(/^(ha_|custom_)/, "")}`, "success");
              else { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to assign", "error"); }
            } catch { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to assign", "error"); }
          });
          content.appendChild(item);
        });

        if (!users.length) {
          const empty = document.createElement("div");
          empty.className = "popover-item";
          empty.style.color = "var(--text-muted)";
          empty.style.fontStyle = "italic";
          empty.textContent = "No users configured";
          content.appendChild(empty);
        }
      });
    });

    // =============================================
    // Quick Action: Set Color (P1-2 active indicator, P3-4 optimistic)
    // =============================================
    (() => {
      const COLOR_SWATCHES = [
        { color: "#ef4444", label: "Red" },
        { color: "#f97316", label: "Orange" },
        { color: "#eab308", label: "Yellow" },
        { color: "#22c55e", label: "Green" },
        { color: "#3b82f6", label: "Blue" },
        { color: "#8b5cf6", label: "Purple" },
        { color: "#ec4899", label: "Pink" },
        { color: "#6b7280", label: "Gray" },
      ];

      document.querySelectorAll(".card-color-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();

          const taskId = btn.dataset.id;
          if (!taskId) return;

          const card = btn.closest(".kanban-card");
          const currentColor = btn.dataset.color || "";

          const content = document.createElement("div");

          const grid = document.createElement("div");
          grid.className = "color-swatch-grid";
          grid.setAttribute("role", "radiogroup");
          grid.setAttribute("aria-label", "Color options");

          COLOR_SWATCHES.forEach(({ color, label }) => {
            const swatch = document.createElement("button");
            swatch.className = "color-swatch";
            // P1-2: Active color indicator
            if (currentColor && currentColor.toLowerCase() === color.toLowerCase()) {
              swatch.classList.add("swatch-active");
            }
            swatch.style.background = color;
            swatch.title = label;
            swatch.setAttribute("role", "radio");
            swatch.setAttribute("aria-checked", currentColor === color ? "true" : "false");
            swatch.setAttribute("aria-label", `Set color: ${label}`);
            swatch.addEventListener("click", async () => {
              // P3-4: Optimistic UI
              if (card) card.style.borderLeft = `5px solid ${color}`;
              btn.dataset.color = color;
              _qa.close();
              try {
                const res = await fetch(`${window.__ingress_path || ""}/api/tasks/${taskId}`, {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ color }),
                });
                if (res.ok) _qa.toast("Color updated", "success");
                else { if (card) card.style.borderLeft = currentColor ? `5px solid ${currentColor}` : ""; _qa.toast("Failed to set color", "error"); }
              } catch { if (card) card.style.borderLeft = currentColor ? `5px solid ${currentColor}` : ""; _qa.toast("Failed to set color", "error"); }
            });
            grid.appendChild(swatch);
          });

          content.appendChild(grid);

          // Clear color button
          const clearBtn = document.createElement("button");
          clearBtn.className = "popover-item clear-color-btn";
          clearBtn.setAttribute("role", "menuitem");
          clearBtn.textContent = "✕ Clear color";
          clearBtn.addEventListener("click", async () => {
            if (card) card.style.borderLeft = "";
            btn.dataset.color = "";
            _qa.close();
            try {
              const res = await fetch(`${window.__ingress_path || ""}/api/tasks/${taskId}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ color: null }),
              });
              if (res.ok) _qa.toast("Color cleared", "success");
              else _qa.toast("Failed to clear color", "error");
            } catch { _qa.toast("Failed to clear color", "error"); }
          });
          content.appendChild(clearBtn);

          _qa.open(btn, content, "Card Color");
        });
      });
    })();

    // T-1903: Click anywhere on kanban card is natively handled by Layout.astro delegated click listener.

    // Context menu for the "More" (⋯) button
    (() => {
      let activeMenu = null;

      function closeMenu() {
        if (activeMenu) { activeMenu.remove(); activeMenu = null; }
      }

      document.addEventListener("click", (e) => {
        if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
      });

      document.querySelectorAll(".card-more-btn").forEach((btn) => {
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
            const action = ev.target.closest("[data-action]")?.dataset.action;
            if (!action) return;
            closeMenu();

            if (action === "delete") {
              if (!confirm("Delete this task permanently?")) return;
              try {
                const res = await fetch(`${window.__ingress_path || ""}/api/tasks/${id}`, { method: "DELETE" });
                if (res.ok) {
                  const card = document.querySelector(`.kanban-card[data-id="${id}"]`);
                  if (card) {
                    card.style.transition = "opacity 0.2s ease, transform 0.2s ease";
                    card.style.opacity = "0";
                    card.style.transform = "scale(0.95)";
                    setTimeout(() => { card.remove(); window.updateAllCounts(); }, 200);
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
                const res = await fetch(`${window.__ingress_path || ""}/api/tasks/${id}`, {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ status: "complete" }),
                });
                if (res.ok) window.location.reload();
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
        if (firstBtn) firstBtn.click();
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
          if (shouldCollapse && !group?.classList.contains("collapsed")) btn.click();
          if (!shouldCollapse && group?.classList.contains("collapsed")) btn.click();
        });
      }
    });

    // WIP limit visual indicator on column badge counts
    document.querySelectorAll(".kanban-column").forEach((col) => {
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
    document.querySelectorAll(".kanban-add-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        // If inline form already exists, focus it
        const existing = btn.parentElement.querySelector(".kanban-inline-add");
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
        btn.parentElement.insertBefore(form, btn);
        btn.classList.add("hidden");

        const input = form.querySelector("input");
        const addBtn = form.querySelector("button");
        input.focus();

        async function submitTask() {
          const title = input.value.trim();
          if (!title) {
            cleanup();
            return;
          }
          try {
            // P1-2: Double-submit prevention
            addBtn.disabled = true;
            addBtn.classList.add("btn-loading");
            const payload = { title, status };
            if (taskType) payload.task_type = taskType;
            const res = await fetch(
              (window.__ingress_path || "") + "/api/tasks",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              },
            );
            if (res.ok) window.location.reload();
            else {
              addBtn.disabled = false;
              addBtn.classList.remove("btn-loading");
            }
          } catch (err) {
            console.warn("[Meitheal] Quick-add task failed:", err);
            addBtn.disabled = false;
            addBtn.classList.remove("btn-loading");
          }
        }

        function cleanup() {
          form.remove();
          btn.classList.remove("hidden");
        }

        addBtn.addEventListener("click", submitTask);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitTask();
          }
          if (e.key === "Escape") {
            cleanup();
          }
        });
        input.addEventListener("blur", () => {
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

    // Lane management (API-backed, server-persisted)
    const manageLanesBtn = document.getElementById("manage-lanes-btn");
    const laneMgmt = document.getElementById("lane-mgmt");
    const laneList = document.getElementById("lane-list");
    const newLaneInput = document.getElementById("new-lane-input");
    const addLaneBtn = document.getElementById("add-lane-btn");

    async function fetchLanes() {
      try {
        const res = await fetch((window.__ingress_path || "") + "/api/lanes");
        if (res.ok) {
          const data = await res.json();
          return data.lanes || [];
        }
      } catch { /* non-fatal */ }
      return [];
    }

    async function renderLaneList() {
      const lanes = await fetchLanes();
      laneList.innerHTML = lanes
        .map(
          (lane) => `
        <div class="lane-item" data-id="${lane.id}" data-position="${lane.position}">
          <span class="lane-drag-handle" title="Drag to reorder">⠿</span>
          <span class="lane-item-label">${lane.builtIn ? "🔒" : "📌"} ${lane.label}</span>
          <label class="lane-wip-label" title="WIP limit (0 = unlimited)">
            WIP: <input type="number" class="lane-wip-input" data-id="${lane.id}" value="${lane.wip_limit}" min="0" max="99" />
          </label>
          ${
            !lane.builtIn
              ? `
            <button type="button" class="lane-action-btn edit lane-edit" data-id="${lane.id}" data-label="${lane.label}" title="Rename" aria-label="Rename lane">✎</button>
            <button type="button" class="lane-action-btn remove lane-remove" data-id="${lane.id}" title="Remove" aria-label="Remove lane">×</button>
          `
              : '<span class="lane-builtin-label">built-in</span>'
          }
        </div>
      `,
        )
        .join("");

      // WIP limit change handlers
      laneList.querySelectorAll(".lane-wip-input").forEach((input) => {
        input.addEventListener("change", async () => {
          const laneId = input.dataset.id;
          const wipLimit = Math.max(0, parseInt(input.value) || 0);
          try {
            await fetch(`${window.__ingress_path || ""}/api/lanes/${laneId}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ wip_limit: wipLimit }),
            });
            window.location.reload();
          } catch { /* non-fatal */ }
        });
      });

      // Edit handlers
      laneList.querySelectorAll(".lane-edit").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const laneId = btn.dataset.id;
          const currentLabel = btn.dataset.label;
          const newName = prompt("Rename lane:", currentLabel);
          if (newName?.trim()) {
            try {
              await fetch(
                `${window.__ingress_path || ""}/api/lanes/${laneId}`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ label: newName.trim() }),
                },
              );
              window.location.reload();
            } catch { /* non-fatal */ }
          }
        });
      });

      // Remove handlers
      laneList.querySelectorAll(".lane-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const laneId = btn.dataset.id;
          const ok = await window.confirmDialog({
            message: "Tasks in this lane will move to Pending.",
            variant: "warning",
            confirmText: "Delete Lane",
            title: "Delete Lane",
          });
          if (!ok) return;
          try {
            await fetch(`${window.__ingress_path || ""}/api/lanes/${laneId}`, {
              method: "DELETE",
            });
            window.location.reload();
          } catch { /* non-fatal */ }
        });
      });

      // Drag to reorder lanes
      let draggedItem = null;
      laneList.querySelectorAll(".lane-item").forEach((item) => {
        const handle = item.querySelector(".lane-drag-handle");
        if (!handle) return;

        handle.addEventListener("mousedown", () => {
          item.setAttribute("draggable", "true");
        });
        handle.addEventListener("mouseup", () => {
          item.removeAttribute("draggable");
        });

        item.addEventListener("dragstart", (e) => {
          draggedItem = item;
          item.style.opacity = "0.5";
          e.dataTransfer.effectAllowed = "move";
        });
        item.addEventListener("dragend", async () => {
          item.style.opacity = "";
          item.removeAttribute("draggable");
          draggedItem = null;

          // Collect new order and save positions
          const items = laneList.querySelectorAll(".lane-item");
          const updates = [];
          items.forEach((el, idx) => {
            updates.push(
              fetch(
                `${window.__ingress_path || ""}/api/lanes/${el.dataset.id}`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ position: idx }),
                },
              ),
            );
          });
          await Promise.all(updates);
          window.location.reload();
        });
        item.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (draggedItem && draggedItem !== item) {
            const rect = item.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (e.clientY < mid) {
              item.parentElement.insertBefore(draggedItem, item);
            } else {
              item.parentElement.insertBefore(draggedItem, item.nextSibling);
            }
          }
        });
      });
    }

    // Helper to close lanes panel
    function closeLaneMgmt() {
      if (laneMgmt) laneMgmt.classList.add("hidden");
    }

    // T-1904: Toggle lanes panel
    manageLanesBtn?.addEventListener("click", () => {
      const isOpen = !laneMgmt.classList.contains("hidden");
      laneMgmt.classList.toggle("hidden", isOpen);
      if (!isOpen) renderLaneList();
    });

    // Close on backdrop click (click on outer lane-mgmt, not inner content)
    laneMgmt?.addEventListener("click", (e) => {
      if (e.target === laneMgmt) closeLaneMgmt();
    });

    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && laneMgmt && !laneMgmt.classList.contains("hidden")) {
        closeLaneMgmt();
      }
    });

    // Close button
    document
      .getElementById("lane-mgmt-close")
      ?.addEventListener("click", closeLaneMgmt);

    // T-1905: Lane creation via API
    addLaneBtn?.addEventListener("click", async () => {
      const raw = newLaneInput.value.trim();
      const name = raw.replace(/<[^>]*>/g, "");
      if (!name || name.length < 1 || name.length > 50) {
        const t = document.createElement("div");
        t.className = "toast error";
        t.textContent = "Lane name must be 1-50 characters";
        document.getElementById("toast-container")?.appendChild(t);
        setTimeout(() => t.remove(), 3000);
        return;
      }
      try {
        const res = await fetch((window.__ingress_path || "") + "/api/lanes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: name }),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          const err = await res.json();
          const t = document.createElement("div");
          t.className = "toast error";
          t.textContent = err.error || "Failed to create lane";
          document.getElementById("toast-container")?.appendChild(t);
          setTimeout(() => t.remove(), 3000);
        }
      } catch { /* non-fatal */ }
    });

    // T-1907: Search filters Kanban cards in real-time
    (() => {
      const searchInput = document.querySelector(".search-input");
      if (!searchInput) return;

      searchInput.addEventListener("input", () => {
        const query = searchInput.value.toLowerCase().trim();
        const cards = document.querySelectorAll(".kanban-card");

        cards.forEach((card) => {
          const title = (card.dataset.title || "").toLowerCase();
          const desc = (card.dataset.desc || "").toLowerCase();
          const match = !query || title.includes(query) || desc.includes(query);
          card.style.display = match ? "" : "none";

          // Highlight matching text in title
          const titleEl = card.querySelector(".kanban-card-title .kanban-title-text");
          if (titleEl && !titleEl.hasAttribute("contenteditable")) {
            const originalTitle = card.dataset.title || "";
            if (query && match && title.includes(query)) {
              const idx = title.indexOf(query);
              const before = originalTitle.substring(0, idx);
              const matched = originalTitle.substring(idx, idx + query.length);
              const after = originalTitle.substring(idx + query.length);
              titleEl.innerHTML = `${before}<mark class="search-highlight">${matched}</mark>${after}`;
            } else {
              titleEl.textContent = originalTitle;
            }
          }
        });

        window.updateAllCounts();
      });
    })();

    // T-1914: Keyboard navigation for kanban board
    (() => {
      const board = document.querySelector(".kanban-board");
      if (!board) return;

      // Swimlane collapse event delegation
      board.addEventListener("click", (e) => {
        const header = e.target.closest(".swimlane-header");
        if (header && !e.target.closest("button")) {
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
          const type = group.dataset.swimlaneType || group.dataset.swimlaneValue || "dynamic";
          localStorage.setItem(`meitheal-swimlane-${type}`, isCollapsed ? "collapsed" : "expanded");
        }
      });

      let focusedCard = null;

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

        switch (e.key) {
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
            const nextColCards = nextCol.querySelectorAll(".kanban-card");
            nextCard = nextColCards[0] || null;
            break;
          case "ArrowLeft":
            e.preventDefault();
            const prevCol = columns[colPos - 1] || columns[columns.length - 1];
            const prevColCards = prevCol.querySelectorAll(".kanban-card");
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

      // Board-level tabindex removed — it causes drag ghost artifacts and
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
        groupBySelect.value = savedGroupBy;
        // Don't auto-dispatch here; FilterToolbar handles initialization and emits meitheal:filter-change
      }

      // We share isCardVisible with the global scope for updateAllCounts
      let currentFilterState = {};

      window.isCardVisible = function (card) {
        if (!window.__filterStateLoaded) return true; // Show all before first filter event
        // We need to dynamically import the filter logic or assume it is bundled
        // Since isTaskVisible is in @lib/filter-state, we can import it dynamically
        // But table-controller.ts uses it directly. Wait, kanban is an inline script.
        // Let's implement a lighter standalone visibility check, OR import it.
        // Given we are in a module-like block:
        if (typeof window.__isTaskVisible === "function") {
          return window.__isTaskVisible(card, currentFilterState);
        }
        return true;
      }

      // Listen for unified filter events from FilterToolbar
      document.addEventListener("meitheal:filter-change", (e) => {
        if (e.detail?.view !== "kanban") return;
        currentFilterState = e.detail;

        // Apply groupBy
        const mode = currentFilterState.groupBy || "none";
        if (mode !== (localStorage.getItem("meitheal-kanban-group-by") || "none")) {
          // Sync select element if needed
          if (groupBySelect && groupBySelect.value !== mode) groupBySelect.value = mode;
          applyGroupBy(mode);
        }

        // Apply visibility to all cards
        if (typeof window.__isTaskVisible === "function") {
          document.querySelectorAll(".kanban-card").forEach(card => {
            if (window.__isTaskVisible(card, currentFilterState)) {
               card.style.display = "";
            } else {
               card.style.display = "none";
            }
          });
        }
        
        window.updateAllCounts();
      });

      // Unified count updater — column headers + swimlane badges
      window.updateAllCounts = function () {
        // 1. Column header counts
        document.querySelectorAll(".kanban-column").forEach((col) => {
          const count = col.querySelector(".kanban-count")
          const visible = Array.from(
            col.querySelectorAll(".kanban-card"),
          ).filter(c => c.style.display !== "none")
          if (count) count.textContent = visible.length
        })

        // 2. Swimlane group counts (both static + dynamic)
        document.querySelectorAll(".swimlane-group").forEach((group) => {
          const countEl = group.querySelector(".swimlane-count-val") || group.querySelector(".swimlane-count")
          if (!countEl) return
          const visible = Array.from(
            group.querySelectorAll(".kanban-card"),
          ).filter(c => c.style.display !== "none")
          countEl.textContent = visible.length
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
      async function applyGroupBy(mode) {
        localStorage.setItem("meitheal-kanban-group-by", mode);

        let boardTitleMap = {};
        if (mode === "board") {
          try {
            const res = await fetch((window.__ingress_path || "") + "/api/boards");
            if (res.ok) {
              const data = await res.json();
              (data.boards || []).forEach(b => { boardTitleMap[b.id] = `${b.icon || '📋'} ${b.title}`; });
            }
          } catch { /* use raw IDs as fallback */ }
          boardTitleMap["default"] = "📋 Default";
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
              g.style.display = "none";
            });
        });

        if (mode === "none") {
          window.updateAllCounts();
          return;
        }

        if (mode === "type") {
          // Use the pre-rendered type swimlane groups
          document.querySelectorAll(".kanban-column").forEach((col) => {
            const cardsContainer = col.querySelector(".kanban-cards");
            if (!cardsContainer) return;
            cardsContainer.querySelectorAll(".flat-card").forEach((card) => {
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
                const groupType = group.dataset.swimlaneType;
                group.style.display = ""; // Show all type swimlanes — visibility filtering handled by isTaskVisible
                const countEl = group.querySelector(".swimlane-count");
                const cards = group.querySelectorAll(".kanban-card");
                if (countEl) countEl.textContent = Array.from(cards).filter(window.isCardVisible).length;
              });
          });
        } else if (mode === "board" || mode === "priority") {
          // Dynamic swimlane generation for board/priority
          const dataAttr = mode === "board" ? "board" : "priority";
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
                card.dataset[dataAttr] ||
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

              // Color accent for dynamic swimlanes — use CSS custom properties
              const cs = getComputedStyle(document.documentElement);
              const colorMap = mode === "priority"
                ? {
                    "1": cs.getPropertyValue("--prio-critical").trim() || "#ef4444",
                    "2": cs.getPropertyValue("--prio-high").trim() || "#f97316",
                    "3": cs.getPropertyValue("--prio-medium").trim() || "#eab308",
                    "4": cs.getPropertyValue("--prio-low").trim() || "#22c55e",
                    "5": cs.getPropertyValue("--prio-none").trim() || "#64748b",
                  }
                : {}; // board mode — use a neutral accent
              const accentColor = colorMap[key] || cs.getPropertyValue("--accent").trim() || "#6366F1";
              group.style.borderTop = `3px solid ${accentColor}`;

              const header = document.createElement("div");
              header.className = "swimlane-header";
              const label =
                icons[key] || (mode === "board" ? (boardTitleMap[key] || `📋 ${key}`) : defaultLabel);
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
              countSpan.textContent = String(cards.filter(window.isCardVisible).length);
              header.append(toggleSpan, dotSpan, labelSpan, countSpan);

              // Collapse toggle — matches static swimlane CSS class pattern
              header.style.cursor = "pointer"
              // Add a generic collapse listener to the kanban board instead of here

              const swimlaneCards = document.createElement("div");
              swimlaneCards.className = "swimlane-cards";
              cards.forEach((card) => {
                card.classList.remove("flat-card");
                card.classList.add("grouped-card");
                swimlaneCards.appendChild(card);
              });

              group.appendChild(header);
              group.appendChild(swimlaneCards);
              cardsContainer.appendChild(group);

              // Restore saved collapse state for dynamic swimlane
              const collapseKey = `meitheal-swimlane-dyn-${key}`;
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
      document.querySelectorAll(".swimlane-header").forEach((header) => {
        const group = header.closest(".swimlane-group");
        if (!group) return;
        const cards = group.querySelector(".swimlane-cards");
        const toggle = header.querySelector(".swimlane-toggle");
        const type = header.dataset.type || "unknown";
        const storageKey = `meitheal-kanban-swimlane-${type}`;

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

        header.style.cursor = "pointer";
        header.addEventListener("click", () => {
          if (!cards) return;
          const isCollapsed = cards.classList.toggle("collapsed");
          if (toggle) {
            toggle.classList.toggle("collapsed", isCollapsed);
            toggle.textContent = isCollapsed ? "▶" : "▼";
          }
          group.classList.toggle("swimlane-collapsed", isCollapsed);
          localStorage.setItem(storageKey, isCollapsed ? "collapsed" : "expanded");
        });
      });
    })();

    // T-1915: Column collapse toggle (REMOVED — clicking lane headers to collapse
    // was unintuitive UX and caused visual breakage, per user feedback).

    // --- Offline Attachments Feature (Phase 23) ---
    (async function renderThumbnails() {
      if (!window.indexedDB) return;
      // Only attempt module load if there are attachment slots in the DOM
      var slots = document.querySelectorAll("img.kanban-attachment");
      if (!slots.length) return;
      try {
        // Dynamic import — Vite resolves this at build time into the
        // bundled chunk. No @vite-ignore needed since path is static.
        var mod = await import("@domains/offline/offline-store").catch(
          function () {
            return null; // Silently skip if module not available
          },
        );
        if (!mod || !mod.getAttachmentsByTaskId) return;
        var getAttachmentsByTaskId = mod.getAttachmentsByTaskId;
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
        const res = await fetch((window.__ingress_path || "") + "/api/users");
        if (!res.ok) return;
        const data = await res.json();
        const users = data.users || [];

        // Render user pills dynamically
        users.forEach((u) => {
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
        const activeBtn = container.querySelector(".filter-toolbar__user-btn.active");
        const userId = activeBtn?.dataset.user || "all";
        localStorage.setItem("meitheal-kanban-user-filter", userId);

        document
          .querySelectorAll(".kanban-card[data-assigned]")
          .forEach((el) => {
            const card = el;
            const assigned = card.dataset.assigned || "";

            if (userId === "all") {
              card.classList.remove("user-filtered-out");
            } else if (userId === "unassigned") {
              card.classList.toggle("user-filtered-out", assigned !== "");
            } else {
              card.classList.toggle("user-filtered-out", assigned !== userId);
            }
          });

        window.updateAllCounts()
      }

      // Click handlers
      container.addEventListener("click", (e) => {
        const btn = e.target.closest(".filter-toolbar__user-btn");
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
    // HTML5 Drag API doesn't fire on touch devices. Mobile UX:
    // Hold card 300ms → haptic vibrate → enter drag mode → drop on column.
    (function initTouchDrag() {
      let dragCard = null;
      let ghost = null;
      let holdTimer = null;
      let isDragging = false;
      let startX = 0,
        startY = 0;

      function cancelHold() {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      }

      function createGhost(card, x, y) {
        ghost = card.cloneNode(true);
        const w = card.offsetWidth;
        ghost.style.cssText =
          "position:fixed;pointer-events:none;opacity:0.85;z-index:9999;" +
          "width:" +
          w +
          "px;transform:rotate(2deg) scale(1.05);" +
          "box-shadow:0 12px 40px rgba(0,0,0,0.5);border-radius:12px;" +
          "left:" +
          (x - w / 2) +
          "px;top:" +
          (y - 30) +
          "px;transition:none;";
        document.body.appendChild(ghost);
      }

      function activateDrag(card, x, y) {
        isDragging = true;
        dragCard = card;
        card.classList.add("dragging");
        card.style.opacity = "0.3";
        card.style.touchAction = "none";
        createGhost(card, x, y);
        // Haptic feedback on supported devices
        if (navigator.vibrate) navigator.vibrate(30);
      }

      function cleanup() {
        cancelHold();
        if (dragCard) {
          dragCard.classList.remove("dragging");
          dragCard.style.opacity = "";
          dragCard.style.touchAction = "";
        }
        if (ghost) {
          ghost.remove();
          ghost = null;
        }
        document
          .querySelectorAll(".kanban-column.drag-over")
          .forEach(function (c) {
            c.classList.remove("drag-over");
          });
        dragCard = null;
        isDragging = false;
      }

      // Use event delegation on the board container
      var board = document.querySelector(".kanban-board");
      if (!board) return;

      board.addEventListener(
        "touchstart",
        function (e) {
          var card = e.target.closest('.kanban-card[draggable="true"]');
          if (!card) return;
          // Don't interfere with action button taps
          if (e.target.closest("button, a, .card-action-btn")) return;

          var t = e.touches[0];
          if (!t) return;
          startX = t.clientX;
          startY = t.clientY;

          // Start 300ms hold timer
          cancelHold();
          holdTimer = setTimeout(function () {
            holdTimer = null;
            activateDrag(card, startX, startY);
          }, 300);
        },
        { passive: true },
      );

      board.addEventListener(
        "touchmove",
        function (e) {
          var t = e.touches[0];
          if (!t) return;

          // If hold timer is still active, cancel if finger moves too much (scrolling)
          if (holdTimer) {
            var dx = Math.abs(t.clientX - startX);
            var dy = Math.abs(t.clientY - startY);
            if (dx > 8 || dy > 8) {
              cancelHold(); // user is scrolling, not holding
            }
            return;
          }

          if (!isDragging || !dragCard) return;
          e.preventDefault(); // prevent scroll during drag

          // Move ghost to follow finger
          if (ghost) {
            ghost.style.left = t.clientX - ghost.offsetWidth / 2 + "px";
            ghost.style.top = t.clientY - 30 + "px";
          }

          // Highlight column under touch (hide ghost briefly for elementFromPoint)
          if (ghost) ghost.style.display = "none";
          var el = document.elementFromPoint(t.clientX, t.clientY);
          if (ghost) ghost.style.display = "";

          document.querySelectorAll(".kanban-column").forEach(function (col) {
            col.classList.remove("drag-over");
          });
          var col = el ? el.closest(".kanban-column") : null;
          if (col) col.classList.add("drag-over");
        },
        { passive: false },
      );

      board.addEventListener(
        "touchend",
        function (e) {
          cancelHold();
          if (!isDragging || !dragCard) {
            cleanup();
            return;
          }

          var t = e.changedTouches[0];
          if (!t) {
            cleanup();
            return;
          }

          // Hide ghost for accurate elementFromPoint
          if (ghost) ghost.style.display = "none";
          var el = document.elementFromPoint(t.clientX, t.clientY);
          if (ghost) ghost.style.display = "";

          var targetCol = el ? el.closest(".kanban-column") : null;
          var cardId = dragCard.dataset.id;

          cleanup(); // reset visual state first

          if (targetCol && cardId) {
            var fakeEvent = {
              preventDefault: function () {},
              currentTarget: targetCol,
              target: el,
              dataTransfer: {
                getData: function () {
                  return cardId;
                },
              },
            };
            handleDrop(fakeEvent);
          }
        },
        { passive: true },
      );

      // Cancel drag on context menu / multi-touch
      board.addEventListener(
        "touchcancel",
        function () {
          cleanup();
        },
        { passive: true },
      );
    })();
}
