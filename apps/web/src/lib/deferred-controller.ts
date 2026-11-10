import { pageLifecycle } from "./page-lifecycle"
import { buildTaskPermalink, openTaskDetailHandoff } from "./task-detail-handoff"
import {
  allowsDeferral, DEFERRAL_RECONCILED, DEFERRAL_TIMEOUT_MS, notifyTaskCountsChanged, readDeferralGuard, writeDeferral,
  type DeferralReconciliation,
} from "./deferral-client"

function queueUrl(): URL {
  const url = new URL(location.href)
  url.searchParams.delete("open")
  url.hash = ""
  return url
}

pageLifecycle.onPageLoad(signal => {
  const root = document.querySelector<HTMLElement>("[data-deferred-root]")
  const content = root?.querySelector<HTMLElement>("[data-deferred-content]")
  const status = root?.querySelector<HTMLElement>("[data-deferred-status]")
  const reload = root?.querySelector<HTMLAnchorElement>("[data-deferred-reload]")
  const heading = root?.querySelector<HTMLElement>("#deferred-heading")
  const permalink = root?.querySelector<HTMLAnchorElement>("[data-deferred-permalink]")
  if (!root || !content || !status || !reload || !heading || !permalink) return

  const ui = { root, content, status, reload, heading, permalink }
  const workers = navigator.serviceWorker
  let generation = 0
  let visible = false
  let suspended = false
  let pending = false
  let updateRequired = false
  const live = () => ui.root.isConnected && !signal.aborted && !suspended
  const message = (key: string, fallback: string) => window.mI18n?.get(`deferral.${key}`) ?? fallback
  const cardFor = (id: string) => ui.content.querySelector<HTMLElement>(`[data-deferred-card="${CSS.escape(id)}"]`)
  function showStatus(text: string, retry = false) {
    ui.status.textContent = text
    ui.status.hidden = !text
    ui.reload.hidden = !retry
  }

  function openFromLocation() {
    if (!visible || !live()) return
    const url = new URL(location.href)
    const id = url.searchParams.get("open")
    ui.permalink.hidden = true
    if (id && /^[\w-]{1,128}$/.test(id) && !cardFor(id)) {
      ui.permalink.href = buildTaskPermalink(id)
      ui.permalink.hidden = false
    }
    if (!id || !cardFor(id)) return
    const deadline = performance.now() + 1000
    function openWhenReady() {
      if (!visible || !live() || location.href !== url.href || !cardFor(id!)) return
      if (typeof window.openTaskDetail === "function") {
        if (document.querySelector<HTMLElement>("#task-detail-overlay.active")?.dataset.taskId !== id) {
          openTaskDetailHandoff(id!)
        }
      } else if (performance.now() < deadline) requestAnimationFrame(openWhenReady)
    }
    openWhenReady()
  }

  async function readQueue(focus?: string, notice?: string, dataOnly = false) {
    const current = ++generation
    const worker = workers?.controller ?? null
    const origin = queueUrl().href
    const currentLocation = location.href
    const apply = () => live() && generation === current && queueUrl().href === origin &&
      (workers?.controller ?? null) === worker && (!dataOnly || location.href === currentLocation)
    updateRequired = false
    if (!dataOnly) {
      visible = false
      ui.content.replaceChildren()
      ui.permalink.hidden = true
      showStatus(message("loading", "Loading deferred work…"))
    }
    try {
      if (!await allowsDeferral(worker)) {
        if (apply()) {
          updateRequired = true
          showStatus(message("worker_update", "Reload Deferred to activate the update."), true)
        }
        return
      }
      if (!apply()) return
      const request = new URL(origin)
      request.searchParams.set("deferredRefresh", `${performance.timeOrigin}-${current}`)
      const response = await fetch(request, {
        cache: "no-store", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(DEFERRAL_TIMEOUT_MS)]),
      })
      if (!response.ok || response.url !== request.href || !response.headers.get("cache-control")?.includes("no-store")) {
        throw new Error("Deferred work needs a fresh response")
      }
      const doc = new DOMParser().parseFromString(await response.text(), "text/html")
      const fragment = doc.querySelector<HTMLTemplateElement>("template[data-deferred-fragment]")
      const page = Number(fragment?.dataset.page)
      if (fragment?.dataset.available !== "true" || !Number.isSafeInteger(page) || page < 1) {
        throw new Error("Invalid Deferred response")
      }
      if (!apply()) return
      ui.content.replaceChildren(fragment.content.cloneNode(true))
      visible = true
      showStatus(notice ?? "")
      if (dataOnly) return
      const url = new URL(location.href)
      if (page > 1) url.searchParams.set("page", String(page))
      else url.searchParams.delete("page")
      history.replaceState(history.state, "", url)
      if (focus !== undefined) {
        const control = focus ? cardFor(focus)?.querySelector<HTMLElement>("[data-deferred-details]") : null
        ;(control ?? ui.heading).focus()
      }
      openFromLocation()
    } catch {
      if (apply()) showStatus(message("network_required", "Deferred work needs a connection. Reload when you’re back online."), true)
    }
  }

  async function resume(button: HTMLButtonElement) {
    const card = button.closest<HTMLElement>("[data-deferred-card]")
    const id = card?.dataset.deferredCard
    const guard = readDeferralGuard(Number(card?.dataset.version), card?.dataset.revision || null)
    if (!card || !id || !guard || pending || !visible || !live()) return
    const start = queueUrl().href
    const next = (card.nextElementSibling ?? card.previousElementSibling) as HTMLElement | null
    const worker = workers?.controller ?? null
    const relevant = () => live() && card.isConnected && queueUrl().href === start && (workers?.controller ?? null) === worker
    pending = true
    button.disabled = true
    card.setAttribute("aria-busy", "true")
    showStatus("")
    let needsRefresh = false
    try {
      if (!await allowsDeferral(worker) || !relevant()) return
      const result = await writeDeferral(id, false, guard, signal)
      if (result.kind === "saved") notifyTaskCountsChanged(card.dataset.project)
      if (!relevant()) return
      switch (result.kind) {
        case "saved":
          await readQueue(next?.dataset.deferredCard ?? "", message("resumed", "Task resumed."))
          break
        case "blocked": {
          const text = message("blocked", "This task is still blocked.")
          showStatus(result.blockers.length ? `${text} ${result.blockers.join(", ")}` : text)
          break
        }
        case "changed":
        case "uncertain":
          needsRefresh = true
          showStatus(message("verify", "Reload to check the task before trying again."), true)
          ui.reload.focus()
          break
        case "failed":
          showStatus(message("failed", "Couldn’t save the change."))
          break
      }
    } finally {
      pending = false
      if (relevant()) {
        card.removeAttribute("aria-busy")
        button.disabled = needsRefresh
        if (!needsRefresh) button.focus()
      }
    }
  }

  ui.root.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>("[data-deferred-resume]")
    if (button) { void resume(button); return }
    const details = target?.closest<HTMLAnchorElement>("[data-deferred-details]")
    if (!details || !visible || pending || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        typeof window.openTaskDetail !== "function") return
    const id = details.closest<HTMLElement>("[data-deferred-card]")?.dataset.deferredCard
    if (!id) return
    event.preventDefault()
    details.focus()
    openTaskDetailHandoff(id)
  }, { signal })
  ui.reload.addEventListener("click", async event => {
    event.preventDefault()
    if (updateRequired) {
      const origin = queueUrl().href
      const waiting = await workers?.getRegistration().then(registration => registration?.waiting).catch(() => null)
      if (!live() || queueUrl().href !== origin) return
      if (waiting) { waiting.postMessage({ type: "SKIP_WAITING" }); return }
      location.replace(origin)
      return
    }
    void readQueue("")
  }, { signal })
  window.addEventListener("popstate", openFromLocation, { signal })
  window.addEventListener(DEFERRAL_RECONCILED, event => {
    const { taskId: origin, dataOnly } = (event as CustomEvent<DeferralReconciliation>).detail ?? {}
    if (dataOnly) {
      void readQueue(undefined, undefined, true)
      return
    }
    const card = origin ? cardFor(origin) : null
    const next = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null
    void readQueue(next?.dataset.deferredCard ?? "")
  }, { signal })
  workers?.addEventListener("controllerchange", () => { if (live()) void readQueue() }, { signal })
  window.addEventListener("pagehide", () => {
    suspended = true
    generation++
    visible = false
    ui.content.replaceChildren()
  }, { signal })
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return
    suspended = false
    void readQueue()
  }, { signal })
  void readQueue()
})
