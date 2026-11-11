import { getClientLocale, t } from "../i18n/client"
import { pageLifecycle } from "./page-lifecycle"
import { getStatusDef } from "./status-config"
import { buildTaskPermalink } from "./task-detail-handoff"
import {
  activatePinUpdate, PinAccessError, pinsInvalidated, readPinPage, setTaskPin, supportsPersonalPins,
  verifyPinLease, watchPinLease, type PinLease, type PinTask,
} from "./task-pin-client"

pageLifecycle.onPageLoad(signal => {
  const root = document.querySelector<HTMLElement>("[data-pinned-root]")
  const heading = root?.querySelector<HTMLElement>("#pinned-heading")
  const status = root?.querySelector<HTMLElement>("[data-pins-status]")
  const refresh = root?.querySelector<HTMLButtonElement>("[data-pins-refresh]")
  const list = root?.querySelector<HTMLUListElement>("[data-pins-list]")
  const pagination = root?.querySelector<HTMLElement>("[data-pins-pagination]")
  const pageLabel = root?.querySelector<HTMLElement>("[data-pins-page]")
  const previous = root?.querySelector<HTMLButtonElement>("[data-pins-previous]")
  const next = root?.querySelector<HTMLButtonElement>("[data-pins-next]")
  const template = root?.querySelector<HTMLTemplateElement>("[data-pin-row]")
  if (!root || !heading || !status || !refresh || !list || !pagination || !pageLabel || !previous || !next || !template) return
  if (root.dataset.pinsReady === "true") return
  root.dataset.pinsReady = "true"
  signal.addEventListener("abort", () => { delete root.dataset.pinsReady }, { once: true })
  const ui = { root, heading, status, refresh, list, pagination, pageLabel, previous, next, template }
  const locale = getClientLocale()
  const message = (key: string, variables?: Record<string, string>) => t(`pins.${key}`, locale, variables)
  const foreground = () => !signal.aborted && ui.root.isConnected &&
    document.visibilityState !== "hidden" && document.hasFocus()

  let operation: AbortController | undefined
  let stopLease: (() => void) | undefined
  let lease: PinLease | undefined
  let rows: PinTask[] = []
  let page = 1
  let pendingWrite = false
  let updateRequired = false
  let refreshRequired = false
  let lastInteraction = performance.now()

  function showStatus(text: string, canRefresh = false, activate = false) {
    ui.status.textContent = text
    ui.status.hidden = !text
    ui.refresh.hidden = !canRefresh
    ui.refresh.textContent = message(activate ? "activate" : "refresh")
    updateRequired = activate
  }

  function withdraw(restoreFocus = true) {
    const needsFocus = restoreFocus && (ui.list.contains(document.activeElement) || ui.pagination.contains(document.activeElement))
    operation?.abort()
    operation = undefined
    stopLease?.()
    stopLease = undefined
    lease = undefined
    rows = []
    ui.list.replaceChildren()
    ui.list.hidden = true
    ui.pagination.hidden = true
    if (needsFocus && foreground()) ui.heading.focus()
  }

  function failed(error?: unknown, broadcast = true) {
    withdraw()
    refreshRequired = true
    const kind = error instanceof PinAccessError ? error.kind : "network"
    if (kind === "account" && broadcast) window.dispatchEvent(new Event(pinsInvalidated))
    showStatus(message(kind === "update" ? "update" : kind === "account" ? "account" : "connection"), true, kind === "update")
  }

  function watch(current: PinLease) {
    stopLease?.()
    lease = current
    stopLease = watchPinLease(current, signal, () => lastInteraction, renewed => { lease = renewed }, failed)
  }

  function render(items: PinTask[], total: number, focusId?: string, notice?: string) {
    const fragment = document.createDocumentFragment()
    let focus: HTMLElement | undefined
    for (const item of items) {
      const row = ui.template.content.cloneNode(true) as DocumentFragment
      const link = row.querySelector<HTMLAnchorElement>("[data-pin-task]")!
      const ticket = row.querySelector<HTMLElement>("[data-pin-ticket]")!
      const badge = row.querySelector<HTMLElement>("[data-pin-status]")!
      const remove = row.querySelector<HTMLButtonElement>("[data-pin-remove]")!
      link.textContent = item.title
      link.href = buildTaskPermalink(item.id)
      link.dataset.pinTask = item.id
      ticket.textContent = item.ticket_key ?? ""
      ticket.hidden = !item.ticket_key
      const definition = getStatusDef(item.status)
      const workflow = definition ? t(definition.i18nKey, locale) : item.status
      badge.textContent = item.deferred_at == null ? workflow : `${workflow} · ${t("deferral.title", locale)}`
      remove.dataset.pinRemove = item.id
      remove.setAttribute("aria-label", message("unpin_named", { title: item.title }))
      if (item.id === focusId) focus = link
      fragment.append(row)
    }
    ui.list.replaceChildren(fragment)
    ui.list.hidden = items.length === 0
    const pages = Math.max(1, Math.ceil(total / 25))
    ui.pagination.hidden = pages === 1
    ui.pageLabel.textContent = message("page", { page: String(page), pages: String(pages) })
    ui.previous.disabled = page <= 1
    ui.next.disabled = page >= pages
    showStatus(notice ?? (items.length ? "" : message("empty")))
    if (focusId !== undefined) (focus ?? ui.heading).focus()
  }

  async function load(target: number, expected?: PinLease, focusId?: string, notice?: string) {
    if (!foreground()) return
    withdraw(focusId === undefined)
    refreshRequired = false
    const current = new AbortController()
    operation = current
    showStatus(message("loading"))
    try {
      const result = await readPinPage(target, AbortSignal.any([current.signal, signal]), expected)
      if (operation !== current || !foreground()) return
      const { value } = result
      if (!Number.isSafeInteger(value.page) || value.page < 1 || !Number.isSafeInteger(value.total) ||
          value.total < 0 || !Array.isArray(value.items) || value.items.length > 25) throw new PinAccessError("network")
      page = value.page
      rows = value.items
      render(rows, value.total, focusId, notice)
      watch(result.lease)
    } catch (error) {
      if (operation === current && foreground()) failed(error)
    }
  }

  async function removePin(button: HTMLButtonElement) {
    const current = lease
    const id = button.dataset.pinRemove
    if (!current || !id || pendingWrite || !foreground()) return
    const index = rows.findIndex(row => row.id === id)
    if (index < 0) return
    const nextFocus = rows[index + 1]?.id ?? rows[index - 1]?.id ?? ""
    const action = operation
    pendingWrite = true
    button.disabled = true
    try {
      await setTaskPin(id, false, current, AbortSignal.any([signal, action?.signal ?? signal]))
      if (action === operation && foreground()) await load(page, current, nextFocus, message("removed"))
    } catch (error) {
      if (action === operation && foreground()) failed(error)
    } finally {
      pendingWrite = false
      if (button.isConnected) button.disabled = false
    }
  }

  async function openTask(id: string) {
    const current = lease
    const action = operation
    if (!current || !action || pendingWrite || !foreground() || !rows.some(row => row.id === id)) return
    try {
      const confirmed = await verifyPinLease(current, AbortSignal.any([signal, action.signal]))
      if (operation !== action || !foreground()) return
      watch(confirmed)
      window.openPinnedTaskDetail?.(id, () => {
        if (foreground() && !refreshRequired) void load(page, lease, id)
      })
    } catch (error) {
      if (operation === action && foreground()) failed(error)
    }
  }

  if (!supportsPersonalPins()) {
    showStatus(message("unavailable"))
    return
  }

  ui.root.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>("[data-pin-remove]")
    if (button) { void removePin(button); return }
    const link = target?.closest<HTMLAnchorElement>("[data-pin-task]")
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        typeof window.openPinnedTaskDetail !== "function") return
    event.preventDefault()
    if (link.dataset.pinTask) void openTask(link.dataset.pinTask)
  }, { signal })
  ui.previous.addEventListener("click", () => { if (!pendingWrite && lease) void load(page - 1, lease, "") }, { signal })
  ui.next.addEventListener("click", () => { if (!pendingWrite && lease) void load(page + 1, lease, "") }, { signal })
  ui.refresh.addEventListener("click", async () => {
    if (!updateRequired) { await load(page, undefined, ""); return }
    ui.refresh.disabled = true
    try {
      if (!await activatePinUpdate(signal)) showStatus(message("update"), true, true)
    } catch {
      showStatus(message("update"), true, true)
    } finally {
      ui.refresh.disabled = false
    }
  }, { signal })
  const touched = () => { lastInteraction = performance.now() }
  for (const event of ["pointerdown", "keydown", "focusin"]) ui.root.addEventListener(event, touched, { signal })
  const suspend = () => { withdraw(false); if (!refreshRequired) showStatus(message("loading")) }
  const resume = () => { if (foreground() && !lease && !operation && !refreshRequired) { touched(); void load(page) } }
  window.addEventListener("blur", suspend, { signal })
  window.addEventListener("focus", resume, { signal })
  window.addEventListener("pagehide", suspend, { signal })
  window.addEventListener("pageshow", resume, { signal })
  window.addEventListener(pinsInvalidated, () => failed(new PinAccessError("account"), false), { signal })
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" ? suspend() : resume(), { signal })
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    const canReload = updateRequired || !refreshRequired
    withdraw()
    if (canReload) { refreshRequired = false; resume() }
  }, { signal })
  signal.addEventListener("abort", () => withdraw(false), { once: true })
  resume()
})
