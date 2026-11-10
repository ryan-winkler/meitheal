import { escapeHtml } from "@lib/safe-html"

type Item = { id?: string; text: string; done: boolean }

function parseChecklist(raw: string | null): Item[] | null {
  if (raw === null) return []
  try {
    const items = JSON.parse(raw) as Item[]
    return Array.isArray(items) && items.every(item =>
      item && typeof item.text === "string" && typeof item.done === "boolean") ? items : null
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

export function showTaskChecklist(taskId: string, rawChecklist: unknown, signal: AbortSignal) {
  const container = document.getElementById("td-checklists")
  const add = document.querySelector<HTMLButtonElement>("#td-add-checklist-item")
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
  let saving = false
  let problem: "retry" | "conflict" | null = null
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
  }

  function render(focus?: { index: number; selector: string }) {
    if (signal.aborted) return
    rendering = true
    const rows = items.map((item, index) => {
      const row = document.createElement("div")
      row.className = "flex items-center gap-2 group"
      row.dataset.checklistRow = String(index)
      row.innerHTML = `
        <input type="checkbox" class="form-checkbox h-4 w-4 bg-transparent border-border rounded"
          aria-label="${escapeHtml(item.text || "Checklist item " + (index + 1))}" ${item.done ? "checked" : ""} />
        <input type="text" class="form-input flex-1 text-sm bg-transparent border-transparent px-1 py-0.5 focus:bg-(--bg-input) focus:border-(--border-focus) hover:bg-(--bg-hover)"
          aria-label="Checklist item ${index + 1}" value="${escapeHtml(item.text)}" placeholder="Checklist item..." />
        <button type="button" class="text-danger opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-xs p-1"
          aria-label="Delete checklist item ${index + 1}" title="Delete item">×</button>
      `
      const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      const text = row.querySelector<HTMLInputElement>('input[type="text"]')!
      checkbox.addEventListener("change", () => {
        const current = items[index]
        if (!current) return
        items[index] = { ...current, done: checkbox.checked }
        updateProgress()
        void save()
      }, { signal })
      text.addEventListener("blur", () => {
        if (rendering || signal.aborted) return
        const current = items[index]
        const next = text.value.trim()
        if (!current || next === current.text) return
        items[index] = { ...current, text: next }
        checkbox.setAttribute("aria-label", next || "Checklist item " + (index + 1))
        void save()
      }, { signal })
      text.addEventListener("keydown", event => {
        if (event.key !== "Enter") return
        event.preventDefault()
        text.blur()
      }, { signal })
      row.querySelector("button")!.addEventListener("click", () => {
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

  async function save() {
    if (saving || problem || equal(saved, items)) return
    saving = true
    let rebased = false
    try {
      while (!equal(saved, items)) {
        const pending = JSON.stringify(items)
        const response = await fetch(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ checklists: pending, expected_checklists: savedRaw }),
        })
        if (response.ok) {
          savedRaw = pending
          saved = JSON.parse(pending) as Item[]
          continue
        }
        const conflict = response.status === 409 ? await response.json() : null
        const latestRaw = conflict?.checklists
        if (conflict?.code !== "checklist_conflict" || (latestRaw !== null && typeof latestRaw !== "string")) {
          report("retry")
          return
        }
        if (signal.aborted) return
        const latest = parseChecklist(latestRaw)
        const active = document.activeElement
        const row = active?.closest<HTMLElement>("[data-checklist-row]")
        const index = Number(row?.dataset.checklistRow)
        const focusedItem = items[index]
        const merged = latest && !rebased ? rebaseChecklist(saved, items, latest) : null
        if (!latest || !merged) {
          report("conflict")
          return
        }
        let focusedIndex = focusedItem ? merged.indexOf(focusedItem) : -1
        if (focusedIndex < 0 && focusedItem?.id &&
            items.filter(item => item.id === focusedItem.id).length === 1 &&
            merged.filter(item => item.id === focusedItem.id).length === 1) {
          focusedIndex = merged.findIndex(item => item.id === focusedItem.id)
        }
        const typing = active instanceof HTMLInputElement && active.type === "text"
        const typedValue = typing && focusedItem && active.value !== focusedItem.text ? active.value : undefined
        if (typedValue !== undefined && merged[focusedIndex]?.text !== focusedItem?.text) {
          report("conflict")
          return
        }
        rebased = true
        savedRaw = latestRaw
        saved = latest
        items = merged
        const selector = active instanceof HTMLInputElement ? `input[type="${active.type}"]` : "button"
        render(row ? { index: focusedIndex, selector } : undefined)
        const restored = document.activeElement
        if (typedValue !== undefined && typing && restored instanceof HTMLInputElement) {
          restored.value = typedValue
          restored.setSelectionRange(active.selectionStart, active.selectionEnd)
        }
      }
    } catch {
      report("retry")
    } finally {
      saving = false
    }
  }

  add.addEventListener("click", () => {
    // Ingress can also be served over local HTTP, where randomUUID is unavailable.
    const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
      byte => byte.toString(16).padStart(2, "0")).join("")
    items.push({ id, text: "New Item", done: false })
    render({ index: items.length - 1, selector: 'input[type="text"]' })
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.select()
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
      const response = await fetch(path, { cache: "no-store", signal })
      if (!response.ok) throw new Error()
      const task = await response.json()
      const latestRaw = task.checklists
      const latest = latestRaw === null || typeof latestRaw === "string" ? parseChecklist(latestRaw) : null
      if (signal.aborted) return
      if (!latest) throw new Error()
      const editing = document.activeElement
      if (editing instanceof HTMLInputElement && container.contains(editing)) editing.blur()
      draftRows.replaceChildren(...(items.length ? items : [{ text: "No items", done: false }]).map(item => {
        const entry = document.createElement("li")
        entry.textContent = item.done ? item.text + " (checked)" : item.text
        return entry
      }))
      recoveredDraft.hidden = false
      recoveredDraft.open = true
      savedRaw = latestRaw
      saved = latest
      items = latest.slice()
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
}
