/**
 * glass-dropdown.ts
 *
 * Client-side script to manage glassmorphic dropdowns.
 * Handles click-to-open, click-outside-to-close, and accessibility bindings.
 */

let _globalClickAttached = false

export function initGlassDropdowns() {
  const dropdowns = document.querySelectorAll<HTMLElement>(".glass-dropdown")

  dropdowns.forEach((dropdown) => {
    // Only initialize once
    if (dropdown.dataset.initialized === "true") return
    dropdown.dataset.initialized = "true"

    const trigger = dropdown.querySelector(".glass-dropdown__trigger")
    const content = dropdown.querySelector(".glass-dropdown__content")
    
    // Often the trigger contains a button, we want that button specifically for aria-expanded
    const triggerBtn = trigger?.querySelector("button") || trigger

    if (!trigger || !content) return

    // Toggle menu
    trigger.addEventListener("click", (e) => {
      e.preventDefault()
      const isOpen = content.classList.contains("is-open")
      
      // Close all other dropdowns first
      closeAllDropdowns()

      if (!isOpen) {
        content.classList.add("is-open")
        triggerBtn?.setAttribute("aria-expanded", "true")
        
        // Optional: Ensure it fits in viewport, though CSS position:absolute covers most
      }
    })

    // Handle clicks inside the menu
    content.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      // If they clicked an item (a button or link inside the menu)
      if (target.closest(".glass-dropdown__item")) {
        // Optionally close it after selection, or let the specific view handle logic
        // We'll close default items, but if it has `data-keep-open`, we do not
        const item = target.closest(".glass-dropdown__item") as HTMLElement
        if (item.dataset.keepOpen !== "true") {
          content.classList.remove("is-open")
          triggerBtn?.setAttribute("aria-expanded", "false")
        }
      }
    })
  })

  // Global click outside listener
  if (!_globalClickAttached) {
    _globalClickAttached = true
    document.addEventListener("click", (e) => {
      const target = e.target as Node
      const openDropdowns = document.querySelectorAll(".glass-dropdown__content.is-open")
      
      openDropdowns.forEach((content) => {
        const dropdown = content.closest(".glass-dropdown")
        if (dropdown && !dropdown.contains(target)) {
          content.classList.remove("is-open")
          const triggerBtn = dropdown.querySelector(".glass-dropdown__trigger button") || dropdown.querySelector(".glass-dropdown__trigger")
          triggerBtn?.setAttribute("aria-expanded", "false")
        }
      })
    })
  }
}

function closeAllDropdowns() {
  document.querySelectorAll(".glass-dropdown__content.is-open").forEach(content => {
    content.classList.remove("is-open")
    const dropdown = content.closest(".glass-dropdown")
    if (dropdown) {
      const triggerBtn = dropdown.querySelector(".glass-dropdown__trigger button") || dropdown.querySelector(".glass-dropdown__trigger")
      triggerBtn?.setAttribute("aria-expanded", "false")
    }
  })
}
