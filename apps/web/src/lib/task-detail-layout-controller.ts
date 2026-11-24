import {
  hasPersonalTaskDetailLayout,
  normalizeTaskDetailLayoutConfig,
  readPersonalTaskDetailLayout,
  readServerTaskDetailLayoutFromJson,
  resetTaskDetailLayout,
  resolveEffectiveTaskDetailLayout,
  savePersonalTaskDetailLayout,
  taskDetailLayoutChange,
  taskDetailLayoutKey,
  taskDetailServerSettingKey,
  type TaskDetailLayoutConfig,
} from "@lib/task-detail-layout"
import { mountInlineRename } from "@lib/inline-rename"
import { createTablerSvgElement, type TablerIconName } from "@lib/tabler-svg"
import { showToast } from "@lib/toast"

function layoutItems(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-layout-item]"))
}

function applyOrder(list: HTMLElement, order: readonly string[]): void {
  const items = layoutItems(list)
  const byId = new Map(items.map(item => [item.dataset.layoutItem, item]))
  const focus = document.activeElement
  let next: HTMLElement | null = items[0] ?? null

  for (const id of order) {
    const item = byId.get(id)
    if (!item) continue
    if (item !== next) {
      if (typeof list.moveBefore === "function") list.moveBefore(item, next)
      else list.insertBefore(item, next)
    }
    next = item.nextElementSibling as HTMLElement | null
  }

  if (focus instanceof HTMLElement && list.contains(focus) && focus !== document.activeElement) {
    focus.focus({ preventScroll: true })
  }
}

function observeOrder(update: () => void, signal: AbortSignal): void {
  window.addEventListener(taskDetailLayoutChange, update, { signal })
  window.addEventListener("storage", event => {
    if (event.key === taskDetailLayoutKey || event.key === null) update()
  }, { signal })
}

function getTicketLabelEl(item: HTMLElement, isSection: boolean): HTMLElement | null {
  return isSection
    ? item.querySelector<HTMLElement>(":scope > .td-section__summary > span")
    : item.querySelector<HTMLElement>("[data-layout-field-label], :scope > label:not(:has(input,select,textarea))")
}

export function initTicketSectionOrder(sections: HTMLElement, signal: AbortSignal): () => void {
  const lists = [sections, ...sections.querySelectorAll<HTMLElement>("[data-layout-order]")]
  const apply = () => {
    const serverDefault = readServerTaskDetailLayoutFromJson(sections.dataset.serverLayout)
    const config = resolveEffectiveTaskDetailLayout(readPersonalTaskDetailLayout(), serverDefault)
    for (const list of lists) {
      const group = list.dataset.layoutOrder ?? ""
      applyOrder(list, config.orders[group] ?? [])
      const hidden = new Set(config.hidden[group] ?? [])
      const isSection = group === "sections"
      for (const item of layoutItems(list)) {
        const id = item.dataset.layoutItem ?? ""
        item.hidden = hidden.has(id) || (item.dataset.haAreaField === "edit" && !item.dataset.haAreaEndpoint)
        const labelEl = getTicketLabelEl(item, isSection)
        if (labelEl) {
          if (labelEl.dataset.defaultLabel === undefined) {
            labelEl.dataset.defaultLabel = labelEl.textContent?.trim() ?? ""
          }
          labelEl.textContent = config.labels[id] ?? labelEl.dataset.defaultLabel
        }
      }
    }
  }
  let deferred = false
  observeOrder(() => {
    deferred = sections.contains(document.activeElement)
    if (!deferred) apply()
  }, signal)
  sections.addEventListener("focusout", () => {
    if (!deferred) return
    queueMicrotask(() => {
      if (signal.aborted || sections.contains(document.activeElement)) return
      deferred = false
      apply()
    })
  }, { signal })
  return apply
}

type LayoutSection = {
  id: string
  label: string
  icon?: string
  fields?: [id: string, label: string][]
}

