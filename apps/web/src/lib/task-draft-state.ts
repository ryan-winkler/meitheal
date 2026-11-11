import { z } from "zod"
import { VALID_TASK_KINDS } from "@meitheal/domain-tasks"

export const taskDraftBodyLimit = 64 * 1024

const id = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/)
const reference = z.string().max(255)
const controlDate = z.string().max(64)
const label = z.string().min(1).max(100)
const labels = z.array(label).max(32)
const itemText = z.string().min(1).max(200)
const itemQuantity = z.number().int().min(1).max(999)
const priority = z.number().int().min(1).max(5)
const category = z.enum(["", "produce", "dairy", "meat", "pantry", "frozen", "beverages", "household", "other"])
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
const shoppingItems = z.array(z.strictObject({ name: itemText, qty: itemQuantity, category })).max(64)

export const taskDraftVersion = z.strictObject({
  draftId: id,
  revision: z.number().int().positive(),
})

export const taskDraftSnapshot = z.strictObject({
  version: z.literal(1),
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
  checklist: z.strictObject({ items: checklistItems, input: z.string().max(12864) }),
  shopping: z.strictObject({ items: shoppingItems, input: z.string().max(200), quantity: z.string().max(8), category }),
  event: z.strictObject({
    start: controlDate,
    end: controlDate,
    location: z.string().max(300),
    allDay: z.boolean(),
    calendar: reference,
  }),
  fields,
}).refine(snapshot => snapshot.newLabels.every(name => snapshot.labels.includes(name)))

const publishDate = z.iso.datetime({ local: true, offset: true }).max(64)
export const taskDraftPublication = z.strictObject({
  title: z.string().min(1).max(500),
  description: z.string().max(16384),
  task_kind: taskKind,
  status: z.string().regex(/^[a-z0-9_]{1,50}$/),
  priority,
  labels,
  catalogLabels: labels,
  newLabels: labels,
  due_date: publishDate.nullable(),
  assigned_to: reference.nullable(),
  goal_id: reference.nullable(),
  recurrence_rule: z.string().regex(/^[A-Z=;,0-9]{1,200}$/).optional(),
  checklists: checklistItems.optional(),
  custom_fields: z.strictObject({
    quantity: itemQuantity.optional(),
    category: category.optional(),
    items: shoppingItems.optional(),
    fields: fields.optional(),
  }).optional(),
  start_date: publishDate.optional(),
  end_date: publishDate.optional(),
  location: z.string().max(300).optional(),
  all_day: z.boolean().optional(),
  is_routine: z.boolean().optional(),
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
