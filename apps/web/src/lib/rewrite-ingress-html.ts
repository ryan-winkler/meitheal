import { Readable, Transform, pipeline } from "node:stream"
import { RewritingStream } from "parse5-html-rewriting-stream"
import type { WaitForResponseDrain } from "../../scripts/ingress-transport.mjs"
import { paceResponseBody } from "./response-backpressure"

const scopedAttributes = new Set(["href", "src", "action"])
const outputBatchSize = 16 * 1024

function shouldPrefixUrl(val: string, prefix: string): boolean {
  return (
    val.startsWith("/") &&
    !val.startsWith("//") &&
    val !== prefix &&
    !val.startsWith(prefix + "/") &&
    !val.startsWith(prefix + "?") &&
    !val.startsWith(prefix + "#")
  )
}

function rewriteSrcset(rawSrcset: string, prefix: string): { value: string; changed: boolean } {
  let changed = false
  const parts = rawSrcset.split(",").map((candidate) => {
    const match = candidate.match(/^(\s*)(\S+)([\s\S]*)$/)
    if (!match) return candidate
    const [, leading, urlToken, descriptor] = match
    if (urlToken && shouldPrefixUrl(urlToken, prefix)) {
      changed = true
      return `${leading}${prefix}${urlToken}${descriptor}`
    }
    return candidate
  })
  return { value: changed ? parts.join(",") : rawSrcset, changed }
}

export async function rewriteIngressHtml(
  response: Response,
  ingressPath: string,
  options?: { wait?: WaitForResponseDrain | undefined; signal: AbortSignal },
): Promise<Response> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/html")) return response
  const prefix = ingressPath.replace(/\/+$/, "")
  if (prefix === "") return response

  const reader = response.body.getReader()
  const signal = options?.signal
  let readerReleased = false
  const cancelInput = () => {
    if (!readerReleased) void reader.cancel().catch(() => {})
  }
  const releaseInput = () => {
    if (readerReleased) return
    readerReleased = true
    signal?.removeEventListener("abort", cancelInput)
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  signal?.addEventListener("abort", cancelInput, { once: true })
  if (signal?.aborted) {
    cancelInput()
    releaseInput()
    signal.throwIfAborted()
  }

  const script = `<script>window.__ingress_path=${JSON.stringify(prefix)};</script>`
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const result = (body: BodyInit) => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })

  const rewriter = new RewritingStream()
  let headInjected = false

  rewriter.on("startTag", (tag, raw) => {
    let changed = false
    for (const attr of tag.attrs) {
      if (scopedAttributes.has(attr.name)) {
        if (shouldPrefixUrl(attr.value, prefix)) {
          attr.value = prefix + attr.value
          changed = true
        }
      } else if (attr.name === "srcset") {
        const nextSrcset = rewriteSrcset(attr.value, prefix)
        if (nextSrcset.changed) {
          attr.value = nextSrcset.value
          changed = true
        }
      }
    }
    if (changed) rewriter.emitStartTag(tag)
    else rewriter.emitRaw(raw)

    if (!headInjected && tag.tagName === "head") {
      headInjected = true
      rewriter.emitRaw(script)
    }
  })

  async function* readBody() {
    const decoder = new TextDecoder("utf-8")
    try {
      while (true) {
        const next = await reader.read()
        signal?.throwIfAborted()
        if (next.done) {
          const tail = decoder.decode()
          if (tail) yield tail
          return
        }
        const value = next.value
        for (let offset = 0; offset < value.byteLength; offset += outputBatchSize) {
          const decoded = decoder.decode(value.subarray(offset, offset + outputBatchSize), { stream: true })
          if (decoded) yield decoded
        }
      }
    } finally {
      cancelInput()
      releaseInput()
    }
  }

  let outputBatch: Buffer[] = []
  let outputSize = 0
  const output = new Transform({
    transform(chunk: Buffer | string, _encoding, done) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8")
      outputBatch.push(buf)
      outputSize += buf.byteLength
      if (outputSize < outputBatchSize) return done()
      const batch = Buffer.concat(outputBatch, outputSize)
      outputBatch = []
      outputSize = 0
      done(null, batch)
    },
    flush(done) {
      if (outputSize > 0) {
        const batch = Buffer.concat(outputBatch, outputSize)
        outputBatch = []
        outputSize = 0
        done(null, batch)
      } else {
        done()
      }
    },
  })

  const body = Readable.from(readBody(), { encoding: "utf8", objectMode: false })
  output.once("close", () => {
    cancelInput()
    releaseInput()
  })
  pipeline(body, rewriter, output, () => { /* Stream failures propagate to the response consumer. */ })

  const stream = Readable.toWeb(output, { strategy: { highWaterMark: 0 } }) as ReadableStream<Uint8Array>
  return result(options?.wait ? paceResponseBody(stream, options.wait, options.signal, outputBatchSize) : stream)
}
