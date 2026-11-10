import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { readFrameworkImport } from "../../apps/web/src/domains/strategy/framework-import"
import { frameworkImportBytesMax } from "../../apps/web/src/lib/framework-import-limit"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

const yaml = `---
name: Fáilte Framework
version: 2.1.0
description: |
  Keep household decisions simple.
  Preserve quoted and Unicode text: "Fáilte 🐕".
formula: impact / effort
fields:
  - { key: impact, label: Impact, min: &zero 0, max: 10, weight: 2, help_text: Helpful }
  - key: effort
    label: Effort
    min: *zero
    ui_type: number
badge_thresholds:
  - { min: 1, label: Useful, color: bg-success }
`
const imported = {
  id: "f-ilte-framework", name: "Fáilte Framework", version: "2.1.0", source: "imported", archetype: "formula",
  description: 'Keep household decisions simple.\nPreserve quoted and Unicode text: "Fáilte 🐕".\n', formula: "impact / effort",
  fields: [
    { key: "impact", label: "Impact", type: "number", uiType: "slider", weight: 2, min: 0, max: 10, helpText: "Helpful" },
    { key: "effort", label: "Effort", type: "number", uiType: "number", weight: 1, min: 0, helpText: "" },
  ],
  badgeThresholds: [{ min: 1, label: "Useful", color: "bg-success" }],
}
const yamlRequest = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://127.0.0.1/api/frameworks", {
  method: "POST", headers: { "content-type": "application/yaml", ...headers }, body,
})

test("server YAML import preserves flow mappings, block scalars, aliases, Unicode and existing defaults", async () => {
  const result = await readFrameworkImport(yamlRequest(yaml))
  expect(result.ok).toBe(true)
  if (result.ok) expect(JSON.parse(JSON.stringify(result.config))).toEqual(imported)
})

for (const [name, source] of [
  ["syntax", "name: [unterminated"],
  ["missing name", "fields: []"],
  ["scalar root", "42"],
  ["multiple documents", "name: first\n---\nname: second"],
  ["deep nesting", `name: Too deep\nunused: ${"[".repeat(200)}0${"]".repeat(200)}`],
  ["cyclic persisted aliases", "name: Loop\nfields: [{key: loop, label: Loop, min: &loop [*loop]}]"],
  ["alias amplification", "name: Aliases\na: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]"],
] as const) {
  test(`server rejects ${name} as an import error`, async () => {
    expect(await readFrameworkImport(yamlRequest(source))).toMatchObject({ ok: false, status: 400, errorCode: "FRAMEWORK_IMPORT_INVALID" })
  })
}

test("server rejects oversized headers, actual UTF-8 bytes and invalid UTF-8 before creating a framework", async () => {
  expect(await readFrameworkImport(yamlRequest(yaml, { "content-length": String(frameworkImportBytesMax + 1) })))
    .toMatchObject({ ok: false, status: 413 })
  expect(await readFrameworkImport(yamlRequest("é".repeat(frameworkImportBytesMax / 2 + 1))))
    .toMatchObject({ ok: false, status: 413 })
  expect(await readFrameworkImport(yamlRequest(new Uint8Array([0xff, 0xfe]))))
    .toMatchObject({ ok: false, status: 400 })
})

