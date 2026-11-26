import { z } from "zod"
import { SHOPPING_CATEGORIES, VALID_TASK_KINDS } from "@meitheal/domain-tasks"

export const taskDraftBodyLimit = 64 * 1024

const id = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/)
const reference = z.string().max(255)
const controlDate = z.string().max(64)
const label = z.string().min(1).max(100)
const labels = z.array(label).max(32)
const itemText = z.string().min(1).max(200)
const itemQuantity = z.union([z.number().int().min(1).max(999), z.string().trim().min(1).max(32)])
const priority = z.number().int().min(1).max(5)
const category = z.string().trim().max(48)
const shoppingUnit = z.string().trim().max(24)
const taskKind = z.enum(VALID_TASK_KINDS)
const field = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["url", "text", "number", "date"]),
    value: z.string().max(1024),
  }),
  z.strictObject({
    type: z.literal("checkbox"),
    label: z.string().max(1024),
    checked: z.boolean(),
  }),
])
const fields = z.array(field).max(24)
const checklistItems = z.array(z.strictObject({ id, text: itemText, done: z.boolean() })).max(64)
const shoppingItems = z.array(z.strictObject({
  name: itemText,
  qty: itemQuantity,
  unit: shoppingUnit.optional(),
  category,
  checked: z.boolean().optional(),
})).max(64)

export const taskDraftVersion = z.strictObject({
  draftId: id,
  revision: z.number().int().positive(),
})

const placement = z.strictObject({ areaId: reference.nullable(), projectId: reference.nullable() })
const taskType = z.enum(["epic", "story", "task"])

export const taskDraftSnapshot = z.strictObject({
  version: z.literal(1),
  placement: placement.optional(),
  taskType: taskType.optional(),
  parentId: reference.nullable().optional(),
  parentTitle: z.string().max(500).optional(),
  parentType: taskType.optional(),
  parentTicketKey: z.string().max(100).nullable().optional(),
  title: z.string().max(500),
  description: z.string().max(16384),
  taskKind,
  status: z.string().max(64),
  priority,
  due: controlDate,
  labels,
  newLabels: labels,
  assignedTo: reference,
  goal: reference,
  recurrence: z.string().max(200),
  isRoutine: z.boolean(),
  urgency: z.number().int().min(0).max(5).optional(),
  importance: z.number().int().min(0).max(5).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  color: z.string().max(16).optional(),
  pillarId: reference.optional(),
  principleId: reference.optional(),
  boardCustomFields: z.record(z.string().max(60), z.string().max(1024)).optional(),
  checklist: z.strictObject({ items: checklistItems, input: z.string().max(12864) }),
  shopping: z.strictObject({
    items: shoppingItems,
    input: z.string().max(200),
    quantity: z.string().max(8),
    unit: shoppingUnit.optional(),
    category,
  }),
  event: z.strictObject({
    start: controlDate,
    end: controlDate,
    location: z.string().max(300),
    allDay: z.boolean(),
    calendar: reference,
  }),
  fields,
}).refine(snapshot => snapshot.newLabels.every(name => snapshot.labels.includes(name)))

const publishDate = z.union([z.iso.date(), z.iso.datetime({ local: true, offset: true }).max(64)])
export const taskDraftPublication = z.strictObject({
  placement: placement.optional(),
  task_type: taskType.optional(),
  parent_id: reference.nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(16384),
  task_kind: taskKind,
  status: z.string().regex(/^[a-z0-9_]{1,50}$/),
  priority,
  labels,
  catalogLabels: labels,
  newLabels: labels,
  due_date: publishDate.nullable().optional(),
  assigned_to: reference.nullable(),
  goal_id: reference.nullable(),
  recurrence_rule: z.string().regex(/^[A-Z=;,0-9]{1,200}$/).optional(),
  checklists: checklistItems.optional(),
  custom_fields: z.object({
    quantity: itemQuantity.optional(),
    category: category.optional(),
    items: shoppingItems.optional(),
    fields: fields.optional(),
  }).catchall(z.union([z.string().max(1024), z.number().finite(), z.boolean()]))
    .refine(record => {
      const keys = Object.keys(record)
      return keys.length <= 16 && keys.every(key =>
        key !== "__proto__" && key !== "constructor" && key !== "prototype" && key.length <= 60)
    }).optional(),
  start_date: publishDate.optional(),
  end_date: publishDate.optional(),
  location: z.string().max(300).optional(),
  home_assistant_area_id: z.string().min(1).max(150).optional(),
  all_day: z.boolean().optional(),
  is_routine: z.boolean().optional(),
  urgency: z.number().int().min(0).max(5).optional(),
  importance: z.number().int().min(0).max(5).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).nullable().optional(),
  pillar_id: reference.nullable().optional(),
  principle_id: reference.nullable().optional(),
  framework_payload: z.string().max(4096).optional(),
}).refine(task => task.catalogLabels.every(name => task.labels.includes(name) && !task.newLabels.includes(name))
  && task.newLabels.every(name => task.labels.includes(name)))

const saveSelector = z.strictObject({ kind: z.literal("save"), attemptId: id })
const publishSelector = taskDraftVersion.extend({ kind: z.literal("publish"), attemptId: id })
export const readTaskDraftRequest = z.strictObject({
  action: z.literal("read"),
  resolve: z.discriminatedUnion("kind", [saveSelector, publishSelector]).optional(),
})
export const writeTaskDraftRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("save"), expected: taskDraftVersion.nullable(), attemptId: id, snapshot: taskDraftSnapshot }),
  z.strictObject({ action: z.literal("discard"), expected: taskDraftVersion }),
  z.strictObject({ action: z.literal("publish"), expected: taskDraftVersion, attemptId: id, task: taskDraftPublication }),
  z.strictObject({ action: z.literal("abandon-publish"), expected: taskDraftVersion, attemptId: id }),
])

export type TaskDraftVersion = z.infer<typeof taskDraftVersion>
export type TaskDraftSnapshot = z.infer<typeof taskDraftSnapshot>
export type TaskDraftPublication = z.infer<typeof taskDraftPublication>
export type TaskDraftRead = z.infer<typeof readTaskDraftRequest>
export type TaskDraftWrite = z.infer<typeof writeTaskDraftRequest>

export interface SavedTaskDraft extends TaskDraftVersion {
  snapshot: TaskDraftSnapshot
  updatedAt: number
}

export interface TaskDraftReceipt extends TaskDraftVersion {
  taskId: string
  ticketKey: string | null
  publishedAt: number
}