function populateLayoutEditor(root: HTMLElement): void {
  const list = root.querySelector<HTMLOListElement>('[data-layout-order="sections"]')
  const row = root.querySelector<HTMLTemplateElement>("template[data-layout-row]")?.content.firstElementChild
  const fields = root.querySelector<HTMLTemplateElement>("template[data-layout-fields]")?.content.firstElementChild
  if (!list || !row || !fields || list.childElementCount) return

  const sections: LayoutSection[] = JSON.parse(root.dataset.layoutSections ?? "[]")

  function createRow(id: string, label: string, icon?: string): HTMLLIElement {
    const item = row!.cloneNode(true) as HTMLLIElement
    item.dataset.layoutItem = id
    item.dataset.defaultLabel = label
    const iconSlot = item.querySelector<HTMLElement>("[data-layout-icon]")
    if (iconSlot) {
      if (icon) iconSlot.replaceChildren(createTablerSvgElement(icon as TablerIconName, 16))
      else iconSlot.remove()
    }
    item.querySelector("[data-layout-label]")!.textContent = label
    const renameBtn = item.querySelector<HTMLButtonElement>("[data-layout-rename]")
    if (renameBtn) {
      renameBtn.title = `Rename · ${label}`
      renameBtn.setAttribute("aria-label", renameBtn.title)
    }
    for (const [direction, action] of [["up", root.dataset.layoutMoveUp], ["down", root.dataset.layoutMoveDown]]) {
      const button = item.querySelector<HTMLButtonElement>(`[data-layout-move="${direction}"]`)!
      button.title = `${action} · ${label}`
      button.setAttribute("aria-label", button.title)
    }
    return item
  }

  const items = document.createDocumentFragment()
  for (const section of sections) {
    const item = createRow(section.id, section.label, section.icon)
    if (section.fields) {
      const disclosure = fields.cloneNode(true) as HTMLDetailsElement
      const titleEl = disclosure.querySelector("[data-layout-fields-title]")
      if (titleEl) titleEl.textContent = `${root.dataset.layoutFieldsLabel} · ${section.label}`
      const fieldList = disclosure.querySelector("ol")!
      fieldList.dataset.layoutOrder = section.id
      fieldList.setAttribute("aria-label", section.label)
      fieldList.append(...section.fields.map(([id, label]) => createRow(id, label)))
      item.append(disclosure)
    }
    items.append(item)
  }
  list.append(items)
}

