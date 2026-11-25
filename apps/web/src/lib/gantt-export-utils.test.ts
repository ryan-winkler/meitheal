import test from "node:test"
import assert from "node:assert/strict"
import { buildTimelineExportFilename, resolveCssVarExpression } from "./gantt-export-utils"

test("resolveCssVarExpression resolves direct tokens and fallbacks", () => {
  const tokens: Record<string, string> = {
    "--bg-card": "#141923",
    "--text-primary": "#f1f5f9",
    "--accent": "#22c55e",
  }
  const getVar = (name: string) => tokens[name] ?? ""

  assert.equal(resolveCssVarExpression("var(--bg-card)", getVar), "#141923")
  assert.equal(resolveCssVarExpression("var(--missing, #abcdef)", getVar), "#abcdef")
  assert.equal(resolveCssVarExpression("1px solid var(--accent)", getVar), "1px solid #22c55e")
})

test("resolveCssVarExpression handles nested fallbacks and chained vars", () => {
  const tokens: Record<string, string> = {
    "--alias": "var(--real)",
    "--real": "#3b82f6",
    "--border-subtle": "",
    "--border": "rgba(255,255,255,0.12)",
  }
  const getVar = (name: string) => tokens[name] ?? ""

  assert.equal(resolveCssVarExpression("var(--alias)", getVar), "#3b82f6")
  assert.equal(
    resolveCssVarExpression("var(--border-subtle, var(--border, #333))", getVar),
    "rgba(255,255,255,0.12)",
  )
  assert.equal(
    resolveCssVarExpression("var(--unknown-a, var(--unknown-b, rgba(255,255,255,0.05)))", getVar),
    "rgba(255,255,255,0.05)",
  )
})

test("buildTimelineExportFilename formats deterministic ISO date filename", () => {
  assert.equal(
    buildTimelineExportFilename(new Date(2026, 10, 5)),
    "meitheal-timeline-2026-11-05.png",
  )
})
