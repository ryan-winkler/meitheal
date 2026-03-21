/**
 * IconPickerController — client-side logic for shared IconPicker component
 *
 * Handles emoji tab switching, emoji selection, custom file upload (SVG/PNG),
 * and picker show/hide via DropdownController.
 *
 * @domain shared/ui
 * @phase 17C — Shared Pickers
 */

import { DropdownController } from "../dropdown-controller"

/** Maximum file size for uploaded icons (64KB) */
const MAX_FILE_SIZE = 64 * 1024

/** Maximum dimensions for raster icons (PNG) */
const MAX_ICON_DIM = 128

/** Allowed MIME types for icon upload */
const ALLOWED_MIME_TYPES = ["image/svg+xml", "image/png"]

/** SVG allowlisted tags — all others stripped during sanitization */
const SVG_SAFE_TAGS = new Set([
  "svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline",
  "polygon", "text", "tspan", "defs", "clippath", "mask", "use",
  "lineargradient", "radialgradient", "stop", "title", "desc",
])

/** SVG allowlisted attributes — all others stripped */
const SVG_SAFE_ATTRS = new Set([
  "viewbox", "xmlns", "width", "height", "fill", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "d", "cx", "cy", "r", "rx", "ry",
  "x", "y", "x1", "y1", "x2", "y2", "points", "transform", "opacity",
  "class", "id", "clip-path", "mask", "offset", "stop-color", "stop-opacity",
  "href", "xlink:href", "font-size", "font-family", "text-anchor",
  "dominant-baseline", "fill-rule", "clip-rule", "style",
])

export interface IconPickerOptions {
  /** Callback when an icon is selected (emoji string or data URI) */
  onSelect: (icon: string) => void
  /** Current icon value for pre-selection */
  currentValue?: string
}

/**
 * Initialize an icon picker instance.
 * @param pickerId - DOM id of the icon picker container
 * @param options - configuration
 * @returns cleanup function to tear down listeners
 */
export function initIconPicker(
  pickerId: string,
  options: IconPickerOptions,
): () => void {
  const picker = document.getElementById(pickerId)
  if (!picker) return () => {}

  const preview = picker.querySelector<HTMLSpanElement>("[data-icon-preview]")
  const hiddenInput = picker.querySelector<HTMLInputElement>("[data-icon-value]")
  const tabs = picker.querySelectorAll<HTMLButtonElement>("[data-emoji-tab]")
  const panels = picker.querySelectorAll<HTMLElement>("[data-emoji-panel]")
  const emojiButtons = picker.querySelectorAll<HTMLButtonElement>("[data-emoji-value]")
  const uploadInput = picker.querySelector<HTMLInputElement>("[data-icon-upload]")
  const uploadBtn = picker.querySelector<HTMLButtonElement>("[data-icon-upload-trigger]")

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

  // Pre-select current value
  if (options.currentValue) {
    setIcon(options.currentValue)
  }

  // --- Emoji tab switching ---
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const idx = tab.dataset.emojiTab
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.emojiTab === idx))
      panels.forEach((p) => p.classList.toggle("hidden", p.dataset.emojiPanel !== idx))
    }, { signal })
  })

  // --- Emoji button selection ---
  emojiButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const emoji = btn.dataset.emojiValue
      if (emoji) {
        setIcon(emoji)
        options.onSelect(emoji)
      }
    }, { signal })
  })

  // --- File upload trigger ---
  uploadBtn?.addEventListener("click", () => {
    uploadInput?.click()
  }, { signal })

  uploadInput?.addEventListener("change", async () => {
    const file = uploadInput.files?.[0]
    if (!file) return

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      dispatchToast("Only SVG and PNG files are allowed", "error")
      uploadInput.value = ""
      return
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      dispatchToast(`File too large (max ${MAX_FILE_SIZE / 1024}KB)`, "error")
      uploadInput.value = ""
      return
    }

    try {
      if (file.type === "image/svg+xml") {
        const text = await file.text()
        const sanitized = sanitizeSvg(text)
        if (!sanitized) {
          dispatchToast("Invalid SVG file", "error")
          uploadInput.value = ""
          return
        }
        const dataUri = `data:image/svg+xml;base64,${btoa(sanitized)}`
        setIcon(dataUri)
        options.onSelect(dataUri)
      } else {
        // PNG — validate dimensions
        const dataUri = await readFileAsDataUri(file)
        const valid = await validateImageDimensions(dataUri)
        if (!valid) {
          dispatchToast(`Image too large (max ${MAX_ICON_DIM}×${MAX_ICON_DIM}px)`, "error")
          uploadInput.value = ""
          return
        }
        setIcon(dataUri)
        options.onSelect(dataUri)
      }
    } catch {
      dispatchToast("Failed to process file", "error")
    }

    uploadInput.value = ""
  }, { signal })

  // --- Helpers ---
  function setIcon(value: string) {
    if (preview) {
      if (value.startsWith("data:")) {
        preview.innerHTML = ""
        const img = document.createElement("img")
        img.src = value
        img.alt = "Custom icon"
        img.style.width = "100%"
        img.style.height = "100%"
        img.style.objectFit = "contain"
        preview.appendChild(img)
      } else {
        preview.textContent = value
      }
    }
    if (hiddenInput) hiddenInput.value = value

    // Update selected state on emoji buttons
    emojiButtons.forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.emojiValue === value)
    })
  }

  function dispatchToast(message: string, type: string) {
    document.dispatchEvent(
      new CustomEvent("meitheal:toast", { detail: { message, type } }),
    )
  }

  // Cleanup
  return () => {
    ac.abort()
    observer.disconnect()
    dropdownCtrl.hide()
  }
}

