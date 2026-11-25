import Sortable from "sortablejs"
import { createChecklistItem } from "@lib/checklist-items"
import { notifyInactivityTaskChanged } from "@lib/inactivity-client"
import {
  SHOPPING_UNITS,
  clampShoppingQty,
  defaultShoppingCategories,
  loadShoppingCategories,
  normalizeShoppingUnit,
  type ShoppingCategoryOption,
} from "@lib/shopping-items"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { defaultChildTaskType } from "@lib/task-editor-fields"
import { formatTicketKey, parseTicketKey } from "@lib/ticket-key"
import { showToast } from "@lib/toast"
import { createSpriteIconElement } from "../../generated/icon-registry"

type Item = { id?: string; text: string; done: boolean }
export type ModalShoppingItem = { name: string; qty: number | string; unit: string; category: string; checked: boolean }
type ShoppingMeta = { qty: number; unit: string; category: string }

function normalizeCategoryValue(raw: unknown): string {
  if (typeof raw !== "string") return ""
  return raw.trim().toLowerCase().slice(0, 48)
}

const pendingChecklistSaves = new Map<string, Promise<boolean>>()

export function pendingChecklistSave(taskId: string): Promise<boolean> | undefined {
  const ticketKey = formatTicketKey(parseTicketKey(taskId))
  return pendingChecklistSaves.get(taskId) ?? (ticketKey ? pendingChecklistSaves.get(ticketKey) : undefined)
}

