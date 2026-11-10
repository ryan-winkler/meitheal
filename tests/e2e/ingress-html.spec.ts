import { expect, test } from "@playwright/test"
import { rewriteIngressHtml } from "../../apps/web/src/lib/rewrite-ingress-html"

test("scopes HTML tags split across chunks and preserves scripts, UTF-8 and external links", async () => {
  const prefix = "/api/hassio_ingress/fixture"
  const padding = "<div></div>".repeat(500_000)
  const raw = `<!doctype html><html><head><script>const note = 'href="/unchanged"'</script></head>
<body>${padding}<a href="/tasks?a=1&amp;b=2">Nótaí</a><img src="//example.org/photo">
<a href="${prefix}/today">Today</a><form action='/save'><button>Save</button></form></body></html>`
  const bytes = new TextEncoder().encode(raw)
  const input = new Response(new ReadableStream({
    start(controller) {
      // Split around tags and a multibyte letter without allocating a chunk per padding byte.
      for (const byte of bytes.slice(0, 100)) controller.enqueue(Uint8Array.of(byte))
      controller.enqueue(bytes.slice(100, -190))
      for (const byte of bytes.slice(-190)) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }), { headers: { "content-type": "text/html; charset=utf-8", "content-length": String(bytes.length) } })
  const result = await rewriteIngressHtml(input, prefix)
  expect(result.headers.has("content-length")).toBe(false)
  expect(await result.text()).toBe(
    `<!doctype html><html><head><script>window.__ingress_path="${prefix}";</script><script>const note = 'href="/unchanged"'</script></head>
<body>${padding}<a href="${prefix}/tasks?a=1&amp;b=2">Nótaí</a><img src="//example.org/photo">
<a href="${prefix}/today">Today</a><form action="${prefix}/save"><button>Save</button></form></body></html>`,
  )
})

test("keeps non-HTML and empty responses unchanged", async () => {
  const prefix = "/api/hassio_ingress/fixture"
  const json = Response.json({ href: "/tasks" })
  const noContent = new Response(null, { status: 204, headers: { "content-type": "text/html" } })
  expect(await rewriteIngressHtml(json, prefix)).toBe(json)
  expect(await rewriteIngressHtml(noContent, prefix)).toBe(noContent)
})

test("keeps ordinary HTML on the compact response path", async () => {
  const prefix = "/api/hassio_ingress/fixture"
  const raw = '<html><head></head><a href="/tasks">Tasks</a><img src="//example.org/photo"></html>'
  const input = new Response(raw, { headers: { "content-type": "text/html", "content-length": String(raw.length) } })
  const result = await rewriteIngressHtml(input, prefix)
  expect(result.headers.has("content-length")).toBe(false)
  expect(await result.text()).toBe(
    `<html><head><script>window.__ingress_path="${prefix}";</script></head><a href="${prefix}/tasks">Tasks</a><img src="//example.org/photo"></html>`,
  )
})
