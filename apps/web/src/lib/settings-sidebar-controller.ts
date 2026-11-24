/**
 * Server-wide Sidebar & Top Bar Configuration Controller.
 *
 * Uses the exact visual & interaction grammar of TaskDetailLayoutEditor:
 * - Server-wide default scope (`PUT /api/settings` `sidebar_config`)
 * - Clear personal override notice & reset
 * - Drag-and-drop reordering within & across sections (zero dropdowns)
 * - Inline pencil rename, eye/eye-off visibility toggle, up/down arrows
 * - Add/delete custom sections and add/delete custom links with Tabler icons
 */
import {
  addSection,
  clearPersonalSidebarConfig,
  DEFAULT_SIDEBAR_ITEM_ICONS,
  DEFAULT_SIDEBAR_ITEM_LABELS,
  TASK_VIEW_ITEM_KEYS,
  defaultSectionLabel,
  deleteSection,
  hasPersonalSidebarConfig,
  isBuiltinSidebarSectionId,
  isItemHidden,
  isSectionHidden,
  isSidebarConfigEqual,
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
  sanitizeCustomLinkIcon,
  sanitizeLabel,
  serializeSidebarConfig,
  SIDEBAR_PERSONAL_STORAGE_KEY,
  toggleItemVisibility,
  toggleSectionVisibility,
  unpinCustomItem,
  type CustomNavItem,
  type SidebarMenuConfig,
  type SidebarSectionId,
} from "@domains/navigation/sidebar-menu"
import { withAsyncButton } from "@lib/async-button"
import { browserUuid } from "@lib/browser-uuid"
import { confirmDialog } from "@lib/confirm-dialog"
import { mountInlineRename } from "@lib/inline-rename"
import { pageLifecycle } from "@lib/page-lifecycle"
import { createTablerSvgElement, type TablerIconName } from "@lib/tabler-svg"
import { showToast } from "@lib/toast"
import { saveSetting, showSettingsSaveError, log } from "@lib/settings-utils"
import { settingsStore } from "@lib/settings-store"
import {
  SIDEBAR_CONFIG_UPDATED_EVENT,
  SIDEBAR_EDIT_MODE_EVENT,
  SIDEBAR_ORDER_STORAGE_KEY,
  SIDEBAR_PERSONAL_CLEARED_EVENT,
  SIDEBAR_SERVER_UPDATED_EVENT,
  bindSidebarHtmlDragReorder,
  isSafeCustomHref,
} from "@lib/sidebar-order"
import { byId, domEl, qs, setAttr } from "@lib/dom-helpers"

const SETTINGS_DEFAULT_KEYS = [
  "dashboard",
  "today",
  "upcoming",
  "tasks",
  ...TASK_VIEW_ITEM_KEYS,
  "activity",
  "mentionInbox",
  "progress",
  "planning",
  "boards",
  "settings",
]

function customLinkId(): string {
  return `custom-${browserUuid()}`
}

function cloneConfig(config: SidebarMenuConfig): SidebarMenuConfig {
  return normalizeSidebarConfig(serializeSidebarConfig(config), SETTINGS_DEFAULT_KEYS)
}

let serverCommitted: SidebarMenuConfig = normalizeSidebarConfig(null, SETTINGS_DEFAULT_KEYS)
let draftConfig: SidebarMenuConfig = cloneConfig(serverCommitted)

export function initSidebarSettings(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-customize-sidebar-menu]").forEach(button => {
    pageLifecycle.on(button, "click", () => {
      window.dispatchEvent(new CustomEvent(SIDEBAR_EDIT_MODE_EVENT, { detail: { active: true } }))
    })
  })
}

