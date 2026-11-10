// Fault only the native response boundary; the normal ingress/token fixture runs unchanged.
const networkFetch = globalThis.fetch
let failure = null
process.on("message", message => {
  if (message?.type !== "fixture-mcp-result") return
  failure = message.result
  process.send?.({ mcpResultReady: true })
})
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (failure && url.hostname === "127.0.0.1" && url.pathname === "/api/search") {
    return Promise.resolve(Response.json({ sections: [{ id: "tasks", items: [{ id: "result-fixture", title: "Fixture title" }] }] }))
  }
  if (failure && url.hostname === "127.0.0.1" && url.pathname === "/api/tasks/result-fixture") {
    return Promise.resolve(new Response(failure.status === 204 ? null : failure.body, {
      status: failure.status,
      headers: { "content-type": "application/json" },
    }))
  }
  return networkFetch(input, options)
}
await import("./feedback-ingress-fixture.mjs")
