import {
  avatarContrastForeground,
  isThemeAvatarColor,
  normalizeUserProfile,
  profileInitials,
  profileSubtitle,
  validateUserProfile,
  type UserProfile,
} from "@domains/auth/user-profile"
import { showToast } from "@lib/toast"
import { SIDEBAR_EDIT_MODE_EVENT } from "@lib/sidebar-order"
import { TOUR_START_EVENT } from "@lib/tour-steps"

async function openProfileTablerModal(modal: HTMLElement, trigger: HTMLElement): Promise<void> {
  const { openTablerModal } = await import("@lib/tabler-modal")
  await openTablerModal(modal, trigger)
}

function closeProfileTablerModal(modal: HTMLElement): void {
  if (!modal.classList.contains("show")) return
  void import("@lib/tabler-modal").then(({ closeTablerModal }) => closeTablerModal(modal))
}

export const USER_PROFILE_UPDATED_EVENT = "meitheal:user-profile-updated"

function paintAvatarElement(el: HTMLElement, initials: string, avatarColor: string): void {
  el.textContent = initials
  if (isThemeAvatarColor(avatarColor)) {
    el.dataset.avatarMode = "theme"
    el.style.removeProperty("background-color")
    el.style.removeProperty("color")
  } else {
    el.dataset.avatarMode = "custom"
    el.style.backgroundColor = avatarColor
    el.style.color = avatarContrastForeground(avatarColor)
  }
}

function applyProfileToDom(profile: UserProfile): void {
  const initials = profileInitials(profile)
  const subtitle = profileSubtitle(profile)

  document.querySelectorAll<HTMLElement>("[data-user-profile-avatar]").forEach(el => {
    paintAvatarElement(el, initials, profile.avatarColor)
  })
  document.querySelectorAll<HTMLElement>("[data-user-profile-name]").forEach(el => {
    el.textContent = profile.displayName
  })
  document.querySelectorAll<HTMLElement>("[data-user-profile-subtitle]").forEach(el => {
    el.textContent = subtitle
  })
  const trigger = document.getElementById("sidebar-user-trigger")
  if (trigger) {
    trigger.dataset.tooltip = `${profile.displayName} (${subtitle}) — Edit profile`
  }
}

function placePopover(popoverEl: HTMLElement, anchorEl: HTMLElement, fallbackWidth: number, fallbackHeight: number): void {
  const rect = anchorEl.getBoundingClientRect()
  const popoverWidth = popoverEl.offsetWidth || fallbackWidth
  const popoverHeight = popoverEl.offsetHeight || fallbackHeight
  const margin = 12
  const isNavbar = document.documentElement.dataset.appearanceNavigation === "navbar" && window.innerWidth > 768

  if (isNavbar || rect.top < popoverHeight + 24) {
    const left = Math.max(margin, Math.min(rect.right - popoverWidth, window.innerWidth - popoverWidth - margin))
    popoverEl.style.left = `${Math.round(left)}px`
    popoverEl.style.top = `${Math.round(Math.min(rect.bottom + 8, window.innerHeight - popoverHeight - margin))}px`
    popoverEl.style.bottom = "auto"
    popoverEl.style.transformOrigin = "top right"
    return
  }

  const fitsRight = rect.right + 10 + popoverWidth <= window.innerWidth - margin
  if (fitsRight && window.innerWidth > 768) {
    popoverEl.style.left = `${Math.round(rect.right + 10)}px`
    popoverEl.style.bottom = `${Math.max(margin, Math.round(window.innerHeight - rect.bottom))}px`
    popoverEl.style.top = "auto"
    popoverEl.style.transformOrigin = "bottom left"
  } else {
    const left = Math.max(margin, Math.min(rect.right - popoverWidth, window.innerWidth - popoverWidth - margin))
    const bottom = Math.min(window.innerHeight - popoverHeight - margin, window.innerHeight - rect.top + 8)
    popoverEl.style.left = `${Math.round(left)}px`
    popoverEl.style.bottom = `${Math.max(margin, Math.round(bottom))}px`
    popoverEl.style.top = "auto"
    popoverEl.style.transformOrigin = "bottom right"
  }
}

