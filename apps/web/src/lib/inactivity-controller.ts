import type { InactivityFilter } from "@domains/tasks/persistence/task-inactivity-repository"
import { t, type Locale } from "../i18n/client"
import { InactivityRequestError, requestInactivity, type InactivityPreview } from "./inactivity-client"
import { pageLifecycle } from "./page-lifecycle"

pageLifecycle.onPageLoad(signal => {
  const root = document.querySelector<HTMLElement>("[data-inactivity-page]")
  if (!root || root.dataset.inactivityMounted) return
  root.dataset.inactivityMounted = "true"
  signal.addEventListener("abort", () => { delete root.dataset.inactivityMounted }, { once: true })

  const select = <T extends Element>(part: string) => root.querySelector<T>(`[data-inactivity-${part}]`)!
  const locale = (root.dataset.locale === "ga" ? "ga" : "en") satisfies Locale
  const label = (key: string, params?: Record<string, string>) => t(`inactivity.${key}`, locale, params)
  const status = select<HTMLParagraphElement>("status")
  const content = select<HTMLDivElement>("content")
  const area = select<HTMLSelectElement>("area")
  const filter = select<HTMLSelectElement>("filter")
  const edit = select<HTMLFormElement>("edit")
  const mode = select<HTMLSelectElement>("mode")
  const interval = select<HTMLLabelElement>("interval")
  const days = interval.querySelector<HTMLInputElement>("input")!
  const save = select<HTMLButtonElement>("save")
  const retry = select<HTMLButtonElement>("retry")
  const rows = select<HTMLUListElement>("rows")
  const empty = select<HTMLParagraphElement>("empty")
  const previous = select<HTMLButtonElement>("previous")
  const next = select<HTMLButtonElement>("next")
  const pagination = select<HTMLElement>("pages")
  const back = select<HTMLAnchorElement>("back")
  const heading = document.getElementById("inactivity-review")
  const dateOptions = { dateStyle: "medium", timeStyle: "short" } as const
  let dateFormat: Intl.DateTimeFormat
  try {
    dateFormat = new Intl.DateTimeFormat(locale, { ...dateOptions, timeZone: root.dataset.timezone })
  } catch {
    dateFormat = new Intl.DateTimeFormat(locale, { ...dateOptions, timeZone: "UTC" })
  }

  const params = new URLSearchParams(location.search)
  let scope = params.get("area") || null
  let page = Math.min(100_000, Math.max(1, Number.parseInt(params.get("page") ?? "", 10) || 1))
  let currentFilter: InactivityFilter = params.get("filter") === "ready" ? "ready"
    : params.get("filter") === "upcoming" ? "upcoming" : "all"
  let pending: AbortController | undefined
  let reviewed: { preview: InactivityPreview; proposed: number } | undefined
  let snapshot: InactivityPreview | undefined
  let saving = false

  function setMode(value: number) {
    mode.value = value < 0 ? "inherit" : value === 0 ? "off" : "interval"
    days.value = String(value > 0 ? value : 30)
    syncMode()
  }

  function syncMode() {
    interval.hidden = mode.value !== "interval"
    days.disabled = interval.hidden || saving
  }

  function policyLabel(value: number) {
    return value < 0 ? label("inherit") : value === 0 ? label("off") : label("interval", { days: String(value) })
  }

  function invalidateReview() {
    pending?.abort()
    reviewed = undefined
    save.disabled = true
  }

  function clear() {
    invalidateReview()
    snapshot = undefined
    setMode(0)
    content.hidden = true
    rows.replaceChildren()
    select<HTMLElement>("policy").textContent = ""
    while (area.options.length > 1) area.remove(1)
    select<HTMLElement>("range").textContent = ""
    empty.hidden = true
    retry.hidden = true
    status.textContent = label("loading")
  }

  function writeUrl() {
    const url = new URL(location.href)
    for (const [key, value] of [["area", scope], ["page", page > 1 ? String(page) : null],
      ["filter", currentFilter === "all" ? null : currentFilter]] as const) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    history.replaceState(history.state, "", url)
    const tasks = new URL(back.href)
    if (scope) tasks.searchParams.set("area", scope)
    else tasks.searchParams.delete("area")
    back.href = tasks.href
  }

  function render(preview: InactivityPreview, proposed: number | undefined, resetEdit: boolean) {
    snapshot = preview
    page = preview.page
    writeUrl()
    while (area.options.length > 1) area.remove(1)
    for (const item of preview.areas) area.add(new Option(item.name, item.id))
    area.value = scope ?? ""
    filter.value = currentFilter
    const current = select<HTMLElement>("policy")
    current.textContent = `${label("current")} · ${policyLabel(preview.policy.days)}`
    if (scope !== null) current.append(` · ${label("default")} · ${policyLabel(preview.defaultPolicy.days)}`)

    edit.hidden = !preview.canSave
    select<HTMLElement>("readonly").hidden = preview.canSave
    mode.options[0]!.disabled = scope === null
    mode.options[0]!.hidden = scope === null
    if (resetEdit) setMode(preview.policy.days)

    rows.replaceChildren()
    for (const task of preview.tasks) {
      const row = document.createElement("li")
      const title = document.createElement("h3")
      title.dir = "auto"
      title.textContent = task.title
      const summary = document.createElement("p")
      const time = document.createElement("time")
      time.dateTime = new Date(task.deadline).toISOString()
      time.textContent = dateFormat.format(task.deadline)
      summary.append(label(task.deadline <= preview.now ? "ready" : "upcoming"), " · ", time)
      const details = document.createElement("a")
      const target = new URL(back.href)
      target.searchParams.set("area", task.area_id)
      target.searchParams.set("open", task.id)
      details.href = target.href
      details.dataset.astroPrefetch = "false"
      details.className = "btn btn-outline"
      details.textContent = t("triage.details", locale)
      row.append(title, summary, details)
      rows.append(row)
    }

    empty.hidden = preview.tasks.length > 0
    empty.textContent = label(preview.hasEffectivePolicy ? "empty" : "disabled")
    pagination.hidden = preview.total <= 25
    previous.disabled = page <= 1
    const last = (page - 1) * 25 + preview.tasks.length
    next.disabled = last >= preview.total
    select<HTMLElement>("range").textContent = t("triage.range", locale, {
      first: String((page - 1) * 25 + 1), last: String(last), total: String(preview.total),
    })
    content.hidden = false
    if (proposed !== undefined && preview.canSave) reviewed = { preview, proposed }
    save.disabled = !reviewed
  }

  async function load(proposed?: number, options: { focus?: boolean; resetEdit?: boolean; notice?: string } = {}) {
    invalidateReview()
    const request = new AbortController()
    pending = request
    rows.replaceChildren()
    empty.hidden = true
    pagination.hidden = true
    retry.hidden = true
    status.textContent = label("loading")

    try {
      const preview = await requestInactivity({
        action: "preview", areaId: scope, page, filter: currentFilter,
        ...(proposed === undefined ? {} : { days: proposed }),
      }, AbortSignal.any([signal, request.signal]))
      if (signal.aborted || request.signal.aborted) return
      render(preview, proposed, options.resetEdit ?? true)
      status.textContent = options.notice ?? (proposed === undefined ? "" : label("previewed"))
      if (options.focus) heading?.focus()
    } catch (error) {
      if (request.signal.aborted || signal.aborted) return
      const code = error instanceof InactivityRequestError ? error.status : 0
      if (code === 404 && scope !== null) {
        scope = null
        page = 1
        void load(undefined, { notice: label("missing") })
        return
      }
      clear()
      status.textContent = label(code === 403 ? "denied" : "failed")
      retry.hidden = false
    } finally {
      if (pending === request) pending = undefined
    }
  }

  async function savePolicy() {
    if (!reviewed || saving) return
    const { preview, proposed } = reviewed
    invalidateReview()
    const request = new AbortController()
    pending = request
    saving = true
    area.disabled = filter.disabled = mode.disabled = true
    select<HTMLButtonElement>("preview").disabled = previous.disabled = next.disabled = true
    syncMode()
    status.textContent = label("saving")
    try {
      await requestInactivity({
        action: "save", areaId: scope, days: proposed, expectedRevision: preview.policy.revision,
        expectedDefaultRevision: preview.defaultPolicy.revision, areaGeneration: preview.areaGeneration,
        expectedAreaCatalogRevision: preview.areaCatalogRevision,
      }, AbortSignal.any([signal, request.signal]))
      if (!signal.aborted && !request.signal.aborted) await load(undefined, { notice: label("saved"), focus: true })
    } catch (error) {
      if (request.signal.aborted || signal.aborted) return
      const code = error instanceof InactivityRequestError ? error.status : 0
      if (code === 403) {
        clear()
        retry.hidden = false
      }
      status.textContent = label(code === 409 ? "stale" : code === 403 ? "denied" : code === 404 ? "missing" : "failed")
    } finally {
      if (pending === request) pending = undefined
      saving = false
      area.disabled = filter.disabled = mode.disabled = false
      select<HTMLButtonElement>("preview").disabled = false
      previous.disabled = page <= 1
      next.disabled = page * 25 >= (snapshot?.total ?? 0)
      syncMode()
    }
  }

  area.addEventListener("change", () => {
    scope = area.value || null
    page = 1
    void load()
  }, { signal })
  filter.addEventListener("change", () => {
    currentFilter = filter.value as InactivityFilter
    page = 1
    void load(reviewed?.proposed, { resetEdit: false })
  }, { signal })
  for (const input of [mode, days]) input.addEventListener("input", () => {
    syncMode()
    if (reviewed || pending) void load(undefined, { resetEdit: false })
  }, { signal })
  edit.addEventListener("submit", event => {
    event.preventDefault()
    const proposed = mode.value === "inherit" ? -1 : mode.value === "off" ? 0 : days.valueAsNumber
    if (!Number.isInteger(proposed) || proposed < -1 || proposed > 365 || (scope === null && proposed < 0)) return
    page = 1
    void load(proposed, { focus: true, resetEdit: false })
  }, { signal })
  for (const [button, step] of [[previous, -1], [next, 1]] as const) {
    button.addEventListener("click", () => {
      page += step
      void load(reviewed?.proposed, { focus: true, resetEdit: false })
    }, { signal })
  }
  save.addEventListener("click", () => void savePolicy(), { signal })
  retry.addEventListener("click", () => void load(), { signal })
  window.addEventListener("offline", () => {
    clear()
    status.textContent = label("failed")
    retry.hidden = false
  }, { signal })
  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("pageshow", event => {
    if (event.persisted) void load()
  }, { signal })
  signal.addEventListener("abort", clear, { once: true })
  if (window.isSecureContext) {
    void load()
  } else {
    status.textContent = label("secure_origin")
  }
})