function parseChecklist(raw: string | null): Item[] | null {
  if (raw === null) return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return null
    const items: Item[] = []
    for (const item of parsed) {
      if (typeof item === "string") {
        items.push({ text: item, done: false })
      } else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>
        const text = typeof rec.text === "string" ? rec.text : typeof rec.title === "string" ? rec.title : null
        if (text === null) return null
        const done = typeof rec.done === "boolean"
          ? rec.done
          : typeof rec.checked === "boolean"
            ? rec.checked
            : typeof rec.completed === "boolean"
              ? rec.completed
              : false
        items.push({
          ...(typeof rec.id === "string" && rec.id ? { id: rec.id } : {}),
          text,
          done,
        })
      } else {
        return null
      }
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

type ShoppingInputItem = {
  name?: unknown
  qty?: unknown
  quantity?: unknown
  unit?: unknown
  category?: unknown
  checked?: unknown
}

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
  const draftIds = new Set<string>()
  const persistedItems = () => items.filter(item => !item.id || !draftIds.has(item.id) || item.text.trim())
  const isShopping = options?.taskKind === "shopping_item"
  let shoppingCategories: ShoppingCategoryOption[] = defaultShoppingCategories()
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
      const nextMeta: ShoppingMeta = matchedIndex >= 0
        ? {
            qty: clampShoppingQty(entries[matchedIndex]!.qty ?? entries[matchedIndex]!.quantity),
            unit: normalizeShoppingUnit(entries[matchedIndex]!.unit),
            category: normalizeCategoryValue(entries[matchedIndex]!.category),
          }
        : getItemMeta(item) ?? prevByName.get(nameKey)?.shift() ?? { qty: 1, unit: "pcs", category: "" }
      setItemMeta(item, { ...nextMeta })
    })
  }
  reconcileShoppingMeta(items, options?.shoppingItems)

  const buildShoppingItems = (): ModalShoppingItem[] => persistedItems().map(item => {
    const meta = getItemMeta(item) ?? { qty: 1, unit: "pcs", category: "" }
    return {
      name: item.text.trim() || "Item",
      qty: meta.qty,
      unit: meta.unit || "pcs",
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

  container.classList.toggle("td-keep-list", !isShopping)
  container.classList.toggle("td-shop-list", isShopping)

  const refreshCategorySelects = () => {
    container.querySelectorAll<HTMLSelectElement>(".td-shop-cat").forEach((sel) => {
      const current = sel.value
      sel.replaceChildren(new Option("Uncategorized", ""))
      for (const cat of shoppingCategories) {
        sel.append(new Option(cat.label, cat.slug))
      }
      if (current && !shoppingCategories.some((c) => c.slug === current)) {
        sel.append(new Option(current, current))
      }
      sel.value = current
    })
  }

  if (isShopping) {
    void loadShoppingCategories(signal).then((cats) => {
      if (signal.aborted) return
      shoppingCategories = cats
      refreshCategorySelects()
    })
    window.addEventListener("meitheal:shopping-categories-changed", () => {
      void loadShoppingCategories(signal).then((cats) => {
        if (signal.aborted) return
        shoppingCategories = cats
        refreshCategorySelects()
      })
    }, { signal })
  }

  const sortable = Sortable.create(container, {
    handle: ".td-cl-drag",
    animation: 160,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 3,
    touchStartThreshold: 4,
    swapThreshold: 0.65,
    preventOnFilter: false,
    ghostClass: "nt-sortable-ghost",
    chosenClass: "nt-sortable-chosen",
    fallbackClass: "nt-sortable-fallback",
    onEnd: (evt) => {
      if (evt.oldIndex === undefined || evt.newIndex === undefined || evt.oldIndex === evt.newIndex) return
      const [moved] = items.splice(evt.oldIndex, 1)
      if (!moved) return
      items.splice(evt.newIndex, 0, moved)
      render()
      if (isShopping) emitShoppingChange()
      void save()
    },
  })
  signal.addEventListener("abort", () => sortable.destroy(), { once: true })

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

  function render(focus?: { index: number; selector: string; scrollIntoView?: boolean; highlight?: boolean }) {
    if (signal.aborted) return
    rendering = true
    const subtitleEl = document.getElementById("td-checklist-subtitle")
    if (subtitleEl) {
      subtitleEl.textContent = isShopping
        ? "Items on this shopping list — drag the grip handle to sort by aisle."
        : "Lightweight steps inside this task"
    }
    const rows = items.map((item, index) => {
      const row = document.createElement("div")
      row.className = isShopping
        ? `td-cl-row td-shop-row group${item.done ? " is-checked" : ""}`
        : `td-cl-row td-keep-row group${item.done ? " is-checked" : ""}`
      row.dataset.checklistRow = String(index)

      const dragHandle = document.createElement("button")
      dragHandle.type = "button"
      dragHandle.className = "td-cl-drag"
      dragHandle.setAttribute("aria-label", `Drag to reorder ${item.text || `item ${index + 1}`}`)
      dragHandle.title = "Drag to reorder"
      dragHandle.replaceChildren(createSpriteIconElement("grip-vertical", { size: 15 }))

      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      checkbox.className = "form-check-input td-keep-check"
      checkbox.setAttribute("aria-label", item.text || `Checklist item ${index + 1}`)
      checkbox.checked = Boolean(item.done)

      const displayName = isShopping
        ? item.text.replace(/^\d+\s*[×x]\s+/i, "").trim()
        : item.text
      const editor = document.createElement("div")
      editor.className = "checklist-editor"
      const text = document.createElement("textarea")
      text.className = "td-keep-text"
      text.rows = 1
      text.setAttribute("aria-label", isShopping ? `Shopping item ${index + 1}` : `Checklist item ${index + 1}`)
      text.placeholder = isShopping ? "Item name…" : "List item…"
      text.value = displayName
      editor.dataset.content = displayName
      editor.appendChild(text)

      const promoteBtn = document.createElement("button")
      promoteBtn.type = "button"
      promoteBtn.className = "td-cl-action opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      promoteBtn.setAttribute("aria-label", `Convert checklist item ${index + 1} to child task`)
      promoteBtn.title = "Convert to child task"
      promoteBtn.replaceChildren(createSpriteIconElement("corner-down-right", { size: 14 }))

      const delBtn = document.createElement("button")
      delBtn.type = "button"
      delBtn.className = "td-cl-del"
      delBtn.setAttribute("aria-label", `Delete checklist item ${index + 1}`)
      delBtn.title = "Delete item"
      delBtn.replaceChildren(createSpriteIconElement("x", { size: 14 }))

      const rowControls: HTMLElement[] = [dragHandle, checkbox, editor]
      if (isShopping) {
        let meta = getItemMeta(item)
        if (!meta) {
          meta = { qty: 1, unit: "pcs", category: "" }
          setItemMeta(item, meta)
        }
        const shopControls = document.createElement("div")
        shopControls.className = "td-shop-controls"

        const stepper = document.createElement("div")
        stepper.className = "nt-qty-stepper nt-qty-stepper--sm"
        stepper.setAttribute("role", "group")
        stepper.setAttribute("aria-label", `Quantity for ${item.text || `item ${index + 1}`}`)

        const decBtn = document.createElement("button")
        decBtn.type = "button"
        decBtn.className = "nt-qty-btn"
        decBtn.setAttribute("aria-label", `Decrease quantity for ${item.text || `item ${index + 1}`}`)
        decBtn.replaceChildren(createSpriteIconElement("minus", { size: 12 }))

        const qtyInput = document.createElement("input")
        qtyInput.type = "number"
        qtyInput.min = "1"
        qtyInput.max = "999"
        qtyInput.step = "1"
        qtyInput.inputMode = "numeric"
        qtyInput.value = String(meta.qty)
        qtyInput.className = "nt-qty-input"
        qtyInput.setAttribute("aria-label", `Quantity for ${item.text || `item ${index + 1}`}`)

        const incBtn = document.createElement("button")
        incBtn.type = "button"
        incBtn.className = "nt-qty-btn"
        incBtn.setAttribute("aria-label", `Increase quantity for ${item.text || `item ${index + 1}`}`)
        incBtn.replaceChildren(createSpriteIconElement("plus", { size: 12 }))

        const setQty = (val: number) => {
          const next = clampShoppingQty(val)
          qtyInput.value = String(next)
          meta!.qty = next
          emitShoppingChange()
        }
        decBtn.addEventListener("click", () => setQty(Number(qtyInput.value || 1) - 1), { signal })
        incBtn.addEventListener("click", () => setQty(Number(qtyInput.value || 1) + 1), { signal })
        qtyInput.addEventListener("change", () => setQty(Number(qtyInput.value || 1)), { signal })
        stepper.append(decBtn, qtyInput, incBtn)

        const unitSelect = document.createElement("select")
        unitSelect.className = "form-select text-xs td-shop-unit"
        unitSelect.setAttribute("aria-label", `Unit for ${displayName || `item ${index + 1}`}`)
        for (const u of SHOPPING_UNITS) {
          unitSelect.append(new Option(u.label, u.value))
        }
        unitSelect.value = normalizeShoppingUnit(meta.unit)
        unitSelect.addEventListener("change", () => {
          meta!.unit = normalizeShoppingUnit(unitSelect.value)
          emitShoppingChange()
        }, { signal })

        const catSelect = document.createElement("select")
        catSelect.className = "form-select text-xs td-shop-cat"
        catSelect.setAttribute("aria-label", `Category for ${item.text || `item ${index + 1}`}`)
        catSelect.append(new Option("Uncategorized", ""))
        for (const cat of shoppingCategories) {
          catSelect.append(new Option(cat.label, cat.slug))
        }
        if (meta.category && !shoppingCategories.some((c) => c.slug === meta!.category)) {
          catSelect.append(new Option(meta.category, meta.category))
        }
        catSelect.value = meta.category
        catSelect.addEventListener("change", () => {
          meta!.category = catSelect.value
          emitShoppingChange()
        }, { signal })

        shopControls.append(stepper, unitSelect, catSelect)
        row.append(...rowControls, delBtn, shopControls)
      } else {
        row.append(...rowControls, promoteBtn, delBtn)
      }

      text.addEventListener("input", () => { editor.dataset.content = text.value }, { signal })
      checkbox.addEventListener("change", () => {
        if (!updateItemAt(index, { done: checkbox.checked })) return
        row.classList.toggle("is-checked", checkbox.checked)
        updateProgress()
        if (isShopping) emitShoppingChange()
        void save()
      }, { signal })
      text.addEventListener("blur", () => {
        if (rendering || signal.aborted) return
        const next = text.value.trim()
        if (!items[index] || next === items[index]!.text) return
        updateItemAt(index, { text: next })
        checkbox.setAttribute("aria-label", next || "Checklist item " + (index + 1))
        textEditPending = true
        if (isShopping) emitShoppingChange()
        void save()
      }, { signal })
      text.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.isComposing) return
        event.preventDefault()
        const currentText = text.value.trim()
        if (!currentText && !items[index]?.text) return
        if (items[index] && currentText !== items[index]!.text) {
          updateItemAt(index, { text: currentText })
        }
        insertDraft(index + 1)
        void save()
      }, { signal })
      promoteBtn.addEventListener("click", async () => {
        const current = items[index]
        if (!current || promoteBtn.disabled || signal.aborted) return
        const childTitle = current.text.trim()
        if (!childTitle) return
        promoteBtn.disabled = true
        try {
          const ctx = currentTaskApiContext()
          const parentArea = (document.getElementById("td-area") as HTMLSelectElement | null)?.value || null
          const parentProject = (document.getElementById("td-project") as HTMLSelectElement | null)?.value || null
          const parentType = (document.getElementById("td-task-type") as HTMLSelectElement | null)?.value
          const res = await fetch("/api/tasks", { // nosemgrep
            method: "POST",
            headers: ctx ? taskApiHeaders(ctx, { "content-type": "application/json" }) : { "content-type": "application/json" },
            body: JSON.stringify({
              title: childTitle,
              parent_id: taskId,
              task_type: defaultChildTaskType(parentType),
              status: current.done ? "complete" : "pending",
              ...(parentArea ? { area_id: parentArea } : {}),
              ...(parentProject ? { project_id: parentProject } : {}),
            }),
            signal,
          })
          if (!res.ok) {
            const err = await res.json().catch(() => null) as { error?: string; detail?: string } | null
            showToast(err?.error ?? err?.detail ?? "Could not convert step to child task", "error")
            return
          }
          items.splice(index, 1)
          render()
          await save()
          if (signal.aborted) return
          document.dispatchEvent(new CustomEvent("meitheal:refresh-task-detail", { detail: { taskId } }))
          document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "checklist-promoted" } }))
          showToast("Converted step to child task", "success")
        } catch {
          if (!signal.aborted) showToast("Network error converting step", "error")
        } finally {
          if (!signal.aborted) promoteBtn.disabled = false
        }
      }, { signal })
      delBtn.addEventListener("click", () => {
        if (item.id) draftIds.delete(item.id)
        items.splice(index, 1)
        render({ index: Math.max(0, index - 1), selector: ".td-cl-del" })
        if (isShopping) emitShoppingChange()
        void save()
      }, { signal })
      return row
    })
    container!.replaceChildren(...rows)
    rendering = false
    updateProgress()
    if (focus) {
      const targetRow = rows[focus.index]
      if (focus.highlight && targetRow) {
        targetRow.classList.add("td-cl-row--added")
        window.setTimeout(() => targetRow.classList.remove("td-cl-row--added"), 700)
      }
      const focusTarget = targetRow?.querySelector<HTMLElement>(focus.selector) ?? add!
      if (focus.scrollIntoView && targetRow) {
        targetRow.scrollIntoView({ behavior: "smooth", block: "nearest" })
      }
      focusTarget?.focus({ preventScroll: Boolean(focus.scrollIntoView) })
    }
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
    if (equal(saved, persistedItems())) {
      textEditPending = false
      return
    }
    const pending = persist().then(savedOk => {
      if (savedOk) textEditPending = false
      return savedOk
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
      let next = persistedItems()
      while (!equal(saved, next)) {
        const pending = JSON.stringify(next)
        const ctx = currentTaskApiContext()
        const payload: Record<string, unknown> = {
          checklists: pending,
          expected_checklists: savedRaw,
        }
        if (isShopping && options?.buildShoppingCustomFields) {
          payload.custom_fields = options.buildShoppingCustomFields(buildShoppingItems())
        }
        const response = await write(version => fetch(path, { // nosemgrep
          method: "PUT",
          headers: ctx ? taskApiHeaders(ctx, { "content-type": "application/json" }) : { "content-type": "application/json" },
          body: JSON.stringify(version === null ? payload : { ...payload, updated_at: version }),
          signal: AbortSignal.timeout(10_000),
        }))
        if (response.ok) {
          notifyInactivityTaskChanged(taskId)
          savedRaw = pending
          saved = JSON.parse(pending) as Item[]
          for (const item of saved) {
            if (item.id) draftIds.delete(item.id)
          }
          next = persistedItems()
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
        next = persistedItems()
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

  function insertDraft(index: number, scrollIntoView = false) {
    const newItem = createChecklistItem("")
    draftIds.add(newItem.id)
    if (isShopping) setItemMeta(newItem, { qty: 1, unit: "pcs", category: "" })
    items.splice(index, 0, newItem)
    render({ index, selector: "textarea", scrollIntoView, highlight: scrollIntoView })
  }

  add.addEventListener("click", () => {
    insertDraft(items.length, true)
  }, { signal })
  uncheckAll?.addEventListener("click", () => {
    if (!items.some(item => item.done)) return
    items.forEach((_, idx) => updateItemAt(idx, { done: false }))
    render()
    if (isShopping) emitShoppingChange()
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
