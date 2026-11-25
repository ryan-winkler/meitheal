import {
  createDefaultEntityFormLayoutConfig,
  createDefaultTaskDetailBaseConfigForKind,
  hasCuratedTaskKindDefault,
  hasPersonalTaskDetailLayout,
  isEntityFormLayoutScope,
  isTaskKindLayoutScope,
  normalizeEntityFormLayoutConfig,
  normalizeTaskDetailLayoutConfig,
  readPersonalTaskDetailLayout,
  readServerTaskDetailLayoutFromJson,
  resetTaskDetailLayout,
  resolveEffectiveEntityFormLayout,
  resolveEffectiveTaskDetailLayout,
  resolveEffectiveTaskDetailLayoutForKind,
  savePersonalTaskDetailLayout,
  taskDetailLayoutChange,
  taskDetailLayoutKey,
  taskDetailServerSettingKey,
  type EntityFormLayoutConfig,
  type EntityFormLayoutScope,
  type LayoutEditorScope,
  type TaskDetailLayoutBaseConfig,
  type TaskDetailLayoutConfig,
} from "@lib/task-detail-layout"
import { mountInlineRename } from "@lib/inline-rename"
import { createTablerSvgElement, type TablerIconName } from "@lib/tabler-svg"
import { showToast } from "@lib/toast"

function layoutItems(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-layout-item]"))
}

function applyOrder(list: HTMLElement, order: readonly string[], attrName: "layoutItem" | "entityField" = "layoutItem"): void {
  const items = attrName === "layoutItem"
    ? layoutItems(list)
    : Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-entity-field]"))
  const byId = new Map(items.map(item => [item.dataset[attrName], item]))
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

// A field label can wrap its control, so read and write only the label's own text.
function labelTextNode(labelEl: HTMLElement): Text | undefined {
  return [...labelEl.childNodes].find((node): node is Text => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))
}

function setLabelText(labelEl: HTMLElement, text: string): void {
  if (labelEl.childElementCount === 0) labelEl.textContent = text
  else {
    const node = labelTextNode(labelEl)
    if (node) node.textContent = text
    else labelEl.prepend(text)
  }
}

