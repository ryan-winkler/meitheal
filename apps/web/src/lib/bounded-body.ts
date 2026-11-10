export async function readWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  signal?.throwIfAborted()
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) return Buffer.concat(chunks, size)
      size += value.byteLength
      if (size > limit) {
        // Cancellation of a cloned stream may wait for the original branch.
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}
