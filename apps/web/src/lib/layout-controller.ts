// Window globals (typed in types/window.d.ts):
//   attachStrategicLens

        import { confirmDialog } from "@lib/confirm-dialog";
        import { promptDialog } from "@lib/prompt-dialog";
        import { createClientLogger, registerGlobalLogger } from "@lib/client-logger";
        import { containTabFocus } from "@lib/focus-trap"
        import { applyAppearancePreferences, bindAppearanceNavigation, readAppearancePreferences } from "@lib/appearance-preferences"
        import { hasPriorityOverlay, initShortcutModal } from "@lib/layout-shortcuts-controller"
        import { pageLifecycle } from "@lib/page-lifecycle";
        import { SINGLE_KEY_SHORTCUTS_STORAGE_KEY, singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
        import { attachShortcutTooltips, injectShortcutStyles } from "@lib/shortcut-tooltip";

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

          // Phase 25 T10: Keyboard shortcut tooltip badges on hover
          // Dynamically annotate known shortcut-bound elements
          const shortcutMap: Record<string, string> = {
            dashboard: "D", kanban: "K", table: "T",
            today: "Y", upcoming: "U", calendar: "C",
          }
          for (const [page, key] of Object.entries(shortcutMap)) {
            const links = Array.from(
              document.querySelectorAll<HTMLElement>(`[data-page="${page}"]`),
            )
            const link = links.find((candidate) => !candidate.closest("#mobile-tab-bar"))
            if (link && !link.dataset.shortcut) link.dataset.shortcut = key
          }
          // Search trigger
          const searchBtn = document.querySelector<HTMLElement>("[data-search-trigger]")
          if (searchBtn && !searchBtn.dataset.shortcut) searchBtn.dataset.shortcut = "/"

          injectShortcutStyles();
          attachShortcutTooltips(document.body);
          if (bindKeyboard) window.addEventListener("storage", (event) => {
            if (event.key === SINGLE_KEY_SHORTCUTS_STORAGE_KEY || event.key === null) {
              attachShortcutTooltips(document.body)
            }
          }, { signal })

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
                // Search owns Escape inside its panel.
                const taskOverlay = document.getElementById(
                  "task-detail-overlay",
                );
                const sidebar = document.getElementById("sidebar");

                if (taskOverlay && taskOverlay.classList.contains("active")) {
                  document.getElementById("td-close")?.click()
                  return;
                }
                if (sidebar?.classList.contains("open")) {
                  sidebar.classList.remove("open");
                  return;
                }
              }

              if (e.key === "Tab") {
                const task = document.querySelector<HTMLElement>("#task-detail-overlay.active")
                const search = document.querySelector<HTMLElement>("#search-hub-overlay:not(.hidden)")
                const activeOverlay = task ?? search
                if (activeOverlay) containTabFocus(activeOverlay, e)
                return
              }

              if (isEditing) return;

              // Suppress most shortcuts when task detail overlay is open
              // Allow ? and Escape through so users can access help and close
              const taskDetailOpen = document
                .getElementById("task-detail-overlay")
                ?.classList.contains("active") ?? false;
              if (
                taskDetailOpen &&
                e.key !== "?" &&
                e.key !== "Escape"
              )
                return;

              if (e.ctrlKey || e.metaKey || !singleKeyShortcutsEnabled()) return

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
              if (e.key === "?" && !e.repeat && !e.altKey && openShortcutModal?.()) {
                e.preventDefault()
              }

              // Phase 20 (ADHD Optimization): T/S/E shortcuts for detail panel task_type
              // Only active when task detail is open AND user is NOT editing a text field
              if (taskDetailOpen) {
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
              if (event.key !== "k" || event.defaultPrevented || event.ctrlKey || event.metaKey || !singleKeyShortcutsEnabled()) return
              const target = event.target
              if (target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)) return
              if (hasPriorityOverlay() || document.getElementById("task-detail-overlay")?.classList.contains("active")) return
              window.location.href = (window.__ingress_path || "") + "/tasks#kanban"
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
                allOpt.textContent = "🗂 All Areas";
                select.appendChild(allOpt);
                boards.forEach(
                  (b: { id: string; name: string; icon: string }) => {
                    const opt = document.createElement("option");
                    opt.value = b.id;
                    opt.textContent = `${b.icon} ${b.name}`;
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
            if (!(event as CustomEvent<{ dataOnly?: boolean }>).detail?.dataOnly) reloadOnEvent()
          }, { signal })
          document.addEventListener("meitheal:navigation-changed", reloadOnEvent, { signal })
        })