export function initTicketSectionOrder(sections: HTMLElement, signal: AbortSignal): () => void {
  const lists = [sections, ...sections.querySelectorAll<HTMLElement>("[data-layout-order]")]
  const apply = () => {
    const serverDefault = readServerTaskDetailLayoutFromJson(sections.dataset.serverLayout)
    const taskKind = sections.dataset.taskKind || null
    const config = resolveEffectiveTaskDetailLayoutForKind(readPersonalTaskDetailLayout(), serverDefault, taskKind)
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
            labelEl.dataset.defaultLabel = (labelEl.childElementCount ? labelTextNode(labelEl)?.textContent : labelEl.textContent)?.trim() ?? ""
          }
          setLabelText(labelEl, config.labels[id] ?? labelEl.dataset.defaultLabel)
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

/**
 * Apply customized field ordering, visibility, and label overrides to an Entity Form
 * (Routine Form, Pillar Form, or Goal Form).
 */
export function initEntityFormLayout(
  container: HTMLElement,
  formScope: EntityFormLayoutScope,
  signal: AbortSignal,
  serverDefaultJson?: string | null,
): () => void {
  const apply = () => {
    const serverDefault = readServerTaskDetailLayoutFromJson(serverDefaultJson ?? container.dataset.serverLayout)
    const config = resolveEffectiveEntityFormLayout(readPersonalTaskDetailLayout(), serverDefault, formScope)
    const hidden = new Set(config.hidden)

    const fields = Array.from(container.querySelectorAll<HTMLElement>("[data-entity-field]"))
    const parents = new Set<HTMLElement>()
    for (const field of fields) {
      if (field.parentElement) parents.add(field.parentElement)
    }
    for (const parent of parents) {
      applyOrder(parent, config.order, "entityField")
    }

    for (const field of fields) {
      const id = field.dataset.entityField ?? ""
      if (!id) continue
      field.hidden = hidden.has(id)
      const labelEl = field.querySelector<HTMLElement>("[data-entity-field-label]") ?? field.querySelector<HTMLElement>(":scope > label")
      if (labelEl) {
        if (labelEl.dataset.defaultLabel === undefined) {
          labelEl.dataset.defaultLabel = (labelEl.childElementCount ? labelTextNode(labelEl)?.textContent : labelEl.textContent)?.trim() ?? ""
        }
        setLabelText(labelEl, config.labels[id] ?? labelEl.dataset.defaultLabel)
      }
    }
  }

  observeOrder(() => {
    if (!container.contains(document.activeElement)) apply()
  }, signal)
  apply()
  return apply
}

type LayoutSection = {
  id: string
  label: string
  icon?: string
  fields?: [id: string, label: string][]
}

type EntityFormMeta = {
  id: EntityFormLayoutScope
  label: string
  icon?: string
  fields: [id: string, label: string][]
}

function createEditorRow(
  root: HTMLElement,
  rowTemplate: Element,
  id: string,
  label: string,
  icon?: string,
): HTMLLIElement {
  const item = rowTemplate.cloneNode(true) as HTMLLIElement
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

function populateLayoutEditor(root: HTMLElement): void {
  const list = root.querySelector<HTMLOListElement>('[data-layout-order="sections"]')
  const row = root.querySelector<HTMLTemplateElement>("template[data-layout-row]")?.content.firstElementChild
  const fields = root.querySelector<HTMLTemplateElement>("template[data-layout-fields]")?.content.firstElementChild
  if (!list || !row || !fields || list.childElementCount) return

  const sections: LayoutSection[] = JSON.parse(root.dataset.layoutSections ?? "[]")

  const items = document.createDocumentFragment()
  for (const section of sections) {
    const item = createEditorRow(root, row, section.id, section.label, section.icon)
    if (section.fields) {
      const disclosure = fields.cloneNode(true) as HTMLDetailsElement
      const titleEl = disclosure.querySelector("[data-layout-fields-title]")
      if (titleEl) titleEl.textContent = `${root.dataset.layoutFieldsLabel} · ${section.label}`
      const fieldList = disclosure.querySelector("ol")!
      fieldList.dataset.layoutOrder = section.id
      fieldList.setAttribute("aria-label", section.label)
      fieldList.append(...section.fields.map(([id, label]) => createEditorRow(root, row, id, label)))
      item.append(disclosure)
    }
    items.append(item)
  }
  list.append(items)
}

function cloneBaseConfig(base: TaskDetailLayoutBaseConfig): TaskDetailLayoutBaseConfig {
  return {
    orders: Object.fromEntries(Object.entries(base.orders).map(([k, v]) => [k, [...v]])),
    hidden: Object.fromEntries(Object.entries(base.hidden).map(([k, v]) => [k, [...v]])),
    labels: { ...base.labels },
  }
}

export function initTaskDetailLayoutEditor(root: HTMLElement, signal: AbortSignal): void {
  populateLayoutEditor(root)
  const sectionsList = root.querySelector<HTMLOListElement>('[data-layout-order="sections"]')
  const entityList = root.querySelector<HTMLOListElement>("[data-layout-entity-list]")
  const rowTemplate = root.querySelector<HTMLTemplateElement>("template[data-layout-row]")?.content.firstElementChild
  const lists = Array.from(root.querySelectorAll<HTMLElement>("[data-layout-order]"))
  const status = root.querySelector<HTMLElement>("[data-layout-status]")
  const error = root.querySelector<HTMLElement>("[data-layout-error]")
  const saveBtn = root.querySelector<HTMLButtonElement>("[data-layout-save]")
  const resetScopeBtn = root.querySelector<HTMLButtonElement>("[data-layout-reset-scope]")
  const scopeBadge = root.querySelector<HTMLElement>("[data-layout-scope-badge]")
  const activeHint = root.querySelector<HTMLElement>("[data-layout-active-hint]")
  const scopeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-layout-target]"))

  const entityForms: EntityFormMeta[] = JSON.parse(root.dataset.entityForms ?? "[]")
  const entityFormsById = new Map<EntityFormLayoutScope, EntityFormMeta>(entityForms.map(f => [f.id, f]))
  const defaultHintText = activeHint?.textContent ?? ""

  let activeScope: LayoutEditorScope = "default"
  let draft: TaskDetailLayoutConfig = resolveEffectiveTaskDetailLayout(
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

  function activeTaskConfig(): TaskDetailLayoutBaseConfig {
    if (isTaskKindLayoutScope(activeScope)) {
      if (draft.kinds?.[activeScope]) return draft.kinds[activeScope]!
      if (hasCuratedTaskKindDefault(activeScope)) {
        return createDefaultTaskDetailBaseConfigForKind(activeScope)
      }
      return draft
    }
    return draft
  }

  function ensureMutableTaskConfig(): TaskDetailLayoutBaseConfig {
    if (isTaskKindLayoutScope(activeScope)) {
      draft.kinds ??= {}
      if (!draft.kinds[activeScope]) {
        const base = hasCuratedTaskKindDefault(activeScope)
          ? createDefaultTaskDetailBaseConfigForKind(activeScope)
          : draft
        draft.kinds[activeScope] = cloneBaseConfig(base)
      }
      return draft.kinds[activeScope]!
    }
    return draft
  }

  function activeEntityConfig(scope: EntityFormLayoutScope): EntityFormLayoutConfig {
    return draft.forms?.[scope] ?? createDefaultEntityFormLayoutConfig(scope)
  }

  function ensureMutableEntityConfig(scope: EntityFormLayoutScope): EntityFormLayoutConfig {
    draft.forms ??= {}
    if (!draft.forms[scope]) {
      draft.forms[scope] = createDefaultEntityFormLayoutConfig(scope)
    }
    return draft.forms[scope]!
  }

  function updateScopeChrome(): void {
    for (const btn of scopeButtons) {
      const target = btn.dataset.layoutTarget as LayoutEditorScope | undefined
      const selected = target === activeScope
      btn.classList.toggle("is-active", selected)
      btn.setAttribute("aria-selected", String(selected))

      const hasOverride = Boolean(
        target &&
          ((isTaskKindLayoutScope(target) && draft.kinds?.[target]) ||
            (isEntityFormLayoutScope(target) && draft.forms?.[target])),
      )
      btn.classList.toggle("is-customized", hasOverride)
    }

    if (scopeBadge) {
      const personal = hasPersonalTaskDetailLayout()
      if (activeScope === "default") {
        scopeBadge.textContent = personal ? "Personal browser override" : "Using server default"
      } else if (isTaskKindLayoutScope(activeScope)) {
        const hasKindOverride = Boolean(draft.kinds?.[activeScope])
        if (hasKindOverride) {
          scopeBadge.textContent = "Custom kind override"
        } else if (hasCuratedTaskKindDefault(activeScope)) {
          scopeBadge.textContent = "Curated kind default"
        } else {
          scopeBadge.textContent = "Inheriting All Tasks default"
        }
      } else {
        const hasFormOverride = Boolean(draft.forms?.[activeScope])
        scopeBadge.textContent = hasFormOverride ? "Custom form layout" : "Using default form order"
      }
    }

    if (resetScopeBtn) {
      const canResetScope =
        (isTaskKindLayoutScope(activeScope) && Boolean(draft.kinds?.[activeScope])) ||
        (isEntityFormLayoutScope(activeScope) && Boolean(draft.forms?.[activeScope]))
      resetScopeBtn.hidden = !canResetScope
    }

    if (activeHint) {
      if (isEntityFormLayoutScope(activeScope)) {
        const meta = entityFormsById.get(activeScope)
        activeHint.textContent = `Reorder, rename, or hide fields shown in the ${meta?.label ?? "entity form"}.`
      } else if (isTaskKindLayoutScope(activeScope)) {
        const activeBtn = scopeButtons.find(b => b.dataset.layoutTarget === activeScope)
        const label = activeBtn?.textContent?.trim() || activeScope
        activeHint.textContent = hasCuratedTaskKindDefault(activeScope)
          ? `Tailored default sections and fields matching the ${label} input form. Customize any section or field, or reset to restore its curated default.`
          : `Customize section and field layout specifically for ${label} tickets. Unedited standard tasks inherit "All Tasks (Default)".`
      } else {
        activeHint.textContent = defaultHintText
      }
    }
  }

  function populateEntityList(scope: EntityFormLayoutScope): void {
    if (!entityList || !rowTemplate) return
    const meta = entityFormsById.get(scope)
    if (!meta) return
    entityList.replaceChildren()
    entityList.dataset.entityScope = scope
    const frag = document.createDocumentFragment()
    for (const [id, label] of meta.fields) {
      frag.append(createEditorRow(root, rowTemplate, id, label))
    }
    entityList.append(frag)
  }

  function renderRowStates(
    list: HTMLElement,
    hidden: Set<string>,
    labels: Record<string, string>,
  ): { visibleCount: number; total: number } {
    const items = layoutItems(list)
    let visibleCount = 0
    for (const [index, item] of items.entries()) {
      const id = item.dataset.layoutItem ?? ""
      const defaultLabel = item.dataset.defaultLabel ?? id
      const displayLabel = labels[id] ?? defaultLabel
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
    return { visibleCount, total: items.length }
  }

  function renderActiveScope(): void {
    if (dragging) return
    const scope = activeScope
    const isEntity = isEntityFormLayoutScope(scope)
    if (sectionsList) sectionsList.hidden = isEntity
    if (entityList) entityList.hidden = !isEntity

    if (isEntity && entityList) {
      if (entityList.dataset.entityScope !== scope) {
        populateEntityList(scope)
      }
      const config = activeEntityConfig(scope)
      applyOrder(entityList, config.order)
      renderRowStates(entityList, new Set(config.hidden), config.labels)
    } else {
      const config = activeTaskConfig()
      for (const list of lists) {
        const group = list.dataset.layoutOrder ?? ""
        applyOrder(list, config.orders[group] ?? [])
        const { visibleCount, total } = renderRowStates(list, new Set(config.hidden[group] ?? []), config.labels)
        if (group !== "sections") {
          const countEl = list.closest("details")?.querySelector<HTMLElement>("[data-layout-fields-count]")
          if (countEl) countEl.textContent = `${visibleCount}/${total} visible`
        }
      }
    }

    updateScopeChrome()
  }

  function syncFromStorage(): void {
    draft = resolveEffectiveTaskDetailLayout(
      readPersonalTaskDetailLayout(),
      readServerTaskDetailLayoutFromJson(root.dataset.serverLayout),
    )
    renderActiveScope()
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

  function startInlineRename(item: HTMLElement): void {
    const id = item.dataset.layoutItem
    const labelEl = item.querySelector<HTMLElement>(":scope > .td-layout-editor__row > [data-layout-label]")
    if (!id || !labelEl || labelEl.querySelector("input")) return
    const defaultLabel = item.dataset.defaultLabel ?? id

    if (isEntityFormLayoutScope(activeScope)) {
      const scope = activeScope
      const current = activeEntityConfig(scope)
      mountInlineRename({
        labelEl,
        value: current.labels[id] ?? defaultLabel,
        placeholder: defaultLabel,
        maxLength: 60,
        className: "td-layout-editor__rename-input",
        signal,
        onCommit: raw => {
          const target = ensureMutableEntityConfig(scope)
          const cleaned = raw.trim().slice(0, 60)
          if (!cleaned || cleaned === defaultLabel) delete target.labels[id]
          else target.labels[id] = cleaned
          labelEl.replaceChildren(document.createTextNode(target.labels[id] ?? defaultLabel))
          commitDraft()
        },
        onCancel: () => labelEl.replaceChildren(document.createTextNode(activeEntityConfig(scope).labels[id] ?? defaultLabel)),
      })
      return
    }

    const current = activeTaskConfig()
    mountInlineRename({
      labelEl,
      value: current.labels[id] ?? defaultLabel,
      placeholder: defaultLabel,
      maxLength: 60,
      className: "td-layout-editor__rename-input",
      signal,
      onCommit: raw => {
        const target = ensureMutableTaskConfig()
        const cleaned = raw.trim().slice(0, 60)
        if (!cleaned || cleaned === defaultLabel) delete target.labels[id]
        else target.labels[id] = cleaned
        labelEl.replaceChildren(document.createTextNode(target.labels[id] ?? defaultLabel))
        commitDraft()
      },
      onCancel: () => labelEl.replaceChildren(document.createTextNode(activeTaskConfig().labels[id] ?? defaultLabel)),
    })
  }

  root.addEventListener("click", async (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>("button")
    if (!button) return

    const targetScope = button.dataset.layoutTarget
    if (targetScope) {
      if (targetScope === "default" || isTaskKindLayoutScope(targetScope) || isEntityFormLayoutScope(targetScope)) {
        activeScope = targetScope
        renderActiveScope()
      }
      return
    }

    if (button.hasAttribute("data-layout-reset-scope")) {
      if (isTaskKindLayoutScope(activeScope) && draft.kinds) {
        const wasCurated = hasCuratedTaskKindDefault(activeScope)
        delete draft.kinds[activeScope]
        if (Object.keys(draft.kinds).length === 0) delete draft.kinds
        commitDraft(wasCurated ? "Scope reset to curated kind default" : "Scope reset to All Tasks default")
      } else if (isEntityFormLayoutScope(activeScope) && draft.forms) {
        delete draft.forms[activeScope]
        if (Object.keys(draft.forms).length === 0) delete draft.forms
        commitDraft("Form layout reset to default")
      }
      return
    }

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
        renderActiveScope()
        showError(undefined)
        showToast("Server-wide Task & Form layout defaults saved.")
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
    const id = item?.dataset.layoutItem
    if (!item || !list || !id) return

    if (button.hasAttribute("data-layout-rename")) {
      startInlineRename(item)
      return
    }

    if (isEntityFormLayoutScope(activeScope) && list === entityList) {
      const scope = activeScope
      if (button.hasAttribute("data-layout-toggle-vis")) {
        const target = ensureMutableEntityConfig(scope)
        const currentHidden = new Set(target.hidden)
        if (currentHidden.has(id)) currentHidden.delete(id)
        else currentHidden.add(id)
        target.hidden = [...currentHidden]
        commitDraft()
        return
      }
      const direction = button.dataset.layoutMove
      if (!direction || button.getAttribute("aria-disabled") === "true" || dragging) return
      const items = layoutItems(list)
      const index = items.indexOf(item)
      items.splice(index, 1)
      items.splice(index + (direction === "up" ? -1 : 1), 0, item)
      const target = ensureMutableEntityConfig(scope)
      target.order = items.map(row => row.dataset.layoutItem ?? "")
      const label = target.labels[id] ?? item.dataset.defaultLabel ?? id
      const msg = (root.dataset.moved ?? "")
        .replace("{item}", label)
        .replace("{position}", String(items.indexOf(item) + 1))
        .replace("{total}", String(items.length))
      commitDraft(msg)
      button.scrollIntoView({ block: "nearest" })
      return
    }

    const group = list.dataset.layoutOrder
    if (!group) return

    if (button.hasAttribute("data-layout-toggle-vis")) {
      const target = ensureMutableTaskConfig()
      const currentHidden = new Set(target.hidden[group] ?? [])
      if (currentHidden.has(id)) currentHidden.delete(id)
      else currentHidden.add(id)
      if (currentHidden.size > 0) target.hidden[group] = [...currentHidden]
      else delete target.hidden[group]
      commitDraft()
      return
    }

    const direction = button.dataset.layoutMove
    if (!direction || button.getAttribute("aria-disabled") === "true" || dragging) return
    const items = layoutItems(list)
    const index = items.indexOf(item)
    items.splice(index, 1)
    items.splice(index + (direction === "up" ? -1 : 1), 0, item)
    const target = ensureMutableTaskConfig()
    target.orders[group] = items.map((row) => row.dataset.layoutItem ?? "")
    const label = target.labels[id] ?? item.dataset.defaultLabel ?? id
    const msg = (root.dataset.moved ?? "")
      .replace("{item}", label)
      .replace("{position}", String(items.indexOf(item) + 1))
      .replace("{total}", String(items.length))
    commitDraft(msg)
    button.scrollIntoView({ block: "nearest" })
  }, { signal })

  observeOrder(syncFromStorage, signal)
  renderActiveScope()

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
          if (oldIndex === newIndex) { renderActiveScope(); return }
          const group = list.dataset.layoutOrder
          if (!group) return
          const items = layoutItems(list)
          const target = ensureMutableTaskConfig()
          target.orders[group] = items.map((row) => row.dataset.layoutItem ?? "")
          const id = item.dataset.layoutItem ?? ""
          const label = target.labels[id] ?? item.dataset.defaultLabel ?? id
          commitDraft((root.dataset.moved ?? "")
            .replace("{item}", label)
            .replace("{position}", String(newIndex + 1))
            .replace("{total}", String(items.length)))
        },
      })
    }

    if (entityList) {
      attachVerticalListDragReorder(entityList, {
        handle: "[data-layout-handle]",
        item: "[data-layout-item]",
        ghostClass: "td-layout-editor__ghost",
        signal,
        onStart: () => { dragging = true },
        onEnd: ({ item, oldIndex, newIndex }) => {
          dragging = false
          if (oldIndex === newIndex || !isEntityFormLayoutScope(activeScope)) { renderActiveScope(); return }
          const items = layoutItems(entityList)
          const target = ensureMutableEntityConfig(activeScope)
          target.order = items.map((row) => row.dataset.layoutItem ?? "")
          const id = item.dataset.layoutItem ?? ""
          const label = target.labels[id] ?? item.dataset.defaultLabel ?? id
          commitDraft((root.dataset.moved ?? "")
            .replace("{item}", label)
            .replace("{position}", String(newIndex + 1))
            .replace("{total}", String(items.length)))
        },
      })
    }

    root.dataset.dragReady = "true"
  }).catch(() => { if (!signal.aborted) showError(root.dataset.dragFailed) })
}
