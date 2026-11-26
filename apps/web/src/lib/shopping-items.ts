/**
 * Pure shopping list domain helpers — Grocy-compatible quantity units,
 * configurable categories, CSV/JSON/newline import parsing, and item formatting.
 *
 * @domain tasks / shopping / grocy
 */
import { SHOPPING_CATEGORIES } from "@meitheal/domain-tasks"

export const SHOPPING_UNITS = [
  { value: "pcs", label: "pcs (Piece)" },
  { value: "bag", label: "bag (Bag)" },
  { value: "box", label: "box (Box)" },
  { value: "pack", label: "pack (Pack)" },
  { value: "bottle", label: "bottle (Bottle)" },
  { value: "can", label: "can (Can)" },
  { value: "jar", label: "jar (Jar)" },
  { value: "carton", label: "carton (Carton)" },
  { value: "bunch", label: "bunch (Bunch)" },
  { value: "loaf", label: "loaf (Loaf)" },
  { value: "lb", label: "lb (Pound)" },
  { value: "oz", label: "oz (Ounce)" },
  { value: "kg", label: "kg (Kilogram)" },
  { value: "g", label: "g (Gram)" },
  { value: "L", label: "L (Liter)" },
  { value: "ml", label: "ml (Milliliter)" },
] as const

export type ShoppingUnitValue = typeof SHOPPING_UNITS[number]["value"]

export interface ShoppingCategoryOption {
  slug: string
  label: string
}

export interface ShoppingItemRecord {
  name: string
  qty: number
  unit: string
  category: string
  checked?: boolean
}

export const SHOPPING_CATEGORIES_SETTING_KEY = "shopping_categories"
export const SHOPPING_CATEGORIES_CHANGED_EVENT = "meitheal:shopping-categories-changed"

const DEFAULT_CATEGORY_LABELS: Record<string, string> = {
  produce: "Produce",
  dairy: "Dairy",
  meat: "Meat & Fish",
  bakery: "Bakery",
  pantry: "Pantry",
  frozen: "Frozen",
  household: "Household",
  beverages: "Beverages",
  personal: "Personal Care",
  other: "Other",
}

export function defaultShoppingCategories(): ShoppingCategoryOption[] {
  return SHOPPING_CATEGORIES.map(slug => ({
    slug,
    label: DEFAULT_CATEGORY_LABELS[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1),
  }))
}

export function slugifyShoppingCategory(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

export function normalizeShoppingCategories(raw: unknown): ShoppingCategoryOption[] {
  const defaults = defaultShoppingCategories()
  if (!raw) return defaults

  let list: unknown[] = []
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (!trimmed) return defaults
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) list = parsed
      else return parseShoppingCategoriesImport(trimmed)
    } catch {
      return parseShoppingCategoriesImport(trimmed)
    }
  } else if (Array.isArray(raw)) {
    list = raw
  } else {
    return defaults
  }

  const seen = new Set<string>()
  const normalized: ShoppingCategoryOption[] = []
  for (const entry of list) {
    let label = ""
    let slug = ""
    if (typeof entry === "string") {
      label = entry.trim().slice(0, 48)
      slug = slugifyShoppingCategory(label)
    } else if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>
      const rawLabel = typeof rec.label === "string"
        ? rec.label
        : typeof rec.name === "string"
          ? rec.name
          : typeof rec.slug === "string"
            ? rec.slug
            : ""
      label = rawLabel.trim().slice(0, 48)
      slug = typeof rec.slug === "string" && rec.slug.trim()
        ? slugifyShoppingCategory(rec.slug)
        : slugifyShoppingCategory(label)
    }
    if (!slug || !label || seen.has(slug)) continue
    seen.add(slug)
    normalized.push({ slug, label })
    if (normalized.length >= 100) break
  }

  return normalized.length > 0 ? normalized : defaults
}

/**
 * Parse uploaded or pasted shopping categories from JSON, CSV, or newline/comma text.
 * Supports Grocy product group exports (`[{ id, name }]`, `["Produce", ...]`, or CSV with `name` header).
 */