/** Read a File as a data URI */
function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}

/** Validate image dimensions (max 128×128) */
function validateImageDimensions(dataUri: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.width <= MAX_ICON_DIM && img.height <= MAX_ICON_DIM)
    img.onerror = () => resolve(false)
    img.src = dataUri
  })
}

/** Sanitize SVG by stripping unsafe tags and attributes */
function sanitizeSvg(raw: string): string | null {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(raw, "image/svg+xml")
    const svg = doc.querySelector("svg")
    if (!svg) return null

    // Check for parser errors
    if (doc.querySelector("parsererror")) return null

    stripUnsafe(svg)
    return new XMLSerializer().serializeToString(svg)
  } catch {
    return null
  }
}

/** Recursively strip unsafe tags and attributes from an SVG element */
function stripUnsafe(el: Element): void {
  // Remove script elements and event handler attributes
  const children = Array.from(el.children)
  for (const child of children) {
    if (!SVG_SAFE_TAGS.has(child.tagName.toLowerCase())) {
      child.remove()
      continue
    }
    // Strip unsafe attributes
    const attrs = Array.from(child.attributes)
    for (const attr of attrs) {
      const name = attr.name.toLowerCase()
      if (name.startsWith("on") || !SVG_SAFE_ATTRS.has(name)) {
        child.removeAttribute(attr.name)
      }
    }
    // Strip javascript: URLs from href
    const href = child.getAttribute("href") || child.getAttribute("xlink:href")
    if (href?.toLowerCase().includes("javascript:")) {
      child.removeAttribute("href")
      child.removeAttribute("xlink:href")
    }
    stripUnsafe(child)
  }
}

/** Shared DropdownController instance for icon pickers */
let sharedCtrl: DropdownController | null = null

/** Show an icon picker anchored to a trigger element */
export function showIconPicker(pickerId: string, trigger: HTMLElement): void {
  if (!sharedCtrl) sharedCtrl = new DropdownController()
  const picker = document.getElementById(pickerId)
  if (picker) sharedCtrl.show(picker, trigger)
}

/** Hide the currently active icon picker */
export function hideIconPicker(): void {
  sharedCtrl?.hide()
}
