import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { expect, test, type Page } from "@playwright/test"

const ordinaryPath = "/fixture-offline-page"
const privatePath = "/fixture-no-store"
const unscheduledPath = "/today?unscheduledPage=1"

async function fixture(prefix: string) {
  const worker = await readFile(new URL("../../apps/web/public/sw.js", import.meta.url), "utf8")
  let boardRequests = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const path = url.pathname.slice(prefix.length)
    if (path === "/sw.js") {
      response.writeHead(200, { "content-type": "application/javascript" })
      return response.end(worker)
    }
    if (path === "/version.json") {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end('{"version":"0.0.1"}')
    }
    if (path === "/api/tasks" && url.searchParams.get("board_id") === "fixture") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "max-age=600" })
      return response.end(`<h1>Origin Board response ${++boardRequests}</h1>`)
    }

    const isPrivate = path === "/settings" || path === "/review" || path.startsWith(privatePath) ||
      (path === "/today" && url.searchParams.has("unscheduledPage"))
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": isPrivate ? "private, No-Store" : "max-age=0",
    })
    response.end(isPrivate ? "<h1>Live only</h1>" : "<h1>Ordinary offline page</h1>")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(Number(process.env.MEITHEAL_SW_TEST_PORT ?? 0), "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No fixture address")
  return {
    base: `http://127.0.0.1:${address.port}${prefix}`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

async function register(page: Page, script: string) {
  await page.evaluate(async url => {
    await navigator.serviceWorker.register(url)
    await navigator.serviceWorker.ready
  }, script)
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
}

async function cached(page: Page, url: string) {
  return page.evaluate(async url => Boolean(await caches.match(url)), url)
}

test("no-store responses stay out of navigation and fetch caches", async ({ browser }) => {
  const server = await fixture("")
  const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
  try {
    const page = await context.newPage()
    await page.goto(server.base + "/fixture")
    await register(page, server.base + "/sw.js")
    expect(await cached(page, server.base + "/settings")).toBe(false)

    const fetchUrl = server.base + privatePath + "-fetch"
    expect(await page.evaluate(url => fetch(url).then(response => response.text()), fetchUrl)).toContain("Live only")
    const navUrl = server.base + privatePath + "-nav"
    await page.goto(navUrl)
    await expect(page.getByRole("heading")).toHaveText("Live only")

    await page.goto(server.base + ordinaryPath)
    await expect.poll(() => cached(page, server.base + ordinaryPath)).toBe(true)
    expect(await cached(page, fetchUrl)).toBe(false)
    expect(await cached(page, navUrl)).toBe(false)

    await page.evaluate(async ({ fetchUrl, navUrl }) => {
      const headers = { "cache-control": "private, no-store", "date": new Date().toUTCString() }
      await (await caches.open("meitheal-static-v0.0.1")).put(fetchUrl, new Response("Old private fetch", { headers }))
      await (await caches.open("meitheal-nav-v0.0.1")).put(navUrl, new Response("Old private page", { headers }))
    }, { fetchUrl, navUrl })

    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole("heading")).toHaveText("Ordinary offline page")
    expect(await page.evaluate(url => fetch(url).then(response => response.status), fetchUrl)).toBe(503)
    const navigation = await page.goto(navUrl)
    expect(await navigation?.text()).toContain("Ordinary offline page")
  } finally {
    await context.close()
    await server.close()
  }
})

