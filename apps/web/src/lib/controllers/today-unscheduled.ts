import type { ListenerManager } from "../managed-listeners"
import { setUnscheduledPage } from "../today-list"

export function setupUnscheduledSection(
  container: HTMLElement,
  lm: ListenerManager,
  addBatchCheckboxes: (scope: HTMLElement) => void,
): () => void {
  const section = container.querySelector<HTMLElement>("#section-unscheduled")
  const list = section?.querySelector<HTMLElement>("#today-unscheduled-list")
  const toggle = section?.querySelector<HTMLButtonElement>(".today-section__toggle")
  const status = section?.querySelector<HTMLElement>("#today-unscheduled-status")
  const retry = section?.querySelector<HTMLButtonElement>("#today-unscheduled-retry")
  if (!section || !list || !toggle || !status || !retry) return () => {}

  let pending: AbortController | undefined
  let timer = 0
  let requestedPage = 1
  let focusRange = false
  const currentPage = () => Number(list.querySelector<HTMLElement>("#today-unscheduled-page")?.dataset.page ?? 0)
  const isOpen = () => !section.classList.contains("today-section--collapsed")

  const syncExpanded = () => {
    toggle.setAttribute("aria-expanded", String(isOpen()))
    list.hidden = !isOpen()
  }

  const setStatus = (message: string, failed = false) => {
    status.textContent = message
    status.hidden = !message
    retry.hidden = !failed
  }

  const loadPage = async (page: number, focus: boolean) => {
    pending?.abort()
    requestedPage = page
    focusRange = focus
    const controller = new AbortController()
    pending = controller
    const url = setUnscheduledPage(new URL(window.location.href), page)
    list.setAttribute("aria-busy", "true")
    setStatus("Loading unscheduled tasks…")
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([lm.signal, controller.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
        cache: "no-store",
      })
      if (!response.ok) throw new Error("Could not load unscheduled tasks")
      const html = new DOMParser().parseFromString(await response.text(), "text/html")
      const replacement = html.querySelector<HTMLElement>("#today-unscheduled-page")
      const previous = list.querySelector("#today-unscheduled-page")
      if (controller.signal.aborted || lm.signal.aborted || !isOpen()) return
      if (!replacement || !(Number(replacement.dataset.page) > 0) || !previous) {
        throw new Error("Unscheduled task page unavailable")
      }
      const shouldFocus = focus && (previous.contains(document.activeElement) || document.activeElement === retry)
      previous.replaceWith(replacement)
      addBatchCheckboxes(replacement)
      const count = html.querySelector("#section-unscheduled .today-section__count")?.textContent
      const total = section.querySelector(".today-section__count")
      if (count && total) total.textContent = count
      const currentUrl = setUnscheduledPage(new URL(window.location.href), currentPage())
      history.replaceState(history.state, "", currentUrl)
      setStatus("")
      if (shouldFocus) replacement.querySelector<HTMLElement>("[data-unscheduled-range]")?.focus()
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
      void loadPage(currentPage() || 1, false)
    } else {
      pending?.abort()
      window.clearTimeout(timer)
      const url = setUnscheduledPage(new URL(window.location.href), 0)
      history.replaceState(history.state, "", url)
    }
  })
  lm.on(list, "click", (event: Event) => {
    if (!(event instanceof MouseEvent) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const link = (event.target as Element)?.closest<HTMLElement>("[data-unscheduled-page]")
    if (!link) return
    event.preventDefault()
    void loadPage(Number(link.dataset.unscheduledPage), true)
  })
  lm.on(retry, "click", () => void loadPage(requestedPage, focusRange))
  syncExpanded()

  return () => {
    if (!isOpen()) return
    pending?.abort()
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (!lm.disposed && isOpen()) void loadPage(1, false)
    }, 200)
  }
}
