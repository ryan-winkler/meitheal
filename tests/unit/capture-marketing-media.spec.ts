import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

import { escapeHtml, parseArgs } from "../../scripts/capture-marketing-media.mjs"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

test("parseArgs returns defaults when invoked without flags", () => {
  const options = parseArgs([])
  expect(options.updateReadme).toBe(false)
  expect(options.stillsOnly).toBe(false)
  expect(options.baseUrl).toBeNull()
  expect(options.outDir).toBe(resolve(REPO_ROOT, ".planning/marketing/media"))
})

test("parseArgs accepts --out, --update-readme, --stills-only, and valid HTTP(S) --base-url", () => {
  const options = parseArgs([
    "--out",
    "custom-out/media",
    "--update-readme",
    "--stills-only",
    "--base-url",
    "https://ha.example.com/app///",
  ])

  expect(options).toEqual({
    outDir: resolve(process.cwd(), "custom-out/media"),
    updateReadme: true,
    stillsOnly: true,
    baseUrl: "https://ha.example.com/app",
  })

  expect(parseArgs(["--base-url", "http://127.0.0.1:3000/"]).baseUrl).toBe("http://127.0.0.1:3000")
})

test("parseArgs rejects missing values, non-HTTP URLs, and unknown flags", () => {
  expect(() => parseArgs(["--out"])).toThrow(/--out requires/)
  expect(() => parseArgs(["--out", ""])).toThrow(/--out requires/)
  expect(() => parseArgs(["--base-url"])).toThrow(/--base-url requires/)
  expect(() => parseArgs(["--base-url", ""])).toThrow(/--base-url requires/)
  expect(() => parseArgs(["--base-url", "not-a-valid-url"])).toThrow(/Invalid --base-url/)
  expect(() => parseArgs(["--base-url", "file:///etc/passwd"])).toThrow(/http: or https:/)
  expect(() => parseArgs(["--base-url", "javascript:alert(1)"])).toThrow(/http: or https:/)
  expect(() => parseArgs(["--unknown-flag"])).toThrow(/Unknown CLI argument/)
})

test("escapeHtml neutralizes HTML special characters", () => {
  expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
    "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
  )
  expect(escapeHtml("Plain household title")).toBe("Plain household title")
})