for (const [route, label] of [[unscheduledPath, "Unscheduled Today"], ["/review", "Proposal Review"]]) {
  for (const prefix of ["", "/api/hassio_ingress/synthetic-worker"]) {
    test(`${label} cannot replay stale pages in ${prefix ? "ingress" : "standalone"}`, async ({ browser }) => {
      const server = await fixture(prefix)
      const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
      try {
        const page = await context.newPage()
        const url = server.base + route
        await page.goto(server.base + "/fixture")
        await page.evaluate(async url => {
          for (const bucket of ["nav", "static", "api", "precache"]) {
            const cache = await caches.open(`meitheal-${bucket}-v0.0.1`)
            await cache.put(url, new Response("<h1>Stale private page</h1>", {
              headers: { date: new Date().toUTCString(), "content-type": "text/html" },
            }))
          }
          await caches.open("fixture-other-software")
        }, url)
        await register(page, server.base + "/sw.js")

        expect(await cached(page, url)).toBe(false)
        expect(await page.evaluate(() => caches.keys())).toContain("fixture-other-software")
        const navigation = await page.goto(url)
        expect(navigation?.fromServiceWorker()).toBe(false)
        await expect(page.getByRole("heading")).toHaveText("Live only")
        expect(await page.evaluate(url => fetch(url).then(response => response.text()), url)).toContain("Live only")
        expect(await cached(page, url)).toBe(false)

        await context.setOffline(true)
        expect(await page.evaluate(url => fetch(url).then(() => "unexpected response", () => "offline"), url)).toBe("offline")
        await expect(page.reload()).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/)
      } finally {
        await context.close()
        await server.close()
      }
    })
  }
}

