import { confirmDialog } from "./confirm-dialog"
import { escapeHtml } from "./safe-html"
import { showToast } from "./toast"

interface LabelData {
  id: number
  title: string
  hex_color: string
}
interface LabelRow {
  label: LabelData
  element: HTMLLIElement
  form: HTMLFormElement
  title: HTMLInputElement
  color: HTMLInputElement
  badge: HTMLSpanElement
  swatch: HTMLSpanElement
  status: HTMLParagraphElement
  save: HTMLButtonElement
  remove: HTMLButtonElement
  busy: boolean
}
export interface LabelChangeDetail {
  source: "editor" | "cleanup"
  removed?: number
  removedIds?: number[]
}

function color(value: unknown) {
  return typeof value === "string" && /^#?[a-f0-9]{6}$/i.test(value) ? "#" + value.replace(/^#/, "") : "#6b7280"
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
  const copy = JSON.parse(root.dataset.copy ?? "{}") as Record<string, string>
  const text = (key: string, name = "") => (copy[key] ?? key).replaceAll("{name}", name)
  const list = root.querySelector<HTMLUListElement>("#labels-list")!
  const status = root.querySelector<HTMLElement>("[data-label-editor-status]")!
  const retry = root.querySelector<HTMLButtonElement>("[data-label-editor-retry]")!
  const create = root.querySelector<HTMLFormElement>("#create-label-form")!
  const newTitle = root.querySelector<HTMLInputElement>("#new-label-title")!
  const newColor = root.querySelector<HTMLInputElement>("#new-label-color")!
  const createButton = create.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const rows = new Map<number, LabelRow>()
  const removedIds = new Set<number>()
  let loading = false
  let creating = false

  function announce(row: LabelRow, message: string, error = false) {
    row.status.setAttribute("role", error ? "alert" : "status")
    row.status.textContent = message
  }
  function busy(row: LabelRow, value: boolean) {
    row.busy = value
    row.form.setAttribute("aria-busy", String(value))
    row.title.readOnly = value
    row.color.disabled = value
    row.save.setAttribute("aria-disabled", String(value))
    row.remove.setAttribute("aria-disabled", String(value))
  }
  function committed(row: LabelRow, label: LabelData) {
    row.label = label
    const display = label.title || text("untitled")
    row.badge.textContent = display
    row.swatch.style.backgroundColor = label.hex_color
    row.save.setAttribute("aria-label", text("save_label", display))
    row.remove.setAttribute("aria-label", text("delete_label", display))
    row.title.setAttribute("aria-label", text("name") + ": " + display)
    row.color.setAttribute("aria-label", text("color") + ": " + display)
  }
  function changed(detail: Omit<LabelChangeDetail, "source"> = {}) {
    document.dispatchEvent(new CustomEvent<LabelChangeDetail>("meitheal:labels-changed", { detail: { source: "editor", ...detail } }))
  }
  function removeRow(id: number, confirmation?: HTMLElement | null) {
    // A removal can arrive before a pending initial list or create response.
    removedIds.add(id)
    const row = rows.get(id)
    if (!row) return
    const ordered = [...rows.values()]
    const index = ordered.indexOf(row)
    // confirmDialog resolves before its closing overlay is removed. A fast
    // response must still repair focus if it remains in that exact dialog.
    const focus = row.element.contains(document.activeElement) || Boolean(confirmation?.contains(document.activeElement))
    const fallback = ordered[index + 1]?.title ?? ordered[index - 1]?.title ?? newTitle
    rows.delete(id)
    row.element.remove()
    if (focus) fallback.focus()
    if (!rows.size) status.textContent = text("empty")
  }
  function append(label: LabelData) {
    if (removedIds.has(label.id)) return
    // A create response can reuse an existing ID; never duplicate or repaint a dirty row.
    if (rows.has(label.id)) return rows.get(label.id)!
    const item = element("li", "label-settings-row")
    item.dataset.id = String(label.id)
    const form = element("form", "label-settings-form")
    form.dataset.labelId = String(label.id)
    const badgeLine = element("div", "label-settings-badge")
    const swatch = element("span", "label-settings-swatch")
    swatch.setAttribute("aria-hidden", "true")
    const badge = element("span")
    badge.dataset.badgeId = String(label.id)
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
    title.dataset.id = String(label.id)
    title.value = label.title
    title.dir = "auto"
    nameField.append(nameCaption, title)
    const colorField = element("label", "label-color-field")
    const colorCaption = element("span")
    colorCaption.textContent = text("color")
    const picker = element("input", "labels-color-picker label-color-edit")
    picker.type = "color"
    picker.dataset.id = String(label.id)
    picker.value = label.hex_color
    colorField.append(colorCaption, picker)
    const actions = element("div", "label-row-actions")
    const save = element("button", "btn btn-outline")
    save.type = "submit"
    save.textContent = text("save")
    const remove = element("button", "btn btn-ghost label-delete-btn")
    remove.type = "button"
    remove.dataset.deleteLabel = String(label.id)
    remove.dataset.id = String(label.id)
    remove.textContent = text("delete")
    actions.append(save, remove)
    fields.append(nameField, colorField, actions)
    const notice = element("p", "label-row-status")
    notice.setAttribute("role", "status")
    notice.setAttribute("aria-atomic", "true")
    form.append(badgeLine, fields, notice)
    item.append(form)
    const row: LabelRow = { label, element: item, form, title, color: picker, badge, swatch, status: notice, save, remove, busy: false }
    rows.set(label.id, row)
    committed(row, label)
    list.append(item)
    return row
  }
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, { method, signal, cache: "no-store",
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
    retry.hidden = true
    status.textContent = text("loading")
    try {
      const values: unknown = await request("/api/labels")
      if (signal.aborted) return
      if (!Array.isArray(values)) throw new Error(text("load_error"))
      const labels = values.map(value => readLabel(value))
      if (labels.some(label => !label)) throw new Error(text("load_error"))
      for (const label of labels) append(label!)
      status.textContent = rows.size ? "" : text("empty")
      root!.dataset.labelsReady = "true"
    } catch {
      if (signal.aborted) return
      status.textContent = text("load_error")
      retry.hidden = false
    } finally { loading = false }
  }
  async function save(row: LabelRow) {
    if (row.busy || signal.aborted) return
    if (!row.title.value.trim()) {
      announce(row, text("invalid"), true)
      row.title.focus()
      return
    }
    busy(row, true)
    announce(row, text("saving"))
    try {
      const result = readLabel(await request(`/api/labels/${row.label.id}`, "PUT", { title: row.title.value, hex_color: row.color.value }), false)
      if (signal.aborted || rows.get(row.label.id) !== row) return
      if (!result || result.id !== row.label.id) throw new Error(text("failed"))
      committed(row, result)
      row.title.value = result.title
      row.color.value = result.hex_color
      announce(row, text("saved"))
      changed()
    } catch (error) {
      if (!signal.aborted && rows.get(row.label.id) === row) announce(row, error instanceof Error ? error.message : text("failed"), true)
    } finally { if (!signal.aborted && rows.get(row.label.id) === row) busy(row, false) }
  }
  async function remove(row: LabelRow) {
    if (row.busy || signal.aborted) return
    busy(row, true)
    const accepted = await confirmDialog({ title: text("delete_title"), message: text("delete_message", escapeHtml(row.label.title)),
      confirmText: text("delete"), cancelText: text("cancel"), variant: "danger", signal })
    if (signal.aborted || rows.get(row.label.id) !== row) return
    if (!accepted) { busy(row, false); return }
    const confirmation = document.getElementById("meitheal-confirm-overlay")
    announce(row, text("deleting"))
    try {
      const result = await request(`/api/labels/${row.label.id}`, "DELETE")
      if (signal.aborted || rows.get(row.label.id) !== row) return
      if (result?.ok !== true || result.deleted !== row.label.id) throw new Error(text("failed"))
      removeRow(row.label.id, confirmation)
      changed({ removed: 1, removedIds: [row.label.id] })
      showToast(text("deleted"), "success")
    } catch (error) {
      if (!signal.aborted && rows.get(row.label.id) === row) announce(row, error instanceof Error ? error.message : text("failed"), true)
    } finally { if (!signal.aborted && rows.get(row.label.id) === row) busy(row, false) }
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
      const existed = rows.has(result.id)
      append(result)
      newTitle.value = ""
      status.textContent = text(existed ? "exists" : "created")
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
      const row = rows.get(Number(event.target.dataset.labelId))
      if (row) void save(row)
    }
  }, { signal })
  root.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-delete-label]") : null
    if (button) {
      const row = rows.get(Number(button.dataset.deleteLabel))
      if (row) void remove(row)
    }
  }, { signal })
  retry.addEventListener("click", () => { void load() }, { signal })
  document.addEventListener("meitheal:labels-changed", event => {
    const detail = (event as CustomEvent<LabelChangeDetail>).detail
    if (detail?.source !== "cleanup" || !Array.isArray(detail.removedIds)) return
    for (const id of detail.removedIds) if (Number.isSafeInteger(id) && id > 0) removeRow(id)
  }, { signal })
  signal.addEventListener("abort", () => {
    rows.clear()
    removedIds.clear()
    delete root!.dataset.labelsBooted
  }, { once: true })
  void load()
}
