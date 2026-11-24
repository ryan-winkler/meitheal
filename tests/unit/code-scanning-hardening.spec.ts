import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { sanitizePluginIconSvg, validatePluginManifest } from "../../apps/web/src/domains/plugins/plugin-manifest"
import { renderMarkdownToHtml } from "../../apps/web/src/lib/markdown-client"

function baseManifest(hosts: string[] = ["api.example.com"]) {
  return {
    id: "hardened-plugin",
    name: "Hardened Plugin",
    version: "1.0.0",
    minMeithealVersion: "0.0.2",
    type: "extension",
    description: "Validates hardened parsing paths.",
    author: "Tester",
    license: "MIT",
    entry: "plugin.js",
    iFrame: "index.html",
    sidePanel: true,
    permissions: hosts.length ? ["tasks:read", "http:outbound"] : ["tasks:read"],
    hooks: ["task.completed"],
    allowedHosts: hosts,
    dataSharing: {
      outbound: hosts.length > 0,
      destinations: hosts.map((host) => ({ host, purpose: "Testing destination validation." })),
      dataTypes: hosts.length ? ["task_title"] : [],
      summary: hosts.length ? "Outbound test destination." : "Local-only test plugin.",
    },
  }
}

test("sanitizePluginIconSvg strips script/foreignObject/event attrs via AST while preserving camelCase SVG geometry", () => {
  const dirty = `<?xml version="1.0"?><!-- prolog --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onLoad="alert(1)" ONCLICK="evil()"><ScRiPt>alert(1)</ScRiPt><ForeignObject><div>leak</div></ForeignObject><defs><linearGradient id="g" gradientTransform="rotate(45)"><stop offset="0%" stop-color="#fff"/></linearGradient></defs><path d="M0 0h24" onclick="bad()"/></svg>`
  const res = sanitizePluginIconSvg(dirty)
  expect(res.ok).toBe(true)
  if (res.ok) {
    expect(res.data).not.toMatch(/<script/i)
    expect(res.data).not.toMatch(/foreignobject/i)
    expect(res.data).not.toMatch(/\bonload\b/i)
    expect(res.data).not.toMatch(/\bonclick\b/i)
    expect(res.data).not.toContain("alert(1)")
    expect(res.data).not.toContain("leak")
    expect(res.data).toContain('viewBox="0 0 24 24"')
    expect(res.data).toContain("<linearGradient")
    expect(res.data).toContain('gradientTransform="rotate(45)"')
  }
})

