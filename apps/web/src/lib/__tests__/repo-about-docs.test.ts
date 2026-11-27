import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  groupChangelogItemsByCategory,
  parseChangelogMarkdown,
  tokenizeInlineCode,
} from "../repo-about-docs"

describe("parseChangelogMarkdown", () => {
  it("parses Keep a Changelog 1.1.0 releases with ISO dates, channels, and categorized items", () => {
    const md = [
      "# Changelog",
      "",
      "## [0.0.4-canary] - 2026-11-25 (Canary channel)",
      "",
      "Continuous validation build from `dev`.",
      "",
      "### Added",
      "- **Unified Cards**: Share `KanbanTaskCard` everywhere.",
      "",
      "### Fixed",
      "- **Mobile Modal**: Prevent scroll trapping.",
      "- Plain bullet without bold title.",
      "",
      "### Security",
      "- **Cache Hardening**: Never cache `401` or `403` responses.",
      "",
      "## [0.0.3] - 2026-09-12",
      "",
      "### Changed",
      "- **SQLite Tuning**: Add WAL checkpoint tuning.",
      "",
      "[0.0.4-canary]: https://github.com/ryan-winkler/meitheal/compare/v0.0.3...dev",
    ].join("\n")

    const releases = parseChangelogMarkdown(md)
    assert.equal(releases.length, 2)

    assert.equal(releases[0]?.version, "0.0.4-canary")
    assert.equal(releases[0]?.date, "2026-11-25")
    assert.equal(releases[0]?.channel, "Canary channel")
    assert.equal(releases[0]?.summary, "Continuous validation build from `dev`.")
    assert.equal(releases[0]?.items.length, 4)
    assert.deepEqual(releases[0]?.items[0], {
      title: "Unified Cards",
      body: "Share `KanbanTaskCard` everywhere.",
      category: "Added",
    })
    assert.deepEqual(releases[0]?.items[2], {
      title: "",
      body: "Plain bullet without bold title.",
      category: "Fixed",
    })
    assert.equal(releases[0]?.items[3]?.category, "Security")

    assert.equal(releases[1]?.version, "0.0.3")
    assert.equal(releases[1]?.channel, "Stable release")
    assert.equal(releases[1]?.date, "2026-09-12")
    assert.equal(releases[1]?.items[0]?.category, "Changed")
  })

  it("retains backward compatibility with legacy bullet-based Release Summary markdown", () => {
    const md = [
      "## Release Summary",
      "- **0.0.4-canary** (Canary channel): Summary line.",
      "  - **Feature A**: Details for A.",
      "  - Plain note B.",
    ].join("\n")

    const releases = parseChangelogMarkdown(md)
    assert.equal(releases.length, 1)
    assert.equal(releases[0]?.version, "0.0.4-canary")
    assert.equal(releases[0]?.channel, "Canary channel")
    assert.equal(releases[0]?.summary, "Summary line.")
    assert.deepEqual(releases[0]?.items, [
      { title: "Feature A", body: "Details for A." },
      { title: "", body: "Plain note B." },
    ])
  })
})

describe("groupChangelogItemsByCategory", () => {
  it("groups categorized items in canonical Keep a Changelog order", () => {
    const grouped = groupChangelogItemsByCategory([
      { title: "Fix", body: "Fixed bug", category: "Fixed" },
      { title: "Sec", body: "Hardened auth", category: "Security" },
      { title: "Add", body: "New card", category: "Added" },
    ])
    assert.deepEqual(
      grouped.map((g) => g.category),
      ["Added", "Fixed", "Security"],
    )
  })
})

describe("tokenizeInlineCode", () => {
  it("splits backtick spans into safe text and code tokens without HTML", () => {
    const tokens = tokenizeInlineCode("Share `KanbanTaskCard` and `/new?kind=task` safely.")
    assert.deepEqual(tokens, [
      { type: "text", value: "Share " },
      { type: "code", value: "KanbanTaskCard" },
      { type: "text", value: " and " },
      { type: "code", value: "/new?kind=task" },
      { type: "text", value: " safely." },
    ])
  })

  it("handles plain text and unmatched backticks safely", () => {
    assert.deepEqual(tokenizeInlineCode("No code here"), [{ type: "text", value: "No code here" }])
    assert.deepEqual(tokenizeInlineCode("Unmatched `backtick"), [{ type: "text", value: "Unmatched `backtick" }])
  })
})