export function initTaskDetailLayoutEditor(root: HTMLElement, signal: AbortSignal): void {
  populateLayoutEditor(root)
  const lists = Array.from(root.querySelectorAll<HTMLElement>("[data-layout-order]"))
  const status = root.querySelector<HTMLElement>("[data-layout-status]")
  const error = root.querySelector<HTMLElement>("[data-layout-error]")
  const saveBtn = root.querySelector<HTMLButtonElement>("[data-layout-save]")
  const scopeBadge = root.querySelector<HTMLElement>("[data-layout-scope-badge]")

  let draft = resolveEffectiveTaskDetailLayout(
    readPersonalTaskDetailLayout(),
    readServerTaskDetailLayoutFromJson(root.dataset.serverLayout),
  )

  let dragging = false
  let saving = false

  function showError(message: string | undefined): void {
    if (!error) return
    error.textContent = message ?? ""
    error.hidden = !message
    if (message && status) status.textContent = message
  }

  function updateScopeBadge(): void {
    if (scopeBadge) {
      scopeBadge.textContent = hasPersonalTaskDetailLayout() ? "Personal browser override" : "Using server default"
    }
  }

  function renderConfig(config: TaskDetailLayoutConfig): void {
    if (dragging) return
    for (const list of lists) {
      const group = list.dataset.layoutOrder ?? ""
      applyOrder(list, config.orders[group] ?? [])
      const hidden = new Set(config.hidden[group] ?? [])
      const items = layoutItems(list)
      let visibleCount = 0
      for (const [index, item] of items.entries()) {
        const id = item.dataset.layoutItem ?? ""
        const defaultLabel = item.dataset.defaultLabel ?? id
        const displayLabel = config.labels[id] ?? defaultLabel
        const isHidden = hidden.has(id)
        if (!isHidden) visibleCount += 1

        item.classList.toggle("is-hidden", isHidden)
        const labelEl = item.querySelector<HTMLElement>(":scope > .td-layout-editor__row > [data-layout-label]")
        if (labelEl && !labelEl.querySelector("input")) labelEl.textContent = displayLabel

        const visBtn = item.querySelector<HTMLButtonElement>(":scope > .td-layout-editor__row [data-layout-toggle-vis]")
        if (visBtn) {
          visBtn.setAttribute("aria-pressed", String(isHidden))
          visBtn.title = `${isHidden ? "Show" : "Hide"} · ${displayLabel}`
          visBtn.setAttribute("aria-label", visBtn.title)
        }
        item.querySelector(':scope > .td-layout-editor__row [data-layout-move="up"]')?.setAttribute("aria-disabled", String(index === 0))
        item.querySelector(':scope > .td-layout-editor__row [data-layout-move="down"]')?.setAttribute("aria-disabled", String(index === items.length - 1))
      }
      if (group !== "sections") {
        const countEl = list.closest("details")?.querySelector<HTMLElement>("[data-layout-fields-count]")
        if (countEl) countEl.textContent = `${visibleCount}/${items.length} visible`
      }
    }
    updateScopeBadge()
  }

  function syncFromStorage(): void {
    draft = resolveEffectiveTaskDetailLayout(
      readPersonalTaskDetailLayout(),
      readServerTaskDetailLayoutFromJson(root.dataset.serverLayout),
    )
    renderConfig(draft)
  }

  function commitDraft(announce?: string): void {
    draft = normalizeTaskDetailLayoutConfig(draft)
    try {
      savePersonalTaskDetailLayout(draft)
      showError(undefined)
      if (announce && status) status.textContent = announce
    } catch {
      syncFromStorage()
      showError(root.dataset.saveFailed)
    }
  }

  function formatMoved(id: string, defaultLabel: string | undefined, position: number, total: number): string {
    const label = draft.labels[id] ?? defaultLabel ?? id
    return (root.dataset.moved ?? "")
      .replace("{item}", label)
      .replace("{position}", String(position))
      .replace("{total}", String(total))
  }

  function startInlineRename(item: HTMLElement): void {
    const id = item.dataset.layoutItem
    const labelEl = item.querySelector<HTMLElement>(":scope > .td-layout-editor__row > [data-layout-label]")
    if (!id || !labelEl || labelEl.querySelector("input")) return
    const defaultLabel = item.dataset.defaultLabel ?? id
    mountInlineRename({
      labelEl,
      value: draft.labels[id] ?? defaultLabel,
      placeholder: defaultLabel,
      maxLength: 60,
      className: "td-layout-editor__rename-input",
      signal,
      onCommit: raw => {
        const cleaned = raw.trim().slice(0, 60)
        if (!cleaned || cleaned === defaultLabel) delete draft.labels[id]
        else draft.labels[id] = cleaned
        labelEl.replaceChildren(document.createTextNode(draft.labels[id] ?? defaultLabel))
        commitDraft()
      },
      onCancel: () => labelEl.replaceChildren(document.createTextNode(draft.labels[id] ?? defaultLabel)),
    })
  }

  root.addEventListener("click", async (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>("button")
    if (!button) return

    if (button.hasAttribute("data-layout-save")) {
      if (saving) return
      saving = true
      if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.add("btn-loading") }
      try {
        const serialized = JSON.stringify(normalizeTaskDetailLayoutConfig(draft))
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: taskDetailServerSettingKey, value: serialized }),
        })
        if (!res.ok) throw new Error("Save failed")
        root.dataset.serverLayout = serialized
        renderConfig(draft)
        showError(undefined)
        showToast("Server-wide Task Detail default saved.")
      } catch {
        showError(root.dataset.saveFailed ?? "Could not save server-wide layout.")
      } finally {
        saving = false
        if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove("btn-loading") }
      }
      return
    }

    if (button.hasAttribute("data-layout-reset")) {
      try {
        resetTaskDetailLayout()
        showError(undefined)
        if (status) status.textContent = root.dataset.reset ?? ""
      } catch {
        showError(root.dataset.saveFailed)
      }
      return
    }

    const item = button.closest<HTMLElement>("[data-layout-item]")
    const list = item?.parentElement
    const group = list?.dataset.layoutOrder
    const id = item?.dataset.layoutItem
    if (!item || !list || !group || !id) return

    if (button.hasAttribute("data-layout-rename")) {
      startInlineRename(item)
      return
    }

    if (button.hasAttribute("data-layout-toggle-vis")) {
      const currentHidden = new Set(draft.hidden[group] ?? [])
      if (currentHidden.has(id)) currentHidden.delete(id)
      else currentHidden.add(id)
      if (currentHidden.size > 0) draft.hidden[group] = [...currentHidden]
      else delete draft.hidden[group]
      commitDraft()
      return
    }

    const direction = button.dataset.layoutMove
    if (!direction || button.getAttribute("aria-disabled") === "true" || dragging) return
    const items = layoutItems(list)
    const index = items.indexOf(item)
    items.splice(index, 1)
    items.splice(index + (direction === "up" ? -1 : 1), 0, item)
    draft.orders[group] = items.map((row) => row.dataset.layoutItem ?? "")
    commitDraft(formatMoved(id, item.dataset.defaultLabel, items.indexOf(item) + 1, items.length))
    button.scrollIntoView({ block: "nearest" })
  }, { signal })

  observeOrder(syncFromStorage, signal)
  renderConfig(draft)

  void import("./list-drag-reorder").then(({ attachVerticalListDragReorder }) => {
    if (signal.aborted) return
    for (const list of lists) {
      attachVerticalListDragReorder(list, {
        handle: "[data-layout-handle]",
        item: "[data-layout-item]",
        ghostClass: "td-layout-editor__ghost",
        signal,
        onStart: () => { dragging = true },
        onEnd: ({ item, oldIndex, newIndex }) => {
          dragging = false
          if (oldIndex === newIndex) { renderConfig(draft); return }
          const group = list.dataset.layoutOrder
          if (!group) return
          const items = layoutItems(list)
          draft.orders[group] = items.map((row) => row.dataset.layoutItem ?? "")
          const id = item.dataset.layoutItem ?? ""
          commitDraft(formatMoved(id, item.dataset.defaultLabel, items.indexOf(item) + 1, items.length))
        },
      })
    }
    root.dataset.dragReady = "true"
  }).catch(() => { if (!signal.aborted) showError(root.dataset.dragFailed) })
}
