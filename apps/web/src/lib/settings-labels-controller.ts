import { confirmDialog } from "./confirm-dialog"
import { showToast } from "./toast"

interface LabelData {
  id: number
  title: string
  hex_color: string
}
interface LabelState {
  label: LabelData
  draftTitle: string
  draftColor: string
  busy: boolean
  notice: string
  error: boolean
}
interface LabelRow {
  state: LabelState
  element: HTMLLIElement
  form: HTMLFormElement
  title: HTMLInputElement
  color: HTMLInputElement
  badge: HTMLSpanElement
  swatch: HTMLSpanElement
  status: HTMLParagraphElement
  save: HTMLButtonElement
  remove: HTMLButtonElement
}
export interface LabelChangeDetail {
  source: "editor" | "cleanup"
  removed?: number
  removedIds?: number[]
}

const PAGE_SIZE = 25

function color(value: unknown) {
  return typeof value === "string" && /^#?[a-f0-9]{6}$/i.test(value) ? "#" + value.replace(/^#/, "").toLowerCase() : "#6b7280"
}
function readLabel(value: unknown, historicalColor = true): LabelData | null {
  if (!value || typeof value !== "object") return null
  const label = value as LabelData
  if (!historicalColor && (typeof label.hex_color !== "string" || !/^#?[a-f0-9]{6}$/i.test(label.hex_color))) return null
  return Number.isSafeInteger(label.id) && label.id > 0 && typeof label.title === "string"
    ? { id: label.id, title: label.title, hex_color: color(label.hex_color) } : null
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/** The Settings bootstrap owns this controller and its entire page lifetime. */
export function initSettingsLabels(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>("[data-label-editor]")
  if (!root || signal.aborted || root.dataset.labelsBooted === "true") return
  root.dataset.labelsBooted = "true"
  delete root.dataset.labelsReady
  const copy = JSON.parse(root.dataset.copy ?? "{}") as Record<string, string>
  const locale = root.dataset.locale === "ga" ? "ga" : "en"
  const number = new Intl.NumberFormat(locale)
  const text = (key: string, values: string | Record<string, string> = "") => {
    const parameters: Record<string, string> = typeof values === "string" ? { name: values } : values
    return (copy[key] ?? key).replace(/\{(\w+)\}/g, (token, name: string) => parameters[name] ?? token)
  }
  const list = root.querySelector<HTMLUListElement>("#labels-list")!
  const status = root.querySelector<HTMLElement>("[data-label-editor-status]")!
  const retry = root.querySelector<HTMLButtonElement>("[data-label-editor-retry]")!
  const search = root.querySelector<HTMLInputElement>("[data-label-search]")!
  const range = root.querySelector<HTMLElement>("[data-label-range]")!
  const pages = root.querySelector<HTMLElement>("[data-label-pages]")!
  const pageLabel = root.querySelector<HTMLElement>("[data-label-page]")!
  const previous = root.querySelector<HTMLButtonElement>("[data-label-previous]")!
  const next = root.querySelector<HTMLButtonElement>("[data-label-next]")!
  const empty = root.querySelector<HTMLElement>("[data-label-empty]")!
  const create = root.querySelector<HTMLFormElement>("#create-label-form")!
  const newTitle = root.querySelector<HTMLInputElement>("#new-label-title")!
  const newColor = root.querySelector<HTMLInputElement>("#new-label-color")!
  const createButton = create.querySelector<HTMLButtonElement>('button[type="submit"]')!
  // Full definitions and primitive drafts survive paging; editor DOM does not.
  const states = new Map<number, LabelState>()
  const mountedRows = new Map<number, LabelRow>()
  const removedIds = new Set<number>()
  let priorMatches: number[] = []
  let page = 0
  let loading = false
  let ready = false
  let loadFailed = false
  let creating = false
  search.value = ""
  newTitle.readOnly = false
  newColor.disabled = false
  createButton.setAttribute("aria-disabled", "false")
  // A replacement lifecycle can reuse the shell after its predecessor aborts.
  for (const child of [...list.children]) child.remove()

  function live(state: LabelState) {
    return !signal.aborted && !removedIds.has(state.label.id) && states.get(state.label.id) === state
  }
  function paint(row: LabelRow) {
    const state = row.state
    const label = state.label
    const display = label.title || text("untitled")
    if (row.title.value !== state.draftTitle) row.title.value = state.draftTitle
    if (row.color.value !== state.draftColor) row.color.value = state.draftColor
    row.badge.textContent = display
    row.swatch.style.backgroundColor = label.hex_color
    row.save.setAttribute("aria-label", text("save_label", display))
    row.remove.setAttribute("aria-label", text("delete_label", display))
    row.title.setAttribute("aria-label", text("name") + ": " + display)
    row.color.setAttribute("aria-label", text("color") + ": " + display)
    row.form.setAttribute("aria-busy", String(state.busy))
    row.title.readOnly = state.busy
    row.color.disabled = state.busy
    row.save.setAttribute("aria-disabled", String(state.busy))
    row.remove.setAttribute("aria-disabled", String(state.busy))
    row.status.setAttribute("role", state.error ? "alert" : "status")
    row.status.textContent = state.notice
  }
  function paintState(state: LabelState) {
    const row = mountedRows.get(state.label.id)
    if (row) paint(row)
  }
  function announce(state: LabelState, message: string, error = false) {
    state.notice = message
    state.error = error
    paintState(state)
  }
  function capture(row: LabelRow) {
    const state = row.state
    if (state.draftTitle === row.title.value && state.draftColor === row.color.value) return
    state.draftTitle = row.title.value
    state.draftColor = row.color.value
    state.notice = state.draftTitle !== state.label.title || state.draftColor !== state.label.hex_color ? text("unsaved") : ""
    state.error = false
  }
  function captureVisible() {
    for (const row of mountedRows.values()) capture(row)
  }
  function changed(detail: Omit<LabelChangeDetail, "source"> = {}) {
    document.dispatchEvent(new CustomEvent<LabelChangeDetail>("meitheal:labels-changed", { detail: { source: "editor", ...detail } }))
  }
  function append(label: LabelData) {
    if (removedIds.has(label.id)) return
    // POST may reuse an existing definition. Keep its draft and insertion order.
    const existing = states.get(label.id)
    if (existing) return existing
    const state: LabelState = { label, draftTitle: label.title, draftColor: label.hex_color, busy: false, notice: "", error: false }
    states.set(label.id, state)
    return state
  }
  function mount(state: LabelState) {
    const id = state.label.id
    const item = element("li", "label-settings-row")
    item.dataset.id = String(id)
    const form = element("form", "label-settings-form")
    form.dataset.labelId = String(id)
    const badgeLine = element("div", "label-settings-badge")
    const swatch = element("span", "label-settings-swatch")
    swatch.setAttribute("aria-hidden", "true")
    const badge = element("span")
    badge.dataset.badgeId = String(id)
    badge.dir = "auto"
    badgeLine.append(swatch, badge)
    const fields = element("div", "label-row-fields")
    const nameField = element("label", "label-name-field")
    const nameCaption = element("span")
    nameCaption.textContent = text("name")
    const title = element("input", "form-input label-title-edit")
    title.type = "text"
    title.required = true
    title.maxLength = 100
    title.dataset.id = String(id)
    title.dir = "auto"
    nameField.append(nameCaption, title)
    const colorField = element("label", "label-color-field")
    const colorCaption = element("span")
    colorCaption.textContent = text("color")
    const picker = element("input", "labels-color-picker label-color-edit")
    picker.type = "color"
    picker.dataset.id = String(id)
    colorField.append(colorCaption, picker)
    const actions = element("div", "label-row-actions")
    const save = element("button", "btn btn-outline")
    save.type = "submit"
    save.textContent = text("save")
    const remove = element("button", "btn btn-ghost label-delete-btn")
    remove.type = "button"
    remove.dataset.deleteLabel = String(id)
    remove.dataset.id = String(id)
    remove.textContent = text("delete")
    actions.append(save, remove)
    fields.append(nameField, colorField, actions)
    const notice = element("p", "label-row-status")
    notice.setAttribute("role", "status")
    notice.setAttribute("aria-atomic", "true")
    form.append(badgeLine, fields, notice)
    item.append(form)
    const row: LabelRow = { state, element: item, form, title, color: picker, badge, swatch, status: notice, save, remove }
    mountedRows.set(id, row)
    return row
  }
  function pagerFocus(preferred: HTMLButtonElement) {
    if (!root!.getClientRects().length) return
    const target = !pages.hidden && !preferred.disabled ? preferred
      : !pages.hidden && !previous.disabled ? previous
      : !pages.hidden && !next.disabled ? next
      : !search.disabled ? search : newTitle
    target.focus()
  }
  function project(confirmation?: HTMLElement | null, confirmationId?: number) {
    const term = search.value.trim().normalize("NFC").toLocaleLowerCase(locale)
    const matches = [...states.values()].filter(state => state.label.title.normalize("NFC").toLocaleLowerCase(locale).includes(term))
    const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE))
    page = Math.max(0, Math.min(page, pageCount - 1))
    const offset = page * PAGE_SIZE
    const visible = matches.slice(offset, offset + PAGE_SIZE)
    const visibleIds = new Set(visible.map(state => state.label.id))
    const active = document.activeElement
    const focusedRow = [...mountedRows.values()].find(row => row.element.contains(active))
    // A fast DELETE can resolve while its exact confirmation is still closing.
    const focusedId = focusedRow?.state.label.id
      ?? (confirmation?.contains(active) ? confirmationId : undefined)
    const repairFocus = focusedId !== undefined && !visibleIds.has(focusedId)
    for (const [id, row] of mountedRows) {
      if (visibleIds.has(id)) continue
      row.element.remove()
      mountedRows.delete(id)
    }
    for (const [index, state] of visible.entries()) {
      const row = mountedRows.get(state.label.id) ?? mount(state)
      if (list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] ?? null)
      paint(row)
    }
    search.disabled = !ready
    range.textContent = ready ? text("range", {
      from: number.format(matches.length ? offset + 1 : 0), to: number.format(offset + visible.length),
      matches: number.format(matches.length), total: number.format(states.size),
    }) : text(loadFailed ? "load_error" : "loading")
    pageLabel.textContent = text("page", { page: number.format(page + 1), pages: number.format(pageCount) })
    pages.hidden = matches.length <= PAGE_SIZE
    previous.disabled = page === 0
    next.disabled = page === pageCount - 1
    empty.hidden = !ready || matches.length > 0
    empty.textContent = text(states.size ? "empty_search" : "empty")
    if (repairFocus && root!.getClientRects().length) {
      const index = priorMatches.indexOf(focusedId!)
      const after = index >= 0 ? priorMatches.slice(index + 1).find(id => visibleIds.has(id)) : undefined
      const before = index >= 0 ? priorMatches.slice(0, index).reverse().find(id => visibleIds.has(id)) : undefined
      const fallbackId = after ?? before ?? visible[0]?.label.id
      const row = fallbackId === undefined ? undefined : mountedRows.get(fallbackId)
      const target = row?.title ?? (!states.size || search.disabled ? newTitle : search)
      target.focus()
    } else if ((active === previous || active === next) && (pages.hidden || (active === previous ? previous.disabled : next.disabled))) {
      pagerFocus(active === previous ? previous : next)
    }
    priorMatches = matches.map(state => state.label.id)
  }
  function removeStates(ids: number[], confirmation?: HTMLElement | null, confirmationId?: number) {
    captureVisible()
    // Tombstone the complete batch first, including records not loaded or mounted.
    for (const id of ids) removedIds.add(id)
    for (const id of ids) states.delete(id)
    project(confirmation, confirmationId)
  }
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, { method, signal, cache: "no-store", // nosemgrep
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      const code = typeof result?.errorCode === "string" ? result.errorCode : ""
      throw new Error(copy[code] ?? result?.detail ?? result?.error ?? text("failed"))
    }
    return result
  }
  async function load() {
    if (loading || signal.aborted) return
    loading = true
    loadFailed = false
    retry.hidden = true
    status.textContent = text("loading")
    captureVisible()
    project()
    try {
      const values: unknown = await request("/api/labels")
      if (signal.aborted) return
      if (!Array.isArray(values)) throw new Error(text("load_error"))
      const labels = values.map(value => readLabel(value))
      if (labels.some(label => !label)) throw new Error(text("load_error"))
      captureVisible()
      for (const label of labels) append(label!)
      ready = true
      if (status.textContent === text("loading")) status.textContent = ""
      project()
      root!.dataset.labelsReady = "true"
    } catch {
      if (signal.aborted) return
      loadFailed = true
      if (status.textContent === text("loading")) status.textContent = text("load_error")
      retry.hidden = false
      captureVisible()
      project()
    } finally { if (!signal.aborted) loading = false }
  }
  async function save(state: LabelState) {
    if (state.busy || !live(state)) return
    captureVisible()
    if (!state.draftTitle.trim()) {
      announce(state, text("invalid"), true)
      mountedRows.get(state.label.id)?.title.focus()
      return
    }
    state.busy = true
    announce(state, text("saving"))
    try {
      const result = readLabel(await request(`/api/labels/${state.label.id}`, "PUT", { title: state.draftTitle, hex_color: state.draftColor }), false)
      if (!live(state)) return
      if (!result || result.id !== state.label.id) throw new Error(text("failed"))
      // Capture BEFORE committing normalized values; old DOM must not restore them.
      captureVisible()
      state.label = result
      state.draftTitle = result.title
      state.draftColor = result.hex_color
      state.notice = text("saved")
      state.error = false
      project()
      if (!mountedRows.has(result.id)) status.textContent = text("background_saved", result.title)
      changed()
    } catch (error) {
      if (!live(state)) return
      const reason = error instanceof Error ? error.message : text("failed")
      announce(state, reason, true)
      if (!mountedRows.has(state.label.id)) status.textContent = text("background_failed", { name: state.label.title, reason })
    } finally {
      if (live(state)) { state.busy = false; paintState(state) }
    }
  }
  async function remove(state: LabelState) {
    if (state.busy || !live(state)) return
    captureVisible()
    state.busy = true
    paintState(state)
    const accepted = await confirmDialog({ title: text("delete_title"), message: text("delete_message", state.label.title),
      confirmText: text("delete"), cancelText: text("cancel"), variant: "danger", signal })
    if (!live(state)) return
    if (!accepted) { state.busy = false; paintState(state); return }
    const confirmation = document.getElementById("meitheal-confirm-overlay")
    announce(state, text("deleting"))
    try {
      const result = await request(`/api/labels/${state.label.id}`, "DELETE")
      if (!live(state)) return
      if (result?.ok !== true || result.deleted !== state.label.id) throw new Error(text("failed"))
      removeStates([state.label.id], confirmation, state.label.id)
      changed({ removed: 1, removedIds: [state.label.id] })
      showToast(text("deleted"), "success")
    } catch (error) {
      if (!live(state)) return
      const reason = error instanceof Error ? error.message : text("failed")
      announce(state, reason, true)
      if (!mountedRows.has(state.label.id)) status.textContent = reason
    } finally {
      if (live(state)) { state.busy = false; paintState(state) }
    }
  }
  async function createLabel() {
    if (creating || signal.aborted || !newTitle.value.trim()) return
    creating = true
    createButton.setAttribute("aria-disabled", "true")
    newTitle.readOnly = true
    newColor.disabled = true
    status.textContent = text("creating")
    try {
      const result = readLabel(await request("/api/labels", "POST", { title: newTitle.value, hex_color: newColor.value }), false)
      if (signal.aborted) return
      if (!result) throw new Error(text("failed"))
      if (removedIds.has(result.id)) throw new Error(text("missing"))
      captureVisible()
      const existed = states.has(result.id)
      append(result)
      newTitle.value = ""
      status.textContent = text(existed ? "exists" : "created")
      project()
      changed()
    } catch (error) {
      if (!signal.aborted) status.textContent = error instanceof Error ? error.message : text("failed")
    } finally {
      if (!signal.aborted) {
        creating = false
        createButton.setAttribute("aria-disabled", "false")
        newTitle.readOnly = false
        newColor.disabled = false
      }
    }
  }
  root.addEventListener("submit", event => {
    if (!(event.target instanceof HTMLFormElement)) return
    event.preventDefault()
    if (event.target === create) void createLabel()
    else {
      const state = states.get(Number(event.target.dataset.labelId))
      if (state) void save(state)
    }
  }, { signal })
  root.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-delete-label]") : null
    if (button) {
      const state = states.get(Number(button.dataset.deleteLabel))
      if (state) void remove(state)
    }
  }, { signal })
  const edit = (event: Event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement)) return
    const row = mountedRows.get(Number(input.dataset.id))
    if (!row || row.state.busy || (input !== row.title && input !== row.color)) return
    capture(row)
    row.status.setAttribute("role", row.state.error ? "alert" : "status")
    row.status.textContent = row.state.notice
  }
  root.addEventListener("input", edit, { signal })
  root.addEventListener("change", edit, { signal })
  search.addEventListener("input", () => {
    captureVisible()
    page = 0
    project()
  }, { signal })
  for (const [button, step] of [[previous, -1], [next, 1]] as const) {
    button.addEventListener("click", () => {
      if (button.disabled) return
      captureVisible()
      page += step
      project()
    }, { signal })
  }
  retry.addEventListener("click", () => { void load() }, { signal })
  document.addEventListener("meitheal:labels-changed", event => {
    const detail = (event as CustomEvent<LabelChangeDetail>).detail
    if (detail?.source !== "cleanup" || !Array.isArray(detail.removedIds)) return
    removeStates(detail.removedIds.filter(id => Number.isSafeInteger(id) && id > 0))
  }, { signal })
  signal.addEventListener("abort", () => {
    states.clear()
    mountedRows.clear()
    removedIds.clear()
    delete root!.dataset.labelsBooted
  }, { once: true })
  void load()
}
