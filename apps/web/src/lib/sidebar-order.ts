import {
  addSection,
  clearPersonalSidebarConfig,
  defaultSectionLabel,
  DEFAULT_SIDEBAR_ITEM_LABELS,
  deleteSection,
  hasPersonalSidebarConfig,
  isBuiltinSidebarSectionId,
  isItemHidden,
  isSectionHidden,
  isSidebarSectionId,
  moveItemByStep,
  moveItemToSection,
  moveSectionByStep,
  normalizeSidebarConfig,
  pinCustomItem,
  readPersonalSidebarConfig,
  renameItem,
  renameSection,
  reorderItem,
  reorderSections,
  sanitizeCustomLinkIcon,
  sanitizeLabel,
  savePersonalSidebarConfig,
  serializeSidebarConfig,
  setItemVisible,
  SIDEBAR_PERSONAL_STORAGE_KEY,
  toggleItemVisibility,
  toggleSectionVisibility,
  unpinCustomItem,
  type CustomNavItem,
  type SidebarMenuConfig,
  type SidebarSectionId,
} from "@domains/navigation/sidebar-menu"
import { createTablerSvgElement, type TablerIconName } from "@lib/tabler-svg"
import { safeIngressHref } from "@lib/ingress-navigation"
import { showToast } from "@lib/toast"

export const SIDEBAR_ORDER_STORAGE_KEY = "meitheal-sidebar-order"
export const sidebarOrderChanged = "meitheal:sidebar-order-changed"
export const SIDEBAR_EDIT_MODE_EVENT = "meitheal:sidebar-edit-mode"
export const SIDEBAR_CONFIG_UPDATED_EVENT = "meitheal:sidebar-config-updated"
export const SIDEBAR_SERVER_UPDATED_EVENT = "meitheal:sidebar-server-updated"
export const SIDEBAR_PERSONAL_CLEARED_EVENT = "meitheal:sidebar-personal-cleared"
export const SIDEBAR_TOGGLE_VIEW_PIN_EVENT = "meitheal:sidebar-toggle-view-pin"
export const SIDEBAR_TOGGLE_SHORTCUT_PIN_EVENT = "meitheal:sidebar-toggle-shortcut-pin"

export interface ShortcutPinDetail {
  id: string
  label: string
  href: string
  icon?: string
  section?: SidebarSectionId
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

function isSafeCustomHref(href: string): boolean {
  return /^(\/(?!\/)|https?:\/\/)/i.test(href.trim())
}

function generateCustomLinkId(): string {
  const raw = crypto.randomUUID?.()
    ?? Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("")
  return `custom-${raw}`
}

function buildActionBtn(
  className: string,
  iconName: TablerIconName,
  label: string,
  dataAttr: string,
  dataVal: string,
): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = className
  btn.setAttribute(dataAttr, dataVal)
  btn.setAttribute("aria-label", label)
  btn.title = label
  btn.append(createTablerSvgElement(iconName, 14))
  return btn
}

function buildEyeToggleBtn(dataAttr: string, dataVal: string, hidden: boolean, label: string): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "sidebar-edit-btn"
  btn.setAttribute(dataAttr, dataVal)
  btn.setAttribute("aria-pressed", String(hidden))
  btn.setAttribute("aria-label", label)
  btn.title = label
  const vis = document.createElement("span")
  vis.className = "sidebar-eye-visible"
  vis.append(createTablerSvgElement("eye", 14))
  const hid = document.createElement("span")
  hid.className = "sidebar-eye-hidden"
  hid.append(createTablerSvgElement("eye-off", 14))
  btn.append(vis, hid)
  return btn
}

function buildDynamicSectionElement(sectionId: SidebarSectionId, label: string, hidden: boolean): HTMLElement {
  const removable = !isBuiltinSidebarSectionId(sectionId)
  const section = document.createElement("section")
  section.className = "sidebar-section"
  section.dataset.sidebarSection = sectionId
  if (hidden) section.dataset.sidebarSectionHidden = "true"
  if (removable) section.dataset.sidebarSectionRemovable = "true"
  section.setAttribute("aria-label", label)

  const header = document.createElement("div")
  header.className = "sidebar-section__header"
  header.dataset.sidebarSectionHeader = sectionId

  const grip = buildActionBtn("sidebar-edit-grip", "grip-vertical", `Reorder ${label} section`, "data-sidebar-section-drag", sectionId)
  grip.draggable = true
  grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown")

  const title = document.createElement("span")
  title.className = "sidebar-section__title"
  title.dataset.sidebarSectionLabel = sectionId
  title.dataset.defaultLabel = label
  title.textContent = label

  const actions = document.createElement("div")
  actions.className = "sidebar-edit-actions"
  actions.append(
    buildActionBtn("sidebar-edit-btn", "pencil", `Rename ${label} section`, "data-sidebar-section-rename", sectionId),
    buildEyeToggleBtn("data-sidebar-section-toggle", sectionId, hidden, hidden ? `Show ${label} section` : `Hide ${label} section`),
  )
  if (removable) {
    actions.append(
      buildActionBtn("sidebar-edit-btn sidebar-edit-btn--danger", "trash", `Delete ${label} section`, "data-sidebar-section-delete", sectionId),
    )
  }

  header.append(grip, title, actions)

  const list = document.createElement("ul")
  list.className = "nav-list nav-overflow__primary flex flex-col gap-1 list-none m-0 p-0 w-full"
  list.setAttribute("data-nav-overflow-primary", "")
  list.dataset.sidebarSectionList = sectionId

  section.append(header, list)
  return section
}

