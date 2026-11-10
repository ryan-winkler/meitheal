/**
 * ColorPickerController — client-side logic for shared ColorPicker component
 *
 * Handles swatch selection, custom hex input with live preview,
 * custom color persistence, and picker show/hide via DropdownController.
 *
 * @domain shared/ui
 * @phase 17C — Shared Pickers
 */

import { DropdownController } from "../dropdown-controller"

/** Maximum number of saved custom colors */
const MAX_CUSTOM_COLORS = 10

/** Settings key for persisted custom colors */
const CUSTOM_COLORS_KEY = "custom_accent_colors"

/** Hex color validation regex */
const HEX_REGEX = /^#[0-9a-fA-F]{6}$/

export interface ColorPickerOptions {
  /** Callback when a color is selected */
  onSelect: (color: string) => void
  /** Current color value for pre-selection */
  currentValue?: string
}

/**
 * Initialize a color picker instance.
 * @param pickerId - DOM id of the color picker container
 * @param options - configuration
 * @returns cleanup function to tear down listeners
 */
export function initColorPicker(
  pickerId: string,
  options: ColorPickerOptions,
): () => void {
  const picker = document.getElementById(pickerId)
  if (!picker) return () => {}

  const swatches = picker.querySelectorAll<HTMLButtonElement>("[data-swatch-color]")
  const hexInput = picker.querySelector<HTMLInputElement>("[data-color-hex-input]")
  const hexPreview = picker.querySelector<HTMLSpanElement>("[data-color-hex-preview]")
  const addCustomBtn = picker.querySelector<HTMLButtonElement>("[data-color-add-custom]")
  const customContainer = picker.querySelector<HTMLElement>("[data-custom-colors]")
  const previewDot = picker.querySelector<HTMLSpanElement>("[data-color-preview-dot]")

  const ac = new AbortController()
  const { signal } = ac

  // --- Trigger button: click to show/hide dropdown ---
  const trigger = document.getElementById(`${pickerId}-trigger`)
  const dropdownCtrl = new DropdownController()

  trigger?.addEventListener("click", () => {
    if (dropdownCtrl.isShowing(picker)) {
      dropdownCtrl.hide()
    } else {
      dropdownCtrl.show(picker, trigger)
    }
  }, { signal })

  // Sync aria-expanded when DropdownController hides via outside-click/Escape
  const observer = new MutationObserver(() => {
    const expanded = !picker.hidden
    trigger?.setAttribute("aria-expanded", String(expanded))
  })
  observer.observe(picker, { attributes: true, attributeFilter: ["hidden"] })

  // Load custom colors
  loadCustomColors()

  // Pre-select current value
  if (options.currentValue) {
    selectColor(options.currentValue, false)
  }

  // --- Swatch selection ---
  swatches.forEach((swatch) => {
    swatch.addEventListener("click", () => {
      const color = swatch.dataset.swatchColor
      if (color) {
        selectColor(color, true)
      }
    }, { signal })
  })

  // --- Hex input ---
  hexInput?.addEventListener("input", () => {
    const val = hexInput.value.trim()
    if (HEX_REGEX.test(val)) {
      if (hexPreview) hexPreview.style.background = val
      if (previewDot) previewDot.style.background = val
      hexInput.classList.remove("invalid")
    } else if (val.length >= 7) {
      hexInput.classList.add("invalid")
    }
  }, { signal })

  hexInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      const val = hexInput.value.trim()
      if (HEX_REGEX.test(val)) {
        selectColor(val, true)
      }
    }
  }, { signal })

  // --- Add custom color ---
  addCustomBtn?.addEventListener("click", async () => {
    const val = hexInput?.value.trim()
    if (!val || !HEX_REGEX.test(val)) return

    await saveCustomColor(val)
    selectColor(val, true)
    renderCustomColors()
  }, { signal })

  // --- Helpers ---

  function selectColor(color: string, notify: boolean) {
    // Update swatch selection state
    swatches.forEach((s) => {
      s.classList.toggle("selected", s.dataset.swatchColor === color)
    })

    // Update custom color selection
    picker?.querySelectorAll<HTMLButtonElement>("[data-custom-swatch]").forEach((s) => {
      s.classList.toggle("selected", s.dataset.customSwatch === color)
    })

    // Update hex input
    if (hexInput) hexInput.value = color
    if (hexPreview) hexPreview.style.background = color
    if (previewDot) previewDot.style.background = color

    if (notify) options.onSelect(color)
  }

  async function loadCustomColors() {
    try {
      const res = await fetch("/api/settings")
      if (!res.ok) return
      const data = await res.json()
      const raw = data[CUSTOM_COLORS_KEY]
      if (raw) {
        renderCustomColors(JSON.parse(raw))
      }
    } catch {
      // Settings may not be available yet
    }
  }

  function renderCustomColors(colors?: string[]) {
    if (!customContainer) return

    let colorList = colors
    if (!colorList) {
      // Read from DOM
      const existing = customContainer.querySelectorAll<HTMLButtonElement>("[data-custom-swatch]")
      colorList = Array.from(existing).map((s) => s.dataset.customSwatch || "")
    }

    customContainer.replaceChildren()
    colorList.forEach((color) => {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "picker-swatch"
      btn.dataset.customSwatch = color
      btn.style.background = color
      btn.title = color
      btn.setAttribute("aria-label", `Custom color ${color}`)
      if (options.currentValue === color || hexInput?.value === color) {
        btn.classList.add("selected")
      }
      btn.addEventListener("click", () => selectColor(color, true), { signal })
      customContainer.appendChild(btn)
    })
  }

  async function saveCustomColor(color: string) {
    try {
      const res = await fetch("/api/settings")
      if (!res.ok) return
      const data = await res.json()
      const raw = data[CUSTOM_COLORS_KEY]
      let colors: string[] = raw ? JSON.parse(raw) : []

      // Don't duplicate
      if (colors.includes(color)) return

      // Enforce max
      colors = [color, ...colors].slice(0, MAX_CUSTOM_COLORS)

      await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [CUSTOM_COLORS_KEY]: JSON.stringify(colors) }),
      })
    } catch {
      // Best-effort — custom colors are non-critical
    }
  }

  return () => {
    ac.abort()
    observer.disconnect()
    dropdownCtrl.hide()
  }
}

/** Shared DropdownController instance for color pickers */
let sharedCtrl: DropdownController | null = null

/** Show a color picker anchored to a trigger element */
export function showColorPicker(pickerId: string, trigger: HTMLElement): void {
  if (!sharedCtrl) sharedCtrl = new DropdownController()
  const picker = document.getElementById(pickerId)
  if (picker) sharedCtrl.show(picker, trigger)
}

/** Hide the currently active color picker */
export function hideColorPicker(): void {
  sharedCtrl?.hide()
}
