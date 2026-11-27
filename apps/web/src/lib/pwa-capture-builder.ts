/**
 * Pure payload & list helpers for the PWA Quick-Capture page (`/new`).
 *
 * Keeps Shopping List and Checklist item serialization decoupled and testable.
 * @domain tasks
 */

export interface QuickShoppingItem {
  id: string
  name: string
  qty: string
  category: string
  done: boolean
}

export interface QuickChecklistStep {
  id: string
  text: string
  done: boolean
}

export const SHOPPING_CATEGORIES = [
  { value: "produce", label: "Produce" },
  { value: "dairy", label: "Dairy" },
  { value: "meat", label: "Meat" },
  { value: "pantry", label: "Pantry" },
  { value: "frozen", label: "Frozen" },
  { value: "beverages", label: "Beverages" },
  { value: "household", label: "Household" },
  { value: "other", label: "Other" },
] as const

const PRIORITY_MAP: Record<string, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
  none: 5,
}

export function mapQuickCapturePriority(raw: string | undefined | null): number {
  if (!raw) return 3
  const num = Number(raw)
  if (Number.isInteger(num) && num >= 1 && num <= 5) return num
  return PRIORITY_MAP[raw.trim().toLowerCase()] ?? 3
}

export function buildQuickCapturePayload(input: {
  title: string
  kind: string
  description?: string
  priority?: string
  dueDate?: string
  shoppingItems?: QuickShoppingItem[]
  checklistSteps?: QuickChecklistStep[]
}): Record<string, unknown> {
  const title = input.title.trim()
  const taskKind = (input.kind || "standard_action").trim()
  const payload: Record<string, unknown> = {
    title,
    task_kind: taskKind,
    priority: mapQuickCapturePriority(input.priority),
  }

  const desc = input.description?.trim()
  if (desc) payload.description = desc
  if (input.dueDate?.trim()) payload.due_date = input.dueDate.trim()

  if (taskKind === "shopping_item") {
    const cleanItems = (input.shoppingItems ?? [])
      .map(item => ({
        name: item.name.trim(),
        qty: item.qty.trim() || "1",
        category: item.category.trim() || "other",
        done: Boolean(item.done),
      }))
      .filter(item => item.name.length > 0)

    if (cleanItems.length > 0) {
      payload.custom_fields = {
        items: cleanItems.map(({ name, qty, category, done }) => ({
          name,
          qty,
          category,
          checked: done,
        })),
      }
      payload.checklists = cleanItems.map((item, idx) => ({
        id: `shop_${idx + 1}_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20)}`,
        text: item.qty && item.qty !== "1" ? `${item.name} (${item.qty})` : item.name,
        done: item.done,
      }))
    }
  } else if (taskKind === "checklist") {
    const cleanSteps = (input.checklistSteps ?? [])
      .map(step => ({
        id: step.id,
        text: step.text.trim(),
        done: Boolean(step.done),
      }))
      .filter(step => step.text.length > 0)

    if (cleanSteps.length > 0) {
      payload.checklists = cleanSteps
    }
  }

  return payload
}
