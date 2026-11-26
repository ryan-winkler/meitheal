import { expect, test } from "@playwright/test"

import {
  createDefaultEntityFormLayoutConfig,
  createDefaultTaskDetailBaseConfigForKind,
  createDefaultTaskDetailLayoutConfig,
  hasCuratedTaskKindDefault,
  hasPersonalTaskDetailLayout,
  isEntityFormLayoutEqual,
  isEntityFormLayoutScope,
  isTaskDetailBaseLayoutEqual,
  isTaskDetailLayoutEqual,
  isTaskKindLayoutScope,
  normalizeEntityFormLayoutConfig,
  normalizeTaskDetailLayoutConfig,
  readPersonalTaskDetailLayout,
  readServerTaskDetailLayoutFromJson,
  readTaskDetailLayout,
  resetTaskDetailLayout,
  resolveEffectiveEntityFormLayout,
  resolveEffectiveTaskDetailLayout,
  resolveEffectiveTaskDetailLayoutForKind,
  savePersonalTaskDetailLayout,
  saveTaskDetailOrder,
  taskDetailLayoutChange,
  taskDetailLayoutKey,
} from "../../apps/web/src/lib/task-detail-layout"

test("legacy and structured task settings keep valid ordering, visibility, and labels", () => {
  const legacy = {
    sections: ["comments", "unknown", 3, "comments", "description"],
    properties: ["priority", "due", "status"],
  }
  const defaults = createDefaultTaskDetailLayoutConfig()
  const normalized = normalizeTaskDetailLayoutConfig(legacy)
  expect(normalized.orders.sections).toEqual([
    "comments", "description", "properties", "scheduling", "metadata", "scoring",
    "checklists", "attachments", "relationships", "activity",
  ])
  expect(normalized.orders.properties).toEqual([
    "priority", "status", ...defaults.orders.properties.filter(id => id !== "priority" && id !== "status"),
  ])
  expect(readServerTaskDetailLayoutFromJson(JSON.stringify(legacy))).toEqual(normalized)

  const longLabel = "a".repeat(65)
  const structured = normalizeTaskDetailLayoutConfig({
    orders: legacy,
    hidden: {
      sections: ["activity", "priority", "activity", false],
      properties: ["assignee", "status", "assignee"],
      scheduling: ["activity"],
      metadata: "labels",
      unknown: ["description"],
    },
    labels: { description: " Task notes ", checklists: ` ${longLabel} `, importance: "   ", due: 4, unknown: "Other" },
  })
  expect(structured.orders).toEqual(normalized.orders)
  expect(structured.hidden).toEqual({ sections: ["activity"], properties: ["assignee", "status"] })
  expect(structured.labels).toEqual({ description: "Task notes", checklists: "a".repeat(60) })
  expect(normalizeTaskDetailLayoutConfig(structured)).toEqual(structured)
})

test("invalid persisted settings use defaults and unknown scopes are discarded", () => {
  const defaults = createDefaultTaskDetailLayoutConfig()
  for (const raw of [null, undefined, "bad", 8, [], { orders: [], hidden: [], labels: [], kinds: [], forms: [] }]) {
    expect(normalizeTaskDetailLayoutConfig(raw)).toEqual(defaults)
  }
  for (const raw of [null, undefined, "", "{invalid", "null", "[]", "3"]) {
    expect(readServerTaskDetailLayoutFromJson(raw)).toBeNull()
  }
  expect(normalizeTaskDetailLayoutConfig({ kinds: { default: {}, unknown: {} }, forms: { unknown: {} } })).toEqual(defaults)
  expect(isTaskKindLayoutScope("shopping_item")).toBe(true)
  expect(isTaskKindLayoutScope("default")).toBe(false)
  expect(isTaskKindLayoutScope(null)).toBe(false)
  expect(isEntityFormLayoutScope("routine_form")).toBe(true)
  expect(isEntityFormLayoutScope("shopping_item")).toBe(false)
  expect(isEntityFormLayoutScope(1)).toBe(false)
})

