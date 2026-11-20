import {
  defaultSectionLabel,
  DEFAULT_SIDEBAR_ITEM_LABELS,
  isItemHidden,
  isSectionHidden,
  isSidebarSectionId,
  moveItemByStep,
  moveItemToSection,
  moveSectionByStep,
  normalizeSidebarConfig,
  pinCustomItem,
  renameItem,
  renameSection,
  reorderItem,
  reorderSections,
  sanitizeLabel,
  serializeSidebarConfig,
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

  const grip = document.createElement("button")
  grip.type = "button"
  grip.className = "sidebar-edit-grip"
  grip.dataset.sidebarItemDrag = item.id
  grip.draggable = true
  grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown")
  grip.setAttribute("aria-label", `Reorder ${item.label}`)
  grip.title = `Reorder ${item.label}`
  grip.append(createTablerSvgElement("grip-vertical", 14))

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
  iconWrap.append(createTablerSvgElement((item.icon || "link") as TablerIconName, 18))

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

  const renameBtn = document.createElement("button")
  renameBtn.type = "button"
  renameBtn.className = "sidebar-edit-btn"
  renameBtn.dataset.sidebarItemRename = item.id
  renameBtn.setAttribute("aria-label", `Rename ${item.label}`)
  renameBtn.title = `Rename ${item.label}`
  renameBtn.append(createTablerSvgElement("pencil", 14))

  const toggleBtn = document.createElement("button")
  toggleBtn.type = "button"
  toggleBtn.className = "sidebar-edit-btn"
  toggleBtn.dataset.sidebarItemToggle = item.id
  toggleBtn.setAttribute("aria-pressed", String(hidden))
  toggleBtn.setAttribute("aria-label", hidden ? `Show ${item.label}` : `Hide ${item.label}`)
  toggleBtn.title = hidden ? `Show ${item.label}` : `Hide ${item.label}`

  const eyeVisible = document.createElement("span")
  eyeVisible.className = "sidebar-eye-visible"
  eyeVisible.append(createTablerSvgElement("eye", 14))

  const eyeHidden = document.createElement("span")
  eyeHidden.className = "sidebar-eye-hidden"
  eyeHidden.append(createTablerSvgElement("eye-off", 14))
  toggleBtn.append(eyeVisible, eyeHidden)

  const removeBtn = document.createElement("button")
  removeBtn.type = "button"
  removeBtn.className = "sidebar-edit-btn sidebar-edit-btn--danger"
  removeBtn.dataset.sidebarItemRemove = item.id
  removeBtn.setAttribute("aria-label", `Remove ${item.label}`)
  removeBtn.title = `Remove ${item.label}`
  removeBtn.append(createTablerSvgElement("x", 14))

  actions.append(renameBtn, toggleBtn, removeBtn)
  row.append(grip, link, actions)
  li.append(row)
  return li
}

/**
 * Compatibility export for nav-overflow-controller.ts.
 * Section order and item order are server-rendered and persisted via `/api/settings` (`sidebar_config`).
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

async function persistSidebarConfig(config: SidebarMenuConfig): Promise<boolean> {
  try {
    const payload = serializeSidebarConfig(config)
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "sidebar_config", value: payload }),
    })
    if (!res.ok) return false
    try { localStorage.removeItem(SIDEBAR_ORDER_STORAGE_KEY) } catch { /* Storage may be blocked. */ }
    window.dispatchEvent(new CustomEvent(SIDEBAR_CONFIG_UPDATED_EVENT, { detail: payload }))
    return true
  } catch {
    return false
  }
}

