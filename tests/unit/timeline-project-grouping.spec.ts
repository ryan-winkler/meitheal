import { expect, test } from "@playwright/test"

import { getTimelineProjectGroup, getTimelineProjectLabels } from "../../apps/web/src/lib/timeline-project-grouping"

test("Timeline labels keep reserved and disambiguated titles distinct", () => {
  const projects = [
    { id: "1", title: "Repairs", area_id: "workshop" },
    { id: "2", title: "REPAIRS", area_id: null, goal_id: "goal-home" },
    { id: "3", title: "Repairs · Workshop", area_id: null },
    { id: "4", title: "No Project", area_id: "home", goal_id: "goal-workshop" },
    { id: "5", title: "Unknown Project", area_id: null },
    { id: "6", title: "Safe", area_id: "workshop" },
  ]
  const areas = { workshop: "Workshop", home: "Home" }
  const goals = new Map([["goal-home", "home"], ["goal-workshop", "workshop"]])
  const labels = getTimelineProjectLabels(projects, areas, goals)

  expect(labels).toEqual({
    "project-": { title: "No Project" },
    "unavailable-project": { title: "Unknown Project" },
    "project-1": { title: "Repairs", qualifier: "Workshop · 1" },
    "project-2": { title: "REPAIRS", qualifier: "Home" },
    "project-3": { title: "Repairs · Workshop" },
    "project-4": { title: "No Project", qualifier: "Home" },
    "project-5": { title: "Unknown Project", qualifier: "5" },
    "project-6": { title: "Safe" },
  })
  expect(getTimelineProjectLabels([...projects].reverse(), areas, goals)).toEqual(labels)
})

test("Timeline resolves unavailable IDs to a single opaque group", () => {
  const labels = getTimelineProjectLabels([{ id: "known", title: "Existing", area_id: null }], {})
  expect(getTimelineProjectGroup("known", labels)).toBe("project-known")
  expect(getTimelineProjectGroup(null, labels)).toBe("project-")
  expect(getTimelineProjectGroup("", labels)).toBe("project-")
  for (const id of ["retired", "__proto__", "constructor"]) {
    expect(getTimelineProjectGroup(id, labels)).toBe("unavailable-project")
  }
})
