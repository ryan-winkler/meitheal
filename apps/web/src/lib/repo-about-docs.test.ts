import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { AGPL_LICENSE_SUMMARY, parseChangelogMarkdown } from "./repo-about-docs"

describe("parseChangelogMarkdown", () => {
  it("parses structured releases with channels, summaries, and bold or plain items", () => {
    const sample = [
      "# Changelog",
      "",
      "## Release Summary",
      "",
      "- **0.0.2-canary** (Canary): Major UI and navigation polish.",
      "  - **Planning routes**: Separated planning matrices from board groups.",
      "  - **Reactions**: Enforced one reaction per user per target.",
      "  - Plain bullet without bold prefix.",
      "- **0.0.1** (Stable): Initial public release.",
      "  - **Core**: Local SQLite task workspace.",
    ].join("\n")

    const releases = parseChangelogMarkdown(sample)
    assert.equal(releases.length, 2)

    assert.equal(releases[0]?.version, "0.0.2-canary")
    assert.equal(releases[0]?.channel, "Canary")
    assert.equal(releases[0]?.summary, "Major UI and navigation polish.")
    assert.equal(releases[0]?.items.length, 3)
    assert.deepEqual(releases[0]?.items[0], {
      title: "Planning routes",
      body: "Separated planning matrices from board groups.",
    })
    assert.deepEqual(releases[0]?.items[2], {
      title: "",
      body: "Plain bullet without bold prefix.",
    })

    assert.equal(releases[1]?.version, "0.0.1")
    assert.equal(releases[1]?.channel, "Stable")
    assert.equal(releases[1]?.items.length, 1)
  })

  it("defaults missing channel to Release and handles empty markdown", () => {
    assert.deepEqual(parseChangelogMarkdown(""), [])
    const releases = parseChangelogMarkdown("- **1.0.0**: First milestone.")
    assert.equal(releases.length, 1)
    assert.equal(releases[0]?.channel, "Release")
    assert.equal(releases[0]?.summary, "First milestone.")
  })
})

describe("AGPL_LICENSE_SUMMARY", () => {
  it("exposes AGPL-3.0-only permissions, conditions, and limitations", () => {
    assert.equal(AGPL_LICENSE_SUMMARY.spdx, "AGPL-3.0-only")
    assert.ok(AGPL_LICENSE_SUMMARY.permissions.includes("Commercial use"))
    assert.ok(AGPL_LICENSE_SUMMARY.conditions.includes("Network use is distribution"))
    assert.ok(AGPL_LICENSE_SUMMARY.limitations.includes("Warranty"))
  })
})
