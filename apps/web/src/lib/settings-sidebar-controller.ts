/**
 * Sidebar settings controller.
 *
 * Uses the canonical `@domains/navigation/sidebar-menu` aggregate so Settings
 * and live Sidebar Edit Mode stay 100% in sync (DRY).
 */
import {
  DEFAULT_SIDEBAR_ITEM_LABELS,
  TASK_VIEW_ITEM_KEYS,
  defaultSectionLabel,
  isItemHidden,
  isSectionHidden,
  moveItemByStep,
  moveItemToSection,
  moveSectionByStep,
  normalizeSidebarConfig,
  renameItem,
  renameSection,
  serializeSidebarConfig,
  toggleItemVisibility,
  toggleSectionVisibility,
  type CustomNavItem,
  type SidebarMenuConfig,
  type SidebarSectionId,
} from "@domains/navigation/sidebar-menu"
import { withAsyncButton } from "@lib/async-button"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { saveSetting, showSettingsSaveError, log } from "@lib/settings-utils"
import { settingsStore } from "@lib/settings-store"
import {
  SIDEBAR_CONFIG_UPDATED_EVENT,
  SIDEBAR_EDIT_MODE_EVENT,
  SIDEBAR_ORDER_STORAGE_KEY,
} from "@lib/sidebar-order"

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
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, "0")).join("")
  return `custom-${id}`
}

let activeConfig: SidebarMenuConfig = normalizeSidebarConfig(null, SETTINGS_DEFAULT_KEYS)