export function bindSidebarReorder(sidebar: HTMLElement, signal: AbortSignal): void {
  const root = sidebar.querySelector<HTMLElement>('[data-nav-overflow="sidebar"]')
  const leaveBar = sidebar.querySelector<HTMLElement>("[data-sidebar-leave-edit]")
  const leaveBtn = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-leave-edit-btn]")
  const addLinkTrigger = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-add-link-trigger]")
  const addLinkForm = sidebar.querySelector<HTMLFormElement>("[data-sidebar-add-link-form]")
  const addLinkCancel = sidebar.querySelector<HTMLButtonElement>("[data-sidebar-add-link-cancel]")
  const addLinkError = sidebar.querySelector<HTMLElement>("[data-sidebar-add-link-error]")
  const status = sidebar.querySelector<HTMLElement>("[data-sidebar-reorder-status]")
  if (!root) return

  const initialKeys = Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-item-key]"))
    .map(el => el.dataset.sidebarItemKey ?? "")
    .filter(Boolean)

  let config: SidebarMenuConfig = normalizeSidebarConfig(sidebar.dataset.sidebarConfig, initialKeys)
  let editing = false
  let dragKind: "section" | "item" | null = null
  let dragId: string | null = null
  let dropTarget: HTMLElement | null = null
  let saveCounter = 0

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

  function setAddLinkOpen(open: boolean) {
    if (!addLinkForm || !addLinkTrigger) return
    addLinkForm.hidden = !open
    addLinkTrigger.setAttribute("aria-expanded", String(open))
    if (addLinkError) {
      addLinkError.hidden = true
      addLinkError.textContent = ""
    }
    if (open) {
      const labelInput = addLinkForm.elements.namedItem("label") as HTMLInputElement | null
      labelInput?.focus()
    } else {
      addLinkForm.reset()
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
      btn.setAttribute("aria-label", pinned ? `Unpin ${label} from sidebar` : `Pin ${label} to sidebar`)
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
    if (prev && config.sectionOrder.includes(prev as SidebarSectionId)) {
      select.value = prev
    }
  }

  function syncDomFromConfig() {
    const sectionsContainer = root!.querySelector<HTMLElement>("[data-sidebar-sections]")
    if (!sectionsContainer) return

    const sectionEls = new Map<SidebarSectionId, HTMLElement>()
    sectionsContainer.querySelectorAll<HTMLElement>(":scope > [data-sidebar-section]").forEach(el => {
      const id = el.dataset.sidebarSection
      if (id && isSidebarSectionId(id)) sectionEls.set(id, el)
    })

    const customMap = new Map<string, CustomNavItem>(config.customItems.map(item => [item.id, item]))
    const itemEls = new Map<string, HTMLElement>()
    sectionsContainer.querySelectorAll<HTMLElement>("[data-sidebar-item-key]").forEach(el => {
      const key = el.dataset.sidebarItemKey
      if (!key) return
      // Remove stale removable items that were unpinned/deleted
      if (el.dataset.sidebarItemRemovable === "true" && !customMap.has(key)) {
        el.remove()
        return
      }
      itemEls.set(key, el)
    })

    // Ensure every custom/pinned item has a live DOM element
    for (const custom of config.customItems) {
      if (!itemEls.has(custom.id)) {
        itemEls.set(custom.id, buildDynamicSidebarItem(custom, isItemHidden(config, custom.id)))
      }
    }

    // Reorder sections & update their labels/visibility
    for (const sectionId of config.sectionOrder) {
      const sectionEl = sectionEls.get(sectionId)
      if (!sectionEl) continue
      sectionsContainer.appendChild(sectionEl)

      const hidden = isSectionHidden(config, sectionId)
      sectionEl.toggleAttribute("data-sidebar-section-hidden", hidden)

      const titleEl = sectionEl.querySelector<HTMLElement>(`[data-sidebar-section-label="${sectionId}"]`)
      const label = config.sectionLabels[sectionId] || titleEl?.dataset.defaultLabel || defaultSectionLabel(sectionId)
      if (titleEl && !sectionEl.hasAttribute("data-inline-editing")) {
        titleEl.textContent = label
      }

      const toggleBtn = sectionEl.querySelector<HTMLButtonElement>(`[data-sidebar-section-toggle="${sectionId}"]`)
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-pressed", String(hidden))
        const actionLabel = hidden ? `Show ${label} section` : `Hide ${label} section`
        toggleBtn.setAttribute("aria-label", actionLabel)
        toggleBtn.title = actionLabel
      }

      // Reorder items inside this section
      const list = sectionEl.querySelector<HTMLElement>("[data-sidebar-section-list]")
      if (!list) continue
      const keys = config.sectionItems[sectionId] ?? []
      for (const key of keys) {
        const itemEl = itemEls.get(key)
        if (!itemEl) continue
        list.appendChild(itemEl)

        const itemHidden = isItemHidden(config, key)
        itemEl.toggleAttribute("data-sidebar-item-hidden", itemHidden)

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
      }

      const hasVisible = keys.some(key => {
        const itemEl = itemEls.get(key)
        return itemEl && !itemEl.hidden && !isItemHidden(config, key)
      })
      sectionEl.toggleAttribute("data-sidebar-section-empty", !hasVisible)
      list.toggleAttribute("data-nav-overflow-empty", !hasVisible)
      list.toggleAttribute("data-task-views-primary", keys.includes("tasks"))
    }

    syncTaskViewPinButtons()
    syncAddLinkSectionOptions()

    sidebar.dataset.sidebarConfig = JSON.stringify(serializeSidebarConfig(config))
    root!.dispatchEvent(new Event(sidebarOrderChanged))
  }

  async function commitConfig(next: SidebarMenuConfig, announcement?: string) {
    config = next
    syncDomFromConfig()
    if (announcement) announce(announcement)
    const token = ++saveCounter
    const ok = await persistSidebarConfig(config)
    if (!ok && token === saveCounter && !signal.aborted) {
      showToast(sidebar.dataset.storageError || "Could not save sidebar layout.", "error")
    }
  }

  function setEditing(active: boolean) {
    if (active) {
      window.dispatchEvent(new CustomEvent("meitheal:sidebar-ensure-expanded"))
    }
    editing = active
    sidebar.toggleAttribute("data-sidebar-editing", active)
    sidebar.toggleAttribute("data-sidebar-reordering", active)
    if (leaveBar) leaveBar.hidden = !active
    if (!active) setAddLinkOpen(false)
    stopDrag()
    if (active) {
      syncAddLinkSectionOptions()
      announce("Sidebar edit mode enabled. Hover any section or item to rename, hide, or reorder.")
    } else {
      root!.querySelectorAll<HTMLInputElement>(".sidebar-inline-rename-input").forEach(input => input.blur())
      announce("Left sidebar edit mode.")
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

  // External triggers: User popover "Edit menu", Settings "Customize menu"
  window.addEventListener(SIDEBAR_EDIT_MODE_EVENT, event => {
    const detail = (event as CustomEvent<{ active?: boolean }>).detail
    const next = typeof detail?.active === "boolean" ? detail.active : !editing
    setEditing(next)
  }, { signal })

  // Independently pin / unpin nested Task Views (Calendar, Kanban, Timeline, Table)
  window.addEventListener(SIDEBAR_TOGGLE_VIEW_PIN_EVENT, event => {
    const view = (event as CustomEvent<{ view?: string }>).detail?.view
    if (!view) return
    const key = `view-${view}`
    const next = toggleItemVisibility(config, key)
    const nowPinned = !isItemHidden(next, key)
    const label = next.itemLabels[key] || DEFAULT_SIDEBAR_ITEM_LABELS[key] || view
    void commitConfig(next, nowPinned ? `Pinned ${label} to sidebar.` : `Unpinned ${label} from sidebar.`)
    showToast(nowPinned ? `Pinned ${label} to sidebar` : `Unpinned ${label} from sidebar`, "success")
  }, { signal })

  // Independently pin / unpin nested Board shortcuts as movable first-class items
  window.addEventListener(SIDEBAR_TOGGLE_SHORTCUT_PIN_EVENT, event => {
    const detail = (event as CustomEvent<ShortcutPinDetail>).detail
    if (!detail?.id || !detail.href) return
    const alreadyPinned = config.customItems.some(entry => entry.id === detail.id)
    if (alreadyPinned) {
      const next = unpinCustomItem(config, detail.id)
      void commitConfig(next, `Unpinned ${detail.label} from sidebar.`)
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
      void commitConfig(next, `Pinned ${detail.label} to sidebar.`)
      showToast(`Pinned ${detail.label} to sidebar`, "success")
    }
  }, { signal })

  // Subtle Add Custom Link controls inside Edit Mode footer
  addLinkTrigger?.addEventListener("click", () => {
    setAddLinkOpen(Boolean(addLinkForm?.hidden))
  }, { signal })

  addLinkCancel?.addEventListener("click", () => {
    setAddLinkOpen(false)
    addLinkTrigger?.focus()
  }, { signal })

  addLinkForm?.addEventListener("submit", event => {
    event.preventDefault()
    const labelInput = addLinkForm.elements.namedItem("label") as HTMLInputElement | null
    const hrefInput = addLinkForm.elements.namedItem("href") as HTMLInputElement | null
    const sectionSelect = addLinkForm.elements.namedItem("section") as HTMLSelectElement | null

    const cleanLabel = sanitizeLabel(labelInput?.value ?? "")
    const rawHref = (hrefInput?.value ?? "").trim()
    const rawSection = sectionSelect?.value ?? "workspace"
    const sectionId: SidebarSectionId = isSidebarSectionId(rawSection) ? rawSection : "workspace"

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
      icon: "link",
    }
    const next = pinCustomItem(config, item, sectionId)
    setAddLinkOpen(false)
    void commitConfig(next, `Pinned ${cleanLabel} to ${config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)}.`)
    showToast(`Pinned "${cleanLabel}" to sidebar`, "success")
  }, { signal })

  leaveBtn?.addEventListener("click", () => {
    setEditing(false)
  }, { signal })

  // Prevent link navigation while editing & handle hover action buttons
  root.addEventListener("click", event => {
    if (!editing) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return

    // Section rename
    const sectionRenameBtn = target.closest<HTMLButtonElement>("[data-sidebar-section-rename]")
    if (sectionRenameBtn) {
      event.preventDefault()
      event.stopPropagation()
      const sectionId = sectionRenameBtn.dataset.sidebarSectionRename
      if (!sectionId || !isSidebarSectionId(sectionId)) return
      const sectionEl = root.querySelector<HTMLElement>(`[data-sidebar-section="${sectionId}"]`)
      const labelEl = sectionEl?.querySelector<HTMLElement>(`[data-sidebar-section-label="${sectionId}"]`)
      if (!sectionEl || !labelEl) return
      const defaultVal = labelEl.dataset.defaultLabel || defaultSectionLabel(sectionId)
      const currentVal = config.sectionLabels[sectionId] || defaultVal
      startInlineRename(sectionEl, labelEl, currentVal, defaultVal, nextLabel => {
        void commitConfig(renameSection(config, sectionId, nextLabel), `Renamed section to ${nextLabel}.`)
      })
      return
    }

    // Section show/hide
    const sectionToggleBtn = target.closest<HTMLButtonElement>("[data-sidebar-section-toggle]")
    if (sectionToggleBtn) {
      event.preventDefault()
      event.stopPropagation()
      const sectionId = sectionToggleBtn.dataset.sidebarSectionToggle
      if (!sectionId || !isSidebarSectionId(sectionId)) return
      const next = toggleSectionVisibility(config, sectionId)
      const nowHidden = isSectionHidden(next, sectionId)
      const label = next.sectionLabels[sectionId] || defaultSectionLabel(sectionId)
      void commitConfig(next, nowHidden ? `Hidden ${label} section.` : `Shown ${label} section.`)
      return
    }

    // Item rename
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
        void commitConfig(renameItem(config, key, nextLabel), `Renamed item to ${nextLabel}.`)
      })
      return
    }

    // Item show/hide
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
      void commitConfig(next, nowHidden ? `Hidden ${label}.` : `Shown ${label}.`)
      return
    }

    // Removable custom/pinned item delete
    const itemRemoveBtn = target.closest<HTMLButtonElement>("[data-sidebar-item-remove]")
    if (itemRemoveBtn) {
      event.preventDefault()
      event.stopPropagation()
      const key = itemRemoveBtn.dataset.sidebarItemRemove
      if (!key) return
      const customEntry = config.customItems.find(c => c.id === key)
      const label = config.itemLabels[key] || customEntry?.label || key
      const next = unpinCustomItem(config, key)
      void commitConfig(next, `Removed ${label} from sidebar.`)
      showToast(`Removed "${label}" from sidebar`, "success")
      return
    }

    // Block navigation links during edit mode so clicking never navigates away
    const link = target.closest<HTMLAnchorElement>(".nav-link")
    if (link) {
      event.preventDefault()
    }
  }, { signal })

  // Keyboard navigation in edit mode (Escape exits, ArrowUp/ArrowDown on handles reorders)
  sidebar.addEventListener("keydown", event => {
    if (!editing || event.defaultPrevented) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.matches("input, textarea, select")) {
      if (event.key === "Escape" && addLinkForm && !addLinkForm.hidden && addLinkForm.contains(target)) {
        event.preventDefault()
        setAddLinkOpen(false)
        addLinkTrigger?.focus()
      }
      return
    }

    if (event.key === "Escape") {
      event.preventDefault()
      setEditing(false)
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
          void commitConfig(next, `Moved ${config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)} section.`)
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
          void commitConfig(next, `Moved ${config.itemLabels[key] || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key}.`)
          itemGrip.focus({ preventScroll: true })
        }
      }
    }
  }, { signal })

  // Drag-and-drop for BOTH sections and items (including cross-section item drops)
  root.addEventListener("dragstart", event => {
    if (!editing || !event.dataTransfer) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return

    const sectionGrip = target.closest<HTMLElement>("[data-sidebar-section-drag]")
    if (sectionGrip?.dataset.sidebarSectionDrag) {
      dragKind = "section"
      dragId = sectionGrip.dataset.sidebarSectionDrag
      const sectionEl = root.querySelector<HTMLElement>(`[data-sidebar-section="${dragId}"]`)
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
        void commitConfig(next, `Reordered ${config.sectionLabels[dragId] || defaultSectionLabel(dragId)} section.`)
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
        void commitConfig(next, `Moved ${config.itemLabels[dragId] || DEFAULT_SIDEBAR_ITEM_LABELS[dragId] || dragId}.`)
        stopDrag()
        return
      }

      const sectionEl = target.closest<HTMLElement>("[data-sidebar-section]")
      const sectionId = sectionEl?.dataset.sidebarSection
      if (sectionId && isSidebarSectionId(sectionId)) {
        event.preventDefault()
        const next = moveItemToSection(config, dragId, sectionId)
        void commitConfig(next, `Moved item into ${config.sectionLabels[sectionId] || defaultSectionLabel(sectionId)}.`)
      }
      stopDrag()
    }
  }, { signal })

  root.addEventListener("dragend", stopDrag, { signal })
  root.addEventListener("dragleave", event => {
    if (!root.contains(event.relatedTarget as Node | null)) clearDropIndicator()
  }, { signal })

  // Exit edit mode if sidebar collapses on desktop, closes on mobile, or switches to navbar mode
  const layoutObserver = new MutationObserver(() => {
    if (!editing) return
    if (document.body.classList.contains("sidebar-collapsed") ||
      document.documentElement.dataset.appearanceNavigation === "navbar" ||
      (innerWidth <= 768 && !sidebar.classList.contains("open"))) {
      setEditing(false)
    }
  })
  layoutObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] })
  layoutObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance-navigation"] })

  signal.addEventListener("abort", () => {
    layoutObserver.disconnect()
    setEditing(false)
  }, { once: true })
}
