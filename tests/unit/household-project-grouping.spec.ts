import { expect, test } from "@playwright/test"

import { getHouseholdProjectGroup, getHouseholdProjectLabels } from "../../apps/web/src/lib/household-project-grouping"

const key = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase()

test("Project headings are unique after qualifiers render, including adversarial raw titles and empty IDs", () => {
  const projects = [
    { id: "1", title: "Repairs", area_id: "workshop" },
    { id: "2", title: " REPAIRS ", area_id: "workshop" },
    { id: "3", title: "Repairs · #1 · Workshop", area_id: null },
    { id: "4", title: "No Project", area_id: null },
    { id: "5", title: "Unknown Project", area_id: null },
    { id: "", title: "Empty ID", area_id: null },
  ]
  const labels = getHouseholdProjectLabels(projects, { workshop: "Workshop" })
  const rendered = Object.values(labels).map(label => key([label.title, label.qualifier].filter(Boolean).join(" · ")))
  expect(new Set(rendered).size).toBe(rendered.length)
  expect(labels["project-"]).toEqual({ title: "No Project" })
  expect(Object.keys(labels)).toHaveLength(7)
  expect(getHouseholdProjectLabels([...projects].reverse(), { workshop: "Workshop" })).toEqual(labels)
  expect(labels["project-1"]?.qualifier).toBe("#1 · Workshop ·")
})

test("Project qualifiers start with stable identity before long Areas and preserve direct Area precedence", () => {
  const projects = [
    { id: "first-shared00", title: "Work", area_id: "missing", goal_id: "goal" },
    { id: "second-shared00", title: "Work", area_id: null, goal_id: "goal" },
    { id: "independent-3", title: "Work", area_id: "direct", goal_id: "goal" },
  ]
  const longArea = "An unusually long inherited Area name that remains useful in a tooltip"
  const labels = getHouseholdProjectLabels(projects, { inherited: longArea, direct: "Direct" }, new Map([["goal", "inherited"]]))
  expect(labels["project-first-shared00"]?.qualifier).toBe("#first-shared00")
  expect(labels["project-second-shared00"]?.qualifier).toBe(`#second-shared00 · ${longArea}`)
  expect(labels["project-independent-3"]?.qualifier).toBe("#endent-3 · Direct")
  const additional = getHouseholdProjectLabels([...projects, { id: "unrelated", title: "Other", area_id: null }], { inherited: longArea, direct: "Direct" }, new Map([["goal", "inherited"]]))
  expect(additional["project-independent-3"]).toEqual(labels["project-independent-3"])
})

test("Localized fallback labels participate in collisions and never reveal unavailable project IDs", () => {
  const labels = getHouseholdProjectLabels([
    { id: "known", title: "Gan Tionscadal", area_id: null },
    { id: "other", title: "Tionscadal Anaithnid", area_id: null },
  ], {}, undefined, { none: "Gan Tionscadal", unknown: "Tionscadal Anaithnid" })
  expect(labels["project-"]).toEqual({ title: "Gan Tionscadal" })
  expect(labels["unavailable-project"]).toEqual({ title: "Tionscadal Anaithnid" })
  expect(labels["project-known"]?.qualifier).toBe("#known")
  expect(labels["project-other"]?.qualifier).toBe("#other")
  for (const id of ["retired", "__proto__", "constructor"]) {
    expect(getHouseholdProjectGroup(id, labels)).toBe("unavailable-project")
  }
  expect(getHouseholdProjectGroup("known", labels)).toBe("project-known")
  expect(getHouseholdProjectGroup(null, labels)).toBe("project-")
  expect(getHouseholdProjectGroup("", labels)).toBe("project-")
})