export function initSidebarSettings(): void {
  // Wire all "Customize menu" buttons (Look & Feel + Navigation) to enter live Sidebar Edit Mode
  document.querySelectorAll<HTMLButtonElement>("[data-customize-sidebar-menu]").forEach(button => {
    pageLifecycle.on(button, "click", () => {
      window.dispatchEvent(new CustomEvent(SIDEBAR_EDIT_MODE_EVENT, { detail: { active: true } }))
    })
  })

  // Save sidebar config
  const saveSidebarBtn = document.getElementById("save-sidebar") as HTMLButtonElement | null
  if (saveSidebarBtn) {
    pageLifecycle.on(saveSidebarBtn, "click", withAsyncButton(saveSidebarBtn, async () => {
      const finalCustomItems: CustomNavItem[] = []
      document.querySelectorAll("#custom-links-list > div").forEach(row => {
        const label = (row.querySelector(".custom-item-label") as HTMLInputElement | null)?.value ?? ""
        const href = (row.querySelector(".custom-item-href") as HTMLInputElement | null)?.value ?? ""
        if (label.trim() || href.trim()) {
          finalCustomItems.push({
            id: (row as HTMLElement).dataset.customId || customLinkId(),
            label: label.trim() || "Link",
            href: href.trim() || "/",
            icon: "link",
          })
        }
      })

      const merged = normalizeSidebarConfig(
        {
          ...serializeSidebarConfig(activeConfig),
          customItems: finalCustomItems,
        },
        SETTINGS_DEFAULT_KEYS,
      )
      const payload = serializeSidebarConfig(merged)
      await saveSetting("sidebar_config", payload)
      try { localStorage.removeItem(SIDEBAR_ORDER_STORAGE_KEY) } catch { /* Storage may be blocked. */ }
      showToast("settings.sidebar_saved")
      settingsStore.invalidate()
      window.location.reload()
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }

  // Reset sidebar to defaults
  const resetSidebarBtn = document.getElementById("reset-sidebar") as HTMLButtonElement | null
  if (resetSidebarBtn) {
    pageLifecycle.on(resetSidebarBtn, "click", withAsyncButton(resetSidebarBtn, async () => {
      const confirmed = await confirmDialog({
        message: "Reset sidebar to default configuration? Custom links, section renames, and reordering will be lost.",
        variant: "warning",
      })
      if (!confirmed) return
      await saveSetting("sidebar_config", null)
      try { localStorage.removeItem(SIDEBAR_ORDER_STORAGE_KEY) } catch { /* Storage may be blocked. */ }
      showToast("Sidebar reset to defaults")
      settingsStore.invalidate()
      window.location.reload()
    }, { onError: showSettingsSaveError }))
  }

  // Add custom link
  const addCustomBtn = document.getElementById("add-custom-link-btn")
  if (addCustomBtn) {
    pageLifecycle.on(addCustomBtn, "click", () => {
      window.dispatchEvent(new CustomEvent("meitheal:sidebar-add-custom-link"))
    })
  }
}

export function restoreSidebarSettings(settings: Record<string, unknown>): void {
  try {
    const signal = pageLifecycle.signal
    activeConfig = normalizeSidebarConfig(settings.sidebar_config, SETTINGS_DEFAULT_KEYS)

    function renderSidebarList() {
      const list = document.getElementById("sidebar-item-list")
      if (!list) return
      list.replaceChildren()

      activeConfig.sectionOrder.forEach((sectionId: SidebarSectionId, sectionIdx: number) => {
        const sectionHidden = isSectionHidden(activeConfig, sectionId)
        const defaultSecLabel = defaultSectionLabel(sectionId)
        const secLabel = activeConfig.sectionLabels[sectionId] || defaultSecLabel

        const sectionCard = document.createElement("div")
        sectionCard.className = `sidebar-config-section${sectionHidden ? " sidebar-config-section--hidden" : ""}`
        sectionCard.dataset.sectionId = sectionId

        const header = document.createElement("div")
        header.className = "sidebar-config-section__header"

        const secVisLabel = document.createElement("label")
        secVisLabel.className = "sidebar-config-row__visibility"
        const secVisCb = document.createElement("input")
        secVisCb.type = "checkbox"
        secVisCb.checked = !sectionHidden
        secVisCb.setAttribute("aria-label", `Show ${defaultSecLabel} section in sidebar`)
        const secVisText = document.createElement("span")
        secVisText.textContent = `${defaultSecLabel} section`
        secVisLabel.append(secVisCb, secVisText)

        const secNameInput = document.createElement("input")
        secNameInput.type = "text"
        secNameInput.className = "form-input"
        secNameInput.value = secLabel
        secNameInput.placeholder = defaultSecLabel
        secNameInput.setAttribute("aria-label", `Section title for ${defaultSecLabel}`)

        const secMoves = document.createElement("div")
        secMoves.className = "sidebar-config-row__moves"
        const secUp = document.createElement("button")
        secUp.type = "button"
        secUp.className = "btn btn-ghost"
        secUp.textContent = "↑"
        secUp.disabled = sectionIdx === 0
        secUp.setAttribute("aria-label", `Move ${defaultSecLabel} section up`)
        const secDown = document.createElement("button")
        secDown.type = "button"
        secDown.className = "btn btn-ghost"
        secDown.textContent = "↓"
        secDown.disabled = sectionIdx === activeConfig.sectionOrder.length - 1
        secDown.setAttribute("aria-label", `Move ${defaultSecLabel} section down`)
        secMoves.append(secUp, secDown)

        secVisCb.addEventListener("change", () => {
          activeConfig = toggleSectionVisibility(activeConfig, sectionId)
          renderSidebarList()
        }, { signal })

        secNameInput.addEventListener("input", () => {
          activeConfig = renameSection(activeConfig, sectionId, secNameInput.value)
        }, { signal })

        secUp.addEventListener("click", () => {
          activeConfig = moveSectionByStep(activeConfig, sectionId, -1)
          renderSidebarList()
        }, { signal })

        secDown.addEventListener("click", () => {
          activeConfig = moveSectionByStep(activeConfig, sectionId, 1)
          renderSidebarList()
        }, { signal })

        header.append(secVisLabel, secNameInput, secMoves)
        sectionCard.append(header)

        const itemsContainer = document.createElement("div")
        itemsContainer.className = "sidebar-config-section__items"

        const sectionKeys = activeConfig.sectionItems[sectionId] ?? []
        sectionKeys.forEach((key, index) => {
          const itemHidden = isItemHidden(activeConfig, key)
          const customEntry = activeConfig.customItems.find(c => c.id === key)
          const defaultLabel = customEntry?.label || DEFAULT_SIDEBAR_ITEM_LABELS[key] || key
          const labelStr = activeConfig.itemLabels[key] || defaultLabel

          const row = document.createElement("div")
          row.className = "sidebar-config-row"
          row.dataset.itemKey = key

          const handle = document.createElement("span")
          handle.className = "drag-handle"
          handle.setAttribute("aria-hidden", "true")
          handle.textContent = "⋮⋮"

          const visLabel = document.createElement("label")
          visLabel.className = "sidebar-config-row__visibility"
          const visCb = document.createElement("input")
          visCb.type = "checkbox"
          visCb.className = "sidebar-visible-cb"
          visCb.dataset.key = key
          visCb.checked = !itemHidden
          visCb.setAttribute("aria-label", `Show ${defaultLabel} in sidebar`)
          const visText = document.createElement("span")
          visText.textContent = defaultLabel
          visLabel.append(visCb, visText)

          const labelInput = document.createElement("input")
          labelInput.type = "text"
          labelInput.className = "form-input sidebar-label-input"
          labelInput.dataset.key = key
          labelInput.setAttribute("aria-label", `Custom label for ${defaultLabel}`)
          labelInput.value = labelStr
          labelInput.placeholder = defaultLabel

          const moves = document.createElement("div")
          moves.className = "sidebar-config-row__moves"

          const sectionSelect = document.createElement("select")
          sectionSelect.className = "form-select"
          sectionSelect.style.minWidth = "110px"
          sectionSelect.setAttribute("aria-label", `Section for ${defaultLabel}`)
          for (const candidate of activeConfig.sectionOrder) {
            const opt = document.createElement("option")
            opt.value = candidate
            opt.textContent = activeConfig.sectionLabels[candidate] || defaultSectionLabel(candidate)
            opt.selected = candidate === sectionId
            sectionSelect.append(opt)
          }

          const upBtn = document.createElement("button")
          upBtn.type = "button"
          upBtn.className = "btn btn-ghost sidebar-order-up"
          upBtn.setAttribute("aria-label", `Move ${defaultLabel} up`)
          upBtn.disabled = index === 0
          upBtn.textContent = "↑"

          const downBtn = document.createElement("button")
          downBtn.type = "button"
          downBtn.className = "btn btn-ghost sidebar-order-down"
          downBtn.setAttribute("aria-label", `Move ${defaultLabel} down`)
          downBtn.disabled = index === sectionKeys.length - 1
          downBtn.textContent = "↓"

          moves.append(sectionSelect, upBtn, downBtn)
          row.append(handle, visLabel, labelInput, moves)

          visCb.addEventListener("change", () => {
            activeConfig = toggleItemVisibility(activeConfig, key)
          }, { signal })

          labelInput.addEventListener("input", () => {
            activeConfig = renameItem(activeConfig, key, labelInput.value)
          }, { signal })

          sectionSelect.addEventListener("change", () => {
            activeConfig = moveItemToSection(activeConfig, key, sectionSelect.value as SidebarSectionId)
            renderSidebarList()
          }, { signal })

          upBtn.addEventListener("click", () => {
            activeConfig = moveItemByStep(activeConfig, key, -1)
            renderSidebarList()
          }, { signal })

          downBtn.addEventListener("click", () => {
            activeConfig = moveItemByStep(activeConfig, key, 1)
            renderSidebarList()
          }, { signal })

          itemsContainer.append(row)
        })

        sectionCard.append(itemsContainer)
        list.append(sectionCard)
      })

      // Custom links rendering
      const customList = document.getElementById("custom-links-list")
      if (!customList) return
      customList.replaceChildren()

      activeConfig.customItems.forEach((item, index) => {
        const row = document.createElement("div")
        row.className = "sidebar-custom-link"
        row.dataset.customId = item.id

        const labelInput = document.createElement("input")
        labelInput.type = "text"
        labelInput.className = "form-input custom-item-label"
        labelInput.setAttribute("aria-label", "Custom link label")
        labelInput.placeholder = "Label"
        labelInput.value = item.label

        const hrefInput = document.createElement("input")
        hrefInput.type = "text"
        hrefInput.className = "form-input custom-item-href"
        hrefInput.setAttribute("aria-label", "Custom link URL")
        hrefInput.placeholder = "URL (e.g. /notes)"
        hrefInput.value = item.href

        const removeButton = document.createElement("button")
        removeButton.type = "button"
        removeButton.className = "btn btn-ghost text-danger remove-custom-link"
        removeButton.setAttribute("aria-label", `Remove custom link ${item.label}`)
        removeButton.dataset.index = String(index)
        removeButton.textContent = "×"

        row.append(labelInput, hrefInput, removeButton)

        labelInput.addEventListener("input", () => {
          item.label = labelInput.value
          removeButton.setAttribute("aria-label", `Remove custom link ${item.label}`)
        }, { signal })

        hrefInput.addEventListener("input", () => {
          item.href = hrefInput.value
        }, { signal })

        removeButton.addEventListener("click", () => {
          activeConfig = {
            ...activeConfig,
            customItems: activeConfig.customItems.filter((_, i) => i !== index),
          }
          renderSidebarList()
        }, { signal })

        customList.append(row)
      })
    }

    pageLifecycle.on(window, "meitheal:sidebar-add-custom-link", () => {
      const nextItem: CustomNavItem = { id: customLinkId(), label: "New Link", href: "/", icon: "link" }
      activeConfig = normalizeSidebarConfig(
        {
          ...serializeSidebarConfig(activeConfig),
          customItems: [...activeConfig.customItems, nextItem],
        },
        SETTINGS_DEFAULT_KEYS,
      )
      renderSidebarList()
    })

    // Sync immediately when user edits the sidebar live on the Settings page
    pageLifecycle.on(window, SIDEBAR_CONFIG_UPDATED_EVENT, event => {
      const detail = (event as CustomEvent<unknown>).detail
      activeConfig = normalizeSidebarConfig(detail, SETTINGS_DEFAULT_KEYS)
      renderSidebarList()
    })

    renderSidebarList()
  } catch (e) {
    log.error("Sidebar/custom fields error", e)
  }
}
