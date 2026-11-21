import { expect, test } from "@playwright/test"
import { IntegrationBus } from "../../packages/integration-core/src"

test("emit starts later handlers even when the first throws synchronously", async () => {
  const bus = new IntegrationBus()
  const calls: string[] = []
  bus.register({ key: "broken", handle() { throw new Error("fixture failure") } })
  bus.register({ key: "later", async handle(event) { calls.push(event.eventId) } })
  await expect(bus.emit({ eventType: "fixture", eventId: "one", requestId: "one",
    occurredAt: new Date().toISOString(), payload: {} })).rejects.toThrow("fixture failure")
  expect(calls).toEqual(["one"])
})
