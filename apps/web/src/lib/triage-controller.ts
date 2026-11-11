import { pageLifecycle } from "@lib/page-lifecycle"
import { getLegacyTaskId, openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { taskBackgroundUrl } from "./task-page-url"
import { workerAllowsNetworkOnly } from "./network-only-worker"

const cacheModes = new Set(["visible", "hidden", "disabled", "unavailable"])

function queueUrl(): URL {
  const url = taskBackgroundUrl(new URL(location.href))
  url.searchParams.delete("open")
  url.searchParams.delete("comment")
  return url
}

function overlay(): HTMLElement | null {
  return document.querySelector("#task-detail-overlay.active")
}

function initTriage(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>("[data-triage-root]")
  const initial = root?.querySelector<HTMLTemplateElement>("[data-triage-fragment]")
  const content = root?.querySelector<HTMLElement>("[data-triage-content]")
  const status = root?.querySelector<HTMLElement>("[data-triage-status]")
  const reload = root?.querySelector<HTMLAnchorElement>("[data-triage-reload]")
  const heading = root?.querySelector<HTMLElement>("#triage-heading")
  const planningTab = root?.closest<HTMLElement>('[data-parent-section="triage"]')
  if (!root || (!initial && !planningTab) || !content || !status || !reload || !heading || root.dataset.triageInitialized) return
  const ui = { root, initial, content, status, reload, heading }
  ui.root.dataset.triageInitialized = "true"

  const workers = navigator.serviceWorker
  let refreshGeneration = 0
  let modalGeneration = 0
  let visible = false
  let pending = false
  let suspended = false
  let updateRequired = false

  const live = () => !signal.aborted && ui.root.isConnected && !suspended && !planningTab?.hidden
  const message = (key: string, fallback: string) => window.mI18n?.get(`triage.${key}`) ?? fallback
  const setStatus = (text: string, showReload = false) => {
    ui.status.textContent = text
    ui.status.hidden = !text
    ui.reload.hidden = !showReload
  }

  function checkTaskLocation() {
    const request = ++modalGeneration
    if (!visible || !live()) return
    const start = location.href
    const url = new URL(start)
    const id = getLegacyTaskId(url.hash) ?? url.searchParams.get("open")
    if (!id || overlay()?.dataset.openTaskId === id) return

    const deadline = performance.now() + 1000
    const openWhenReady = () => {
      if (request !== modalGeneration || !visible || !live() || location.href !== start) return
      if (typeof window.openTaskDetail === "function" && document.getElementById("task-detail-overlay")?.isConnected) {
        if (overlay()?.dataset.openTaskId !== id) openTaskDetailHandoff(id)
      } else if (performance.now() < deadline) {
        requestAnimationFrame(openWhenReady)
      }
    }
    openWhenReady()
  }

  function withdrawQueue() {
    visible = false
    modalGeneration++
    ui.content.replaceChildren()
  }

  async function readQueue(forceFresh: boolean) {
    if (!live()) return
    const generation = ++refreshGeneration
    const worker = workers?.controller ?? null
    const path = queueUrl().href
    const canApply = () => live() && generation === refreshGeneration &&
      (workers?.controller ?? null) === worker && queueUrl().href === path

    withdrawQueue()
    updateRequired = false
    setStatus(message("loading", "Loading intake…"))
    let fragment = ui.initial
    try {
      if (worker && !await workerAllowsNetworkOnly(worker, "TRIAGE_NETWORK_ONLY")) {
        if (canApply()) {
          updateRequired = true
          setStatus(message("worker_update", "Reload Triage to activate the update before opening the queue."), true)
        }
        return
      }
      if (!canApply()) return

      if (planningTab || worker || forceFresh) {
        // Read the same network-only intake as the standalone view. Planning may be cached.
        const url = new URL(planningTab ? ui.reload.href : path)
        url.hash = ""
        if (planningTab) {
          const requestedPage = new URL(path).searchParams.get("triagePage")
          if (requestedPage) url.searchParams.set("page", requestedPage)
          url.searchParams.set("triageEmbedded", "1")
        }
        url.searchParams.set("triageRefresh", `${performance.timeOrigin}-${generation}`)
        const response = await fetch(url, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        })
        if (!response.ok) throw new Error("Triage response unavailable")
        const html = new DOMParser().parseFromString(await response.text(), "text/html")
        const fresh = html.querySelector<HTMLTemplateElement>("template[data-triage-fragment]")
        if (!fresh || !cacheModes.has(fresh.dataset.triageMode ?? "")) throw new Error("Invalid Triage response")
        fragment = fresh
      }

      if (!canApply() || !fragment) return
      ui.content.replaceChildren(fragment.content.cloneNode(true))
      if (planningTab) {
        ui.content.querySelectorAll<HTMLAnchorElement>("[data-triage-page]").forEach(link => {
          const destination = new URL(path)
          destination.searchParams.delete("focus")
          const target = link.dataset.triagePage
          if (target && target !== "1") destination.searchParams.set("triagePage", target)
          else destination.searchParams.delete("triagePage")
          link.href = destination.href
        })
      }
      visible = fragment.dataset.triageMode === "visible"
      setStatus("")
      const url = new URL(location.href)
      if (url.searchParams.has("focus")) {
        const id = url.searchParams.get("focus") ?? ""
        const detail = ui.content.querySelector<HTMLElement>(`[data-triage-card="${CSS.escape(id)}"] [data-triage-details]`)
        ;(detail ?? ui.heading).focus()
        url.searchParams.delete("focus")
        history.replaceState(history.state, "", url)
      }
      checkTaskLocation()
    } catch {
      if (canApply()) setStatus(message("network_required", "Triage needs a connection. Reload when you’re back online."), true)
    }
  }

  async function decide(button: HTMLButtonElement) {
    const card = button.closest<HTMLElement>("[data-triage-card]")
    const id = card?.dataset.triageCard
    const version = Number(card?.dataset.triageVersion)
    const target = button.dataset.triageDecision
    if (!card || !id || !Number.isSafeInteger(version) || (target !== "pending" && target !== "active") ||
        pending || !visible || !live()) return

    const origin = queueUrl().href
    const sibling = card.nextElementSibling ?? card.previousElementSibling
    const next = sibling instanceof HTMLElement ? sibling.dataset.triageCard : undefined
    const buttons = card.querySelectorAll<HTMLButtonElement>("[data-triage-decision]")
    const relevant = () => live() && card.isConnected && queueUrl().href === origin
    const uncertain = () => {
      if (relevant()) setStatus(message("verify_outcome", "Reload the queue to check whether the decision saved before retrying."), true)
    }
    pending = true
    card.setAttribute("aria-busy", "true")
    buttons.forEach(control => { control.disabled = true })
    setStatus("")
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "X-Meitheal-Local-Conflict": "1" },
        body: JSON.stringify({ status: target, updated_at: version, expected_status: "backlog" }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })
      if (response.status >= 500) {
        await response.body?.cancel()
        uncertain()
        return
      }
      const body = await response.json()
      if (response.status === 200 && body?.id === id && body?.status === target) {
        if (live() && card.isConnected) card.dataset.triageAcknowledged = "true"
        if (!relevant()) return
        if (overlay()) {
          setStatus(message("saved_reload", "Decision saved. Reload Triage to update the queue."), true)
        } else {
          const url = queueUrl()
          if (next) url.searchParams.set("focus", next)
          else url.searchParams.set("focus", "")
          location.replace(url)
        }
        return
      }
      if (response.ok) {
        uncertain()
      } else if (relevant() && body?.errorCode === "TASK_BLOCKED" && Array.isArray(body.blocked_by)) {
        const entries: Array<{ ticket_key?: unknown; title?: unknown } | null> = body.blocked_by
        const blockers = entries.map(item => item?.ticket_key || item?.title)
          .filter(item => typeof item === "string").join(", ")
        const summary = message("blocked", "Start is blocked by open dependencies.")
        setStatus(blockers ? `${summary} ${blockers}` : summary)
      } else if (relevant() && body?.errorCode === "TASK_VERSION_CONFLICT") {
        setStatus(message("changed", "This task changed. Reload Triage to see the latest version."), true)
      } else if (relevant()) {
        setStatus(message("failed", "Couldn’t save the decision. Try again."))
      }
    } catch {
      uncertain()
    } finally {
      pending = false
      if (live() && card.isConnected) {
        card.removeAttribute("aria-busy")
        if (!card.dataset.triageAcknowledged) {
          buttons.forEach(control => { control.disabled = false })
          const focused = document.activeElement
          if (relevant() && !overlay() && (focused === document.body || ui.root.contains(focused))) button.focus()
        }
      }
    }
  }

  ui.root.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    const decision = target?.closest<HTMLButtonElement>("button[data-triage-decision]")
    if (decision) {
      void decide(decision)
      return
    }
    const details = target?.closest<HTMLAnchorElement>("a[data-triage-details]")
    if (!details || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        typeof window.openTaskDetail !== "function") return
    const id = details.closest<HTMLElement>("[data-triage-card]")?.dataset.triageCard
    if (!id) return
    event.preventDefault()
    details.focus()
    openTaskDetailHandoff(id)
  }, { signal })

  ui.reload.addEventListener("click", async event => {
    event.preventDefault()
    const start = queueUrl().href
    if (updateRequired) {
      const waiting = await workers?.getRegistration().then(registration => registration?.waiting).catch(() => null)
      if (!live() || queueUrl().href !== start) return
      if (waiting) {
        waiting.postMessage({ type: "SKIP_WAITING" })
        return
      }
    }
    location.replace(start)
  }, { signal })
  window.addEventListener("popstate", checkTaskLocation, { signal })
  window.addEventListener("hashchange", checkTaskLocation, { signal })
  workers?.addEventListener("controllerchange", () => { if (live()) void readQueue(true) }, { signal })
  window.addEventListener("pagehide", () => {
    suspended = true
    refreshGeneration++
    withdrawQueue()
  }, { signal })
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return
    suspended = false
    void readQueue(true)
  }, { signal })
  if (planningTab) {
    const tabVisibility = new MutationObserver(() => {
      if (planningTab.hidden) {
        refreshGeneration++
        withdrawQueue()
      } else {
        void readQueue(true)
      }
    })
    tabVisibility.observe(planningTab, { attributeFilter: ["hidden"] })
    signal.addEventListener("abort", () => tabVisibility.disconnect(), { once: true })
  }
  void readQueue(false)
}

pageLifecycle.onPageLoad(initTriage)
