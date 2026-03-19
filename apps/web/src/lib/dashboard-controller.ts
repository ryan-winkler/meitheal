/**
 * Dashboard controller — extracted from index.astro
 *
 * Handles: quick-add form, checkbox toggles, user filter,
 * task click handlers, keyboard shortcut (n → focus quick add).
 *
 * All DOM listeners use pageLifecycle.signal for automatic cleanup
 * on ViewTransition navigations (prevents listener accumulation).
 */
import { showToast } from "@lib/toast"
import { taskApi } from "../lib/task-api-client"
import { pageLifecycle } from "@lib/page-lifecycle"

const signal = pageLifecycle.signal

// ── Quick add form ──────────────────────────────────────────
document
  .getElementById("quick-add-form")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault()
    const input = document.getElementById(
      "quick-title",
    ) as HTMLInputElement
    const title = input.value.trim()
    if (!title) return

    // Optimistic: insert bento card immediately
    const taskList = document.getElementById("task-list")
    const emptyState = taskList?.querySelector(".bento-empty-state")
    if (emptyState) emptyState.remove()

    const activeArea = window.__activeArea ?? "default"
    const newCard = document.createElement("div")
    newCard.className = "bento-card"
    newCard.dataset.board = activeArea === "all" ? "default" : activeArea
    const stripe = document.createElement("div")
    stripe.className = "bento-card-stripe"
    stripe.style.background = "#eab308"
    const body = document.createElement("div")
    body.className = "bento-card-body"
    const titleEl = document.createElement("div")
    titleEl.className = "bento-card-title"
    titleEl.textContent = title
    const footer = document.createElement("div")
    footer.className = "bento-card-footer"
    const badge = document.createElement("span")
    badge.className = "task-badge badge-pending"
    badge.textContent = "Pending"
    footer.appendChild(badge)
    body.append(titleEl, footer)
    newCard.append(stripe, body)
    newCard.style.animation = "fade-in 300ms ease"
    taskList?.prepend(newCard)
    input.value = ""

    // Update stat counts
    const statValues = document.querySelectorAll(".stat-value")
    if (statValues[0])
      statValues[0].textContent = String(
        Number(statValues[0].textContent) + 1,
      )

    try {
      const areaId = window.__activeArea ?? "default"
      await taskApi.createTask({
        title,
        area_id: areaId === "all" ? "default" : areaId,
      })
      showToast("common.task_created")
      // Green flash on form
      const form = document.getElementById("quick-add-form")
      form?.classList.add("flash-success")
      setTimeout(() => form?.classList.remove("flash-success"), 600)
    } catch (err) {
      showToast((err as Error).message || "common.failed_create", "error")
      newCard.remove()
    }
  }, { signal })

// ── Checkbox toggles — optimistic CSS swap ──────────────────
document.querySelectorAll(".task-checkbox").forEach((cb) => {
  cb.addEventListener("change", async (e) => {
    const target = e.target as HTMLInputElement
    const id = target.dataset.id
    const taskItem = target.closest(".task-item")
    const titleEl = taskItem?.querySelector(".task-title")
    const badge = taskItem?.querySelector(".task-badge")
    const newStatus = target.checked ? "complete" : "pending"

    // Optimistic UI update
    if (target.checked) {
      taskItem?.classList.add("task-done")
      titleEl?.classList.add("done")
      if (badge) {
        badge.className = "task-badge badge-complete"
        badge.textContent = "Complete"
      }
    } else {
      taskItem?.classList.remove("task-done")
      titleEl?.classList.remove("done")
      if (badge) {
        badge.className = "task-badge badge-pending"
        badge.textContent = "Pending"
      }
    }

    try {
      await taskApi.updateTask(id!, { status: newStatus })
      showToast(
        target.checked ? "common.task_completed" : "common.task_reopened",
      )
    } catch {
      showToast("common.failed_update", "error")
      // Revert
      target.checked = !target.checked
    }
  }, { signal })
})

