import { expect, test } from "@playwright/test"
import { sanitize } from "../../apps/web/src/lib/sanitize"

test("discards active markup hidden in raw-text elements", () => {
  const input = '<p>Before</p><xmp><img src=x onerror="void(0)"></xmp><p>After</p>'

  expect(sanitize(input)).toBe("<p>Before</p><p>After</p>")
})

test("preserves supported task formatting and safe links", () => {
  const input = '<p><strong>Check the filter</strong> <a href="https://example.test">Manual</a></p>'

  expect(sanitize(input)).toBe(input)
})
