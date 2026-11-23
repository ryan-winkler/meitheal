import { SHOPPING_CATEGORIES, type ShoppingCategory } from "@meitheal/domain-tasks"
import { createChecklistItem } from "@lib/checklist-items"
import { notifyInactivityTaskChanged } from "@lib/inactivity-client"
import { formatTicketKey, parseTicketKey } from "@lib/ticket-key"
import { createSpriteIconElement } from "../../generated/icon-registry"

type Item = { id?: string; text: string; done: boolean }
export type ModalShoppingItem = { name: string; qty: number | string; category: string; checked: boolean }
type ShoppingMeta = { qty: number | string; category: string }

const formatCategoryLabel = (cat: string) =>
  cat === "meat" ? "Meat & Fish" : cat[0]!.toUpperCase() + cat.slice(1)

function normalizeQtyValue(raw: unknown): number | string {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed) return trimmed.slice(0, 32)
  }
  return 1
}

function normalizeCategoryValue(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const cat = raw.trim().toLowerCase()
  return (SHOPPING_CATEGORIES as readonly string[]).includes(cat) ? cat : ""
}

const pendingChecklistSaves = new Map<string, Promise<boolean>>()

export function pendingChecklistSave(taskId: string): Promise<boolean> | undefined {
  const ticketKey = formatTicketKey(parseTicketKey(taskId))
  return pendingChecklistSaves.get(taskId) ?? (ticketKey ? pendingChecklistSaves.get(ticketKey) : undefined)
}

function parseChecklist(raw: string | null): Item[] | null {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const items: Item[] = []
    for (const item of parsed) {
      if (typeof item === "string") items.push({ text: item, done: false })
      else if (item && typeof item.text === "string" && typeof item.done === "boolean") items.push(item)
      else return null
    }
    return items
  } catch {
    return null
  }
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function indexed(items: Item[]): Map<string, Item> | null {
  const result = new Map<string, Item>()
  for (const item of items) {
    if (typeof item.id !== "string" || !item.id || result.has(item.id)) return null
    result.set(item.id, item)
  }
  return result
}

function rebaseChecklist(before: Item[], proposed: Item[], latest: Item[]): Item[] | null {
  if (equal(proposed, latest)) return latest

  // An append leaves the old rows untouched, even when they have no stable IDs.
  if (before.every((item, index) => equal(item, proposed[index]))) {
    const additions = proposed.slice(before.length)
    if (!indexed(additions)) return null
    const appended = []
    for (const item of additions) {
      const matches = latest.filter(current => current.id === item.id)
      if (matches.length > 1 || (matches.length === 1 && !equal(matches[0], item))) return null
      if (!matches.length) appended.push(item)
    }
    return [...latest, ...appended]
  }

  const original = indexed(before)
  const draft = indexed(proposed)
  const current = indexed(latest)
  if (!original || !draft || !current) return null
  for (const [id, item] of original) {
    const desired = draft.get(id)
    if (equal(item, desired) || equal(current.get(id), desired)) continue
    if (!equal(current.get(id), item)) return null
    if (desired) current.set(id, desired)
    else current.delete(id)
  }
  for (const [id, item] of draft) {
    if (original.has(id)) continue
    if (current.has(id) && !equal(current.get(id), item)) return null
    current.set(id, item)
  }
  return [...current.values()]
}

type ShoppingInputItem = { name?: unknown; qty?: unknown; quantity?: unknown; category?: unknown; checked?: unknown }

