import {
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

function applyProfileToDom(profile: UserProfile): void {
  const initials = profileInitials(profile)
  const subtitle = profileSubtitle(profile)

  document.querySelectorAll<HTMLElement>("[data-user-profile-avatar]").forEach(el => {
    el.textContent = initials
    el.style.backgroundColor = profile.avatarColor
  })
  document.querySelectorAll<HTMLElement>("[data-user-profile-name]").forEach(el => {
    el.textContent = profile.displayName
  })
  document.querySelectorAll<HTMLElement>("[data-user-profile-subtitle]").forEach(el => {
    el.textContent = subtitle
  })
  const trigger = document.getElementById("sidebar-user-trigger")
  if (trigger) {
    trigger.dataset.tooltip = `${profile.displayName} (${subtitle})`
    trigger.setAttribute("aria-label", `${profile.displayName} account menu`)
  }
}

export function bindSidebarUserMenu(sidebar: HTMLElement, signal: AbortSignal): void {
  const footer = sidebar.querySelector<HTMLElement>("[data-sidebar-user-footer]")
  const trigger = footer?.querySelector<HTMLButtonElement>("#sidebar-user-trigger")
  const portalHost = sidebar.closest<HTMLElement>(".layout-navigation") ?? document.body
  const popover = sidebar.querySelector<HTMLElement>("#sidebar-user-popover")
    ?? portalHost.querySelector<HTMLElement>("#sidebar-user-popover")
    ?? document.getElementById("sidebar-user-popover")
  const modal = sidebar.querySelector<HTMLElement>("#sidebar-profile-modal")
    ?? portalHost.querySelector<HTMLElement>("#sidebar-profile-modal")
    ?? document.getElementById("sidebar-profile-modal")
  const form = modal?.querySelector<HTMLFormElement>("#sidebar-profile-form")
  if (!footer || !trigger || !popover || !modal || !form) return

  // Escape #sidebar's fixed z-index:40 stacking context while staying inside
  // .layout-navigation[transition:persist="sidebar"] so Astro ClientRouter page
  // transitions never destroy the popover or modal when navigating to /tasks.
  const modalPortal = modal.closest<HTMLElement>(".tabler-surface") ?? modal
  document.querySelectorAll<HTMLElement>("[data-sidebar-user-portal]").forEach(stale => {
    if (stale !== popover && stale !== modalPortal) stale.remove()
  })
  if (popover.parentElement !== portalHost) {
    popover.setAttribute("data-sidebar-user-portal", "popover")
    portalHost.appendChild(popover)
  }
  if (modalPortal.parentElement !== portalHost) {
    modalPortal.setAttribute("data-sidebar-user-portal", "modal")
    portalHost.appendChild(modalPortal)
  }

  let currentProfile: UserProfile = normalizeUserProfile(footer.dataset.userProfile)
  let menuOpen = false

  function positionPopover() {
    if (!popover || !trigger) return
    const rect = trigger.getBoundingClientRect()
    const popoverWidth = popover.offsetWidth || 236
    const popoverHeight = popover.offsetHeight || 168
    const margin = 12

    // Place cleanly to the right of the sidebar footer (like Music Assistant) when room allows,
    // otherwise anchor directly above the footer card.
    const fitsRight = rect.right + 10 + popoverWidth <= window.innerWidth - margin
    if (fitsRight && window.innerWidth > 768) {
      popover.style.left = `${Math.round(rect.right + 10)}px`
      popover.style.bottom = `${Math.max(margin, Math.round(window.innerHeight - rect.bottom))}px`
      popover.style.top = "auto"
    } else {
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - popoverWidth - margin))
      const bottom = Math.min(window.innerHeight - popoverHeight - margin, window.innerHeight - rect.top + 8)
      popover.style.left = `${Math.round(left)}px`
      popover.style.bottom = `${Math.max(margin, Math.round(bottom))}px`
      popover.style.top = "auto"
    }
  }

  function setMenuOpen(open: boolean, restoreFocus = false) {
    menuOpen = open
    popover!.hidden = !open
    trigger!.setAttribute("aria-expanded", String(open))
    if (open) {
      positionPopover()
      // Pre-warm Tabler modal chunk so clicking Profile opens without noticeable delay.
      void import("@lib/tabler-modal")
      const firstAction = popover!.querySelector<HTMLElement>("[role='menuitem']")
      firstAction?.focus({ preventScroll: true })
    } else if (restoreFocus) {
      trigger!.focus({ preventScroll: true })
    }
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

    if (previewAvatar) {
      previewAvatar.textContent = profileInitials(draft)
      previewAvatar.style.backgroundColor = draft.avatarColor
    }
    if (previewName) previewName.textContent = draft.displayName
    if (previewSubtitle) previewSubtitle.textContent = profileSubtitle(draft)

    form!.querySelectorAll<HTMLButtonElement>("[data-avatar-swatch]").forEach(btn => {
      const active = btn.dataset.avatarSwatch?.toLowerCase() === draft.avatarColor.toLowerCase()
      btn.classList.toggle("is-selected", active)
      btn.setAttribute("aria-pressed", String(active))
    })
  }

  function openProfileModal() {
    setMenuOpen(false)
    const nameInput = form!.querySelector<HTMLInputElement>("#profile-display-name")
    const userInput = form!.querySelector<HTMLInputElement>("#profile-handle")
    const roleInput = form!.querySelector<HTMLInputElement>("#profile-role")
    const colorInput = form!.querySelector<HTMLInputElement>("#profile-avatar-color")
    const errorEl = form!.querySelector<HTMLElement>("[data-profile-form-error]")

    if (nameInput) nameInput.value = currentProfile.displayName
    if (userInput) userInput.value = currentProfile.username
    if (roleInput) roleInput.value = currentProfile.role
    if (colorInput) colorInput.value = currentProfile.avatarColor
    if (errorEl) {
      errorEl.hidden = true
      errorEl.textContent = ""
    }

    syncModalPreview()
    void openProfileTablerModal(modal!, trigger!)
  }

  // Trigger button toggles popover submenu
  trigger.addEventListener("click", event => {
    event.stopPropagation()
    setMenuOpen(!menuOpen)
  }, { signal })

  // Popover actions
  popover.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    const actionBtn = target?.closest<HTMLButtonElement>("[data-user-menu-action]")
    if (!actionBtn) return
    const action = actionBtn.dataset.userMenuAction
    if (action === "edit-profile") {
      openProfileModal()
    } else if (action === "edit-menu") {
      setMenuOpen(false)
      window.dispatchEvent(new CustomEvent(SIDEBAR_EDIT_MODE_EVENT, { detail: { active: true } }))
    } else if (action === "start-tour") {
      setMenuOpen(false)
      window.dispatchEvent(new CustomEvent(TOUR_START_EVENT))
    }
  }, { signal })

  // Keyboard navigation inside popover
  popover.addEventListener("keydown", event => {
    if (!menuOpen) return
    const items = Array.from(popover.querySelectorAll<HTMLButtonElement>("[role='menuitem']"))
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false, true)
    } else if (event.key === "ArrowDown" && items.length) {
      event.preventDefault()
      items[(currentIndex + 1) % items.length]?.focus()
    } else if (event.key === "ArrowUp" && items.length) {
      event.preventDefault()
      items[(currentIndex - 1 + items.length) % items.length]?.focus()
    }
  }, { signal })

  // Outside click closes popover
  document.addEventListener("click", event => {
    if (!menuOpen) return
    const target = event.target as Node | null
    if (target && !popover.contains(target) && !trigger.contains(target)) {
      setMenuOpen(false)
    }
  }, { signal })

  window.addEventListener("resize", () => {
    if (menuOpen) positionPopover()
  }, { signal })

  // Profile modal controls
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

  form.addEventListener("input", syncModalPreview, { signal })

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

  signal.addEventListener("abort", () => {
    setMenuOpen(false)
    closeProfileTablerModal(modal)
  }, { once: true })
}
