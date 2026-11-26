import assert from "node:assert/strict"
import { test } from "@playwright/test"
import en from "../../apps/web/src/i18n/en.json" with { type: "json" }
import ga from "../../apps/web/src/i18n/ga.json" with { type: "json" }
import { clientTranslationJson, t } from "../../apps/web/src/i18n/translations"
import { minifyInlineCss } from "../../apps/web/src/lib/minify-inline-css"
import { serializeForScript } from "../../apps/web/src/lib/safe-html"

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
  const catalogs = { en, ga }
  for (const locale of ["en", "ga"] as const) {
    const source = catalogs[locale]
    const payload = clientTranslationJson[locale]
    const parsed = JSON.parse(payload) as Record<string, unknown>
    assert.equal("en" in parsed, false)
    assert.equal("ga" in parsed, false)

    for (const key of new Set([...Object.keys(en.en), ...Object.keys(source[locale])])) {
      if (!key.startsWith("settings.")) continue
      const actual = parsed[key] ?? key.split(".").reduce<unknown>((value, segment) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined, parsed)
      assert.equal(actual, t(key, locale), `${locale} ${key}`)
    }

    const sourceBytes = Buffer.byteLength(serializeForScript(source))
    const payloadBytes = Buffer.byteLength(payload)
    assert.ok(payloadBytes < sourceBytes, `${locale} catalog uses ${payloadBytes} bytes after removing wrappers from ${sourceBytes} bytes`)
  }
})
