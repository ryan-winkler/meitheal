        declare global {
          interface Window {
            attachStrategicLens?: (
              taskId: string,
              taskType: string,
              payload: string,
              cachedSettings?: Record<string, unknown>,
            ) => void;
          }
        }

        import { confirmDialog } from "@lib/confirm-dialog";
        import { pageLifecycle } from "@lib/page-lifecycle";

        // Expose for is:inline scripts (kanban)
        window.confirmDialog = confirmDialog;
        // Connection status check — singleton interval (P0-4: prevent accumulation)
        async function checkHealth() {
          const indicator = document.getElementById("connection-status");
          if (!indicator) return;
          const dot = indicator.querySelector(".status-dot");
          const text = indicator.querySelector(".status-text");
          try {
            const res = await fetch(
              (window.__ingress_path || "") + "/api/health",
            );
            const data = await res.json();
            if (data.status === "ok") {
              dot?.classList.add("online");
              dot?.classList.remove("offline");
              if (text) text.textContent = "Connected";
            } else {
              dot?.classList.remove("online");
              dot?.classList.add("offline");
              if (text) text.textContent = "DB Offline";
            }
          } catch {
            dot?.classList.remove("online");
            dot?.classList.add("offline");
            if (text) text.textContent = "Disconnected";
          }
        }
        checkHealth();
        // P0-4: Clear previous interval before creating new one to prevent
        // accumulation across ViewTransition navigations
        if ((window as any).__healthIntervalId) {
          clearInterval((window as any).__healthIntervalId);
        }
        (window as any).__healthIntervalId = setInterval(checkHealth, 30000);

        // Global error resilience — catch unhandled errors to prevent blank-page crashes
        // (These are global/permanent — intentionally NOT lifecycle-managed)
        window.addEventListener("error", (e) => {
          console.error("[Meitheal] Unhandled error:", e.error ?? e.message);
        });
        window.addEventListener("unhandledrejection", (e) => {
          console.error("[Meitheal] Unhandled promise rejection:", e.reason);
        });

        // Mobile menu toggle managed in TopNavigation.astro

        // ============================================================
        // P0-2/P0-3/P0-5: Lifecycle-managed page initialization
        // All DOM-dependent listeners use pageLifecycle.signal so they
        // auto-cleanup on ViewTransition navigation (astro:before-swap).
        // DOM refs are re-queried on each page load to avoid stale refs.
        // ============================================================
        pageLifecycle.onPageLoad((signal) => {
          // Defensive: clear any stale body scroll lock from a previous page's
          // task-detail or modal overlay (MPA nav doesn't run close handlers)
          document.body.style.overflow = "";
          // Also remove editor-injected scroll lock class (e.g. from PWA banner)
          document.body.classList.remove("antigravity-scroll-lock");

          // Active nav link — strip ingress prefix so path comparison works behind HA ingress
          const rawPath = window.location.pathname;
          const ip = window.__ingress_path || "";
          const currentPath =
            ip && rawPath.startsWith(ip)
              ? rawPath.slice(ip.length) || "/"
              : rawPath;
          document.querySelectorAll(".nav-link").forEach((link) => {
            const href = link.getAttribute("href") || "";
            if (
              href === currentPath ||
              currentPath.startsWith(href + "/") ||
              (currentPath === "/" &&
                link.getAttribute("data-page") === "dashboard")
            ) {
              link.classList.add("active");
            }
          });

          // EmptyState "New Task" buttons dispatch this event to open the modal
          document.addEventListener(
            "meitheal:new-task",
            () => {
              const btn = document.getElementById("create-task-btn");
              if (btn) btn.click();
            },
            { signal } as AddEventListenerOptions,
          );

          // "/" and Cmd/Ctrl+K launch universal search, "n" creates a task
          document.addEventListener(
            "keydown",
            (e) => {
              const tag = (e.target as HTMLElement)?.tagName;
              const isEditing =
                ["INPUT", "TEXTAREA", "SELECT"].includes(tag) ||
                (e.target as HTMLElement)?.contentEditable === "true";

              if (e.key === "Escape") {
                // Close overlays in priority order: task detail > command palette > search > sidebar
                const taskOverlay = document.getElementById(
                  "task-detail-overlay",
                );
                const searchHubOverlay = document.getElementById(
                  "search-hub-overlay",
                );
                const shortcutModal = document.getElementById("shortcut-modal");
                const sidebar = document.getElementById("sidebar");

                if (
                  shortcutModal &&
                  !shortcutModal.classList.contains("hidden")
                ) {
                  shortcutModal.classList.add("hidden");
                  return;
                }
                if (taskOverlay && !taskOverlay.classList.contains("hidden")) {
                  taskOverlay.classList.add("hidden");
                  // Always reset body overflow when closing task detail
                  document.body.style.overflow = "";
                  return;
                }
                if (
                  searchHubOverlay &&
                  !searchHubOverlay.classList.contains("hidden")
                ) {
                  window.closeSearchHub?.();
                  return;
                }
                if (sidebar?.classList.contains("open")) {
                  sidebar.classList.remove("open");
                  return;
                }
              }

              if (isEditing) return;

              // Suppress most shortcuts when task detail overlay is open
              // Allow ?, Escape, and Tab through so users can access help and close/navigate
              const taskDetailOpen = !document
                .getElementById("task-detail-overlay")
                ?.classList.contains("hidden");
              if (
                taskDetailOpen &&
                e.key !== "?" &&
                e.key !== "Escape" &&
                e.key !== "Tab"
              )
                return;

              if (e.key === "/" && !e.shiftKey) {
                e.preventDefault();
                window.openSearchHub?.();
              }
              // Ctrl+K / Cmd+K opens universal search
              if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                window.openSearchHub?.();
                return;
              }
              if (e.key === "n") {
                e.preventDefault();
                // If on tasks page, click the create button; otherwise navigate
                const createBtn = document.getElementById("create-task-btn");
                if (createBtn) {
                  createBtn.click();
                } else {
                  window.location.href =
                    (window.__ingress_path || "") + "/tasks";
                }
              }
              if (e.key === "k") {
                window.location.href =
                  (window.__ingress_path || "") + "/kanban";
              }
              if (e.key === "t") {
                window.location.href = (window.__ingress_path || "") + "/table";
              }
              if (e.key === "d") {
                window.location.href = (window.__ingress_path || "") + "/";
              }
              if (e.key === "y") {
                window.location.href = (window.__ingress_path || "") + "/today";
              }
              if (e.key === "u") {
                window.location.href =
                  (window.__ingress_path || "") + "/upcoming";
              }
              if (e.key === "c") {
                window.location.href =
                  (window.__ingress_path || "") + "/calendar";
              }
              if (e.key === "?") {
                e.preventDefault();
                const modal = document.getElementById("shortcut-modal");
                if (modal) modal.classList.toggle("hidden");
              }

              // --- Focus Trap Logic ---
              const taskOverlay = document.getElementById(
                "task-detail-overlay",
              );
              const searchHubOverlay = document.getElementById(
                "search-hub-overlay",
              );
              const shortcutModal = document.getElementById("shortcut-modal");

              // Find which overlay is active (priority order)
              let activeOverlay: HTMLElement | null = null;
              if (shortcutModal && !shortcutModal.classList.contains("hidden"))
                activeOverlay = shortcutModal;
              else if (taskOverlay && !taskOverlay.classList.contains("hidden"))
                activeOverlay = taskOverlay;
              else if (
                searchHubOverlay &&
                !searchHubOverlay.classList.contains("hidden")
              )
                activeOverlay = searchHubOverlay;

              if (activeOverlay && e.key === "Tab") {
                const focusableElements = activeOverlay.querySelectorAll(
                  'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])',
                );
                const firstElement = focusableElements[0] as HTMLElement;
                const lastElement = focusableElements[
                  focusableElements.length - 1
                ] as HTMLElement;

                if (e.shiftKey) {
                  // Shift + Tab
                  if (document.activeElement === firstElement) {
                    lastElement?.focus();
                    e.preventDefault();
                  }
                } else {
                  // Tab
                  if (document.activeElement === lastElement) {
                    firstElement?.focus();
                    e.preventDefault();
                  }
                }
              }

              // Phase 20 (ADHD Optimization): T/S/E shortcuts for detail panel task_type
              // Only active when task detail is open AND user is NOT editing a text field
              if (taskOverlay && !taskOverlay.classList.contains("hidden")) {
                const tdTag = (e.target as HTMLElement)?.tagName;
                const tdIsEditing =
                  ["INPUT", "TEXTAREA", "SELECT"].includes(tdTag) ||
                  (e.target as HTMLElement)?.contentEditable === "true";

                if (!tdIsEditing) {
                  const typeSelect = document.getElementById(
                    "td-task-type",
                  ) as HTMLSelectElement | null;
                  if (typeSelect) {
                    let newType = null;
                    if (e.key.toLowerCase() === "t") newType = "task";
                    if (e.key.toLowerCase() === "s") newType = "story";
                    if (e.key.toLowerCase() === "e") newType = "epic";

                    if (newType && typeSelect.value !== newType) {
                      e.preventDefault();
                      typeSelect.value = newType;
                      typeSelect.dispatchEvent(new Event("change"));
                    }
                  }
                }
              }
            },
            { signal },
          );

          // Keyboard shortcut onboarding hint (show once, permanently dismissed after click or 8s)
          if (
            !localStorage.getItem("meitheal_shortcut_hint_dismissed") &&
            !document.querySelector(".shortcut-hint")
          ) {
            const hint = document.createElement("div");
            hint.className = "shortcut-hint";
            hint.textContent = "💡 Press ? for keyboard shortcuts";
            hint.setAttribute("role", "tooltip");
            hint.addEventListener("click", () => {
              hint.remove();
              localStorage.setItem(
                "meitheal_shortcut_hint_dismissed",
                "permanent",
              );
            });
            document.body.appendChild(hint);
            setTimeout(() => {
              if (hint.parentNode) {
                hint.remove();
                localStorage.setItem(
                  "meitheal_shortcut_hint_dismissed",
                  "permanent",
                );
              }
            }, 8000);
          }
          // Board switcher
          (async function initBoardSwitcher() {
            const select = document.getElementById(
              "board-select",
            ) as HTMLSelectElement | null;
            const addBtn = document.getElementById("add-board-btn");
            if (!select) return;

            // Load boards from API
            try {
              const res = await fetch(
                (window.__ingress_path || "") + "/api/boards",
              );
              if (res.ok) {
                const data = await res.json();
                const boards = data.boards ?? [];
                select.innerHTML = "";
                // "All Boards" option first
                const allOpt = document.createElement("option");
                allOpt.value = "all";
                allOpt.textContent = "🗂 All Boards";
                select.appendChild(allOpt);
                boards.forEach(
                  (b: { id: string; title: string; icon: string }) => {
                    const opt = document.createElement("option");
                    opt.value = b.id;
                    opt.textContent = `${b.icon} ${b.title}`;
                    select.appendChild(opt);
                  },
                );
              }
            } catch {
              /* fallback to default option */
            }

            // Restore active board from localStorage
            const saved =
              localStorage.getItem("meitheal_active_board") ?? "all";
            if (select.querySelector(`option[value="${saved}"]`)) {
              select.value = saved;
            }

            // Expose active board globally for page scripts
            window.__activeBoard = select.value;

            // Apply board filter to visible items
            function isDoneStatus(s: string) {
              return s === "complete" || s === "cancelled";
            }

            // strategic lens payload integration
            function applyBoardFilter() {
              const board = select!.value;
              window.__activeBoard = board;
              // Filter task items (tasks page)
              document
                .querySelectorAll(".task-item[data-board]")
                .forEach((el) => {
                  const item = el as HTMLElement;
                  item.style.display =
                    board === "all" || item.dataset.board === board
                      ? ""
                      : "none";
                });
              // Filter kanban cards
              document
                .querySelectorAll(".kanban-card[data-board]")
                .forEach((el) => {
                  const card = el as HTMLElement;
                  card.style.display =
                    board === "all" || card.dataset.board === board
                      ? ""
                      : "none";
                });
              // Filter table rows
              document
                .querySelectorAll("#task-table tbody tr[data-board]")
                .forEach((el) => {
                  const row = el as HTMLElement;
                  row.style.display =
                    board === "all" || row.dataset.board === board
                      ? ""
                      : "none";
                });
            }

            // Apply on load
            applyBoardFilter();

            // Switch board → save + filter
            select.addEventListener(
              "change",
              () => {
                localStorage.setItem("meitheal_active_board", select.value);
                applyBoardFilter();
              },
              { signal },
            );

            // Add new board
            addBtn?.addEventListener(
              "click",
              async () => {
                const title = prompt("Board name:");
                if (!title?.trim()) return;
                try {
                  const res = await fetch(
                    (window.__ingress_path || "") + "/api/boards",
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ title: title.trim() }),
                    },
                  );
                  if (res.ok) {
                    const board = await res.json();
                    localStorage.setItem("meitheal_active_board", board.id);
                    window.location.reload();
                  }
                } catch {
                  /* ignore */
                }
              },
              { signal },
            );
          })();
        }); // end pageLifecycle.onPageLoad
