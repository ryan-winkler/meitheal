import { expect, test } from "@playwright/test"
import { quickAddPayload } from "../../apps/web/src/lib/quick-add"
import { parseTaskInput } from "../../apps/web/src/lib/nl-task-parser"

test("shopping and errand lists save checklist items the task detail can show", () => {
  for (const [text, title] of [["shopping: milk, eggs", "Shopping"], ["errand: post office, bank", "Errands"]] as const) {
    const { payload } = quickAddPayload(text)
    expect(payload.title).toBe(title)
    const items = JSON.parse(String(payload.checklists)) as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item).toMatchObject({ text: expect.any(String), done: false })
      expect(typeof item.id).toBe("string")
      expect(item).not.toHaveProperty("title")
    }
  }
})

test("an email address stays in the title instead of becoming an assignee", () => {
  expect(parseTaskInput("Reply to joe@example.com")).toMatchObject({ title: "Reply to joe@example.com", assignee: null })
  expect(parseTaskInput("Call @ryan.")).toMatchObject({ assignee: "ryan" })
  expect(parseTaskInput("Email joe@ryan.com @ryan")).toMatchObject({ title: "Email joe@ryan.com", assignee: "ryan" })
  expect(parseTaskInput("Fix bug #frontend @ryan p2")).toMatchObject({ title: "Fix bug", assignee: "ryan", priority: 2, labels: ["frontend"] })
})