for (const prefix of ["", "/api/hassio_ingress/synthetic-worker"]) {
  test(`unavailable Board URLs cannot replay Household data in ${prefix ? "ingress" : "standalone"}`, async ({ browser }) => {
    const server = await fixture(prefix)
    const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
    try {
      const page = await context.newPage()
      const scoped = [
        "/api/tasks?board_id=fixture",
        "/api/tasks?board_name=fixture",
        "/api/tasks/card?board_id=",
        "/api/tasks/card/links?board_id=fixture",
        "/api/lanes?board_id=fixture",
        "/api/lanes/fixture?board_id=fixture",
        "/api/search?board_id=fixture",
        "/tasks?board=fixture",
        "/tasks?board_id=fixture",
        "/tickets/MTH-1?board_id=fixture",
        "/tickets/MTH-1?board=fixture",
        "//api/%2574asks/card?%62oard_id=fixture",
        "/api%2Flanes/fixture?board_id=fixture",
        "/t%61sks?%62oard=fixture",
      ].map(path => server.base + path)
      const retired = new URL("/api/hassio_ingress/retired-worker/tasks?board=fixture", server.base).href
      scoped.push(retired)
      const householdApi = server.base + "/api/tasks?limit=2"
      const householdPage = server.base + "/tasks?view=kanban"
      const retained = [
        householdApi, householdPage,
        server.base + "/planning?board=fixture",
        server.base + "/api/tasks-archive?board_id=fixture",
      ]
      const cacheNames = ["api", "nav", "precache", "static"].map(bucket => `meitheal-${bucket}-v0.0.1`)
      const candidateUrls = [...scoped, ...retained]
      const seed = (urls: string[], body: string) => page.evaluate(async ({ urls, body, cacheNames }) => {
        const headers = { date: new Date().toUTCString(), "content-type": "text/html" }
        for (const name of cacheNames) {
          const cache = await caches.open(name)
          for (const url of urls) await cache.put(url, new Response(body, { headers }))
        }
      }, { urls, body, cacheNames })
      const storedCandidates = () => page.evaluate(async ({ candidateUrls, cacheNames }) => {
        return Promise.all(cacheNames.map(async name => (await (await caches.open(name)).keys())
          .map(request => request.url).filter(url => candidateUrls.includes(url))))
      }, { candidateUrls, cacheNames })

      const scopedApi = server.base + "/api/tasks?board_id=fixture"
      const scopedPage = server.base + "/tasks?board=fixture"
      await page.goto(server.base + "/fixture")
      expect(await page.evaluate(url => fetch(url).then(response => response.text()), scopedApi))
        .toContain("Origin Board response 1")
      expect(await page.evaluate(url => fetch(url).then(response => response.text()), scopedApi))
        .toContain("Origin Board response 1")
      await seed(scoped, "<h1>Stale Household data for a Board URL</h1>")
      await seed(retained, "<h1>Keep Household and unrelated entries</h1>")
      expect(await storedCandidates()).toEqual(cacheNames.map(() => candidateUrls))
      await register(page, server.base + "/sw.js")
      expect(await storedCandidates()).toEqual(cacheNames.map(() => retained))

      expect((await page.goto(scopedPage))?.fromServiceWorker()).toBe(true)
      expect(await page.evaluate(url => fetch(url).then(response => response.text()), scopedApi))
        .toContain("Origin Board response 2")
      for (const url of scoped) {
        expect(await page.evaluate(url => fetch(url).then(response => response.status), url)).toBe(200)
      }
      expect(await storedCandidates()).toEqual(cacheNames.map(() => retained))

      await seed(scoped, "<h1>Late Household data for a Board URL</h1>")
      await context.setOffline(true)
      for (const url of scoped) {
        const offline = await page.evaluate(async url => {
          const response = await fetch(url)
          return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.text() }
        }, url)
        expect(offline).toMatchObject({ status: 503, cacheControl: "private, no-store" })
        expect(offline.body).not.toContain("Household")
      }
      expect(await page.evaluate(url => fetch(url).then(response => response.text()), householdApi))
        .toContain("Keep Household and unrelated entries")
      expect((await page.goto(householdPage))?.fromServiceWorker()).toBe(true)
      await expect(page.getByRole("heading")).toHaveText("Keep Household and unrelated entries")
      const offlinePage = await page.goto(scopedPage)
      expect(offlinePage?.status()).toBe(503)
      expect(await offlinePage?.text()).toBe("Offline")
    } finally {
      await context.close()
      await server.close()
    }
  })

  test(`private database export aliases are purged and never replayed in ${prefix ? "ingress" : "standalone"}`, async ({ browser }) => {
    const server = await fixture(prefix)
    const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
    try {
      const page = await context.newPage()
      const aliases = [
        server.base + "/api/export/database.sqlite",
        server.base + "//api/export/database.sqlite?download=1",
        server.base + "/api/%2565xport/database.sqlite/",
        server.base + "/api%2Fexport/database.sqlite",
        new URL("/api/hassio_ingress/retired-worker/api/export/database.sqlite", server.base).href,
      ]
      const unrelated = server.base + ordinaryPath
      const cacheNames = ["api", "nav", "precache", "static"].map(bucket => `meitheal-${bucket}-v0.0.1`)
      await page.goto(server.base + "/fixture")
      await page.evaluate(async ({ aliases, unrelated, cacheNames }) => {
        const headers = { date: new Date().toUTCString(), vary: "Accept-Language" }
        for (const name of cacheNames) {
          const cache = await caches.open(name)
          for (const url of aliases) await cache.put(url, new Response("Old private export", { headers }))
          await cache.put(unrelated, new Response("Keep unrelated entries", { headers }))
        }
        await caches.open("fixture-other-software")
      }, { aliases, unrelated, cacheNames })
      await register(page, server.base + "/sw.js")
      for (const url of aliases) {
        expect(await cached(page, url)).toBe(false)
        expect(await page.evaluate(url => fetch(url).then(response => response.text()), url)).toContain("Ordinary offline page")
        expect(await cached(page, url)).toBe(false)
      }
      const preserved = await page.evaluate(async ({ unrelated, cacheNames }) => {
        return Promise.all(cacheNames.map(async name => (await (await caches.open(name)).match(unrelated))?.text()))
      }, { unrelated, cacheNames })
      expect(preserved).toEqual(cacheNames.map(() => "Keep unrelated entries"))
      expect(await page.evaluate(() => caches.keys())).toContain("fixture-other-software")

      await page.evaluate(async ({ aliases, cacheNames }) => {
        for (const name of cacheNames) {
          const cache = await caches.open(name)
          for (const url of aliases) await cache.put(url, new Response("Late private export"))
        }
      }, { aliases, cacheNames })
      await context.setOffline(true)
      for (const url of aliases) {
        expect(await page.evaluate(url => fetch(url).then(() => "unexpected response", () => "offline"), url)).toBe("offline")
      }
    } finally {
      await context.close()
      await server.close()
    }
  })

  test(`Settings, HA status, and reaction requests bypass Cache Storage in ${prefix ? "ingress" : "standalone"}`, async ({ browser }) => {
    const server = await fixture(prefix)
    const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
    try {
      const page = await context.newPage()
      await page.goto(server.base + "/fixture")
      await register(page, server.base + "/sw.js")
      const urls = [
        "/api/settings",
        "/api/settings?key=locale",
        "/api/ha/connection",
        "/api/tasks/reaction-counts?ids=fixture-task",
        "/api/tasks/fixture-task/reactions",
        "/api/tasks/fixture-task/comments/1/reactions",
      ].map(path => server.base + path)
      for (const url of urls) {
        expect(await page.evaluate(url => fetch(url).then(response => response.status), url)).toBe(200)
        expect(await cached(page, url)).toBe(false)
      }
      await page.evaluate(async urls => {
        const cache = await caches.open("meitheal-api-v0.0.1")
        for (const url of urls) await cache.put(url, new Response("Stale application data"))
      }, urls)
      await context.setOffline(true)
      for (const url of urls) {
        expect(await page.evaluate(url => fetch(url).then(() => "unexpected response", () => "offline"), url)).toBe("offline")
      }
    } finally {
      await context.close()
      await server.close()
    }
  })
}