test("sanitizePluginIconSvg rejects entity-encoded/control-split unsafe URIs and multiple root SVGs", () => {
  const encodedJs = `<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><path d="M0 0"/></a></svg>`
  const resJs = sanitizePluginIconSvg(encodedJs)
  expect(resJs.ok).toBe(false)
  if (!resJs.ok) expect(resJs.errorCode).toBe("UNSAFE_ICON")

  const splitData = `<svg xmlns="http://www.w3.org/2000/svg"><image href="d&#97;ta:text/html;base64,PHNjcmlwdD4="/></svg>`
  const resData = sanitizePluginIconSvg(splitData)
  expect(resData.ok).toBe(false)
  if (!resData.ok) expect(resData.errorCode).toBe("UNSAFE_ICON")

  const multiRoot = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg><svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>`
  const resMulti = sanitizePluginIconSvg(multiRoot)
  expect(resMulti.ok).toBe(false)
  if (!resMulti.ok) expect(resMulti.errorCode).toBe("INVALID_ICON")
})

test("validatePluginManifest accepts $userServer and rejects invalid or ReDoS hostnames in linear time", () => {
  const okRes = validatePluginManifest(baseManifest(["$userServer", "api.v2-staging.example.com"]))
  expect(okRes.ok).toBe(true)
  if (okRes.ok) {
    expect(okRes.data.allowedHosts).toEqual(["$userServer", "api.v2-staging.example.com"])
  }

  for (const badHost of ["-bad.example.com", "bad-.example.com", "localhost", "a.123", `${"a".repeat(64)}.example.com`]) {
    const res = validatePluginManifest(baseManifest([badHost]))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorCode).toBe("INVALID_HOST")
  }

  const start = performance.now()
  const adversarial = `${"a-".repeat(125)}a`
  const redosRes = validatePluginManifest(baseManifest([adversarial]))
  const elapsedMs = performance.now() - start
  expect(redosRes.ok).toBe(false)
  expect(elapsedMs).toBeLessThan(20)
})

test("markdown-client handles adversarial separators and horizontal rules in linear time", () => {
  const html = renderMarkdownToHtml("| A | B |\n| :--- | ---: |\n| 1 | 2 |\n\n* * *")
  expect(html).toContain("<table>")
  expect(html).toContain("<hr>")

  const badHr = `${"- ".repeat(5000)}!`
  const badSep = `| ${"--- | ".repeat(2000)}x`
  const start = performance.now()
  const out = renderMarkdownToHtml(`${badHr}\n\n| A | B |\n${badSep}\n`)
  const elapsedMs = performance.now() - start
  expect(out).not.toContain("<hr>")
  expect(out).not.toContain("<table>")
  expect(elapsedMs).toBeLessThan(30)
})

test("client security hardening invariants remain free of code scanning anti-patterns", () => {
  const repoRoot = resolve(import.meta.dirname, "../..")
  const css = readFileSync(resolve(repoRoot, "apps/web/src/styles/_sidebar-reorder.css"), "utf8")
  expect(css).not.toContain("):not(")
  expect(css).toContain(":not([data-sidebar-section-hidden], [data-sidebar-section-empty])")

  const pluginHost = readFileSync(resolve(repoRoot, "apps/web/src/lib/plugin-host.ts"), "utf8")
  expect(pluginHost).toContain("new DOMParser()")
  expect(pluginHost).toContain("<!DOCTYPE html>")
  expect(pluginHost).toContain("\\u003c")

  expect(pluginHost).not.toMatch(/\bfetch\s*\(/)

  for (const rel of [
    "apps/web/src/lib/settings-plugins-controller.ts",
    "apps/web/src/lib/settings-agent-tokens-controller.ts",
    "apps/web/src/lib/deferred-controller.ts",
    "apps/web/src/lib/plugin-host.ts",
    "apps/web/src/lib/controllers/kanban-lanes.ts",
  ]) {
    const src = readFileSync(resolve(repoRoot, rel), "utf8")
    expect(src).toContain("safeFetch")
    expect(src).not.toMatch(/\bfetch\s*\(\s*url\b|\bfetch\s*\(\s*`/)
  }
})

test("hardened manifest $userserver, SVG local/external url(), and markdown link/entity integrity", () => {
  const mixedCaseRes = validatePluginManifest(baseManifest(["$userserver"]))
  expect(mixedCaseRes.ok).toBe(true)
  if (mixedCaseRes.ok) {
    expect(mixedCaseRes.data.allowedHosts).toEqual(["$userServer"])
    expect(mixedCaseRes.data.dataSharing.destinations[0]?.host).toBe("$userServer")
  }

  const localUrlSvg = `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0h24"/></svg>`
  expect(sanitizePluginIconSvg(localUrlSvg).ok).toBe(true)

  for (const externalRef of ["url(https://evil.example/x#g)", "url(//evil.example/x#g)"]) {
    const res = sanitizePluginIconSvg(`<svg xmlns="http://www.w3.org/2000/svg"><path fill="${externalRef}" d="M0 0"/></svg>`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorCode).toBe("UNSAFE_ICON")
  }

  const md = renderMarkdownToHtml("See [docs](https://example.com/a_b_c) and https://example.com/path_with_underscores?a=1&b=2.")
  expect(md).toContain('href="https://example.com/a_b_c"')
  expect(md).toContain('href="https://example.com/path_with_underscores?a=1&amp;b=2"')
  expect(md).not.toContain("<em>")
})
