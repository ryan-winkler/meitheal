// Window globals (typed in types/window.d.ts):
//   attachStrategicLens

        import { confirmDialog } from "@lib/confirm-dialog";
        import { findModalTrapTarget } from "@lib/dialog-overlay"
        import { promptDialog } from "@lib/prompt-dialog";
        import { attemptStaleChunkReload, isStaleChunkError } from "@lib/chunk-recovery"
        import { createClientLogger, registerGlobalLogger } from "@lib/client-logger";
        import { containTabFocus } from "@lib/focus-trap"
        import { applyAppearancePreferences, bindAppearanceNavigation, readAppearancePreferences } from "@lib/appearance-preferences"
        import { safeIngressHref, syncIngressDestination } from "@lib/ingress-navigation"
        import { bindWorkspaceEntry } from "@lib/workspace-entry"
        import { openWorkspaceQuickAdd } from "@lib/open-workspace-capture"
        import { hasPriorityOverlay, initShortcutModal } from "@lib/layout-shortcuts-controller"
        import { currentTaskApiContext } from "@lib/task-api"
        import { boardNavigationLinks, readBoardNavigationContext } from "@lib/board-workspace"
        import { taskViewUrl, type TaskView } from "@lib/task-view-route"
        import { pageLifecycle } from "@lib/page-lifecycle";
        import { SINGLE_KEY_SHORTCUTS_STORAGE_KEY, singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
        import { attachShortcutTooltips, injectShortcutStyles } from "@lib/shortcut-tooltip";
        import {
          formatShortcutKeys,
          KEYBOARD_SHORTCUTS_CHANGED_EVENT,
          KEYBOARD_SHORTCUTS_STORAGE_KEY,
          matchesShortcutEvent,
          readResolvedShortcuts,
          type ShortcutActionId,
        } from "@domains/navigation/keyboard-shortcuts"

        const log = createClientLogger("app", "layout");

        // Register global logger bridge for is:inline scripts
        registerGlobalLogger();

        // The provider and its private URL are now resolved from Settings.
        try {
          localStorage.removeItem("meitheal-ai-provider")
          localStorage.removeItem("meitheal-ai-custom-url")
        } catch { /* The app also runs without browser storage. */ }

        // Expose for is:inline scripts (kanban)
        window.confirmDialog = confirmDialog;
        // Connection status check — singleton interval (P0-4: prevent accumulation)
        async function checkHealth() {
          const indicator = document.getElementById("connection-status");
          if (!indicator) return;
          const dot = indicator.querySelector(".status-dot");
          const text = indicator.querySelector(".status-text");
          try {
            const res = await fetch("/api/health", { cache: "no-store" });
            const data = await res.json();
            if (data.status === "ok") {
              dot?.classList.add("online");
              dot?.classList.remove("offline");
              if (text) text.textContent = indicator.dataset.ready ?? "Meitheal ready";
            } else if (data.db_status === "error") {
              dot?.classList.remove("online");
              dot?.classList.add("offline");
              if (text) text.textContent = indicator.dataset.storageOffline ?? "Storage unavailable";
            } else {
              throw new Error("Health response unavailable");
            }
          } catch {
            dot?.classList.remove("online");
            dot?.classList.add("offline");
            if (text) text.textContent = indicator.dataset.unreachable ?? "Meitheal unavailable";
          }
          indicator.title = text?.textContent ?? ""
        }
        checkHealth();
        // P0-4: Clear previous interval before creating new one to prevent
        // accumulation across ViewTransition navigations
        if (window.__healthIntervalId) {
          clearInterval(window.__healthIntervalId);
        }
        window.__healthIntervalId = setInterval(checkHealth, 30000);

        // Global error resilience — catch unhandled errors to prevent blank-page crashes
        // (These are global/permanent — intentionally NOT lifecycle-managed)
        window.addEventListener("error", (e) => {
          // ResizeObserver loop errors are benign browser noise — suppress them
          if (e.message?.includes("ResizeObserver loop")) return;
          log.error("Unhandled error", e.error ?? e.message);
        });
        window.addEventListener("unhandledrejection", (e) => {
          if (isStaleChunkError(e.reason)) {
            e.preventDefault()
            if (attemptStaleChunkReload(window.sessionStorage, Date.now(), () => window.location.reload())) return
          }
          log.error("Unhandled promise rejection", e.reason);
        });

        // ============================================================
        // P0-2/P0-3/P0-5: Lifecycle-managed page initialization
        // All DOM-dependent listeners use pageLifecycle.signal so they
        // auto-cleanup on ViewTransition navigation (astro:before-swap).
        // DOM refs are re-queried on each page load to avoid stale refs.
        // ============================================================
        let keyboardSignal: AbortSignal | undefined
        pageLifecycle.onPageLoad((signal) => {
          bindWorkspaceEntry(signal)
          // The fallback and initial Astro event can arrive with the same signal.
          const bindKeyboard = keyboardSignal !== signal
          keyboardSignal = signal
          applyAppearancePreferences(readAppearancePreferences())
          if (bindKeyboard) bindAppearanceNavigation(signal)

          // Defensive: clear any stale body scroll lock from a previous page's
          // task-detail or modal overlay (MPA nav doesn't run close handlers)
          document.body.style.overflow = "";
          // Also remove editor-injected scroll lock class (e.g. from PWA banner)
          document.body.classList.remove("antigravity-scroll-lock");

          // Phase 25 T10: Keyboard shortcut tooltip badges & Help modal keycap sync
          const syncShortcutHints = () => {
            const resolved = readResolvedShortcuts()
            const pageActionMap: Record<string, ShortcutActionId> = {
              dashboard: "goDashboard", kanban: "goKanban", table: "goTable",
              today: "goToday", upcoming: "goUpcoming", calendar: "goCalendar",
            }
            for (const [page, action] of Object.entries(pageActionMap)) {
              const links = Array.from(document.querySelectorAll<HTMLElement>(`[data-page="${page}"]`))
              const link = links.find((candidate) => !candidate.closest("#mobile-tab-bar"))
              if (!link) continue
              const combo = resolved[action]
              if (combo) link.dataset.shortcut = combo
              else delete link.dataset.shortcut
            }
            const searchBtn = document.querySelector<HTMLElement>("[data-search-trigger]")
            if (searchBtn) {
              if (resolved.search) searchBtn.dataset.shortcut = resolved.search
              else delete searchBtn.dataset.shortcut
            }
            document.querySelectorAll<HTMLElement>("#shortcut-modal [data-shortcut-action]").forEach((el) => {
              const action = el.dataset.shortcutAction as ShortcutActionId | undefined
              if (!action || !(action in resolved)) return
              const keys = formatShortcutKeys(resolved[action])
              el.replaceChildren()
              if (keys.length === 0) {
                const none = document.createElement("span")
                none.className = "shortcut-note"
                none.textContent = "Unbound"
                el.append(none)
                return
              }
              keys.forEach((key, idx) => {
                if (idx > 0) el.append(document.createTextNode(" + "))
                const kbd = document.createElement("kbd")
                kbd.textContent = key
                el.append(kbd)
              })
            })
            attachShortcutTooltips(document.body)
          }

          injectShortcutStyles()
          syncShortcutHints()
          if (bindKeyboard) {
            window.addEventListener("storage", (event) => {
              if (event.key === SINGLE_KEY_SHORTCUTS_STORAGE_KEY || event.key === KEYBOARD_SHORTCUTS_STORAGE_KEY || event.key === null) {
                syncShortcutHints()
              }
            }, { signal })
            window.addEventListener(KEYBOARD_SHORTCUTS_CHANGED_EVENT, syncShortcutHints, { signal })
          }

          const navigationContext = () => {
            const url = new URL(location.href)
            const ingress = window.__ingress_path || ""
            if (ingress && url.pathname.startsWith(ingress + "/")) url.pathname = url.pathname.slice(ingress.length)
            const context = currentTaskApiContext()
            const selected = readBoardNavigationContext(url)
            return context ? { ...selected, boardId: context.boardId } : undefined
          }
          const taskDestination = (view?: TaskView) => {
            const context = navigationContext()
            if (!context) return "/boards"
            const tasks = new URL(boardNavigationLinks(context).tasks, location.href)
            if (view) {
              const selected = taskViewUrl(tasks, view, true)
              return selected.pathname + selected.search + selected.hash
            }
            return tasks.pathname + tasks.search + tasks.hash
          }
          const openTasks = (view?: TaskView) => {
            const href = taskDestination(view)
            if (!href) return
            syncIngressDestination(href)
            window.location.assign(safeIngressHref(href))
          }

          const SHORTCUT_NAV = {
            dashboard: () => {
              const context = navigationContext()
              const destination = context ? boardNavigationLinks(context).dashboard : "/boards"
              syncIngressDestination(destination)
              window.location.assign(safeIngressHref(destination))
            },
            tasks: () => openTasks(),
            kanban: () => openTasks("kanban"),
            table: () => openTasks("table"),
            today: () => {
              const context = navigationContext()
              const destination = context ? boardNavigationLinks(context).today : "/boards"
              syncIngressDestination(destination)
              window.location.assign(safeIngressHref(destination))
            },
            upcoming: () => {
              const context = navigationContext()
              const destination = context ? boardNavigationLinks(context).upcoming : "/boards"
              syncIngressDestination(destination)
              window.location.assign(safeIngressHref(destination))
            },
            calendar: () => openTasks("calendar"),
          } as const

          // The New Task modal ships in Layout, so open it directly. Clicking a page
          // button by id pattern used to match the modal's own Cancel button instead.
          function openTaskFormOrTasks() {
            const modalFn = (window as { openNewTaskModal?: () => void }).openNewTaskModal
            if (typeof modalFn === "function") {
              modalFn()
              return
            }
            SHORTCUT_NAV.tasks()
          }
          function openNewTaskAction() {
            const trigger = document.activeElement
            if (!openWorkspaceQuickAdd(trigger instanceof HTMLElement ? trigger : undefined, openTaskFormOrTasks)) openTaskFormOrTasks()
          }

          // Collapsed-rail quick action + floating tooltips
          const railNewTaskBtn = document.getElementById("sidebar-rail-new-task")
          if (bindKeyboard) railNewTaskBtn?.addEventListener("click", openNewTaskAction, { signal })

          // Floating collapsed-rail tooltips rendered outside .sidebar-scroll overflow clipping
          let railTooltip = document.getElementById("sidebar-rail-tooltip")
          if (!railTooltip) {
            railTooltip = document.createElement("div")
            railTooltip.id = "sidebar-rail-tooltip"
            railTooltip.className = "sidebar-rail-tooltip"
            railTooltip.setAttribute("role", "tooltip")
            railTooltip.hidden = true
            document.body.appendChild(railTooltip)
          }
          const sidebarEl = document.getElementById("sidebar")
          const hideRailTooltip = () => {
            if (railTooltip) railTooltip.hidden = true
          }
          if (bindKeyboard && sidebarEl) {
            const showRailTooltip = (target: EventTarget | null) => {
              if (!railTooltip || !document.body.classList.contains("sidebar-collapsed")) return
              if (document.documentElement.dataset.appearanceSidebar === "hover" && sidebarEl.matches(":hover")) {
                hideRailTooltip()
                return
              }
              const el = target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null
              const text = el?.dataset.tooltip?.trim()
              if (!el || !text) {
                hideRailTooltip()
                return
              }
              const rect = el.getBoundingClientRect()
              railTooltip.textContent = text
              railTooltip.hidden = false
              railTooltip.style.top = `${Math.round(rect.top + rect.height / 2)}px`
              railTooltip.style.left = `${Math.round(rect.right + 10)}px`
            }
            sidebarEl.addEventListener("pointerover", (event) => showRailTooltip(event.target), { signal })
            sidebarEl.addEventListener("pointerleave", hideRailTooltip, { signal })
            sidebarEl.addEventListener("focusin", (event) => showRailTooltip(event.target), { signal })
            sidebarEl.addEventListener("focusout", hideRailTooltip, { signal })
          }

          // EmptyState "New Task" buttons dispatch this event to open the modal
          if (bindKeyboard) document.addEventListener(
            "meitheal:new-task",
            openNewTaskAction,
            { signal } as AddEventListenerOptions,
          );

          const openShortcutModal = bindKeyboard ? initShortcutModal(signal) : undefined
          // SearchHub owns Search. Layout owns page navigation and modal shortcuts.
          if (bindKeyboard) document.addEventListener(
            "keydown",
            (e) => {
              if (e.defaultPrevented) return
              const tag = (e.target as HTMLElement)?.tagName;
              const isEditing =
                ["INPUT", "TEXTAREA", "SELECT"].includes(tag) ||
                (e.target as HTMLElement)?.contentEditable === "true";

              if (e.key === "Escape") {
                if (hasPriorityOverlay()) return
                // Search owns Escape inside its panel.
                const taskOverlay = document.getElementById(
                  "task-detail-overlay",
                );
                const taskPanel = document.getElementById("task-detail-panel");
                const isDocked = document.body.classList.contains("has-docked-inspector");
                if (
                  taskOverlay &&
                  taskOverlay.classList.contains("active") &&
                  (!isDocked || taskPanel?.contains(document.activeElement))
                ) {
                  const layout = document.getElementById("td-toggle-layout")
                  if (layout?.getAttribute("aria-expanded") === "true") layout.click()
                  else if (taskOverlay.hasAttribute("data-focus-mode")) document.getElementById("td-toggle-focus")?.click()
                  else document.getElementById("td-close")?.click()
                  e.preventDefault()
                  return;
                }
              }

              if (e.key === "Tab") {
                const activeOverlay = findModalTrapTarget()
                if (activeOverlay) containTabFocus(activeOverlay, e)
                return
              }

              if (isEditing) return;

              if (hasPriorityOverlay()) return;

              if (document.documentElement.hasAttribute("data-shortcut-recording")) return

              // Suppress most shortcuts when modal task detail overlay is open (not when docked)
              // Allow help and Escape through so users can access help and close
              const shortcuts = readResolvedShortcuts()
              const singleEnabled = singleKeyShortcutsEnabled()
              const isHelpHit = !e.repeat && matchesShortcutEvent(e, shortcuts.showHelp, singleEnabled)
              const taskDetailOpen = document
                .getElementById("task-detail-overlay")
                ?.classList.contains("active") ?? false;
              const isDockedInspector = document.body.classList.contains("has-docked-inspector");
              const modalTaskDetailOpen = taskDetailOpen && !isDockedInspector;
              if (modalTaskDetailOpen && !isHelpHit && e.key !== "Escape") return

              if (isHelpHit) {
                if (openShortcutModal?.()) e.preventDefault()
                return
              }

              if (matchesShortcutEvent(e, shortcuts.newTask, singleEnabled)) {
                e.preventDefault()
                openNewTaskAction()
                return
              }
              if (matchesShortcutEvent(e, shortcuts.goTable, singleEnabled) && !(isDockedInspector && document.getElementById("task-detail-panel")?.contains(document.activeElement))) {
                e.preventDefault()
                SHORTCUT_NAV.table()
                return
              }
              if (matchesShortcutEvent(e, shortcuts.goDashboard, singleEnabled)) {
                e.preventDefault()
                SHORTCUT_NAV.dashboard()
                return
              }
              if (matchesShortcutEvent(e, shortcuts.goToday, singleEnabled)) {
                e.preventDefault()
                SHORTCUT_NAV.today()
                return
              }
              if (matchesShortcutEvent(e, shortcuts.goUpcoming, singleEnabled)) {
                e.preventDefault()
                SHORTCUT_NAV.upcoming()
                return
              }
              if (matchesShortcutEvent(e, shortcuts.goCalendar, singleEnabled)) {
                e.preventDefault()
                SHORTCUT_NAV.calendar()
                return
              }

              // Phase 20 (ADHD Optimization): T/S/E shortcuts for detail panel task_type
              // Only active when task detail is modal OR focus resides inside the docked panel
              if (!e.ctrlKey && !e.metaKey && !e.altKey && singleEnabled && (modalTaskDetailOpen || (taskDetailOpen && document.getElementById("task-detail-panel")?.contains(document.activeElement)))) {
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

          // Today and Timeline can consume K in document listeners, including after rerenders.
          if (bindKeyboard) {
            window.addEventListener("keydown", event => {
              if (event.defaultPrevented || document.documentElement.hasAttribute("data-shortcut-recording")) return
              const target = event.target
              if (target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)) return
              const modalTdOpen = (document.getElementById("task-detail-overlay")?.classList.contains("active") ?? false) &&
                !document.body.classList.contains("has-docked-inspector")
              if (hasPriorityOverlay() || modalTdOpen) return
              if (!matchesShortcutEvent(event, readResolvedShortcuts().goKanban, singleKeyShortcutsEnabled())) return
              event.preventDefault()
              SHORTCUT_NAV.kanban()
            }, { signal })
          }

          // Area switcher
          (async function initAreaSwitcher() {
            const select = document.getElementById(
              "area-select",
            ) as HTMLSelectElement | null;
            const addBtn = document.getElementById("add-area-btn");
            if (!select) return;

            // Load boards from API
            try {
              const res = await fetch(
                (window.__ingress_path || "") + "/api/areas",
              );
              if (res.ok) {
                const data = await res.json();
                const boards = data.areas ?? [];
                select.replaceChildren();
                // "All Areas" option first
                const allOpt = document.createElement("option");
                allOpt.value = "all";
                allOpt.textContent = "All Areas"
                select.appendChild(allOpt);
                boards.forEach(
                  (b: { id: string; name: string; icon: string }) => {
                    const opt = document.createElement("option");
                    opt.value = b.id;
                    opt.textContent = b.name
                    select.appendChild(opt);
                  },
                );
              }
            } catch {
              /* fallback to default option */
            }

            // Restore active board from localStorage
            const saved =
              localStorage.getItem("meitheal_active_area") ?? "all";
            if (select.querySelector(`option[value="${saved}"]`)) {
              select.value = saved;
            }

            // Expose active board globally for page scripts
            window.__activeArea = select.value;

            // Apply board filter to visible items
            function isDoneStatus(s: string) {
              return s === "complete" || s === "cancelled";
            }

            // strategic lens payload integration
            function applyAreaFilter() {
              const area = select!.value;
              window.__activeArea = area;
              // Filter task items (tasks page)
              document
                .querySelectorAll(".task-item[data-area]")
                .forEach((el) => {
                  const item = el as HTMLElement;
                  item.style.display =
                    area === "all" || item.dataset.area === area
                      ? ""
                      : "none";
                });
              // Filter kanban cards
              document
                .querySelectorAll(".kanban-card[data-area]")
                .forEach((el) => {
                  const card = el as HTMLElement;
                  card.style.display =
                    area === "all" || card.dataset.area === area
                      ? ""
                      : "none";
                });
              // Filter table rows
              document
                .querySelectorAll("#task-table tbody tr[data-area]")
                .forEach((el) => {
                  const row = el as HTMLElement;
                  row.style.display =
                    area === "all" || row.dataset.area === area
                      ? ""
                      : "none";
                });
            }

            // Apply on load
            applyAreaFilter();

            // Switch board → save + filter
            select.addEventListener(
              "change",
              () => {
                localStorage.setItem("meitheal_active_area", select.value);
                applyAreaFilter();
              },
              { signal },
            );

            // Add new board
            addBtn?.addEventListener(
              "click",
              async () => {
                const title = await promptDialog({ title: "Create Area", placeholder: "Area name", required: true });
                if (!title) return;
                try {
                  const res = await fetch(
                    (window.__ingress_path || "") + "/api/areas",
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ name: title.trim() }),
                    },
                  );
                  if (res.ok) {
                    const area = await res.json();
                    localStorage.setItem("meitheal_active_area", area.id);
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

        // Phase 13: Universal event listeners — reload page when tasks or navigation change.
        // Establishes event bus pattern. Future phases can intercept for targeted DOM updates.
        // Moved inside layout init to use global lifecycle — these are permanent per session.
        pageLifecycle.onPageLoad((signal) => {
          const reloadOnEvent = () => window.location.reload()
          document.addEventListener("meitheal:tasks-changed", event => {
            // Calendar already refreshes its month and open day on this event.
            if (document.querySelector("#calendar-shell[data-calendar-ready='true']")) return
            if (!(event as CustomEvent<{ dataOnly?: boolean }>).detail?.dataOnly) reloadOnEvent()
          }, { signal })
          document.addEventListener("meitheal:navigation-changed", reloadOnEvent, { signal })
        })