for (const prefix of ["", "/api/hassio_ingress/synthetic-worker"]) {
  test(`participant reads bypass retained caches in ${prefix ? "ingress" : "standalone"}`, async ({ browser }) => {
    const server = await fixture(prefix)
    const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
    try {
      const page = await context.newPage()
      await page.goto(server.base + "/fixture")
      const activeUrls = [
        "/api/tasks/card/comments",
        "/api/tasks/card/comments/1",
        "/api/tasks/card/comments/1/reactions",
        "/api/tasks/card/comments/1/reactions/2",
        "/api/tasks/card/reactions",
        "/api/tasks/card/reactions/1",
        "/api/tasks/reaction-counts?ids=card",
        "//api/tasks/card/%2563omments/",
        "/api/tasks/card/%63omments/%25legacy",
        "/api/tasks/card/comments/1/%72eactions",
        "/api/tasks/card%2Fcomments",
      ].map(path => server.base + path)
      const retired = new URL("/api/hassio_ingress/retired/api/tasks/card/comments", server.base).href
      const unrelated = server.base + "/api/tasks/card/links"
      const bucket = "meitheal-api-v0.0.1"
      const seed = (urls: string[]) => page.evaluate(async ({ urls, bucket }) => {
        const cache = await caches.open(bucket)
        for (const url of urls) {
          await cache.put(url, new Response("Previously cached activity", { headers: { date: new Date().toUTCString() } }))
        }
      }, { urls, bucket })
      const keys = () => page.evaluate(async bucket => (await (await caches.open(bucket)).keys()).map(request => request.url), bucket)
      await seed([...activeUrls, retired, unrelated])
      expect(await keys()).toEqual(expect.arrayContaining([...activeUrls, retired, unrelated]))
      await register(page, server.base + "/sw.js")
      expect(await keys()).toEqual([unrelated])
      for (const url of activeUrls) {
        expect(await page.evaluate(url => fetch(url, { cache: "no-store" }).then(response => response.status), url)).toBe(200)
      }
      expect(await keys()).toEqual([unrelated])
      await seed(activeUrls)
      await context.setOffline(true)
      for (const url of activeUrls) {
        expect(await page.evaluate(url => fetch(url).then(() => "unexpected response", () => "offline"), url)).toBe("offline")
      }
      expect(await keys()).toEqual(expect.arrayContaining(activeUrls))
    } finally {
      await context.close()
      await server.close()
    }
  })
}
