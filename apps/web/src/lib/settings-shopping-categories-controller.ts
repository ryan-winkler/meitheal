import { createSpriteIconElement } from "../generated/icon-registry"
import {
  defaultShoppingCategories,
  invalidateShoppingCategoriesCache,
  loadShoppingCategories,
  parseShoppingCategoriesImport,
  SHOPPING_CATEGORIES_CHANGED_EVENT,
  SHOPPING_CATEGORIES_SETTING_KEY,
  slugifyShoppingCategory,
  type ShoppingCategoryOption,
} from "./shopping-items"
import { settingsStore } from "./settings-store"
import { showToast } from "./toast"

export function initSettingsShoppingCategories(signal: AbortSignal): void {
  const root = document.getElementById("shopping-categories-editor")
  if (!root || root.dataset.shoppingCatReady === "true") return
  root.dataset.shoppingCatReady = "true"
  signal.addEventListener("abort", () => {
    delete root.dataset.shoppingCatReady
  }, { once: true })

  const listEl = document.getElementById("shopping-cat-list")
  const addForm = document.getElementById("shopping-cat-add-form") as HTMLFormElement | null
  const addInput = document.getElementById("shopping-cat-new-input") as HTMLInputElement | null
  const fileInput = document.getElementById("shopping-cat-file-input") as HTMLInputElement | null
  const resetBtn = document.getElementById("shopping-cat-reset-btn") as HTMLButtonElement | null
  const pasteInput = document.getElementById("shopping-cat-paste-input") as HTMLTextAreaElement | null
  const mergeBtn = document.getElementById("shopping-cat-merge-btn") as HTMLButtonElement | null
  const replaceBtn = document.getElementById("shopping-cat-replace-btn") as HTMLButtonElement | null
  const statusEl = document.getElementById("shopping-cat-status")

  let categories: ShoppingCategoryOption[] = defaultShoppingCategories()

  const setStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text
  }

  async function persist(next: ShoppingCategoryOption[], successMessage: string) {
    const clean = next.slice(0, 100)
    try {
      await settingsStore.saveSetting(SHOPPING_CATEGORIES_SETTING_KEY, JSON.stringify(clean))
    } catch {
      if (!signal.aborted) showToast("Could not save shopping categories", "error")
      return
    }
    if (signal.aborted) return
    categories = clean
    invalidateShoppingCategoriesCache()
    if (window.mSettings) {
      ;(window.mSettings as Record<string, unknown>)[SHOPPING_CATEGORIES_SETTING_KEY] = JSON.stringify(clean)
    }
    window.dispatchEvent(new CustomEvent(SHOPPING_CATEGORIES_CHANGED_EVENT, { detail: { categories: clean } }))
    render()
    setStatus(successMessage)
    showToast(successMessage, "success")
  }

  function render() {
    if (!listEl) return
    listEl.replaceChildren(
      ...categories.map((cat) => {
        const chip = document.createElement("div")
        chip.className = "shopping-cat-chip"
        chip.setAttribute("role", "listitem")

        const label = document.createElement("span")
        label.className = "shopping-cat-chip__label"
        label.textContent = cat.label
        label.title = `${cat.label} (${cat.slug})`

        const removeBtn = document.createElement("button")
        removeBtn.type = "button"
        removeBtn.className = "shopping-cat-chip__remove"
        removeBtn.setAttribute("aria-label", `Remove ${cat.label}`)
        removeBtn.title = `Remove ${cat.label}`
        removeBtn.replaceChildren(createSpriteIconElement("x", { size: 13 }))
        removeBtn.addEventListener("click", () => {
          const next = categories.filter(c => c.slug !== cat.slug)
          if (next.length === 0) {
            showToast("Keep at least one category or reset to defaults", "warning")
            return
          }
          void persist(next, `Removed "${cat.label}"`)
        }, { signal })

        chip.append(label, removeBtn)
        return chip
      }),
    )
  }

  addForm?.addEventListener("submit", (event) => {
    event.preventDefault()
    const raw = addInput?.value.trim() ?? ""
    if (!raw) return
    const slug = slugifyShoppingCategory(raw)
    if (!slug) return
    if (categories.some(c => c.slug === slug)) {
      showToast(`"${raw}" is already in your shopping categories`, "warning")
      return
    }
    const next = [...categories, { slug, label: raw.slice(0, 48) }]
    if (addInput) addInput.value = ""
    void persist(next, `Added "${raw}"`)
  }, { signal })

  const applyImported = (imported: ShoppingCategoryOption[], mode: "merge" | "replace") => {
    if (imported.length === 0) {
      showToast("No valid categories found in import", "warning")
      return
    }
    if (mode === "replace") {
      void persist(imported, `Imported ${imported.length} shopping categories`)
      return
    }
    const seen = new Set(categories.map(c => c.slug))
    const merged = [...categories]
    let added = 0
    for (const item of imported) {
      if (seen.has(item.slug)) continue
      seen.add(item.slug)
      merged.push(item)
      added++
    }
    if (added === 0) {
      showToast("All imported categories are already listed", "info")
      return
    }
    void persist(merged, `Added ${added} shopping ${added === 1 ? "category" : "categories"}`)
  }

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    try {
      if (file.size > 128 * 1024) {
        showToast("Category file must be 128 KiB or smaller", "error")
        return
      }
      const text = await file.text()
      if (signal.aborted) return
      const imported = parseShoppingCategoriesImport(text)
      applyImported(imported, "merge")
    } catch {
      showToast("Could not read category file", "error")
    } finally {
      fileInput.value = ""
    }
  }, { signal })

  mergeBtn?.addEventListener("click", () => {
    const imported = parseShoppingCategoriesImport(pasteInput?.value ?? "")
    applyImported(imported, "merge")
    if (pasteInput && imported.length > 0) pasteInput.value = ""
  }, { signal })

  replaceBtn?.addEventListener("click", () => {
    const imported = parseShoppingCategoriesImport(pasteInput?.value ?? "")
    applyImported(imported, "replace")
    if (pasteInput && imported.length > 0) pasteInput.value = ""
  }, { signal })

  resetBtn?.addEventListener("click", () => {
    void persist(defaultShoppingCategories(), "Shopping categories reset to defaults")
  }, { signal })

  void loadShoppingCategories(signal).then((loaded) => {
    if (signal.aborted) return
    categories = loaded
    render()
    setStatus(`${loaded.length} categories ready for Shopping Lists & Grocy product groups.`)
  })
}
