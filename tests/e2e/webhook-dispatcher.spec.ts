import dns from "node:dns"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import { emitWebhook } from "../../packages/integration-core/src/webhook-emitter"

test("the development webhook dispatcher reaches the configured internal host", async () => {
  const server = createServer((_request, response) => response.writeHead(204).end())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  const lookup = dns.lookup
  const originalEnv = process.env.NODE_ENV
  process.env.NODE_ENV = "development"
  dns.lookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    if (hostname !== "webhook.internal") throw new Error("Unexpected DNS lookup")
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }])
    else callback(null, "127.0.0.1", 4)
  }) as typeof dns.lookup

  try {
    const result = await emitWebhook(
      { eventId: "event", eventType: "task.created", occurredAt: "2026-01-01T00:00:00Z", requestId: "request", payload: {} },
      { id: "subscriber", url: `http://webhook.internal:${port}/`, secret: "fixture", enabled: true, events: ["task.created"] }
    )
    expect(result).toMatchObject({ ok: true, statusCode: 204, attempts: 1 })
  } finally {
    dns.lookup = lookup
    if (originalEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalEnv
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
})