test("specific task layouts use personal, then server, then curated settings", () => {
  const personal = normalizeTaskDetailLayoutConfig({
    labels: { description: "Personal notes" },
    kinds: { shopping_item: { sections: ["metadata"], hidden: { sections: ["comments"] } }, unknown: {} },
  })
  const server = normalizeTaskDetailLayoutConfig({
    labels: { description: "Household notes" },
    kinds: { shopping_item: { orders: { sections: ["attachments"] }, labels: { checklists: "Groceries" } } },
  })
  expect(Object.keys(personal.kinds ?? {})).toEqual(["shopping_item"])
  const shopping = resolveEffectiveTaskDetailLayoutForKind(personal, server, "shopping_item")
  expect(shopping.orders.sections[0]).toBe("metadata")
  expect(shopping.hidden).toEqual({ sections: ["comments"] })
  expect(shopping.labels).toEqual({})
  expect(resolveEffectiveTaskDetailLayoutForKind(null, server, "shopping_item").orders.sections[0]).toBe("attachments")

  const personalBase = normalizeTaskDetailLayoutConfig({ labels: personal.labels })
  expect(resolveEffectiveTaskDetailLayoutForKind(personalBase, server, "shopping_item").labels.checklists).toBe("Groceries")
  const curated = resolveEffectiveTaskDetailLayoutForKind(personalBase, null, "shopping_item")
  expect(curated.orders.sections[0]).toBe("checklists")
  expect(curated.hidden.metadata).toEqual(["color", "custom-fields"])
  expect(curated.labels.checklists).toBe("Shopping Items")
  expect(resolveEffectiveTaskDetailLayoutForKind(null, null, "calendar_event").labels.scheduling).toBe("Date & Recurrence")
  expect(hasCuratedTaskKindDefault("standard_action")).toBe(false)
  expect(createDefaultTaskDetailBaseConfigForKind("standard_action")).toEqual(createDefaultTaskDetailLayoutConfig())
  expect(resolveEffectiveTaskDetailLayoutForKind(personal, server, "standard_action").labels.description).toBe("Personal notes")
  expect(resolveEffectiveTaskDetailLayoutForKind(null, server, "unrecognized").labels.description).toBe("Household notes")
  expect(resolveEffectiveTaskDetailLayoutForKind(null, null)).toEqual(createDefaultTaskDetailLayoutConfig())
  expect(resolveEffectiveTaskDetailLayout(personal, server)).toEqual(personal)
  expect(resolveEffectiveTaskDetailLayout(null, server)).toEqual(server)
  expect(resolveEffectiveTaskDetailLayout(null, null)).toEqual(createDefaultTaskDetailLayoutConfig())
})

test("form customization only uses fields in the active form and falls back by scope", () => {
  const personal = normalizeTaskDetailLayoutConfig({
    forms: {
      goal_form: {
        order: ["description", "cadence", "description"],
        hidden: ["area", 8, "area", "manifesto"],
        labels: { title: " Household goal ", description: " ", area: 2, cadence: "Schedule" },
      },
      unsupported_form: { order: ["description"] },
    },
  })
  const server = normalizeTaskDetailLayoutConfig({ forms: { goal_form: { order: ["area"] }, routine_form: { order: ["cadence"] } } })
  expect(Object.keys(personal.forms ?? {})).toEqual(["goal_form"])
  expect(resolveEffectiveEntityFormLayout(personal, server, "goal_form")).toEqual({
    order: ["description", "title", "area"], hidden: ["area"], labels: { title: "Household goal" },
  })
  expect(resolveEffectiveEntityFormLayout(personal, server, "routine_form").order).toEqual([
    "cadence", "name", "icon", "priority", "area", "project", "description", "checklist",
  ])
  expect(resolveEffectiveEntityFormLayout(personal, server, "pillar_form")).toEqual({
    order: ["name", "manifesto", "appearance", "weight"], hidden: [], labels: {},
  })
  expect(normalizeEntityFormLayoutConfig("pillar_form", [])).toEqual(createDefaultEntityFormLayoutConfig("pillar_form"))
})

