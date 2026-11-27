/**
 * Lightweight on-demand loader for the Task Detail modal controller (~118 KB).
 *
 * Defers downloading and parsing `task-modal-controller` until the user clicks
 * a task, invokes `window.openTaskDetail` / `window.openPinnedTaskDetail`, or
 * lands directly on a task permalink/hash/query URL.
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import type { SearchDetailHandoff } from "@lib/task-detail-handoff"

let loadPromise: Promise<void> | null = null
let controllerReady = false

function hasTaskLocationInUrl(): boolean {
  const url = new URL(window.location.href)
  const ingress = window.__ingress_path || ""
  const pathname = ingress && url.pathname.startsWith(ingress)
    ? url.pathname.slice(ingress.length)
    : url.pathname
  if (/^\/tickets\/[^/]+/.test(pathname)) return true
  if (url.hash.startsWith("#task-")) return true
  return url.searchParams.has("open") || url.searchParams.has("ticket")
}

async function ensureTaskDetailController(): Promise<void> {
  if (controllerReady) return
  if (!loadPromise) {
    loadPromise = import("@lib/task-modal-controller")
      .then(() => {
        controllerReady = true
      })
      .catch((error) => {
        loadPromise = null
        throw error
      })
  }
  await loadPromise
  // `task-modal-controller` initializes via `pageLifecycle.onPageLoad` (0ms timer fallback).
  const overlay = document.getElementById("task-detail-overlay")
  if (overlay && overlay.dataset.detailController !== "ready") {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (overlay.dataset.detailController === "ready") break
    }
  }
}

pageLifecycle.onPageLoad((signal) => {
  if (controllerReady) return
  const overlay = document.getElementById("task-detail-overlay") as HTMLDivElement | null
  if (!overlay || overlay.dataset.namedBoard || overlay.dataset.detailController === "ready") return

  if (overlay.dataset.suppressUrlOpen !== "true" && hasTaskLocationInUrl()) {
    void ensureTaskDetailController()
    return
  }

  const lazyOpenTaskDetail = async (
    taskId: string,
    commentTarget: string | null = null,
    search?: SearchDetailHandoff,
    updateLocation = true,
  ) => {
    await ensureTaskDetailController()
    if (signal.aborted) return
    if (typeof window.openTaskDetail === "function" && window.openTaskDetail !== lazyOpenTaskDetail) {
      window.openTaskDetail(taskId, commentTarget, search, updateLocation)
    }
  }

  const lazyOpenPinnedTaskDetail = async (taskId: string, reconcile: () => void) => {
    await ensureTaskDetailController()
    if (signal.aborted) return
    if (
      typeof window.openPinnedTaskDetail === "function" &&
      window.openPinnedTaskDetail !== lazyOpenPinnedTaskDetail
    ) {
      window.openPinnedTaskDetail(taskId, reconcile)
    }
  }

  if (typeof window.openTaskDetail !== "function") {
    window.openTaskDetail = lazyOpenTaskDetail
  }
  if (typeof window.openPinnedTaskDetail !== "function") {
    window.openPinnedTaskDetail = lazyOpenPinnedTaskDetail
  }

  signal.addEventListener("abort", () => {
    if (window.openTaskDetail === lazyOpenTaskDetail) delete window.openTaskDetail
    if (window.openPinnedTaskDetail === lazyOpenPinnedTaskDetail) delete window.openPinnedTaskDetail
  }, { once: true })

  const handleLazyActivation = (event: Event) => {
    if (controllerReady || overlay.dataset.detailController === "ready") return
    const target = event.target
    if (event.defaultPrevented || !(target instanceof Element)) return

    const link = target.closest<HTMLAnchorElement>("a[data-task-detail-link]")
    if (link) {
      if (
        !(event instanceof MouseEvent) ||
        event.type !== "click" ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        (link.target && link.target !== "_self") ||
        link.hasAttribute("download")
      ) {
        return
      }
      const id = link.dataset.taskDetailLink
      if (!id) return
      event.preventDefault()
      void lazyOpenTaskDetail(id, new URL(link.href).searchParams.get("comment"))
      return
    }

    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return
    if (target.closest("button, a, input, select, textarea, .task-actions, .action-btn")) return
    if (target instanceof HTMLElement && target.isContentEditable) return

    const taskEl = target.closest<HTMLElement>(
      ".task-item, .kanban-card, .bento-card, tr[data-id], [data-task-id]",
    )
    const taskId = taskEl && (taskEl.dataset.id || taskEl.dataset.taskId)
    if (!taskEl || !taskId) return

    event.preventDefault()
    event.stopPropagation()
    if (taskEl.closest("#search-results")) {
      const sr = document.getElementById("search-results")
      const si = document.getElementById("global-search") as HTMLInputElement | null
      if (sr) sr.style.display = "none"
      if (si) si.value = ""
    }
    void lazyOpenTaskDetail(taskId)
  }

  document.body.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a[data-task-detail-link]")) {
      handleLazyActivation(event)
    }
  }, { signal, capture: true })
  document.body.addEventListener("click", handleLazyActivation, { signal })
  document.body.addEventListener("keydown", handleLazyActivation, { signal })

  const handleLazyHistory = () => {
    if (!controllerReady && overlay.dataset.suppressUrlOpen !== "true" && hasTaskLocationInUrl()) {
      void ensureTaskDetailController()
    }
  }
  window.addEventListener("hashchange", handleLazyHistory, { signal })
  window.addEventListener("popstate", handleLazyHistory, { signal })
  window.addEventListener("meitheal:ticket-history", handleLazyHistory, { signal })
})
