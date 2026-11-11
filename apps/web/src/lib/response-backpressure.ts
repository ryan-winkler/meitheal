import type { WaitForResponseDrain } from "../../scripts/ingress-transport.mjs"

export function paceResponseBody(
  body: ReadableStream<Uint8Array>,
  waitForDrain: WaitForResponseDrain,
  signal: AbortSignal,
  maxChunkBytes = Infinity,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const cancelled = new AbortController()
  const streamSignal = AbortSignal.any([signal, cancelled.signal])
  let remainder: Uint8Array | undefined

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!await waitForDrain(streamSignal)) {
          if (!cancelled.signal.aborted) controller.close()
          await reader.cancel().catch(() => undefined)
          return
        }
        if (!remainder) {
          const result = await reader.read()
          if (cancelled.signal.aborted) return
          if (result.done) {
            controller.close()
            return
          }
          remainder = result.value
        }
        const chunk = remainder.subarray(0, maxChunkBytes)
        remainder = chunk.byteLength < remainder.byteLength ? remainder.subarray(chunk.byteLength) : undefined
        controller.enqueue(chunk)
      } catch (error) {
        if (cancelled.signal.aborted) return
        if (signal.aborted) controller.close()
        else throw error
      }
    },
    async cancel(reason) {
      cancelled.abort()
      remainder = undefined
      try {
        await reader.cancel(reason)
      } catch (error) {
        if (!signal.aborted) throw error
      }
    },
  }, { highWaterMark: 0 })
}