export function showTaskChecklist(
  taskId: string,
  rawChecklist: unknown,
  signal: AbortSignal,
  write: (send: (version: number | null) => Promise<Response>) => Promise<Response>,
  ticketKey?: string,
  options?: {
    taskKind?: string | null | undefined
    shoppingItems?: ShoppingInputItem[] | null | undefined
    onShoppingItemsChange?: (items: ModalShoppingItem[]) => void
    buildShoppingCustomFields?: (items: ModalShoppingItem[]) => string
  },
) {
  const container = document.getElementById("td-checklists")
  const add = document.querySelector<HTMLButtonElement>("#td-add-checklist-item")
  const uncheckAll = document.querySelector<HTMLButtonElement>("#td-checklist-uncheck-all")
  const progress = document.getElementById("td-checklist-progress")
  const done = document.getElementById("td-checklist-done")
  const total = document.getElementById("td-checklist-total")
  const bar = document.getElementById("td-checklist-progress-bar")
  const message = document.getElementById("td-checklist-message")
  const recover = document.querySelector<HTMLButtonElement>("#td-checklist-recover")
  const recoveredDraft = document.querySelector<HTMLDetailsElement>("#td-checklist-draft")
  const draftRows = recoveredDraft?.querySelector("ol")
  if (!container || !add || !progress || !done || !total || !bar || !message ||
      !recover || !recoveredDraft || !draftRows) return

  const path = "/api/tasks/" + encodeURIComponent(taskId)
  let savedRaw = rawChecklist === null || typeof rawChecklist === "string"
    ? rawChecklist
    : JSON.stringify(rawChecklist ?? [])
  const loaded = parseChecklist(savedRaw)
  let saved = loaded ?? []
  let items = saved.slice()
  const isShopping = options?.taskKind === "shopping_item"
  const metaByItem = new WeakMap<Item, ShoppingMeta>()
  const metaById = new Map<string, ShoppingMeta>()
  const setItemMeta = (item: Item, meta: ShoppingMeta) => {
    metaByItem.set(item, meta)
    if (item.id) metaById.set(item.id, meta)
  }
  const getItemMeta = (item: Item): ShoppingMeta | undefined =>
    metaByItem.get(item) ?? (item.id ? metaById.get(item.id) : undefined)

  const reconcileShoppingMeta = (targetItems: Item[], rawList?: ShoppingInputItem[] | null) => {
    if (!isShopping) return
    const entries = Array.isArray(rawList) ? rawList : []
    const used = new Set<number>()
    const matchedIndices = targetItems.map(() => -1)
    const prevByName = new Map<string, ShoppingMeta[]>()
    for (const prev of items) {
      const existing = getItemMeta(prev)
      if (!existing) continue
      const key = prev.text.trim().toLowerCase()
      const bucket = prevByName.get(key)
      if (bucket) bucket.push(existing)
      else prevByName.set(key, [existing])
    }
    targetItems.forEach((item, index) => {
      const nameKey = item.text.trim().toLowerCase()
      const sameIdx = entries[index]
      if (sameIdx && !used.has(index) && String(sameIdx.name ?? "").trim().toLowerCase() === nameKey) {
        used.add(index)
        matchedIndices[index] = index
      }
    })
    targetItems.forEach((item, index) => {
      if (matchedIndices[index]! >= 0) return
      const nameKey = item.text.trim().toLowerCase()
      const byName = entries.findIndex((entry, idx) =>
        !used.has(idx) && String(entry.name ?? "").trim().toLowerCase() === nameKey,
      )
      if (byName >= 0) {
        used.add(byName)
        matchedIndices[index] = byName
      }
    })
    targetItems.forEach((item, index) => {
      let matchedIndex = matchedIndices[index]!
      if (matchedIndex < 0 && entries[index] && !used.has(index)) {
        used.add(index)
        matchedIndex = index
      }
      const nameKey = item.text.trim().toLowerCase()
      const nextMeta = matchedIndex >= 0
        ? {
            qty: normalizeQtyValue(entries[matchedIndex]!.qty ?? entries[matchedIndex]!.quantity),
            category: normalizeCategoryValue(entries[matchedIndex]!.category),
          }
        : getItemMeta(item) ?? prevByName.get(nameKey)?.shift() ?? { qty: 1, category: "" }
      setItemMeta(item, { ...nextMeta })
    })
  }
  reconcileShoppingMeta(items, options?.shoppingItems)

  const buildShoppingItems = (): ModalShoppingItem[] => items.map(item => {
    const meta = getItemMeta(item) ?? { qty: 1, category: "" }
    return {
      name: item.text.trim() || "Item",
      qty: meta.qty,
      category: meta.category,
      checked: Boolean(item.done),
    }
  })
  const emitShoppingChange = () => {
    if (!isShopping || !options?.onShoppingItemsChange) return
    options.onShoppingItemsChange(buildShoppingItems())
  }
  let problem: "retry" | "conflict" | null = null
  let textEditPending = false
  let rendering = false

  add.disabled = loaded === null
  recover.disabled = false
  recover.hidden = true
  recoveredDraft.hidden = true
  recoveredDraft.open = false
  draftRows.replaceChildren()
  message.textContent = add.disabled ? "This checklist could not be loaded." : ""

  function updateProgress() {
    const count = items.filter(item => item.done).length
    progress!.style.display = items.length ? "flex" : "none"
    done!.textContent = String(count)
    total!.textContent = String(items.length)
    bar!.style.width = items.length ? (count * 100 / items.length) + "%" : "0%"
    if (uncheckAll) uncheckAll.hidden = count === 0
  }

  const updateItemAt = (index: number, patch: Partial<Item>) => {
    const current = items[index]
    if (!current) return null
    const nextItem = { ...current, ...patch }
    const meta = getItemMeta(current)
    if (meta) setItemMeta(nextItem, meta)
    items[index] = nextItem
    return nextItem
  }

  function render(focus?: { index: number; selector: string }) {
    if (signal.aborted) return
    rendering = true
    const rows = items.map((item, index) => {
      const row = document.createElement("div")
      row.className = "flex items-center gap-2 group td-cl-row"
      row.dataset.checklistRow = String(index)

      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      checkbox.className = "form-checkbox h-5 w-5 bg-transparent border-border rounded"
      checkbox.setAttribute("aria-label", item.text || `Checklist item ${index + 1}`)
      checkbox.checked = Boolean(item.done)

      const editor = document.createElement("div")
      editor.className = "checklist-editor"
      const text = document.createElement("textarea")
      text.className = "form-input bg-transparent border-transparent focus:bg-(--bg-input) focus:border-(--border-focus) hover:bg-(--bg-hover)"
      text.rows = 1
      text.setAttribute("aria-label", isShopping ? `Shopping item ${index + 1}` : `Checklist item ${index + 1}`)
      text.placeholder = isShopping ? "Item name..." : "Checklist item..."
      text.value = item.text
      editor.dataset.content = item.text
      editor.appendChild(text)

      const rowControls: HTMLElement[] = [checkbox, editor]
      if (isShopping) {
        let meta = getItemMeta(item)
        if (!meta) {
          meta = { qty: 1, category: "" }
          setItemMeta(item, meta)
        }
        const qtyInput = document.createElement("input")
        qtyInput.type = "text"
        qtyInput.maxLength = 32
        qtyInput.value = String(meta.qty)
        qtyInput.className = "form-input text-xs td-shop-qty"
        qtyInput.setAttribute("aria-label", `Quantity for ${item.text || `item ${index + 1}`}`)
        qtyInput.addEventListener("change", () => {
          const trimmed = qtyInput.value.trim().slice(0, 32)
          const nextQty: number | string = !trimmed
            ? 1
            : /^[1-9]\d{0,2}$/.test(trimmed)
              ? Number(trimmed)
              : trimmed
          qtyInput.value = String(nextQty)
          meta.qty = nextQty
          emitShoppingChange()
        }, { signal })

        const catSelect = document.createElement("select")
        catSelect.className = "form-select text-xs td-shop-cat"
        catSelect.setAttribute("aria-label", `Category for ${item.text || `item ${index + 1}`}`)
        catSelect.append(
          new Option("Uncategorized", ""),
          ...SHOPPING_CATEGORIES.map(cat => new Option(formatCategoryLabel(cat), cat)),
        )
        catSelect.value = meta.category
        catSelect.addEventListener("change", () => {
          meta.category = catSelect.value
          emitShoppingChange()
        }, { signal })

        rowControls.push(qtyInput, catSelect)
      }

      const delBtn = document.createElement("button")
      delBtn.type = "button"
      delBtn.className = "text-danger td-cl-del"
      delBtn.setAttribute("aria-label", `Delete checklist item ${index + 1}`)
      delBtn.title = "Delete item"
      delBtn.replaceChildren(createSpriteIconElement("x", { size: 14 }))

      row.append(...rowControls, delBtn)
      text.addEventListener("input", () => { editor.dataset.content = text.value }, { signal })
      checkbox.addEventListener("change", () => {
        if (!updateItemAt(index, { done: checkbox.checked })) return
        updateProgress()
        void save()
      }, { signal })
      text.addEventListener("blur", () => {
        if (rendering || signal.aborted) return
        const next = text.value.trim()
        if (!items[index] || next === items[index]!.text) return
        updateItemAt(index, { text: next })
        checkbox.setAttribute("aria-label", next || "Checklist item " + (index + 1))
        textEditPending = true
        void save()
      }, { signal })
      text.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.isComposing) return
        event.preventDefault()
        text.blur()
      }, { signal })
      delBtn.addEventListener("click", () => {
        items.splice(index, 1)
        render({ index: Math.min(index, items.length - 1), selector: "button" })
        void save()
      }, { signal })
      return row
    })
    container!.replaceChildren(...rows)
    rendering = false
    updateProgress()
    if (focus) (rows[focus.index]?.querySelector<HTMLElement>(focus.selector) ?? add!)?.focus()
  }

  function report(kind: "retry" | "conflict") {
    if (signal.aborted) return
    problem = kind
    message!.textContent = kind === "conflict"
      ? "This checklist changed elsewhere. Your draft is still shown. Load the latest checklist to review both versions."
      : "Your checklist changes could not be saved. Check your connection or permissions, then retry."
    recover!.textContent = kind === "conflict" ? "Load latest checklist" : "Retry checklist save"
    recover!.hidden = false
  }

  function save() {
    if (problem || pendingChecklistSaves.has(taskId)) return
    if (equal(saved, items)) {
      textEditPending = false
      return
    }
    const pending = persist().then(saved => {
      if (saved) textEditPending = false
      return saved
    }).finally(() => {
      pendingChecklistSaves.delete(taskId)
      if (ticketKey && pendingChecklistSaves.get(ticketKey) === pending) pendingChecklistSaves.delete(ticketKey)
    })
    pendingChecklistSaves.set(taskId, pending)
    if (ticketKey) pendingChecklistSaves.set(ticketKey, pending)
  }

  async function persist(): Promise<boolean> {
    let rebased = false
    try {
      while (!equal(saved, items)) {
        const pending = JSON.stringify(items)
        const payload: Record<string, unknown> = {
          checklists: pending,
          expected_checklists: savedRaw,
        }
        if (isShopping && options?.buildShoppingCustomFields) {
          payload.custom_fields = options.buildShoppingCustomFields(buildShoppingItems())
        }
        const response = await write(version => fetch(path, { // nosemgrep
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(version === null ? payload : { ...payload, updated_at: version }),
          signal: AbortSignal.timeout(10_000),
        }))
        if (response.ok) {
          notifyInactivityTaskChanged(taskId)
          savedRaw = pending
          saved = JSON.parse(pending) as Item[]
          continue
        }
        const conflict = response.status === 409 ? await response.json() : null
        const latestRaw = conflict?.checklists
        if (conflict?.code !== "checklist_conflict" || (latestRaw !== null && typeof latestRaw !== "string")) {
          report("retry")
          return false
        }
        if (signal.aborted) return false
        const latest = parseChecklist(latestRaw)
        const active = document.activeElement
        const row = active?.closest<HTMLElement>("[data-checklist-row]")
        const index = Number(row?.dataset.checklistRow)
        const focusedItem = items[index]
        const merged = latest && !rebased ? rebaseChecklist(saved, items, latest) : null
        if (!latest || !merged) {
          report("conflict")
          return false
        }
        let focusedIndex = focusedItem ? merged.indexOf(focusedItem) : -1
        if (focusedIndex < 0 && focusedItem?.id &&
            items.filter(item => item.id === focusedItem.id).length === 1 &&
            merged.filter(item => item.id === focusedItem.id).length === 1) {
          focusedIndex = merged.findIndex(item => item.id === focusedItem.id)
        }
        const typing = active instanceof HTMLTextAreaElement
        const selection = typing ? {
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection,
        } : null
        const typedValue = typing && focusedItem && active.value !== focusedItem.text ? active.value : undefined
        if (typedValue !== undefined && merged[focusedIndex]?.text !== focusedItem?.text) {
          report("conflict")
          return false
        }
        rebased = true
        savedRaw = latestRaw
        saved = latest
        reconcileShoppingMeta(merged)
        items = merged
        const selector = typing ? "textarea" : active instanceof HTMLInputElement ? 'input[type="checkbox"]' : "button"
        render(row ? { index: focusedIndex, selector } : undefined)
        const restored = document.activeElement
        if (typing && selection && restored instanceof HTMLTextAreaElement) {
          if (typedValue !== undefined) {
            restored.value = typedValue
            restored.parentElement!.dataset.content = typedValue
          }
          restored.setSelectionRange(selection.start, selection.end, selection.direction)
        }
      }
      return true
    } catch {
      report("retry")
      return false
    }
  }

  add.addEventListener("click", () => {
    const newItem = createChecklistItem("New Item")
    if (isShopping) setItemMeta(newItem, { qty: 1, category: "" })
    items.push(newItem)
    render({ index: items.length - 1, selector: "textarea" })
    if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.select()
    void save()
  }, { signal })
  uncheckAll?.addEventListener("click", () => {
    if (!items.some(item => item.done)) return
    items.forEach((_, idx) => updateItemAt(idx, { done: false }))
    render()
    void save()
  }, { signal })
  recover.addEventListener("click", async () => {
    if (problem === "retry") {
      problem = null
      message.textContent = ""
      recover.hidden = true
      add.focus()
      void save()
      return
    }
    recover.disabled = true
    try {
      const response = await fetch(path, { cache: "no-store", signal }) // nosemgrep
      if (!response.ok) throw new Error()
      const task = await response.json()
      const latestRaw = task.checklists
      const latest = latestRaw === null || typeof latestRaw === "string" ? parseChecklist(latestRaw) : null
      if (signal.aborted) return
      if (!latest) throw new Error()
      const editing = document.activeElement
      if (editing instanceof HTMLTextAreaElement && container.contains(editing)) editing.blur()
      draftRows.replaceChildren(...(items.length ? items : [{ text: "No items", done: false }]).map(item => {
        const entry = document.createElement("li")
        entry.textContent = item.done ? item.text + " (checked)" : item.text
        return entry
      }))
      recoveredDraft.hidden = false
      recoveredDraft.open = true
      savedRaw = latestRaw
      saved = latest
      let remoteShopping: ShoppingInputItem[] | null = null
      if (isShopping && task.custom_fields) {
        try {
          const parsedCf = typeof task.custom_fields === "string" ? JSON.parse(task.custom_fields) : task.custom_fields
          if (Array.isArray(parsedCf?.items)) remoteShopping = parsedCf.items as ShoppingInputItem[]
        } catch { /* ignore */ }
      }
      const nextItems = latest.slice()
      reconcileShoppingMeta(nextItems, remoteShopping)
      items = nextItems
      if (isShopping && options?.buildShoppingCustomFields) {
        options.buildShoppingCustomFields(buildShoppingItems())
      }
      textEditPending = false
      problem = null
      message.textContent = "Latest checklist loaded. Your unsaved draft is below."
      recover.hidden = true
      render()
      recoveredDraft.querySelector("summary")?.focus()
    } catch {
      if (!signal.aborted) message.textContent = "The latest checklist could not be loaded. Your draft is still shown. Try again."
    } finally {
      if (!signal.aborted) recover.disabled = false
    }
  }, { signal })
  render()
  return Object.assign(() => !signal.aborted && textEditPending, {
    getRaw: () => JSON.stringify(items),
  })
}