export function restoreSidebarSettings(settings: Record<string, unknown>): void {
  try {
    const signal = pageLifecycle.signal
    const editor = byId("sidebar-layout-editor")
    const list = byId("sidebar-item-list")
    const sectionTpl = qs<HTMLTemplateElement>(editor, "template[data-nav-section-template]")?.content.firstElementChild
    const itemTpl = qs<HTMLTemplateElement>(editor, "template[data-nav-item-template]")?.content.firstElementChild
    if (!editor || !list || !sectionTpl || !itemTpl) return

    const personalNotice = byId("sidebar-personal-notice")
    const clearPersonalBtn = byId<HTMLButtonElement>("sidebar-clear-personal-btn")
    const dirtyBar = byId("sidebar-dirty-bar")
    const saveBtn = byId<HTMLButtonElement>("save-sidebar")
    const discardBtn = byId<HTMLButtonElement>("discard-sidebar")
    const resetBtn = byId<HTMLButtonElement>("reset-sidebar")
    const addSectionBtn = byId<HTMLButtonElement>("settings-add-section-toggle")
    const addSectionForm = byId<HTMLFormElement>("settings-add-section-form")
    const addSectionCancel = byId<HTMLButtonElement>("settings-add-section-cancel")
    const addSectionError = byId("settings-add-section-error")
    const addLinkBtn = byId<HTMLButtonElement>("settings-add-link-toggle")
    const addLinkForm = byId<HTMLFormElement>("settings-add-link-form")
    const addLinkCancel = byId<HTMLButtonElement>("settings-add-link-cancel")
    const addLinkError = byId("settings-add-link-error")
    const addLinkSectionSelect = byId<HTMLSelectElement>("settings-add-link-section")

    serverCommitted = normalizeSidebarConfig(settings.sidebar_config, SETTINGS_DEFAULT_KEYS)
    draftConfig = cloneConfig(serverCommitted)

    const openState = new Map<string, boolean>()

    function syncNotices() {
      if (personalNotice) personalNotice.hidden = !hasPersonalSidebarConfig()
      if (dirtyBar) dirtyBar.hidden = isSidebarConfigEqual(serverCommitted, draftConfig)
    }

    function syncLinkSectionOptions() {
      if (!addLinkSectionSelect) return
      const prev = addLinkSectionSelect.value
      addLinkSectionSelect.replaceChildren()
      for (const secId of draftConfig.sectionOrder) {
        const opt = domEl("option")
        opt.value = secId
        opt.textContent = draftConfig.sectionLabels[secId] || defaultSectionLabel(secId)
        addLinkSectionSelect.append(opt)
      }
      if (prev && draftConfig.sectionOrder.includes(prev)) addLinkSectionSelect.value = prev
    }

    function resetLinkIconPicker() {
      if (!addLinkForm) return
      const iconInput = addLinkForm.elements.namedItem("icon") as HTMLInputElement | null
      if (iconInput) iconInput.value = "link"
      addLinkForm.querySelectorAll<HTMLButtonElement>("[data-settings-icon-choice]").forEach(btn => {
        const selected = btn.dataset.settingsIconChoice === "link"
        btn.classList.toggle("is-selected", selected)
        setAttr(btn, "aria-pressed", String(selected))
      })
    }

    function setSectionFormOpen(open: boolean) {
      if (!addSectionForm || !addSectionBtn) return
      if (open && addLinkForm && !addLinkForm.hidden) setLinkFormOpen(false)
      addSectionForm.hidden = !open
      setAttr(addSectionBtn, "aria-expanded", String(open))
      if (addSectionError) { addSectionError.hidden = true; addSectionError.textContent = "" }
      if (open) (addSectionForm.elements.namedItem("sectionLabel") as HTMLInputElement | null)?.focus()
      else addSectionForm.reset()
    }

    function setLinkFormOpen(open: boolean) {
      if (!addLinkForm || !addLinkBtn) return
      if (open && addSectionForm && !addSectionForm.hidden) setSectionFormOpen(false)
      addLinkForm.hidden = !open
      setAttr(addLinkBtn, "aria-expanded", String(open))
      if (addLinkError) { addLinkError.hidden = true; addLinkError.textContent = "" }
      if (open) {
        syncLinkSectionOptions()
        ;(addLinkForm.elements.namedItem("label") as HTMLInputElement | null)?.focus()
      } else {
        addLinkForm.reset()
        resetLinkIconPicker()
      }
    }

    function startInlineRename(
      rowEl: HTMLElement,
      currentValue: string,
      defaultValue: string,
      onCommit: (value: string) => void,
    ) {
      const labelEl = qs<HTMLElement>(rowEl, ":scope > .td-layout-editor__row > [data-nav-label]")
      if (!labelEl || labelEl.querySelector("input")) return
      mountInlineRename({
        labelEl,
        value: currentValue,
        placeholder: defaultValue,
        maxLength: 64,
        className: "td-layout-editor__rename-input",
        signal,
        onCommit: raw => {
          const cleaned = sanitizeLabel(raw)
          labelEl.replaceChildren(document.createTextNode(cleaned || currentValue))
          onCommit(cleaned || defaultValue)
        },
        onCancel: () => labelEl.replaceChildren(document.createTextNode(currentValue)),
      })
    }

    function renderTree() {
      // Remember which section disclosures are open/closed
      list!.querySelectorAll<HTMLElement>("[data-nav-section-row]").forEach(row => {
        const id = row.dataset.navSectionRow
        const details = qs<HTMLDetailsElement>(row, ":scope > details")
        if (id && details) openState.set(id, details.open)
      })

      const customMap = new Map<string, CustomNavItem>(draftConfig.customItems.map(item => [item.id, item]))
      const frag = document.createDocumentFragment()

      draftConfig.sectionOrder.forEach((sectionId, sectionIdx) => {
        const sectionRow = sectionTpl!.cloneNode(true) as HTMLLIElement
        const sectionHidden = isSectionHidden(draftConfig, sectionId)
        const removable = !isBuiltinSidebarSectionId(sectionId)
        const secLabel = draftConfig.sectionLabels[sectionId] || defaultSectionLabel(sectionId)

        sectionRow.dataset.navSectionRow = sectionId
        sectionRow.classList.toggle("is-hidden", sectionHidden)

        const labelEl = qs<HTMLElement>(sectionRow, ":scope > .td-layout-editor__row > [data-nav-label]")!
        labelEl.textContent = secLabel

        const visBtn = qs<HTMLButtonElement>(sectionRow, "[data-nav-section-vis]")!
        setAttr(visBtn, "aria-pressed", String(sectionHidden))
        visBtn.title = `${sectionHidden ? "Show" : "Hide"} · ${secLabel}`
        setAttr(visBtn, "aria-label", visBtn.title)

        const upBtn = qs<HTMLButtonElement>(sectionRow, '[data-nav-section-move="up"]')!
        const downBtn = qs<HTMLButtonElement>(sectionRow, '[data-nav-section-move="down"]')!
        setAttr(upBtn, "aria-disabled", String(sectionIdx === 0))
        setAttr(downBtn, "aria-disabled", String(sectionIdx === draftConfig.sectionOrder.length - 1))

        const delBtn = qs<HTMLButtonElement>(sectionRow, "[data-nav-section-delete]")!
        delBtn.hidden = !removable

        const details = qs<HTMLDetailsElement>(sectionRow, ":scope > details")!
        details.open = openState.get(sectionId) ?? true
        const fieldsTitle = qs<HTMLElement>(details, "[data-nav-fields-title]")
        if (fieldsTitle) fieldsTitle.textContent = `Items · ${secLabel}`

        const itemsList = qs<HTMLOListElement>(details, "[data-nav-section-items]")!
        itemsList.dataset.navSectionItems = sectionId

        const keys = draftConfig.sectionItems[sectionId] ?? []
        let visibleCount = 0

        if (keys.length === 0) {
          const empty = domEl("li")
          setAttr(empty, "data-nav-empty-drop", sectionId)
          empty.textContent = "Drag items here or add a custom link to this section."
          itemsList.append(empty)
        } else {
          keys.forEach((key, idx) => {
            const itemRow = itemTpl!.cloneNode(true) as HTMLLIElement
            const itemHidden = isItemHidden(draftConfig, key)
            if (!itemHidden) visibleCount += 1

            const customEntry = customMap.get(key)
            const defaultLabel = customEntry?.label || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key
            const displayLabel = draftConfig.itemLabels[key] || defaultLabel
            const iconName = (customEntry?.icon || DEFAULT_SIDEBAR_ITEM_ICONS[key] || "link") as TablerIconName

            itemRow.dataset.navItemRow = key
            itemRow.dataset.navItemSection = sectionId
            itemRow.classList.toggle("is-hidden", itemHidden)

            const iconSlot = qs<HTMLElement>(itemRow, "[data-nav-item-icon]")!
            iconSlot.replaceChildren(createTablerSvgElement(iconName, 16))

            qs<HTMLElement>(itemRow, "[data-nav-label]")!.textContent = displayLabel

            const hrefEl = qs<HTMLElement>(itemRow, "[data-nav-item-href]")!
            if (customEntry?.href) {
              hrefEl.textContent = customEntry.href
              hrefEl.hidden = false
            }

            const itemVisBtn = qs<HTMLButtonElement>(itemRow, "[data-nav-item-vis]")!
            setAttr(itemVisBtn, "aria-pressed", String(itemHidden))
            itemVisBtn.title = `${itemHidden ? "Show" : "Hide"} · ${displayLabel}`
            setAttr(itemVisBtn, "aria-label", itemVisBtn.title)

            const itemUp = qs<HTMLButtonElement>(itemRow, '[data-nav-item-move="up"]')!
            const itemDown = qs<HTMLButtonElement>(itemRow, '[data-nav-item-move="down"]')!
            setAttr(itemUp, "aria-disabled", String(idx === 0))
            setAttr(itemDown, "aria-disabled", String(idx === keys.length - 1))

            const itemDel = qs<HTMLButtonElement>(itemRow, "[data-nav-item-delete]")!
            itemDel.hidden = !customEntry

            itemsList.append(itemRow)
          })
        }

        const countEl = qs<HTMLElement>(details, "[data-nav-fields-count]")
        if (countEl) countEl.textContent = `${visibleCount}/${keys.length} visible`

        frag.append(sectionRow)
      })

      list!.replaceChildren(frag)
      syncLinkSectionOptions()
      syncNotices()
    }

    // Delegated clicks inside the unified tree
    list.addEventListener("click", event => {
      const btn = (event.target as Element | null)?.closest<HTMLButtonElement>("button")
      if (!btn) return

      const itemRow = btn.closest<HTMLElement>("[data-nav-item-row]")
      if (itemRow?.dataset.navItemRow) {
        const key = itemRow.dataset.navItemRow
        if (btn.hasAttribute("data-nav-item-rename")) {
          const customEntry = draftConfig.customItems.find(c => c.id === key)
          const defLabel = customEntry?.label || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key
          const curLabel = draftConfig.itemLabels[key] || defLabel
          startInlineRename(itemRow, curLabel, defLabel, nextLabel => {
            draftConfig = renameItem(draftConfig, key, nextLabel)
            renderTree()
          })
          return
        }
        if (btn.hasAttribute("data-nav-item-vis")) {
          draftConfig = toggleItemVisibility(draftConfig, key)
          renderTree()
          return
        }
        if (btn.dataset.navItemMove && btn.getAttribute("aria-disabled") !== "true") {
          draftConfig = moveItemByStep(draftConfig, key, btn.dataset.navItemMove === "up" ? -1 : 1)
          renderTree()
          return
        }
        if (btn.hasAttribute("data-nav-item-delete")) {
          draftConfig = unpinCustomItem(draftConfig, key)
          renderTree()
          return
        }
        return
      }

      const sectionRow = btn.closest<HTMLElement>("[data-nav-section-row]")
      const sectionId = sectionRow?.dataset.navSectionRow
      if (!sectionRow || !sectionId) return

      if (btn.hasAttribute("data-nav-section-rename")) {
        const defLabel = defaultSectionLabel(sectionId)
        const curLabel = draftConfig.sectionLabels[sectionId] || defLabel
        startInlineRename(sectionRow, curLabel, defLabel, nextLabel => {
          draftConfig = renameSection(draftConfig, sectionId, nextLabel)
          renderTree()
        })
        return
      }
      if (btn.hasAttribute("data-nav-section-vis")) {
        draftConfig = toggleSectionVisibility(draftConfig, sectionId)
        renderTree()
        return
      }
      if (btn.dataset.navSectionMove && btn.getAttribute("aria-disabled") !== "true") {
        draftConfig = moveSectionByStep(draftConfig, sectionId, btn.dataset.navSectionMove === "up" ? -1 : 1)
        renderTree()
        return
      }
      if (btn.hasAttribute("data-nav-section-delete") && !isBuiltinSidebarSectionId(sectionId)) {
        draftConfig = deleteSection(draftConfig, sectionId)
        renderTree()
      }
    }, { signal })

    bindSidebarHtmlDragReorder(list, signal, {
      sectionRowAttr: "data-nav-section-row",
      sectionGripAttr: "data-nav-section-drag",
      itemRowAttr: "data-nav-item-row",
      itemGripAttr: "data-nav-item-drag",
      dropAttr: "data-nav-drop",
      onSectionDrop: (dragId, targetId, after) => {
        draftConfig = reorderSections(draftConfig, dragId, targetId, after)
        renderTree()
      },
      onItemDrop: (dragId, targetKey, after) => {
        draftConfig = reorderItem(draftConfig, dragId, targetKey, after)
        renderTree()
      },
      onItemIntoSection: (dragId, targetSec) => {
        if (!isSidebarSectionId(targetSec)) return
        draftConfig = moveItemToSection(draftConfig, dragId, targetSec)
        renderTree()
      },
    })

    // Add Section form
    addSectionBtn?.addEventListener("click", () => setSectionFormOpen(Boolean(addSectionForm?.hidden)), { signal })
    addSectionCancel?.addEventListener("click", () => setSectionFormOpen(false), { signal })
    addSectionForm?.addEventListener("submit", event => {
      event.preventDefault()
      const input = addSectionForm.elements.namedItem("sectionLabel") as HTMLInputElement | null
      const clean = sanitizeLabel(input?.value ?? "")
      if (!clean) {
        if (addSectionError) { addSectionError.textContent = "Enter a name for the section."; addSectionError.hidden = false }
        input?.focus()
        return
      }
      const added = addSection(draftConfig, clean)
      draftConfig = added.config
      openState.set(added.sectionId, true)
      setSectionFormOpen(false)
      renderTree()
    }, { signal })

    // Add Custom Link form + Tabler Icon Picker
    addLinkBtn?.addEventListener("click", () => setLinkFormOpen(Boolean(addLinkForm?.hidden)), { signal })
    addLinkCancel?.addEventListener("click", () => setLinkFormOpen(false), { signal })
    addLinkForm?.addEventListener("click", event => {
      const choice = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-settings-icon-choice]")
      if (!choice?.dataset.settingsIconChoice) return
      const iconName = sanitizeCustomLinkIcon(choice.dataset.settingsIconChoice)
      const iconInput = addLinkForm.elements.namedItem("icon") as HTMLInputElement | null
      if (iconInput) iconInput.value = iconName
      addLinkForm.querySelectorAll<HTMLButtonElement>("[data-settings-icon-choice]").forEach(btn => {
        const selected = btn === choice
        btn.classList.toggle("is-selected", selected)
        setAttr(btn, "aria-pressed", String(selected))
      })
    }, { signal })

    addLinkForm?.addEventListener("submit", event => {
      event.preventDefault()
      const labelInput = addLinkForm.elements.namedItem("label") as HTMLInputElement | null
      const hrefInput = addLinkForm.elements.namedItem("href") as HTMLInputElement | null
      const iconInput = addLinkForm.elements.namedItem("icon") as HTMLInputElement | null
      const cleanLabel = sanitizeLabel(labelInput?.value ?? "")
      const rawHref = (hrefInput?.value ?? "").trim()
      const targetSec = addLinkSectionSelect?.value || "workspace"

      if (!cleanLabel) {
        if (addLinkError) { addLinkError.textContent = "Enter a label for the link."; addLinkError.hidden = false }
        labelInput?.focus()
        return
      }
      if (!isSafeCustomHref(rawHref)) {
        if (addLinkError) { addLinkError.textContent = "Enter a URL starting with https://, http://, or /."; addLinkError.hidden = false }
        hrefInput?.focus()
        return
      }
      draftConfig = pinCustomItem(
        draftConfig,
        {
          id: customLinkId(),
          label: cleanLabel,
          href: rawHref,
          icon: sanitizeCustomLinkIcon(iconInput?.value ?? "link"),
        },
        isSidebarSectionId(targetSec) ? targetSec : "workspace",
      )
      setLinkFormOpen(false)
      renderTree()
    }, { signal })

    // Clear personal browser override
    clearPersonalBtn?.addEventListener("click", () => {
      clearPersonalSidebarConfig()
      window.dispatchEvent(new CustomEvent(SIDEBAR_PERSONAL_CLEARED_EVENT))
      syncNotices()
      showToast("Personal browser override cleared — now using server default.")
    }, { signal })

    // Discard unsaved server-wide draft
    discardBtn?.addEventListener("click", () => {
      draftConfig = cloneConfig(serverCommitted)
      renderTree()
    }, { signal })

    // Save server-wide default
    if (saveBtn) {
      saveBtn.addEventListener("click", withAsyncButton(saveBtn, async () => {
        const payload = serializeSidebarConfig(draftConfig)
        await saveSetting("sidebar_config", payload)
        try { localStorage.removeItem(SIDEBAR_ORDER_STORAGE_KEY) } catch { /* Storage may be blocked. */ }
        serverCommitted = normalizeSidebarConfig(payload, SETTINGS_DEFAULT_KEYS)
        draftConfig = cloneConfig(serverCommitted)
        settingsStore.invalidate()
        window.dispatchEvent(new CustomEvent(SIDEBAR_SERVER_UPDATED_EVENT, { detail: payload }))
        renderTree()
        showToast("Server-wide navigation default saved.")
      }, { loadingText: "Saving…", onError: showSettingsSaveError }), { signal })
    }

    // Reset server-wide default to built-in defaults
    if (resetBtn) {
      resetBtn.addEventListener("click", withAsyncButton(resetBtn, async () => {
        const confirmed = await confirmDialog({
          message: "Reset the server-wide navigation default for all users? Custom sections, links, and reordering will be staged for removal.",
          variant: "warning",
        })
        if (!confirmed) return
        draftConfig = normalizeSidebarConfig(null, SETTINGS_DEFAULT_KEYS)
        renderTree()
        showToast("Built-in defaults staged — click Save server default to apply for all users.")
      }, { onError: showSettingsSaveError }), { signal })
    }

    window.addEventListener(SIDEBAR_CONFIG_UPDATED_EVENT, syncNotices, { signal })
    window.addEventListener(SIDEBAR_PERSONAL_CLEARED_EVENT, syncNotices, { signal })
    window.addEventListener("storage", event => {
      if (event.key === SIDEBAR_PERSONAL_STORAGE_KEY || event.key === null) syncNotices()
    }, { signal })

    renderTree()
  } catch (e) {
    log.error("Sidebar configuration error", e)
  }
}
