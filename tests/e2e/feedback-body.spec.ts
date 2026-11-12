import { expect, test } from "@playwright/test"
import { readFeedbackJson } from "../../apps/web/src/lib/feedback-api"

function streamingRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("http://feedback.test/api/feedback", {
    method: "POST", body: stream, duplex: "half",
    headers: { "content-type": "application/json", ...headers }, ...(signal ? { signal } : {}),
  } as RequestInit)
}

test("Feedback cancels stalled producers at five seconds and on request abort", async () => {
  test.setTimeout(12_000)
  let cancellations = 0
  const stalled = () => new ReadableStream<Uint8Array>({ cancel() { cancellations++; return new Promise(() => {}) } })
  const started = Date.now()
  const timed = await readFeedbackJson(streamingRequest(stalled()))
  expect("error" in timed && timed.error.status).toBe(408)
  expect(Date.now() - started).toBeLessThan(7_000)
  expect(cancellations).toBe(1)
  const controller = new AbortController()
  const cancelled = readFeedbackJson(streamingRequest(stalled(), {}, controller.signal))
  controller.abort()
  const result = await cancelled
  expect("error" in result && result.error.status).toBe(499)
  expect(cancellations).toBe(2)
})

test("Feedback bounds bytes and cancels early media and declared-length failures", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-length": "8193" }]) {
    let cancelled = false
    const request = streamingRequest(new ReadableStream({ cancel() { cancelled = true } }), headers)
    const result = await readFeedbackJson(request)
    expect("error" in result && result.error.status).toBe("content-length" in headers ? 413 : 415)
    expect(cancelled).toBe(true)
  }
  let cancelled = false
  const overflow = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8193)) },
    cancel() { cancelled = true },
  })
  const result = await readFeedbackJson(streamingRequest(overflow))
  expect("error" in result && result.error.status).toBe(413)
  expect(cancelled).toBe(true)
  for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode("{")]) {
    const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    const result = await readFeedbackJson(streamingRequest(input))
    expect("error" in result && result.error.status).toBe(400)
    if ("error" in result) expect(result.error.headers.get("cache-control")).toBe("no-store")
  }
  const boundary = '"' + "x".repeat(8190) + '"'
  const exact = await readFeedbackJson(new Request("http://feedback.test", {
    method: "POST", body: boundary, headers: { "content-type": "application/json" },
  }))
  expect("body" in exact && exact.body).toBe("x".repeat(8190))
})
