import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isMobileUserAgent, resolveDefaultTaskView } from "./task-view-route"

describe("mobile experience defaults", () => {
  it("detects phone user agents while excluding desktop and tablets", () => {
    assert.equal(
      isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"),
      true,
    )
    assert.equal(
      isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36"),
      true,
    )
    assert.equal(
      isMobileUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15"),
      false,
    )
    assert.equal(
      isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Safari/537.36"),
      false,
    )
  })

  it("defaults mobile visits without explicit view to table, while honoring explicit view overrides", () => {
    const mobileUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile"
    const desktopUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"

    assert.equal(resolveDefaultTaskView(new URLSearchParams(), "", mobileUa), "table")
    assert.equal(resolveDefaultTaskView(new URLSearchParams(), "", desktopUa), "kanban")
    assert.equal(resolveDefaultTaskView(new URLSearchParams("view=kanban"), "", mobileUa), "kanban")
    assert.equal(resolveDefaultTaskView(new URLSearchParams("view=calendar"), "", mobileUa), "calendar")
    assert.equal(resolveDefaultTaskView(new URLSearchParams(), "#timeline", mobileUa), "timeline")
  })
})
