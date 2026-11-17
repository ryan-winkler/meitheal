import type { ListenerManager } from "../managed-listeners"
import { replaceTaskBackgroundUrl, taskBackgroundUrl } from "../task-page-url"
import { setUnscheduledPage } from "../today-list"

type PageFocus = "none" | "range" | "row"
const rowControls = "a, button, input"

export function setupUnscheduledSection(
  container: HTMLElement,
  lm: ListenerManager,
  addBatchCheckboxes: (scope: HTMLElement) => void,
): (keepPage?: boolean) => void {
  const section = container.querySelector<HTMLElement>("#section-unscheduled")
  const list = section?.querySelector<HTMLElement>("#today-unscheduled-list")
  const toggle = section?.querySelector<HTMLButtonElement>(".today-section__toggle")
  const status = section?.querySelector<HTMLElement>("#today-unscheduled-status")
  const retry = section?.querySelector<HTMLButtonElement>("#today-unscheduled-retry")
  if (!section || !list || !toggle || !status || !retry) return () => {}

  let pending: AbortController | undefined
  let timer = 0
  const background = () => taskBackgroundUrl()
  const currentPage = () => Number(list.querySelector<HTMLElement>("#today-unscheduled-page")?.dataset.page ?? 0)
  const isOpen = () => !section.classList.contains("today-section--collapsed")
  let requestedPage = currentPage() || 1
  let pageNavigation = false

  const syncExpanded = () => {
    toggle.setAttribute("aria-expanded", String(isOpen()))
    list.hidden = !isOpen()
  }

  const setStatus = (message: string, failed = false) => {
    status.textContent = message
    status.hidden = !message
    retry.hidden = !failed
  }

  const loadPage = async (page: number, focus: PageFocus) => {
    window.clearTimeout(timer)
    pending?.abort()
    requestedPage = page
    pageNavigation = focus === "range"
    const controller = new AbortController()
    pending = controller
    const url = setUnscheduledPage(background(), page)
    const retrying = document.activeElement === retry
    list.setAttribute("aria-busy", "true")
    setStatus("Loading unscheduled tasks…")
    try {
      const response = await fetch(url, { // nosemgrep
        signal: AbortSignal.any([lm.signal, controller.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
        cache: "no-store",
        headers: { "x-meitheal-refresh": "1" },
      })
      if (!response.ok) throw new Error()
      const html = new DOMParser().parseFromString(await response.text(), "text/html")
      const replacement = html.querySelector<HTMLElement>("#today-unscheduled-page")
      const previous = list.querySelector("#today-unscheduled-page")
      if (controller.signal.aborted || lm.signal.aborted || !isOpen()) return
      if (!replacement || !(Number(replacement.dataset.page) > 0) || !previous) {
        throw new Error()
      }
      const focused = document.activeElement
      const inside = previous.contains(focused)
      const row = focus === "row" && inside ? focused?.closest<HTMLElement>(".tli[data-id]") : null
      const controlIndex = row && focused ? Array.from(row.querySelectorAll(rowControls)).indexOf(focused) : -1
      const pager = focus === "row" && inside && focused instanceof HTMLAnchorElement ? focused.dataset.unscheduledPage : undefined
      previous.replaceWith(replacement)
      addBatchCheckboxes(replacement)
      requestedPage = currentPage()
      pageNavigation = false
      const count = html.querySelector("#section-unscheduled .today-section__count")?.textContent
      const total = section.querySelector(".today-section__count")
      if (count && total) total.textContent = count
      replaceTaskBackgroundUrl(setUnscheduledPage(background(), requestedPage))
      setStatus("")
      if (focus !== "none" && (inside || retrying && (focused === retry || focused === document.body))) {
        const retainedRow = row?.dataset.id
          ? replacement.querySelector(`.tli[data-id="${CSS.escape(row.dataset.id)}"]`) : null
        const retained = retainedRow?.querySelectorAll<HTMLElement>(rowControls)[controlIndex]
        const retainedPager = pager ? replacement.querySelector<HTMLElement>(`[data-unscheduled-page="${CSS.escape(pager)}"]`) : null
        ;(retained ?? retainedPager ?? replacement.querySelector<HTMLElement>("[data-unscheduled-range]"))?.focus()
      }
    } catch {
      if (!controller.signal.aborted && !lm.signal.aborted) {
        setStatus("Could not load unscheduled tasks. Try again.", true)
      }
    } finally {
      if (pending === controller) {
        pending = undefined
        list.removeAttribute("aria-busy")
      }
    }
  }

  lm.on(toggle, "click", () => {
    section.classList.toggle("today-section--collapsed")
    syncExpanded()
    if (isOpen()) {
      void loadPage(currentPage() || 1, "none")
    } else {
      pending?.abort()
      window.clearTimeout(timer)
      replaceTaskBackgroundUrl(setUnscheduledPage(background(), 0))
    }
  })
  lm.on(list, "click", (event: Event) => {
    if (!(event instanceof MouseEvent) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const link = (event.target as Element)?.closest<HTMLElement>("[data-unscheduled-page]")
    if (!link) return
    event.preventDefault()
    void loadPage(Number(link.dataset.unscheduledPage), "range")
  })
  lm.on(retry, "click", () => void loadPage(requestedPage, "range"))
  syncExpanded()

  return (keepPage = false) => {
    if (!isOpen()) return
    pending?.abort()
    window.clearTimeout(timer)
    if (!keepPage) {
      requestedPage = 1
      pageNavigation = false
    }
    timer = window.setTimeout(() => {
      if (!lm.disposed && isOpen()) void loadPage(requestedPage, pageNavigation ? "range" : keepPage ? "row" : "none")
    }, 200)
  }
}