function buildDynamicSidebarItem(item: CustomNavItem, hidden: boolean): HTMLLIElement {
  const external = isExternalHref(item.href)
  const li = document.createElement("li")
  li.className = "sidebar-nav-item relative"
  li.dataset.sidebarGroup = item.id
  li.dataset.sidebarItemKey = item.id
  li.dataset.sidebarItemRemovable = "true"
  if (hidden) li.dataset.sidebarItemHidden = "true"

  const row = document.createElement("div")
  row.className = "nav-row flex items-center gap-1 min-w-0"

  const grip = buildActionBtn("sidebar-edit-grip", "grip-vertical", `Reorder ${item.label}`, "data-sidebar-item-drag", item.id)
  grip.draggable = true
  grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown")

  const link = document.createElement("a")
  link.href = external ? item.href : safeIngressHref(item.href)
  link.className = `nav-link flex-1 min-w-0${external ? " nav-link--external" : ""}`
  link.dataset.page = item.id
  link.title = item.label
  link.dataset.tooltip = item.label
  link.setAttribute("aria-label", `${item.label}${external ? " (opens in new tab)" : ""}`)
  if (external) {
    link.target = "_blank"
    link.rel = "noopener noreferrer"
  }

  const iconWrap = document.createElement("span")
  iconWrap.className = "nav-icon"
  iconWrap.append(createTablerSvgElement(sanitizeCustomLinkIcon(item.icon) as TablerIconName, 18))

  const labelSpan = document.createElement("span")
  labelSpan.className = "nav-label"
  labelSpan.dataset.sidebarItemLabel = item.id
  labelSpan.dataset.defaultLabel = item.label
  labelSpan.textContent = item.label

  link.append(iconWrap, labelSpan)
  if (external) {
    const ext = document.createElement("span")
    ext.className = "nav-external-icon"
    ext.setAttribute("aria-hidden", "true")
    ext.textContent = "↗"
    link.append(ext)
  }

  const actions = document.createElement("div")
  actions.className = "sidebar-edit-actions"
  actions.append(
    buildActionBtn("sidebar-edit-btn", "pencil", `Rename ${item.label}`, "data-sidebar-item-rename", item.id),
    buildEyeToggleBtn("data-sidebar-item-toggle", item.id, hidden, hidden ? `Show ${item.label}` : `Hide ${item.label}`),
    buildActionBtn("sidebar-edit-btn sidebar-edit-btn--danger", "x", `Remove ${item.label}`, "data-sidebar-item-remove", item.id),
  )

  row.append(grip, link, actions)
  li.append(row)
  return li
}

/**
 * Compatibility export for nav-overflow-controller.ts.
 */
export function applySidebarOrder(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-sidebar-section]").forEach(section => {
    const list = section.querySelector<HTMLElement>("[data-sidebar-section-list]")
    if (!list) return
    const items = Array.from(list.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute("data-sidebar-item-key"),
    )
    const hasVisible = items.some(item => !item.hidden && !item.hasAttribute("data-sidebar-item-hidden"))
    section.toggleAttribute("data-sidebar-section-empty", !hasVisible)
    list.toggleAttribute("data-nav-overflow-empty", !hasVisible)
  })
}