export function parseShoppingCategoriesImport(text: string): ShoppingCategoryOption[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).categories)
          ? (parsed as Record<string, unknown>).categories as unknown[]
          : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).product_groups)
            ? (parsed as Record<string, unknown>).product_groups as unknown[]
            : []
      if (arr.length > 0) {
        const seen = new Set<string>()
        const out: ShoppingCategoryOption[] = []
        for (const item of arr) {
          const label = typeof item === "string"
            ? item.trim().slice(0, 48)
            : item && typeof item === "object"
              ? String((item as Record<string, unknown>).label ?? (item as Record<string, unknown>).name ?? "").trim().slice(0, 48)
              : ""
          const slug = slugifyShoppingCategory(label)
          if (!slug || !label || seen.has(slug)) continue
          seen.add(slug)
          out.push({ slug, label })
          if (out.length >= 100) break
        }
        return out
      }
    } catch {
      // Fall through to line/CSV parser
    }
  }

  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const seen = new Set<string>()
  const out: ShoppingCategoryOption[] = []

  // Detect CSV with header row like "id,name,description" or "name,slug"
  let nameColumnIndex = -1
  if (lines.length > 1 && lines[0]!.includes(",")) {
    const headerCols = lines[0]!.split(",").map(col => col.replace(/^["']|["']$/g, "").trim().toLowerCase())
    const idx = headerCols.findIndex(c => c === "name" || c === "label" || c === "category" || c === "product_group")
    if (idx >= 0) nameColumnIndex = idx
  }

  const startLine = nameColumnIndex >= 0 ? 1 : 0
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]!
    const tokens = nameColumnIndex >= 0
      ? [line.split(",")[nameColumnIndex] ?? ""]
      : line.includes(",") && !line.includes(";")
        ? line.split(",")
        : [line]
    for (const token of tokens) {
      const label = token.replace(/^["']|["']$/g, "").trim().slice(0, 48)
      const slug = slugifyShoppingCategory(label)
      if (!slug || !label || seen.has(slug)) continue
      seen.add(slug)
      out.push({ slug, label })
      if (out.length >= 100) return out
    }
  }
  return out
}

export function clampShoppingQty(raw: unknown, fallback = 1): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim())
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(999, Math.round(n))
}

export function normalizeShoppingUnit(raw: unknown): string {
  if (typeof raw !== "string") return "pcs"
  const trimmed = raw.trim().slice(0, 24)
  if (!trimmed) return "pcs"
  const match = SHOPPING_UNITS.find(u => u.value.toLowerCase() === trimmed.toLowerCase())
  return match ? match.value : trimmed
}

export function formatShoppingItemSummary(item: { name: string; qty?: number | string; unit?: string }): string {
  const name = item.name.trim()
  const qty = clampShoppingQty(item.qty, 1)
  const unit = normalizeShoppingUnit(item.unit)
  if (unit && unit !== "pcs") {
    return `${qty} ${unit} ${name}`.trim()
  }
  return qty > 1 ? `${qty}× ${name}`.trim() : name
}

let cachedCategories: { value: ShoppingCategoryOption[]; fetchedAt: number } | null = null

export function invalidateShoppingCategoriesCache(): void {
  cachedCategories = null
}

export async function loadShoppingCategories(signal?: AbortSignal): Promise<ShoppingCategoryOption[]> {
  if (typeof window !== "undefined") {
    const rawFromSettings = (window.mSettings as Record<string, unknown> | undefined)?.[SHOPPING_CATEGORIES_SETTING_KEY]
    if (rawFromSettings) {
      return normalizeShoppingCategories(rawFromSettings)
    }
  }
  const now = Date.now()
  if (cachedCategories && now - cachedCategories.fetchedAt < 30_000) {
    return cachedCategories.value
  }
  try {
    const res = await fetch(`/api/settings?key=${encodeURIComponent(SHOPPING_CATEGORIES_SETTING_KEY)}`, {
      cache: "no-store",
      signal,
    })
    if (res.ok) {
      const data = await res.json().catch(() => null) as { value?: unknown } | null
      const parsed = normalizeShoppingCategories(data?.value)
      cachedCategories = { value: parsed, fetchedAt: now }
      return parsed
    }
  } catch {
    // Fall back to defaults offline
  }
  return defaultShoppingCategories()
}