test("layout equality ignores visibility and label key order while comparing their meaning", () => {
  const base = normalizeTaskDetailLayoutConfig({
    hidden: { sections: ["activity", "comments"] },
    labels: { description: "Notes", due: "Deadline" },
    kinds: { checklist: { orders: { sections: ["checklists"] } } },
    forms: { goal_form: { hidden: ["area", "description"], labels: { title: "Household goal" } } },
  })
  const reordered = structuredClone(base)
  reordered.hidden.sections.reverse()
  reordered.labels = { due: "Deadline", description: "Notes" }
  reordered.forms!.goal_form!.hidden.reverse()
  expect(isTaskDetailLayoutEqual(base, reordered)).toBe(true)
  expect(reordered.hidden.sections).toEqual(["comments", "activity"])

  expect(isTaskDetailLayoutEqual(base, { ...reordered, orders: { ...base.orders, sections: ["comments"] } })).toBe(false)
  expect(isTaskDetailBaseLayoutEqual(base, { ...reordered, hidden: {} })).toBe(false)
  expect(isTaskDetailBaseLayoutEqual(base, { ...reordered, labels: { description: "Notes" } })).toBe(false)
  expect(isTaskDetailLayoutEqual(base, { ...reordered, labels: { ...reordered.labels, due: "Due by" } })).toBe(false)
  expect(isTaskDetailLayoutEqual(base, { ...reordered, kinds: {} })).toBe(false)
  expect(isTaskDetailLayoutEqual(base, { ...reordered, forms: {} })).toBe(false)
  reordered.kinds!.checklist!.orders.sections.reverse()
  expect(isTaskDetailLayoutEqual(base, reordered)).toBe(false)

  const form = base.forms!.goal_form!
  expect(isEntityFormLayoutEqual(form, { ...form, order: [...form.order].reverse() })).toBe(false)
  expect(isEntityFormLayoutEqual(form, { ...form, hidden: ["area"] })).toBe(false)
  expect(isEntityFormLayoutEqual(form, { ...form, labels: {} })).toBe(false)
  expect(isEntityFormLayoutEqual(form, { ...form, labels: { title: "Goal" } })).toBe(false)
})

test("saving one personal order retains kind and form settings and notifies the UI", () => {
  const values = new Map<string, string>()
  const windowFixture = new EventTarget()
  const globals = ["window", "localStorage"] as const
  const previous = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  let blocked = false
  let changes = 0
  windowFixture.addEventListener(taskDetailLayoutChange, () => { changes += 1 })
  const storage = {
    getItem: (key: string) => {
      if (blocked) throw new DOMException("Storage is blocked", "SecurityError")
      return values.get(key) ?? null
    },
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowFixture })
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
    expect(hasPersonalTaskDetailLayout()).toBe(false)
    expect(readPersonalTaskDetailLayout()).toBeNull()
    for (const corrupt of ["{broken", "[]"]) {
      values.set(taskDetailLayoutKey, corrupt)
      expect(readPersonalTaskDetailLayout()).toBeNull()
    }
    blocked = true
    expect(hasPersonalTaskDetailLayout()).toBe(false)
    expect(readPersonalTaskDetailLayout()).toBeNull()
    blocked = false

    const config = normalizeTaskDetailLayoutConfig({
      hidden: { sections: ["activity"] },
      kinds: { shopping_item: { sections: ["checklists"] } },
      forms: { goal_form: { order: ["description"] } },
    })
    savePersonalTaskDetailLayout(config)
    expect(hasPersonalTaskDetailLayout()).toBe(true)
    saveTaskDetailOrder("unknown", ["comments"])
    expect(changes).toBe(1)

    saveTaskDetailOrder("sections", ["comments", "unknown", "comments"])
    const saved = readPersonalTaskDetailLayout()
    expect(saved).toEqual({ ...config, orders: { ...config.orders, sections: ["comments", ...config.orders.sections.filter(id => id !== "comments")] } })
    expect(readTaskDetailLayout().get("sections")?.[0]).toBe("comments")
    expect(readTaskDetailLayout(null, "shopping_item").get("sections")?.[0]).toBe("checklists")
    expect(changes).toBe(2)

    resetTaskDetailLayout()
    expect(hasPersonalTaskDetailLayout()).toBe(false)
    expect(readTaskDetailLayout().get("sections")?.[0]).toBe("description")
    expect(changes).toBe(3)
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