// ── Header "+ New Task" button → open unified New Task modal ──
document.getElementById("quick-add-btn")?.addEventListener("click", () => {
  if (typeof window.openNewTaskModal === "function") {
    window.openNewTaskModal()
  } else {
    // Retry after a tick — NewTaskModal script may still be loading
    requestAnimationFrame(() => {
      if (typeof window.openNewTaskModal === "function") {
        window.openNewTaskModal()
      } else {
        ;(
          document.getElementById("quick-title") as HTMLInputElement
        )?.focus()
      }
    })
  }
}, { signal })

// ── My open tasks — user filter ─────────────────────────────
const openSelect = document.getElementById(
  "my-open-user-filter",
) as HTMLSelectElement | null
const openList = document.getElementById("my-open-list")
const openCount = document.getElementById("my-open-count")
if (openSelect && openList) {
  taskApi.listUsers()
    .then((users: any[]) => {
      users.forEach((u: any) => {
        const opt = document.createElement("option")
        opt.value = u.id
        opt.textContent = u.display_name || u.name || u.id
        openSelect.appendChild(opt)
      })
      // Add "Unassigned" option
      const unOpt = document.createElement("option")
      unOpt.value = "__unassigned__"
      unOpt.textContent = "Unassigned"
      openSelect.appendChild(unOpt)

      // Restore saved
      const saved = localStorage.getItem(
        "meitheal-dashboard-user-filter",
      )
      if (saved) openSelect.value = saved
      applyOpenFilter()
    })
    .catch(() => {})

  function applyOpenFilter() {
    if (!openSelect || !openList) return
    const val = openSelect.value
    let visible = 0
    openList
      .querySelectorAll<HTMLElement>(".task-item[data-assigned]")
      .forEach((el) => {
        const assigned = el.dataset.assigned || ""
        let show = true
        if (val === "__unassigned__") show = !assigned
        else if (val !== "all") show = assigned === val
        el.style.display = show ? "" : "none"
        if (show) visible++
      })
    if (openCount)
      openCount.textContent = `${visible} open task${visible !== 1 ? "s" : ""}`

    // Dynamic title based on filter selection
    const titleEl = document.getElementById("open-tasks-title")
    const kanbanLink = document.getElementById(
      "kanban-link",
    ) as HTMLAnchorElement | null
    if (titleEl) {
      if (val === "all" || val === "__unassigned__") {
        titleEl.textContent = "🎯 Open Tasks"
      } else {
        const selectedOpt = openSelect.options[openSelect.selectedIndex]
        const name = selectedOpt?.textContent || val
        titleEl.textContent = `🎯 ${name}'s Tasks`
      }
    }
    // Kanban link carries user filter
    if (kanbanLink) {
      const bp = window.__ingress_path || ""
      kanbanLink.href =
        val === "all"
          ? `${bp}/kanban`
          : `${bp}/kanban?user=${encodeURIComponent(val)}`
    }
  }

  openSelect.addEventListener("change", () => {
    localStorage.setItem(
      "meitheal-dashboard-user-filter",
      openSelect.value,
    )
    applyOpenFilter()
  }, { signal })
}

// ── Task items → open detail panel on click ─────────────────
document.querySelectorAll(".task-item[data-id]").forEach((el) => {
  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement
    if (target.closest("input, button, a")) return
    const id = (el as HTMLElement).dataset.id
    if (id && typeof window.openTaskDetail === "function") {
      window.openTaskDetail(id)
    }
  }, { signal })
})

// ── Bento card edit buttons → open detail panel ─────────────
// The global body click handler in task-modal-controller excludes
// buttons (target.closest("button")), so bento `.card-edit-btn`
// needs its own explicit handler per page (like kanban does).
document.querySelectorAll(".card-edit-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    const id = (btn as HTMLElement).dataset.id
    if (!id) return
    if (typeof window.openTaskDetail === "function") {
      window.openTaskDetail(id)
    }
  }, { signal })
})

// ── Keyboard shortcut: n → focus quick add ──────────────────
// Note: layout-controller.ts already handles the global "n" shortcut,
// so this duplicate is removed to prevent double-firing.
