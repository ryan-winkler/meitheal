/**
 * modal-command-palette.ts — Ctrl+K command palette
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Fully self-contained: openCP/closeCP, Ctrl+K handler, search debounce, action routing.
 */
import { createFocusTrap } from "@lib/focus-trap"

export interface CommandPaletteDeps {
  openTaskDetail: (id: string) => void
  __signal: AbortSignal
}

/**
 * Initialise the command palette (Ctrl+K) overlay.
 */
export function initCommandPalette({ openTaskDetail, __signal }: CommandPaletteDeps): void {
  const cpOverlay = document.getElementById(
    "command-palette-overlay",
  ) as HTMLDivElement
  if (!cpOverlay) return
  const cpSearch = document.getElementById(
    "cp-search",
  ) as HTMLInputElement
  const cpTasksSection = document.getElementById(
    "cp-tasks-section",
  ) as HTMLDivElement
  const cpTasks = document.getElementById("cp-tasks") as HTMLDivElement
  let cpAllTasks: Array<{ id: string; title: string }> = []
  const cpFocusTrap = cpOverlay ? createFocusTrap(cpOverlay) : null

  const tdOverlay = document.getElementById(
    "task-detail-overlay",
  ) as HTMLDivElement

  function openCP() {
    cpOverlay?.classList.remove("hidden")
    cpFocusTrap?.activate()
    cpSearch?.focus()
    // Load tasks for search
    fetch((window.__ingress_path || "") + "/api/tasks?limit=200")
      .then((r) => r.json())
      .then((data: { tasks: Array<{ id: string; title: string }> }) => {
        cpAllTasks = data.tasks || []
      })
      .catch(() => {})
  }

  function closeCP() {
    cpFocusTrap?.deactivate()
    cpOverlay?.classList.add("hidden")
    if (cpSearch) cpSearch.value = ""
    cpTasksSection?.classList.add("hidden")
  }

  // Ctrl+K / Cmd+K
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented || tdOverlay?.classList.contains("active")) return
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault()
        if (cpOverlay?.classList.contains("hidden")) openCP()
        else closeCP()
      }
      if (e.key === "Escape" && !cpOverlay.classList.contains("hidden")) {
        e.preventDefault()
        closeCP()
      }
    },
    { signal: __signal },
  )

  cpOverlay?.addEventListener(
    "click",
    (e) => {
      if (e.target === cpOverlay) closeCP()
    },
    { signal: __signal },
  )

  // Search — filters both commands and tasks (P2-1: debounced 150ms)
  let cpSearchTimeout: ReturnType<typeof setTimeout> | null = null
  cpSearch?.addEventListener(
    "input",
    () => {
      if (cpSearchTimeout) clearTimeout(cpSearchTimeout)
      cpSearchTimeout = setTimeout(() => {
        const q = cpSearch.value.toLowerCase().trim()
        // Filter static command items
        document
          .querySelectorAll("#cp-results > .cp-item[data-action]")
          .forEach((el) => {
            const text =
              (el as HTMLElement).textContent?.toLowerCase() ?? ""
            ;(el as HTMLElement).style.display =
              !q || text.includes(q) ? "" : "none"
          })
        // Also hide section headers if all children hidden
        document
          .querySelectorAll(
            "#cp-results > div:not(.cp-item):not(#cp-tasks-section)",
          )
          .forEach((header) => {
            const next = header.nextElementSibling
            if (
              next?.classList.contains("cp-item") &&
              (next as HTMLElement).style.display === "none"
            ) {
              ;(header as HTMLElement).style.display = "none"
            } else {
              ;(header as HTMLElement).style.display = ""
            }
          })

        if (!q) {
          cpTasksSection?.classList.add("hidden")
          return
        }

        const matches = cpAllTasks
          .filter((t) => t.title.toLowerCase().includes(q))
          .slice(0, 10)
        if (matches.length > 0) {
          cpTasksSection?.classList.remove("hidden")
          cpTasks.replaceChildren(
            ...matches.map((t) => {
              const item = document.createElement("div")
              item.className = "cp-item px-4 py-2.5 cursor-pointer hover:bg-bg-hover text-sm text-text-primary"
              item.dataset.taskId = t.id
              item.textContent = t.title
              return item
            }),
          )
        } else {
          cpTasksSection?.classList.add("hidden")
        }
      }, 150) // P2-1: 150ms debounce
    },
    { signal: __signal },
  )

  // Click handlers
  document.getElementById("cp-results")?.addEventListener(
    "click",
    (e) => {
      const target = (e.target as HTMLElement).closest(
        ".cp-item",
      ) as HTMLElement | null
      if (!target) return
      const action = target.dataset.action
      const taskId = target.dataset.taskId

      closeCP()

      if (action === "new-task") {
        const createBtn = document.querySelector(
          "[data-action='create-task']",
        ) as HTMLElement
        if (createBtn) createBtn.click()
        else
          window.location.href = (window.__ingress_path || "") + "/tasks"
      } else if (action === "new-area") {
        const boardBtn = document.querySelector(
          ".area-add-btn",
        ) as HTMLElement
        if (boardBtn) boardBtn.click()
      } else if (action === "go-dashboard") {
        window.location.href = (window.__ingress_path || "") + "/"
      } else if (action === "go-kanban") {
        window.location.href = (window.__ingress_path || "") + "/kanban"
      } else if (action === "go-table") {
        window.location.href = (window.__ingress_path || "") + "/table"
      } else if (action === "go-settings") {
        window.location.href =
          (window.__ingress_path || "") + "/settings"
      } else if (action === "go-today") {
        window.location.href = (window.__ingress_path || "") + "/today"
      } else if (action === "go-upcoming") {
        window.location.href =
          (window.__ingress_path || "") + "/upcoming"
      } else if (action === "go-calendar") {
        window.location.href =
          (window.__ingress_path || "") + "/calendar"
      } else if (action === "export-csv") {
        window.location.href =
          (window.__ingress_path || "") + "/api/export/tasks.csv"
      } else if (taskId) {
        openTaskDetail(taskId)
      }
    },
    { signal: __signal },
  )
}
