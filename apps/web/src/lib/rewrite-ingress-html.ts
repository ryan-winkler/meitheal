import { Readable, Transform, pipeline } from "node:stream"
import { RewritingStream } from "parse5-html-rewriting-stream"
import type { WaitForResponseDrain } from "../../scripts/ingress-transport.mjs"
import { paceResponseBody } from "./response-backpressure"

const scopedAttributes = new Set(["href", "src", "action"])
const bufferedLimit = 5 * 1024 * 1024
const outputBatchSize = 16 * 1024

function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return end === value.length ? value : value.slice(0, end)
}

function isAsciiWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13
}

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
    let urlStart = 0
    while (urlStart < candidate.length && isAsciiWhitespace(candidate.charCodeAt(urlStart))) {
      urlStart += 1
    }
    if (urlStart >= candidate.length) return candidate
    let urlEnd = urlStart
    while (urlEnd < candidate.length && !isAsciiWhitespace(candidate.charCodeAt(urlEnd))) {
      urlEnd += 1
    }
    const urlToken = candidate.slice(urlStart, urlEnd)
    if (urlToken && shouldPrefixUrl(urlToken, prefix)) {
      changed = true
      return `${candidate.slice(0, urlStart)}${prefix}${urlToken}${candidate.slice(urlEnd)}`
    }
    return candidate
  })
  return { value: changed ? parts.join(",") : rawSrcset, changed }
}

function configureRewriter(rewriter: RewritingStream, prefix: string, script: string): void {
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
}

function rewriteBufferedHtml(rawHtml: string, prefix: string, script: string): string {
  const rewriter = new RewritingStream()
  configureRewriter(rewriter, prefix, script)
  const chunks: string[] = []
  rewriter.on("data", (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
  })
  rewriter.write(rawHtml)
  rewriter.end()
  return chunks.join("")
}

function createBatchedOutputStream(): Transform {
  let outputBatch: Buffer[] = []
  let outputSize = 0
  return new Transform({
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
}

export async function rewriteIngressHtml(
  response: Response,
  ingressPath: string,
  options?: { wait?: WaitForResponseDrain | undefined; signal: AbortSignal },
): Promise<Response> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/html")) return response
  const prefix = stripTrailingSlashes(ingressPath)
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
  if (signal?.aborted) cancelInput()

  const buffered: Uint8Array[] = []
  const script = `<script>window.__ingress_path=${JSON.stringify(prefix)};</script>`
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const result = (body: BodyInit) => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })

  let size = 0
  let rewriter: RewritingStream | undefined
  try {
    while (size <= bufferedLimit) {
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      buffered.push(next.value)
      size += next.value.byteLength
    }
    if (size > bufferedLimit) {
      signal?.throwIfAborted()
      rewriter = new RewritingStream()
    }
  } catch (error) {
    cancelInput()
    releaseInput()
    throw error
  }

  if (!rewriter) {
    releaseInput()
    const rawHtml = Buffer.concat(buffered, size).toString("utf8")
    return result(rewriteBufferedHtml(rawHtml, prefix, script))
  }

  configureRewriter(rewriter, prefix, script)

  async function* readBody() {
    try {
      for (const chunk of buffered.splice(0)) {
        for (let offset = 0; offset < chunk.byteLength; offset += outputBatchSize) {
          yield chunk.subarray(offset, offset + outputBatchSize)
        }
      }
      while (true) {
        const next = await reader.read()
        signal?.throwIfAborted()
        if (next.done) return
        const value = next.value
        for (let offset = 0; offset < value.byteLength; offset += outputBatchSize) {
          yield value.subarray(offset, offset + outputBatchSize)
        }
      }
    } finally {
      cancelInput()
      releaseInput()
    }
  }

  const output = createBatchedOutputStream()
  const body = Readable.from(readBody(), { encoding: "utf8", objectMode: false })
  output.once("close", () => {
    cancelInput()
    releaseInput()
  })
  pipeline(body, rewriter, output, () => { /* Stream failures propagate to the response consumer. */ })

  const stream = Readable.toWeb(output, { strategy: { highWaterMark: 0 } }) as ReadableStream<Uint8Array>
  return result(options?.wait ? paceResponseBody(stream, options.wait, options.signal, outputBatchSize) : stream)
}