test.describe("framework import API and Settings", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable App and ingress fixture")

  test("packaged built-ins remain listed, protected, editable and exportable without source files", async ({ request }) => {
    const listed = await request.get("/api/frameworks")
    expect(listed.status()).toBe(200)
    const builtIns = (await listed.json()).data.filter((item: { source: string }) => item.source === "built-in")
    expect(builtIns.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(["rice", "ice", "eisenhower"]))
    const path = "/api/frameworks/rice"
    const original = (await (await request.get(path)).json()).data
    expect(original.source).toBe("built-in")
    expect(original.fields.map((field: { key: string }) => field.key)).toEqual(["reach", "impact", "confidence", "effort"])
    try {
      const shadow = await request.post("/api/frameworks", { data: { ...original, source: "user" } })
      expect(shadow.status()).toBe(409)
      const shadowYaml = await request.post("/api/frameworks", { headers: { "content-type": "application/yaml" },
        data: "name: RICE\nformula: reach\nfields:\n  - key: reach\n    label: Reach\n" })
      expect(shadowYaml.status()).toBe(409)
      expect((await request.put(path, { data: { formula: "reach", fields: { reach: { weight: 2 } } } })).status()).toBe(200)
      const changed = (await (await request.get(path)).json()).data
      expect(changed.formula).toBe("reach")
      expect(changed.fields[0].weight).toBe(2)
      const exported = await request.get(path + "/export")
      expect(exported.status()).toBe(200)
      expect(exported.headers()["content-disposition"]).toContain('filename="rice.yaml"')
      const exportedText = await exported.text()
      expect(exportedText).toContain(original.formula)
      expect(exportedText).toContain("help_text:")
      const reset = await request.delete(path, { data: {} })
      expect(reset.status()).toBe(200)
      expect((await reset.json()).source).toBe("built-in")
      expect((await (await request.get(path)).json()).data).toEqual(original)
    } finally { await request.delete(path, { data: {} }) }
  })

  test("YAML shares JSON validation, collision checks and persistence; JSON clients keep their exact shape", async ({ request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin, "content-type": "application/yaml; charset=utf-8" }
    const json = { ...imported, id: "json-framework-import-compatibility", name: "JSON client", source: "user", fields: [
      { key: "choice", label: "Choice", type: "select", uiType: "select", weight: 3, helpText: "Keep options", options: [{ value: "one", label: "One" }] },
    ] }
    const createdIds: string[] = []
    try {
      const created = await request.post("/api/frameworks", { headers, data: yaml })
      expect(created.status(), await created.text()).toBe(201)
      createdIds.push(imported.id)
      expect((await created.json()).data).toEqual(imported)
      const duplicate = await request.post("/api/frameworks", { headers, data: yaml })
      expect(duplicate.status()).toBe(409)
      const invalid = await request.post("/api/frameworks", { headers, data: "name: Missing fields\nformula: impact" })
      expect(invalid.status()).toBe(400)
      expect((await invalid.json()).errors).toContain("At least one field is required")
      const syntax = await request.post("/api/frameworks", { headers, data: "name: [unterminated" })
      expect(syntax.status()).toBe(400)
      expect((await syntax.json()).message).toContain("Parse error:")
      const tooLarge = await request.post("/api/frameworks", { headers, data: "x".repeat(frameworkImportBytesMax + 1) })
      expect(tooLarge.status()).toBe(413)
      const oldClient = await request.post("/api/frameworks", { headers: { origin: new URL(baseURL!).origin }, data: json })
      expect(oldClient.status(), await oldClient.text()).toBe(201)
      createdIds.push(json.id)
      expect((await oldClient.json()).data).toEqual(json)
      const listed = (await (await request.get("/api/frameworks")).json()).data
      expect(listed.find((item: { id: string }) => item.id === imported.id)).toEqual(imported)
      expect(listed.find((item: { id: string }) => item.id === json.id)).toEqual(json)
    } finally {
      for (const id of createdIds) {
        const removed = await request.delete(`/api/frameworks/${id}`, { headers: { origin: new URL(baseURL!).origin }, data: {} })
        expect(removed.status()).toBe(200)
      }
    }
  })

  test("Settings imports through ingress and keeps errors visible for invalid, oversized, collision and unavailable requests", async () => {
    const work = await mkdtemp(join(tmpdir(), "meitheal-framework-import-"))
    let child: ChildProcess | undefined
    let browser
    try {
      child = startCoreFixture(work)
      child.stdout?.resume()
      child.stderr?.resume()
      const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${info.port}`
      const prefix: string = info.configuredPath
      browser = await launchPinBrowser(work)
      const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
      await context.setExtraHTTPHeaders({})
      await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      page.setDefaultNavigationTimeout(10000)
      const requests: string[] = []
      page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname.endsWith("/api/frameworks")) requests.push(new URL(req.url()).pathname) })
      await page.goto(origin + prefix + "/settings", { waitUntil: "domcontentloaded" })
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      await page.locator('[data-settings-nav="rules-lenses-settings"]').click()
      await expect(page.locator("#fw-import-btn")).toBeVisible()
      const open = async () => { await page.locator("#fw-import-btn").click() }
      const submit = async (text: string) => {
        await page.locator("#fw-import-yaml").fill(text)
        await page.locator("#fw-import-submit").click()
      }
      await open()
      await submit("name: [unterminated")
      await expect(page.locator("#fw-import-errors")).toContainText("Parse error:")
      const count = requests.length
      await submit("é".repeat(frameworkImportBytesMax / 2 + 1))
      await expect(page.locator("#fw-import-errors")).toHaveText("Framework YAML must be 64 KiB or smaller.")
      expect(requests.length).toBe(count)
      await submit(yaml)
      await expect(page.locator("#fw-import-dialog")).not.toBeVisible()
      await open()
      await submit(yaml)
      await expect(page.locator("#fw-import-errors")).toHaveText("Framework ID already exists")
      await page.route(`**${prefix}/api/frameworks`, async route => {
        if (route.request().method() !== "POST") return route.continue()
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, message: "Framework storage is unavailable." }) })
      })
      await submit(yaml)
      await expect(page.locator("#fw-import-errors")).toHaveText("Framework storage is unavailable.")
      await expect(page.locator("#fw-import-dialog")).toBeVisible()
      expect(requests.length).toBeGreaterThan(2)
      expect(requests.every(path => path === prefix + "/api/frameworks")).toBe(true)
    } finally {
      await browser?.close()
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit")
        child.kill()
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  })
})
