import { expect } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"
import { saveWebMcp, toolNames } from "../scripts/webmcp-browser-helpers"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and disposable authenticated fixture")

test("native Chromium WebMCP searches persisted tasks and unregisters on saved disable and lifecycle abort", async ({ household, request }) => {
  const browser = await household.launchBrowser([
    "--enable-blink-features=WebMCP,WebMCPTesting", "--enable-features=WebMCPTesting",
  ])
  // The ordinary guarded fixture uses the same disposable self-signed loopback
  // origin and authenticated fixture cookie. No HA authority headers are forged.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block", extraHTTPHeaders: {} })
  await context.setExtraHTTPHeaders({})
  await context.addCookies(await household.context.cookies())
  const page = await context.newPage()
  try {
    await page.goto(`${household.origin}${household.prefix}/settings#automation-ai-settings`)
    const shape = await page.evaluate(() => {
      const model = (document as any).modelContext
      return { secureContext: isSecureContext, registerTool: typeof model?.registerTool,
        getTools: typeof model?.getTools, executeTool: typeof model?.executeTool,
        unregisterTool: typeof model?.unregisterTool, navigatorModelContext: typeof (navigator as any).modelContext }
    })
    test.info().annotations.push({ type: "native-browser", description: JSON.stringify({ version: browser.version(), temporaryFlags: true, shape }) })
    test.skip(shape.registerTool !== "function" || shape.getTools !== "function" || shape.executeTool !== "function", "This Chromium build does not expose the current native WebMCP API even with experimental flags")
    const names = () => page.evaluate(async () => (await (document as any).modelContext.getTools()).map((t: any) => t.name).sort())
    await expect.poll(names).toEqual([])
    const title = `NativeWebMcp${crypto.randomUUID().replaceAll("-", "")}`
    const created = await request.post("/api/tasks", { data: { title } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id
    await saveWebMcp(request, true)
    await page.reload()
    await expect.poll(names).toEqual(toolNames)
    await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are registered.")
    const search = async () => page.evaluate(async query => {
      const model = (document as any).modelContext
      const tool = (await model.getTools()).find((t: any) => t.name === "meitheal_search_tasks")
      return JSON.parse(await model.executeTool(tool, { query }))
    }, title)
    expect(await search()).toEqual({ tasks: [{ title, url: `${household.prefix}/tasks?open=${id}` }] })
    const moduleUrl = `${household.origin}${household.prefix}/src/lib/webmcp-controller.ts`
    const module = await page.request.get(moduleUrl)
    if (module.ok() && module.headers()["content-type"]?.includes("javascript")) {
      await page.evaluate(async url => { await import(/* @vite-ignore */ `${url}?webmcp-native-hmr=${Date.now()}`) }, moduleUrl)
      await expect.poll(names).toEqual(toolNames)
      expect(await search()).toEqual({ tasks: [{ title, url: `${household.prefix}/tasks?open=${id}` }] })
      test.info().annotations.push({ type: "native-hmr", description: "Actual Astro dev module replacement; native registry retains exactly two tools" })
    }
    await page.evaluate(async () => {
      const model = (document as any).modelContext
      Object.assign(window, { __heldNativeTool: (await model.getTools()).find((t: any) => t.name === "meitheal_search_tasks") })
    })
    await page.locator("#agent-webmcp-enabled").uncheck()
    await page.locator("#save-agent-protocols").click()
    await expect.poll(names).toEqual([])
    const stale = await page.evaluate(async () => {
      try { await (document as any).modelContext.executeTool((window as any).__heldNativeTool, { query: "heating" }); return "unexpected-success" }
      catch (error) { return (error as DOMException).name }
    })
    expect(stale).toBe("NotFoundError")
    await page.locator("#agent-webmcp-enabled").check()
    await page.locator("#save-agent-protocols").click()
    await expect.poll(names).toEqual(toolNames)
    expect(await search()).toEqual({ tasks: [{ title, url: `${household.prefix}/tasks?open=${id}` }] })
    await page.evaluate(() => document.dispatchEvent(new Event("astro:before-swap")))
    await expect.poll(names).toEqual([])
    await page.evaluate(() => document.dispatchEvent(new Event("astro:page-load")))
    await expect.poll(names).toEqual(toolNames)
  } finally {
    await context.close()
    await browser.close()
  }
})