export function bindSidebarReorder(sidebar: HTMLElement, signal: AbortSignal): void {
  const root = sidebar.querySelector<HTMLElement>('[data-nav-overflow="sidebar"]')
  const leaveBar = sidebar.querySelector<HTMLElement>("[data-sidebar-leave-edit]")
  const leaveBtn = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-leave-edit-btn]")
  const resetPersonalBtn = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-reset-personal]")
  const addSectionTrigger = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-add-section-trigger]")
  const addSectionForm = sidebar.querySelector<HTMLFormElement>("[data-sidebar-add-section-form]")
  const addSectionCancel = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-add-section-cancel]")
  const addSectionError = sidebar.querySelector<HTMLElement>("[data-sidebar-add-section-error]")
  const addLinkTrigger = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-add-link-trigger]")
  const addLinkForm = sidebar.querySelector<HTMLFormElement>("[data-sidebar-add-link-form]")
  const addLinkCancel = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-add-link-cancel]")
  const addLinkError = sidebar.querySelector<HTMLElement>("[data-sidebar-add-link-error]")
  const status = sidebar.querySelector<HTMLElement>("[data-sidebar-reorder-status]")
  if (!root) return

  const initialKeys = Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-item-key]"))
    .map(el => el.dataset.sidebarItemKey ?? "")
    .filter(Boolean)

  const readServerConfig = () => normalizeSidebarConfig(
    sidebar.dataset.sidebarServerConfig ?? sidebar.dataset.sidebarConfig,
    initialKeys,
  )

  const personalInitial = readPersonalSidebarConfig(initialKeys)
  let config: SidebarMenuConfig = personalInitial ?? readServerConfig()
  let hydratedLegacyTaskPins = false
  if (!personalInitial) {
    try {
      const rawTaskNav = localStorage.getItem("meitheal-task-nav-prefs")
      const parsedTaskNav = rawTaskNav ? JSON.parse(rawTaskNav) as { pinnedViews?: unknown } : null
      if (Array.isArray(parsedTaskNav?.pinnedViews)) {
        for (const view of parsedTaskNav.pinnedViews) {
          if (typeof view === "string" && ["calendar", "kanban", "timeline", "table"].includes(view)) {
            config = setItemVisible(config, `view-${view}`, true)
            hydratedLegacyTaskPins = true
          }
        }
      }
    } catch { /* ignore invalid legacy prefs */ }
  }
  let editing = false
  let dragKind: "section" | "item" | null = null
  let dragId: string | null = null
  let dropTarget: HTMLElement | null = null

  function announce(message: string) {
    if (!status) return
    status.textContent = ""
    requestAnimationFrame(() => {
      if (!signal.aborted && status) status.textContent = message
    })
  }

  function clearDropIndicator() {
    dropTarget?.removeAttribute("data-sidebar-drop")
    dropTarget = null
  }

  function stopDrag() {
    if (dragId) {
      root?.querySelectorAll<HTMLElement>("[data-sidebar-dragging]").forEach(el => {
        el.removeAttribute("data-sidebar-dragging")
      })
    }
    dragKind = null
    dragId = null
    clearDropIndicator()
  }

  function syncPersonalResetButton() {
    if (resetPersonalBtn) resetPersonalBtn.hidden = !hasPersonalSidebarConfig()
  }

  function resetIconPickerSelection() {
    if (!addLinkForm) return
    const iconInput = addLinkForm.elements.namedItem("icon") as HTMLInputElement | null
    if (iconInput) iconInput.value = "link"
    addLinkForm.querySelectorAll<HTMLButtonElement>("[data-link-icon-choice]").forEach(btn => {
      const selected = btn.dataset.linkIconChoice === "link"
      btn.classList.toggle("is-selected", selected)
      btn.setAttribute("aria-pressed", String(selected))
    })
  }

  function setAddSectionOpen(open: boolean) {
    if (!addSectionForm || !addSectionTrigger) return
    if (open && addLinkForm && !addLinkForm.hidden) setAddLinkOpen(false)
    addSectionForm.hidden = !open
    addSectionTrigger.setAttribute("aria-expanded", String(open))
    if (addSectionError) {
      addSectionError.hidden = true
      addSectionError.textContent = ""
    }
    if (open) {
      const input = addSectionForm.elements.namedItem("sectionLabel") as HTMLInputElement | null
      input?.focus()
    } else {
      addSectionForm.reset()
    }
  }

  function setAddLinkOpen(open: boolean) {
    if (!addLinkForm || !addLinkTrigger) return
    if (open && addSectionForm && !addSectionForm.hidden) setAddSectionOpen(false)
    addLinkForm.hidden = !open
    addLinkTrigger.setAttribute("aria-expanded", String(open))
    if (addLinkError) {
      addLinkError.hidden = true
      addLinkError.textContent = ""
    }
    if (open) {
      syncAddLinkSectionOptions()
      const labelInput = addLinkForm.elements.namedItem("label") as HTMLInputElement | null
      labelInput?.focus()
    } else {
      addLinkForm.reset()
      resetIconPickerSelection()
    }
  }

  function syncTaskViewPinButtons() {
    root!.querySelectorAll<HTMLButtonElement>("#tasks-nav-submenu [data-task-view-pin]").forEach(btn => {
      const view = btn.dataset.taskViewPin
      if (!view) return
      const key = `view-${view}`
      const pinned = !isItemHidden(config, key)
      const label = config.itemLabels[key] || DEFAULT_SIDEBAR_ITEM_LABELS[key] || view
      btn.setAttribute("aria-pressed", String(pinned))
      btn.setAttribute("aria-label", `Pin ${label} to navigation`)
      btn.title = pinned ? `Unpin ${label}` : `Pin ${label}`
    })
  }

  function syncAddLinkSectionOptions() {
    if (!addLinkForm) return
    const select = addLinkForm.elements.namedItem("section") as HTMLSelectElement | null
    if (!select) return
    const prev = select.value
    select.replaceChildren()
    for (const sectionId of config.sectionOrder) {
      const opt = document.createElement("option")
      opt.value = sectionId
      opt.textContent = config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)
      select.append(opt)
    }
    if (prev && config.sectionOrder.includes(prev)) {
      select.value = prev
    }
  }

  function syncDomFromConfig() {
    const sectionsContainer = root!.querySelector<HTMLElement>("[data-sidebar-sections]")
    if (!sectionsContainer) return

    const activeSectionSet = new Set(config.sectionOrder)
    const sectionEls = new Map<SidebarSectionId, HTMLElement>()
    sectionsContainer.querySelectorAll<HTMLElement>(":scope > [data-sidebar-section]").forEach(el => {
      const id = el.dataset.sidebarSection
      if (!id) return
      if (!activeSectionSet.has(id) && !isBuiltinSidebarSectionId(id)) {
        el.remove()
        return
      }
      if (isSidebarSectionId(id)) sectionEls.set(id, el)
    })

    for (const sectionId of config.sectionOrder) {
      if (!sectionEls.has(sectionId)) {
        const label = config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)
        sectionEls.set(sectionId, buildDynamicSectionElement(sectionId, label, isSectionHidden(config, sectionId)))
      }
    }

    const customMap = new Map<string, CustomNavItem>(config.customItems.map(item => [item.id, item]))
    const itemEls = new Map<string, HTMLElement>()
    root!.querySelectorAll<HTMLElement>("[data-sidebar-item-key]").forEach(el => {
      const key = el.dataset.sidebarItemKey
      if (!key) return
      if (el.dataset.sidebarItemRemovable === "true" && !customMap.has(key)) {
        el.remove()
        return
      }
      itemEls.set(key, el)
    })

    for (const custom of config.customItems) {
      if (!itemEls.has(custom.id)) {
        itemEls.set(custom.id, buildDynamicSidebarItem(custom, isItemHidden(config, custom.id)))
      }
    }

    let sectionIdx = 0
    for (const sectionId of config.sectionOrder) {
      const sectionEl = sectionEls.get(sectionId)
      if (!sectionEl) continue
      if (sectionsContainer.children[sectionIdx] !== sectionEl) {
        sectionsContainer.insertBefore(sectionEl, sectionsContainer.children[sectionIdx] ?? null)
      }
      sectionIdx += 1

      const hidden = isSectionHidden(config, sectionId)
      sectionEl.toggleAttribute("data-sidebar-section-hidden", hidden)

      const titleEl = sectionEl.querySelector<HTMLElement>(`[data-sidebar-section-label="${CSS.escape(sectionId)}"]`)
      const label = config.sectionLabels[sectionId] || titleEl?.dataset.defaultLabel || defaultSectionLabel(sectionId)
      if (titleEl && !sectionEl.hasAttribute("data-inline-editing")) {
        titleEl.textContent = label
      }

      const toggleBtn = sectionEl.querySelector<HTMLButtonElement>(`[data-sidebar-section-toggle="${CSS.escape(sectionId)}"]`)
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-pressed", String(hidden))
        const actionLabel = hidden ? `Show ${label} section` : `Hide ${label} section`
        toggleBtn.setAttribute("aria-label", actionLabel)
        toggleBtn.title = actionLabel
      }

      const list = sectionEl.querySelector<HTMLElement>("[data-sidebar-section-list]")
      if (!list) continue
      const overflowMenu = editing ? null : root!.querySelector("[data-nav-overflow-menu]")
      const keys = config.sectionItems[sectionId] ?? []
      let itemIdx = 0
      for (const key of keys) {
        const itemEl = itemEls.get(key)
        if (!itemEl) continue
        if (overflowMenu?.contains(itemEl)) {
          // Skip moving items currently housed inside More so child focus stays intact.
        } else {
          if (list.children[itemIdx] !== itemEl) {
            list.insertBefore(itemEl, list.children[itemIdx] ?? null)
          }
          itemIdx += 1
        }

        const itemHidden = isItemHidden(config, key)
        itemEl.toggleAttribute("data-sidebar-item-hidden", itemHidden)
        const viewId = itemEl.dataset.taskViewItem
        if (viewId) {
          if (itemHidden) itemEl.removeAttribute("data-task-view-pinned-item")
          else itemEl.setAttribute("data-task-view-pinned-item", viewId)
        }

        const labelEl = itemEl.querySelector<HTMLElement>(`[data-sidebar-item-label="${CSS.escape(key)}"]`)
        const customEntry = customMap.get(key)
        const defaultItemLabel = labelEl?.dataset.defaultLabel || customEntry?.label || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key
        const itemLabel = config.itemLabels[key] || defaultItemLabel
        if (labelEl && !itemEl.hasAttribute("data-inline-editing")) {
          labelEl.textContent = itemLabel
        }
        const link = itemEl.querySelector<HTMLAnchorElement>(".nav-link")
        if (link) {
          link.title = itemLabel
          link.dataset.tooltip = itemLabel
          link.setAttribute("aria-label", `${itemLabel}${link.classList.contains("nav-link--external") ? " (opens in new tab)" : ""}`)
        }

        const itemToggle = itemEl.querySelector<HTMLButtonElement>(`[data-sidebar-item-toggle="${CSS.escape(key)}"]`)
        if (itemToggle) {
          itemToggle.setAttribute("aria-pressed", String(itemHidden))
          const actionLabel = itemHidden ? `Show ${itemLabel}` : `Hide ${itemLabel}`
          itemToggle.setAttribute("aria-label", actionLabel)
          itemToggle.title = actionLabel
        }
        if (viewId) {
          const rowUnpin = itemEl.querySelector<HTMLButtonElement>(`[data-task-view-pin="${CSS.escape(viewId)}"]`)
          if (rowUnpin) {
            rowUnpin.setAttribute("aria-pressed", String(!itemHidden))
            rowUnpin.setAttribute("aria-label", `Unpin ${itemLabel} from navigation`)
            rowUnpin.title = `Unpin ${itemLabel}`
          }
        }
      }

      const hasVisible = keys.some(key => {
        const itemEl = itemEls.get(key)
        return itemEl && !itemEl.hidden && !isItemHidden(config, key)
      })
      sectionEl.toggleAttribute("data-sidebar-section-empty", !hasVisible)
      list.toggleAttribute("data-nav-overflow-empty", !editing && !hasVisible)
      list.toggleAttribute("data-task-views-primary", keys.includes("tasks"))
    }

    syncTaskViewPinButtons()
    syncAddLinkSectionOptions()
    syncPersonalResetButton()

    sidebar.dataset.sidebarConfig = JSON.stringify(serializeSidebarConfig(config))
    root!.dispatchEvent(new Event(sidebarOrderChanged))
  }

  function commitPersonalConfig(next: SidebarMenuConfig, announcement?: string): boolean {
    config = next
    const saved = savePersonalSidebarConfig(config)
    syncDomFromConfig()
    if (announcement) announce(announcement)
    if (saved) {
      window.dispatchEvent(new CustomEvent(SIDEBAR_CONFIG_UPDATED_EVENT, { detail: saved }))
    } else if (!signal.aborted) {
      showToast(sidebar.dataset.storageError || "Could not save personal menu.", "error")
    }
    return Boolean(saved)
  }

  // The control that opened edit mode receives focus again when it closes.
  let editInvoker: HTMLElement | null = null
  const isFocusable = (element: HTMLElement | null): element is HTMLElement =>
    Boolean(element?.isConnected && element.getClientRects().length > 0)

  function focusFirstGrip() {
    const grip = [...root!.querySelectorAll<HTMLElement>("[data-sidebar-item-drag]")].find(isFocusable)
    grip?.focus({ preventScroll: true })
  }

  function leaveEditing() {
    setEditing(false)
    const fallback = document.getElementById("nav-utility-trigger")
    const target = isFocusable(editInvoker) ? editInvoker : fallback
    editInvoker = null
    if (isFocusable(target)) target.focus({ preventScroll: true })
  }

  function setEditing(active: boolean, openAddLink = false) {
    editing = active
    sidebar.toggleAttribute("data-sidebar-editing", active)
    sidebar.toggleAttribute("data-sidebar-reordering", active)
    document.body.classList.toggle("sidebar-editing", active)
    if (active) {
      window.dispatchEvent(new CustomEvent("meitheal:sidebar-ensure-expanded"))
    }
    if (leaveBar) leaveBar.hidden = !active
    if (!active) {
      setAddSectionOpen(false)
      setAddLinkOpen(false)
    }
    stopDrag()
    syncPersonalResetButton()
    root!.dispatchEvent(new Event(sidebarOrderChanged))
    if (active) {
      syncAddLinkSectionOptions()
      if (openAddLink) setAddLinkOpen(true)
      // The overflow layout restores navbar items in a later frame.
      else requestAnimationFrame(() => { if (editing) focusFirstGrip() })
      announce("Per-user navigation edit mode enabled.")
    } else {
      root!.querySelectorAll<HTMLInputElement>(".sidebar-inline-rename-input").forEach(input => input.blur())
      window.dispatchEvent(new CustomEvent("meitheal:sidebar-edit-finished"))
      announce("Left navigation edit mode.")
    }
  }

  function startInlineRename(
    host: HTMLElement,
    labelEl: HTMLElement,
    currentValue: string,
    defaultValue: string,
    onCommit: (nextLabel: string) => void,
  ) {
    if (host.hasAttribute("data-inline-editing")) return
    host.setAttribute("data-inline-editing", "true")

    const input = document.createElement("input")
    input.type = "text"
    input.className = "sidebar-inline-rename-input"
    input.value = currentValue
    input.placeholder = defaultValue
    input.maxLength = 64
    input.setAttribute("aria-label", `Rename ${defaultValue}`)

    labelEl.hidden = true
    labelEl.after(input)
    input.focus()
    input.select()

    let finished = false
    const finish = (commit: boolean) => {
      if (finished) return
      finished = true
      const raw = input.value
      input.remove()
      labelEl.hidden = false
      host.removeAttribute("data-inline-editing")
      if (commit) {
        const clean = sanitizeLabel(raw)
        onCommit(clean || defaultValue)
      }
    }

    input.addEventListener("keydown", event => {
      event.stopPropagation()
      if (event.key === "Enter") {
        event.preventDefault()
        finish(true)
      } else if (event.key === "Escape") {
        event.preventDefault()
        finish(false)
      }
    }, { signal })

    input.addEventListener("blur", () => finish(true), { signal })
    input.addEventListener("click", event => event.stopPropagation(), { signal })
  }

  // Hydrate personal override or legacy pinned task views on page load if present
  if (personalInitial || hydratedLegacyTaskPins) {
    syncDomFromConfig()
  } else {
    syncPersonalResetButton()
  }


  // External triggers: Global utility "Edit menu", Settings "Customize my menu"
  window.addEventListener(SIDEBAR_EDIT_MODE_EVENT, event => {
    const detail = (event as CustomEvent<{ active?: boolean; openAddLink?: boolean }>).detail
    const next = typeof detail?.active === "boolean" ? detail.active : !editing
    if (next && !editing) {
      const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
      // A menu item closes with its menu, so return to the menu's trigger instead.
      editInvoker = invoker && invoker !== document.body && !invoker.closest("[role=menu]") ? invoker : null
    }
    if (!next && editing) leaveEditing()
    else setEditing(next, Boolean(detail?.openAddLink))
  }, { signal })

  // Sync when Settings updates server default or clears personal override
  window.addEventListener(SIDEBAR_PERSONAL_CLEARED_EVENT, () => {
    config = readServerConfig()
    syncDomFromConfig()
  }, { signal })

  window.addEventListener(SIDEBAR_SERVER_UPDATED_EVENT, event => {
    const detail = (event as CustomEvent<unknown>).detail
    if (detail) {
      sidebar.dataset.sidebarServerConfig = JSON.stringify(detail)
    }
    if (!hasPersonalSidebarConfig()) {
      config = readServerConfig()
      syncDomFromConfig()
    }
  }, { signal })

  window.addEventListener("storage", event => {
    if (event.key === SIDEBAR_PERSONAL_STORAGE_KEY || event.key === null) {
      config = readPersonalSidebarConfig(initialKeys) ?? readServerConfig()
      syncDomFromConfig()
    }
  }, { signal })

  resetPersonalBtn?.addEventListener("click", () => {
    clearPersonalSidebarConfig()
    config = readServerConfig()
    syncDomFromConfig()
    window.dispatchEvent(new CustomEvent(SIDEBAR_PERSONAL_CLEARED_EVENT))
    showToast("Reset your personal menu to the server default.", "success")
  }, { signal })

  // Independently pin / unpin nested Task Views
  root.addEventListener("click", event => {
    if (editing) return
    const target = event.target instanceof Element ? event.target : null
    const pin = target?.closest<HTMLButtonElement>("[data-task-view-item] [data-task-view-pin]")
    const view = pin?.dataset.taskViewPin
    if (!view) return
    event.preventDefault()
    event.stopPropagation()
    const submenu = root.querySelector<HTMLElement>("#tasks-nav-submenu")
    const toggle = root.querySelector<HTMLButtonElement>("#tasks-submenu-toggle")
    window.dispatchEvent(new CustomEvent(SIDEBAR_TOGGLE_VIEW_PIN_EVENT, { detail: { view } }))
    if (submenu?.hidden && toggle) toggle.focus()
  }, { signal })

  window.addEventListener(SIDEBAR_TOGGLE_VIEW_PIN_EVENT, event => {
    const view = (event as CustomEvent<{ view?: string }>).detail?.view
    if (!view) return
    const key = `view-${view}`
    const wasRowPin = Boolean(document.activeElement?.closest("[data-task-view-item]"))
    const next = toggleItemVisibility(config, key)
    const nowPinned = !isItemHidden(next, key)
    const label = next.itemLabels[key] || DEFAULT_SIDEBAR_ITEM_LABELS[key] || view
    commitPersonalConfig(next, nowPinned ? `Pinned ${label} to navigation.` : `Unpinned ${label} from navigation.`)
    if (!nowPinned && wasRowPin) root!.querySelector<HTMLButtonElement>("#tasks-submenu-toggle")?.focus()
    showToast(nowPinned ? `Pinned ${label} to navigation` : `Unpinned ${label} from navigation`, "success")
  }, { signal })

  // Independently pin / unpin nested Board shortcuts
  window.addEventListener(SIDEBAR_TOGGLE_SHORTCUT_PIN_EVENT, event => {
    const detail = (event as CustomEvent<ShortcutPinDetail>).detail
    if (!detail?.id || !detail.href) return
    const alreadyPinned = config.customItems.some(entry => entry.id === detail.id)
    if (alreadyPinned) {
      const next = unpinCustomItem(config, detail.id)
      commitPersonalConfig(next, `Unpinned ${detail.label} from sidebar.`)
      showToast(`Unpinned ${detail.label} from sidebar`, "success")
    } else {
      const targetSection = detail.section && isSidebarSectionId(detail.section) ? detail.section : "boards"
      const next = pinCustomItem(
        config,
        {
          id: detail.id,
          label: sanitizeLabel(detail.label) || detail.id,
          href: detail.href,
          icon: detail.icon || "layout-kanban",
        },
        targetSection,
      )
      commitPersonalConfig(next, `Pinned ${detail.label} to sidebar.`)
      showToast(`Pinned ${detail.label} to sidebar`, "success")
    }
  }, { signal })

  // Add Section inline form
  addSectionTrigger?.addEventListener("click", () => {
    setAddSectionOpen(Boolean(addSectionForm?.hidden))
  }, { signal })

  addSectionCancel?.addEventListener("click", () => {
    setAddSectionOpen(false)
    addSectionTrigger?.focus()
  }, { signal })

  addSectionForm?.addEventListener("submit", event => {
    event.preventDefault()
    const input = addSectionForm.elements.namedItem("sectionLabel") as HTMLInputElement | null
    const cleanLabel = sanitizeLabel(input?.value ?? "")
    if (!cleanLabel) {
      if (addSectionError) {
        addSectionError.textContent = "Enter a name for the section."
        addSectionError.hidden = false
      }
      input?.focus()
      return
    }
    const { config: next } = addSection(config, cleanLabel)
    setAddSectionOpen(false)
    commitPersonalConfig(next, `Added ${cleanLabel} section.`)
    showToast(`Added section "${cleanLabel}"`, "success")
  }, { signal })

  // Add Custom Link inline form + visual Tabler Icon Picker
  addLinkTrigger?.addEventListener("click", () => {
    setAddLinkOpen(Boolean(addLinkForm?.hidden))
  }, { signal })

  addLinkCancel?.addEventListener("click", () => {
    setAddLinkOpen(false)
    addLinkTrigger?.focus()
  }, { signal })

  addLinkForm?.addEventListener("click", event => {
    const choice = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-link-icon-choice]")
    if (!choice?.dataset.linkIconChoice) return
    const iconName = sanitizeCustomLinkIcon(choice.dataset.linkIconChoice)
    const iconInput = addLinkForm.elements.namedItem("icon") as HTMLInputElement | null
    if (iconInput) iconInput.value = iconName
    addLinkForm.querySelectorAll<HTMLButtonElement>("[data-link-icon-choice]").forEach(btn => {
      const selected = btn === choice
      btn.classList.toggle("is-selected", selected)
      btn.setAttribute("aria-pressed", String(selected))
    })
  }, { signal })

  addLinkForm?.addEventListener("submit", event => {
    event.preventDefault()
    const labelInput = addLinkForm.elements.namedItem("label") as HTMLInputElement | null
    const hrefInput = addLinkForm.elements.namedItem("href") as HTMLInputElement | null
    const sectionSelect = addLinkForm.elements.namedItem("section") as HTMLSelectElement | null
    const iconInput = addLinkForm.elements.namedItem("icon") as HTMLInputElement | null

    const cleanLabel = sanitizeLabel(labelInput?.value ?? "")
    const rawHref = (hrefInput?.value ?? "").trim()
    const rawSection = sectionSelect?.value ?? "workspace"
    const sectionId: SidebarSectionId = isSidebarSectionId(rawSection) ? rawSection : "workspace"
    const chosenIcon = sanitizeCustomLinkIcon(iconInput?.value ?? "link")

    if (!cleanLabel) {
      if (addLinkError) {
        addLinkError.textContent = "Enter a label for the link."
        addLinkError.hidden = false
      }
      labelInput?.focus()
      return
    }

    if (!isSafeCustomHref(rawHref)) {
      if (addLinkError) {
        addLinkError.textContent = "Enter a URL starting with https://, http://, or /."
        addLinkError.hidden = false
      }
      hrefInput?.focus()
      return
    }

    const item: CustomNavItem = {
      id: generateCustomLinkId(),
      label: cleanLabel,
      href: rawHref,
      icon: chosenIcon,
    }
    const next = pinCustomItem(config, item, sectionId)
    setAddLinkOpen(false)
    commitPersonalConfig(next, `Pinned ${cleanLabel} to ${config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)}.`)
    showToast(`Pinned "${cleanLabel}" to navigation`, "success")
  }, { signal })

  leaveBtn?.addEventListener("click", leaveEditing, { signal })

  // Edit mode actions (rename, hide/show, delete section, remove link)
  root.addEventListener("click", event => {
    if (!editing) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return

    const sectionRenameBtn = target.closest<HTMLButtonElement>("[data-sidebar-section-rename]")
    if (sectionRenameBtn) {
      event.preventDefault()
      event.stopPropagation()
      const sectionId = sectionRenameBtn.dataset.sidebarSectionRename
      if (!sectionId || !isSidebarSectionId(sectionId)) return
      const sectionEl = root.querySelector<HTMLElement>(`[data-sidebar-section="${CSS.escape(sectionId)}"]`)
      const labelEl = sectionEl?.querySelector<HTMLElement>(`[data-sidebar-section-label="${CSS.escape(sectionId)}"]`)
      if (!sectionEl || !labelEl) return
      const defaultVal = labelEl.dataset.defaultLabel || defaultSectionLabel(sectionId)
      const currentVal = config.sectionLabels[sectionId] || defaultVal
      startInlineRename(sectionEl, labelEl, currentVal, defaultVal, nextLabel => {
        commitPersonalConfig(renameSection(config, sectionId, nextLabel), `Renamed section to ${nextLabel}.`)
      })
      return
    }

    const sectionToggleBtn = target.closest<HTMLButtonElement>("[data-sidebar-section-toggle]")
    if (sectionToggleBtn) {
      event.preventDefault()
      event.stopPropagation()
      const sectionId = sectionToggleBtn.dataset.sidebarSectionToggle
      if (!sectionId || !isSidebarSectionId(sectionId)) return
      const next = toggleSectionVisibility(config, sectionId)
      const nowHidden = isSectionHidden(next, sectionId)
      const label = next.sectionLabels[sectionId] || defaultSectionLabel(sectionId)
      commitPersonalConfig(next, nowHidden ? `Hidden ${label} section.` : `Shown ${label} section.`)
      return
    }

    const sectionDeleteBtn = target.closest<HTMLButtonElement>("[data-sidebar-section-delete]")
    if (sectionDeleteBtn) {
      event.preventDefault()
      event.stopPropagation()
      const sectionId = sectionDeleteBtn.dataset.sidebarSectionDelete
      if (!sectionId || isBuiltinSidebarSectionId(sectionId)) return
      const label = config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)
      const next = deleteSection(config, sectionId)
      commitPersonalConfig(next, `Deleted ${label} section.`)
      showToast(`Deleted "${label}" section`, "success")
      return
    }

    const itemRenameBtn = target.closest<HTMLButtonElement>("[data-sidebar-item-rename]")
    if (itemRenameBtn) {
      event.preventDefault()
      event.stopPropagation()
      const key = itemRenameBtn.dataset.sidebarItemRename
      if (!key) return
      const itemEl = root.querySelector<HTMLElement>(`[data-sidebar-item-key="${CSS.escape(key)}"]`)
      const labelEl = itemEl?.querySelector<HTMLElement>(`[data-sidebar-item-label="${CSS.escape(key)}"]`)
      if (!itemEl || !labelEl) return
      const defaultVal = labelEl.dataset.defaultLabel || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key
      const currentVal = config.itemLabels[key] || defaultVal
      startInlineRename(itemEl, labelEl, currentVal, defaultVal, nextLabel => {
        commitPersonalConfig(renameItem(config, key, nextLabel), `Renamed item to ${nextLabel}.`)
      })
      return
    }

    const itemToggleBtn = target.closest<HTMLButtonElement>("[data-sidebar-item-toggle]")
    if (itemToggleBtn) {
      event.preventDefault()
      event.stopPropagation()
      const key = itemToggleBtn.dataset.sidebarItemToggle
      if (!key) return
      const next = toggleItemVisibility(config, key)
      const nowHidden = isItemHidden(next, key)
      const customEntry = next.customItems.find(c => c.id === key)
      const label = next.itemLabels[key] || customEntry?.label || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key
      commitPersonalConfig(next, nowHidden ? `Hidden ${label}.` : `Shown ${label}.`)
      return
    }

    const itemRemoveBtn = target.closest<HTMLButtonElement>("[data-sidebar-item-remove]")
    if (itemRemoveBtn) {
      event.preventDefault()
      event.stopPropagation()
      const key = itemRemoveBtn.dataset.sidebarItemRemove
      if (!key) return
      const customEntry = config.customItems.find(c => c.id === key)
      const label = config.itemLabels[key] || customEntry?.label || key
      const next = unpinCustomItem(config, key)
      commitPersonalConfig(next, `Removed ${label} from sidebar.`)
      showToast(`Removed "${label}" from navigation`, "success")
      return
    }

    const link = target.closest<HTMLAnchorElement>(".nav-link")
    if (link) event.preventDefault()
  }, { signal })

  // Keyboard navigation in edit mode
  sidebar.addEventListener("keydown", event => {
    if (!editing || event.defaultPrevented) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.matches("input, textarea, select")) {
      if (event.key === "Escape") {
        if (addSectionForm && !addSectionForm.hidden && addSectionForm.contains(target)) {
          event.preventDefault()
          setAddSectionOpen(false)
          addSectionTrigger?.focus()
        } else if (addLinkForm && !addLinkForm.hidden && addLinkForm.contains(target)) {
          event.preventDefault()
          setAddLinkOpen(false)
          addLinkTrigger?.focus()
        }
      }
      return
    }

    if (event.key === "Escape") {
      event.preventDefault()
      leaveEditing()
      return
    }

    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    const step = event.key === "ArrowUp" ? -1 : 1

    const sectionGrip = target?.closest<HTMLElement>("[data-sidebar-section-drag]")
    if (sectionGrip) {
      const sectionId = sectionGrip.dataset.sidebarSectionDrag
      if (sectionId && isSidebarSectionId(sectionId)) {
        event.preventDefault()
        const next = moveSectionByStep(config, sectionId, step)
        if (next !== config) {
          commitPersonalConfig(next, `Moved ${config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)} section.`)
          sectionGrip.focus({ preventScroll: true })
        }
      }
      return
    }

    const itemGrip = target?.closest<HTMLElement>("[data-sidebar-item-drag]")
    if (itemGrip) {
      const key = itemGrip.dataset.sidebarItemDrag
      if (key) {
        event.preventDefault()
        const next = moveItemByStep(config, key, step)
        if (next !== config) {
          commitPersonalConfig(next, `Moved ${config.itemLabels[key] || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key}.`)
          itemGrip.focus({ preventScroll: true })
        }
      }
    }
  }, { signal })

  // Drag-and-drop for BOTH sections and items (including cross-section drops)
  root.addEventListener("dragstart", event => {
    if (!editing || !event.dataTransfer) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return

    const sectionGrip = target.closest<HTMLElement>("[data-sidebar-section-drag]")
    if (sectionGrip?.dataset.sidebarSectionDrag) {
      dragKind = "section"
      dragId = sectionGrip.dataset.sidebarSectionDrag
      const sectionEl = root.querySelector<HTMLElement>(`[data-sidebar-section="${CSS.escape(dragId)}"]`)
      sectionEl?.setAttribute("data-sidebar-dragging", "true")
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", `section:${dragId}`)
      return
    }

    const itemGrip = target.closest<HTMLElement>("[data-sidebar-item-drag]")
    if (itemGrip?.dataset.sidebarItemDrag) {
      dragKind = "item"
      dragId = itemGrip.dataset.sidebarItemDrag
      const itemEl = root.querySelector<HTMLElement>(`[data-sidebar-item-key="${CSS.escape(dragId)}"]`)
      itemEl?.setAttribute("data-sidebar-dragging", "true")
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", `item:${dragId}`)
    }
  }, { signal })

  root.addEventListener("dragover", event => {
    if (!editing || !dragKind || !dragId) return
    const target = event.target instanceof Element ? event.target : null
    clearDropIndicator()
    if (!target) return

    if (dragKind === "section") {
      const sectionEl = target.closest<HTMLElement>("[data-sidebar-section]")
      const targetId = sectionEl?.dataset.sidebarSection
      if (!sectionEl || !targetId || targetId === dragId) return
      event.preventDefault()
      const bounds = sectionEl.getBoundingClientRect()
      const after = event.clientY > bounds.top + bounds.height / 2
      dropTarget = sectionEl
      sectionEl.setAttribute("data-sidebar-drop", after ? "after" : "before")
      return
    }

    if (dragKind === "item") {
      const itemEl = target.closest<HTMLElement>("[data-sidebar-item-key]")
      const targetKey = itemEl?.dataset.sidebarItemKey
      if (itemEl && targetKey && targetKey !== dragId) {
        event.preventDefault()
        const bounds = itemEl.getBoundingClientRect()
        const after = event.clientY > bounds.top + bounds.height / 2
        dropTarget = itemEl
        itemEl.setAttribute("data-sidebar-drop", after ? "after" : "before")
        return
      }
      const sectionEl = target.closest<HTMLElement>("[data-sidebar-section]")
      if (sectionEl) {
        event.preventDefault()
        dropTarget = sectionEl
        sectionEl.setAttribute("data-sidebar-drop", "into")
      }
    }
  }, { signal })

  root.addEventListener("drop", event => {
    if (!editing || !dragKind || !dragId) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) {
      stopDrag()
      return
    }

    if (dragKind === "section" && isSidebarSectionId(dragId)) {
      const sectionEl = target.closest<HTMLElement>("[data-sidebar-section]")
      const targetId = sectionEl?.dataset.sidebarSection
      if (sectionEl && targetId && isSidebarSectionId(targetId) && targetId !== dragId) {
        event.preventDefault()
        const bounds = sectionEl.getBoundingClientRect()
        const after = event.clientY > bounds.top + bounds.height / 2
        const next = reorderSections(config, dragId, targetId, after)
        commitPersonalConfig(next, `Reordered ${config.sectionLabels[dragId] || defaultSectionLabel(dragId)} section.`)
      }
      stopDrag()
      return
    }

    if (dragKind === "item") {
      const itemEl = target.closest<HTMLElement>("[data-sidebar-item-key]")
      const targetKey = itemEl?.dataset.sidebarItemKey
      if (itemEl && targetKey && targetKey !== dragId) {
        event.preventDefault()
        const bounds = itemEl.getBoundingClientRect()
        const after = event.clientY > bounds.top + bounds.height / 2
        const next = reorderItem(config, dragId, targetKey, after)
        commitPersonalConfig(next, `Moved ${config.itemLabels[dragId] || DEFAULT_SIDEBAR_ITEM_LABELS[dragId] || dragId}.`)
        stopDrag()
        return
      }

      const sectionEl = target.closest<HTMLElement>("[data-sidebar-section]")
      const sectionId = sectionEl?.dataset.sidebarSection
      if (sectionId && isSidebarSectionId(sectionId)) {
        event.preventDefault()
        const next = moveItemToSection(config, dragId, sectionId)
        commitPersonalConfig(next, `Moved item into ${config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)}.`)
      }
      stopDrag()
    }
  }, { signal })

  root.addEventListener("dragend", stopDrag, { signal })
  root.addEventListener("dragleave", event => {
    if (!root.contains(event.relatedTarget as Node | null)) clearDropIndicator()
  }, { signal })

  const layoutObserver = new MutationObserver(() => {
    if (!editing) return
    const isDesktopSidebar = innerWidth > 768 && document.documentElement.dataset.appearanceNavigation !== "navbar"
    if ((isDesktopSidebar && document.body.classList.contains("sidebar-collapsed")) ||
      (innerWidth <= 768 && !sidebar.classList.contains("open"))) {
      setEditing(false)
    }
  })
  layoutObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] })
  layoutObserver.observe(sidebar, { attributes: true, attributeFilter: ["class"] })

  signal.addEventListener("abort", () => {
    layoutObserver.disconnect()
    setEditing(false)
  }, { once: true })
}