export function bindSidebarUserMenu(sidebar: HTMLElement, pageSignal: AbortSignal): void {
  const runtime = window as typeof window & { __meithealSidebarUserMenu?: AbortController }
  runtime.__meithealSidebarUserMenu?.abort()
  const localController = new AbortController()
  runtime.__meithealSidebarUserMenu = localController
  const signal = AbortSignal.any([pageSignal, localController.signal])

  const footer = sidebar.querySelector<HTMLElement>("[data-sidebar-user-footer]")
  if (!footer) return
  const trigger = footer.querySelector<HTMLButtonElement>("#sidebar-user-trigger")
  const utilityTrigger = footer.querySelector<HTMLButtonElement>("#nav-utility-trigger")
  const portalHost = document.body
  const utilityPopover = sidebar.querySelector<HTMLElement>("#nav-utility-popover")
    ?? document.getElementById("nav-utility-popover")
  const modal = sidebar.querySelector<HTMLElement>("#sidebar-profile-modal")
    ?? document.getElementById("sidebar-profile-modal")
  const form = modal?.querySelector<HTMLFormElement>("#sidebar-profile-form") ?? null
  const modalPortal = modal?.closest<HTMLElement>(".tabler-surface") ?? modal

  // Remove any orphaned duplicate portals left behind by earlier navigations.
  document.querySelectorAll<HTMLElement>("[data-sidebar-user-portal]").forEach(stale => {
    if (stale !== utilityPopover && stale !== modalPortal) stale.remove()
  })

  // Keep closed portals docked inside #sidebar so Astro transition:persist="sidebar" preserves them.
  function dockUtility() {
    if (!utilityPopover) return
    utilityPopover.hidden = true
    utilityTrigger?.setAttribute("aria-expanded", "false")
    if (utilityPopover.parentElement !== sidebar) {
      sidebar.appendChild(utilityPopover)
    }
  }

  function dockModal() {
    if (!modal || !modalPortal) return
    modal.classList.remove("show")
    modal.style.display = "none"
    modal.setAttribute("aria-hidden", "true")
    modal.removeAttribute("aria-modal")
    if (modalPortal.parentElement !== sidebar) {
      sidebar.appendChild(modalPortal)
    }
  }

  if (utilityPopover) {
    utilityPopover.setAttribute("data-sidebar-user-portal", "utility")
    utilityPopover.setAttribute("data-sidebar-board-owner", footer.id || "sidebar-footer")
    dockUtility()
  }
  if (modalPortal) {
    modalPortal.setAttribute("data-sidebar-user-portal", "modal")
    if (modalPortal.parentElement !== sidebar && !modal?.classList.contains("show")) {
      sidebar.appendChild(modalPortal)
    }
  }

  let currentProfile: UserProfile = normalizeUserProfile(footer.dataset.userProfile)

  const isUtilityOpen = () => Boolean(utilityPopover && !utilityPopover.hidden)

  function setUtilityOpen(open: boolean, restoreFocus = false) {
    if (!utilityPopover || !utilityTrigger) return
    if (open) {
      window.dispatchEvent(new CustomEvent("meitheal:nav-submenu-open", { detail: { id: "nav-utility" } }))
      if (utilityPopover.parentElement !== portalHost) {
        portalHost.appendChild(utilityPopover)
      }
      utilityPopover.hidden = false
      utilityTrigger.setAttribute("aria-expanded", "true")
      placePopover(utilityPopover, utilityTrigger, 256, 290)
      requestAnimationFrame(() => {
        if (isUtilityOpen()) placePopover(utilityPopover, utilityTrigger, 256, 290)
      })
      utilityPopover.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true })
    } else {
      dockUtility()
      if (restoreFocus) utilityTrigger.focus({ preventScroll: true })
    }
  }

  if (utilityTrigger && utilityPopover) {
    utilityTrigger.addEventListener("click", event => {
      event.stopPropagation()
      setUtilityOpen(!isUtilityOpen())
    }, { signal })

    window.addEventListener("meitheal:nav-submenu-open", event => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id !== "nav-utility" && isUtilityOpen()) setUtilityOpen(false)
    }, { signal })

    utilityPopover.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest("[data-utility-link]")) {
        setUtilityOpen(false)
        return
      }
      const actionBtn = target?.closest<HTMLButtonElement>("[data-utility-action]")
      if (!actionBtn) return
      const action = actionBtn.dataset.utilityAction
      setUtilityOpen(false)
      if (action === "edit-menu") {
        window.dispatchEvent(new CustomEvent(SIDEBAR_EDIT_MODE_EVENT, { detail: { active: true } }))
      } else if (action === "add-link") {
        window.dispatchEvent(new CustomEvent(SIDEBAR_EDIT_MODE_EVENT, { detail: { active: true, openAddLink: true } }))
      } else if (action === "shortcuts") {
        const shortcutModal = document.getElementById("shortcut-modal")
        if (shortcutModal) {
          shortcutModal.classList.remove("hidden")
          shortcutModal.querySelector<HTMLElement>("#shortcut-modal-close")?.focus()
        }
      } else if (action === "start-tour") {
        window.dispatchEvent(new CustomEvent(TOUR_START_EVENT))
      }
    }, { signal })

    utilityPopover.addEventListener("keydown", event => {
      if (!isUtilityOpen()) return
      const items = Array.from(utilityPopover.querySelectorAll<HTMLElement>("[role='menuitem']"))
      const currentIndex = items.indexOf(document.activeElement as HTMLElement)
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        setUtilityOpen(false, true)
      } else if (event.key === "ArrowDown" && items.length) {
        event.preventDefault()
        items[(currentIndex + 1) % items.length]?.focus()
      } else if (event.key === "ArrowUp" && items.length) {
        event.preventDefault()
        items[(currentIndex - 1 + items.length) % items.length]?.focus()
      }
    }, { signal })

    document.addEventListener("click", event => {
      const target = event.target as Node | null
      if (isUtilityOpen() && target && !utilityPopover.contains(target) && !utilityTrigger.contains(target)) {
        setUtilityOpen(false)
      }
    }, { signal })

    window.addEventListener("resize", () => {
      if (isUtilityOpen()) placePopover(utilityPopover, utilityTrigger, 256, 290)
    }, { signal })
  }

  if (trigger && modal && form && modalPortal) {
    let handleManuallyEdited = false

    const deriveHandleFromDisplayName = (rawName: string): string => {
      const slug = rawName
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 32)
      return slug
    }

    function syncModalPreview() {
      const nameInput = form!.querySelector<HTMLInputElement>("#profile-display-name")
      const userInput = form!.querySelector<HTMLInputElement>("#profile-handle")
      const roleInput = form!.querySelector<HTMLInputElement>("#profile-role")
      const colorInput = form!.querySelector<HTMLInputElement>("#profile-avatar-color")
      const previewAvatar = modal!.querySelector<HTMLElement>("[data-profile-preview-avatar]")
      const previewName = modal!.querySelector<HTMLElement>("[data-profile-preview-name]")
      const previewSubtitle = modal!.querySelector<HTMLElement>("[data-profile-preview-subtitle]")

      const draft = normalizeUserProfile({
        displayName: nameInput?.value || currentProfile.displayName,
        username: userInput?.value || currentProfile.username,
        role: roleInput?.value ?? "",
        avatarColor: colorInput?.value || currentProfile.avatarColor,
      })

      if (previewAvatar) paintAvatarElement(previewAvatar, profileInitials(draft), draft.avatarColor)
      if (previewName) previewName.textContent = draft.displayName
      if (previewSubtitle) previewSubtitle.textContent = profileSubtitle(draft)

      form!.querySelectorAll<HTMLButtonElement>("[data-avatar-swatch]").forEach(btn => {
        const active = btn.dataset.avatarSwatch?.toLowerCase() === draft.avatarColor.toLowerCase()
        btn.classList.toggle("is-selected", active)
        btn.setAttribute("aria-pressed", String(active))
      })
    }

    function openProfileModal() {
      if (isUtilityOpen()) setUtilityOpen(false)
      window.dispatchEvent(new CustomEvent("meitheal:nav-submenu-open", { detail: { id: "profile-modal" } }))
      if (modalPortal!.parentElement !== portalHost) {
        portalHost.appendChild(modalPortal!)
      }
      // Clear any stale Tabler modal backdrop left by interrupted transitions.
      document.querySelectorAll<HTMLElement>("[data-meitheal-tabler-modal].show").forEach(stale => {
        if (stale !== modal) {
          stale.classList.remove("show")
          stale.style.display = "none"
        }
      })
      if (!modal!.classList.contains("show")) {
        document.querySelectorAll(".modal-backdrop").forEach(backdrop => backdrop.remove())
        document.body.classList.remove("modal-open")
      }
      const nameInput = form!.querySelector<HTMLInputElement>("#profile-display-name")
      const userInput = form!.querySelector<HTMLInputElement>("#profile-handle")
      const roleInput = form!.querySelector<HTMLInputElement>("#profile-role")
      const colorInput = form!.querySelector<HTMLInputElement>("#profile-avatar-color")
      const errorEl = form!.querySelector<HTMLElement>("[data-profile-form-error]")

      if (nameInput) nameInput.value = currentProfile.displayName
      if (userInput) userInput.value = currentProfile.username
      if (roleInput) roleInput.value = currentProfile.role
      if (colorInput) colorInput.value = currentProfile.avatarColor
      // Auto-sync handle on display name edits until user explicitly edits handle
      handleManuallyEdited = false
      if (errorEl) {
        errorEl.hidden = true
        errorEl.textContent = ""
      }

      syncModalPreview()
      void openProfileTablerModal(modal!, trigger!)
    }

    modal.addEventListener("hidden.bs.modal", () => {
      if (modalPortal.parentElement !== sidebar) {
        sidebar.appendChild(modalPortal)
      }
    }, { signal })

    // Clicking the profile card directly opens Edit Profile (no duplicate popover)
    trigger.addEventListener("click", event => {
      event.stopPropagation()
      openProfileModal()
    }, { signal })

    modal.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest("[data-profile-modal-close]")) {
        closeProfileTablerModal(modal)
        return
      }
      const swatch = target.closest<HTMLButtonElement>("[data-avatar-swatch]")
      if (swatch?.dataset.avatarSwatch) {
        const colorInput = form.querySelector<HTMLInputElement>("#profile-avatar-color")
        if (colorInput) colorInput.value = swatch.dataset.avatarSwatch
        syncModalPreview()
      }
    }, { signal })

    form.addEventListener("input", event => {
      const target = event.target instanceof HTMLInputElement ? event.target : null
      const userInput = form.querySelector<HTMLInputElement>("#profile-handle")
      if (target?.id === "profile-handle") {
        handleManuallyEdited = target.value.trim().length > 0
      } else if (target?.id === "profile-display-name" && userInput && !handleManuallyEdited) {
        const derived = deriveHandleFromDisplayName(target.value)
        if (derived) userInput.value = derived
      }
      syncModalPreview()
    }, { signal })

    form.addEventListener("submit", async event => {
      event.preventDefault()
      const nameInput = form.querySelector<HTMLInputElement>("#profile-display-name")
      const userInput = form.querySelector<HTMLInputElement>("#profile-handle")
      const roleInput = form.querySelector<HTMLInputElement>("#profile-role")
      const colorInput = form.querySelector<HTMLInputElement>("#profile-avatar-color")
      const submitBtn = modal.querySelector<HTMLButtonElement>("[data-profile-save-btn]")
      const errorEl = form.querySelector<HTMLElement>("[data-profile-form-error]")

      const result = validateUserProfile({
        displayName: nameInput?.value,
        username: userInput?.value,
        role: roleInput?.value,
        avatarColor: colorInput?.value,
      })

      if (!result.ok) {
        if (errorEl) {
          errorEl.textContent = result.message
          errorEl.hidden = false
        }
        nameInput?.focus()
        return
      }

      if (errorEl) {
        errorEl.hidden = true
        errorEl.textContent = ""
      }

      const originalText = submitBtn?.textContent ?? "Save profile"
      if (submitBtn) {
        submitBtn.disabled = true
        submitBtn.classList.add("btn-loading")
        submitBtn.textContent = "Saving…"
      }

      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "user_profile", value: result.profile }),
        })
        if (!res.ok) throw new Error("Failed to save profile")

        currentProfile = result.profile
        footer.dataset.userProfile = JSON.stringify(currentProfile)
        applyProfileToDom(currentProfile)
        window.dispatchEvent(new CustomEvent(USER_PROFILE_UPDATED_EVENT, { detail: currentProfile }))
        closeProfileTablerModal(modal)
        showToast("sidebar.profile_saved", "success")
      } catch {
        if (errorEl) {
          errorEl.textContent = "Could not save profile right now. Please try again."
          errorEl.hidden = false
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false
          submitBtn.classList.remove("btn-loading")
          submitBtn.textContent = originalText
        }
      }
    }, { signal })
  }

  signal.addEventListener("abort", () => {
    dockUtility()
    if (modal?.classList.contains("show")) closeProfileTablerModal(modal)
    dockModal()
    document.querySelectorAll(".modal-backdrop").forEach(backdrop => backdrop.remove())
    document.body.classList.remove("modal-open")
  }, { once: true })
}
