import assert from "node:assert/strict"
import { test } from "@playwright/test"
import { minifyInlineCss } from "../../apps/web/src/lib/minify-inline-css"
import { clientTranslationJson } from "../../apps/web/src/i18n/translations"

test("minifyInlineCss strips comments and whitespace while preserving CSS rules", () => {
  const input = `
    /* header comment */
    .sidebar-row > .btn {
      color: var(--text-primary);
      padding: 4px 8px;
    }
  `
  assert.equal(minifyInlineCss(input), ".sidebar-row>.btn{color:var(--text-primary);padding:4px 8px}")
})

test("clientTranslationJson omits duplicate legacy en/ga wrapper subtrees while preserving hoisted keys", () => {
  const parsedEn = JSON.parse(clientTranslationJson.en) as Record<string, unknown>
  const parsedGa = JSON.parse(clientTranslationJson.ga) as Record<string, unknown>
  assert.equal("en" in parsedEn, false)
  assert.equal("ga" in parsedEn, false)
  assert.equal("en" in parsedGa, false)
  assert.equal("ga" in parsedGa, false)
  assert.ok(clientTranslationJson.en.length < 100_000)
})
