import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { boardNavigationLinks, boardWorkspaceHref, readBoardWorkspaceSelection } from "./board-workspace"

describe("boardNavigationLinks", () => {
  it("routes planning to /planning#eisenhower and keeps board groups on /boards/:id?view=groups#groups", () => {
    const links = boardNavigationLinks({ boardId: "household" })
    assert.equal(links.planning, "/planning?board_id=household#eisenhower")
    assert.equal(links.groups, "/boards/household?view=groups#groups")
    assert.equal(links.tasks, "/boards/household#kanban")
    assert.equal(links.progress, "/progress?board_id=household#goals")
  })

  it("preserves project or area placement across planning and groups routes", () => {
    const withArea = boardNavigationLinks({ boardId: "household", area: "kitchen" })
    assert.equal(withArea.planning, "/planning?board_id=household&area_id=kitchen#eisenhower")
    assert.equal(withArea.groups, "/boards/household?view=groups&area=kitchen#groups")

    const withProject = boardNavigationLinks({ boardId: "household", area: "kitchen", project: "remodel" })
    assert.equal(withProject.planning, "/planning?board_id=household&project_id=remodel#eisenhower")
    assert.equal(withProject.groups, "/boards/household?view=groups&project=remodel#groups")
  })

  it("reads board workspace selection parameters accurately", () => {
    const selection = readBoardWorkspaceSelection(new URLSearchParams("view=groups&area=yard&ticket=MTH-6"))
    assert.equal(selection.planning, true)
    assert.equal(selection.areaId, "yard")
    assert.equal(selection.ticketId, "MTH-6")
    assert.equal(boardWorkspaceHref("household", { groups: true }, "groups"), "/boards/household?view=groups#groups")
  })
})
