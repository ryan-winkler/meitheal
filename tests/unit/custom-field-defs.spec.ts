import { expect, test } from "@playwright/test"
import { cardCustomFieldLabel, kanbanCardFieldNames } from "../../apps/web/src/lib/custom-field-defs"

test("Kanban cards list the built-in fields in canonical order", () => {
  expect(kanbanCardFieldNames([])).toEqual(["sprint", "story_points"])
})

test("Kanban cards deduplicate names case-insensitively and keep the first spelling", () => {
  expect(kanbanCardFieldNames([
    { name: "Sprint", type: "text" },
    { name: "Review URL", type: "url" },
    { name: "review url", type: "text" },
    { name: "STORY_POINTS", type: "number" },
    { name: "Release owner", type: "text" },
    { name: "RELEASE OWNER", type: "select", options: ["Primary"] },
  ])).toEqual(["sprint", "story_points", "Review URL", "Release owner"])
})

test("Kanban cards use readable built-in labels and preserve custom labels", () => {
  expect(["sprint", "story_points", "Review URL"].map(cardCustomFieldLabel))
    .toEqual(["Sprint", "Story points", "Review URL"])
})
