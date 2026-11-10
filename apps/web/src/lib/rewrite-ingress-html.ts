import { Readable, Transform, pipeline } from "node:stream"
import { RewritingStream } from "parse5-html-rewriting-stream"

const scopedAttributes = new Set(["href", "src", "action"])
const bufferedLimit = 5 * 1024 * 1024
const outputBatchSize = 16 * 1024

export async function rewriteIngressHtml(response: Response, ingressPath: string): Promise<Response> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/html")) return response

  const reader = response.body.getReader()
  const buffered: Uint8Array[] = []
  const script = `<script>window.__ingress_path=${JSON.stringify(ingressPath)};</script>`
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const result = (body: BodyInit) => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })

  let size = 0
  while (size <= bufferedLimit) {
    const next = await reader.read()
    if (next.done) {
      reader.releaseLock()
      const html = Buffer.concat(buffered, size).toString("utf8")
      return result(html.replace("<head>", `<head>${script}`)
        .replace(/((?:href|src|action)=["'])\/(?!\/)/g, `$1${ingressPath}/`))
    }
    buffered.push(next.value)
    size += next.value.byteLength
  }

  // Ordinary pages take the existing fast path. Large pages stay scoped
  // without joining their whole bodies into a single HTML string.
  const rewriter = new RewritingStream()
  rewriter.on("startTag", (tag, raw) => {
    let changed = false
    for (const attr of tag.attrs) {
      if (scopedAttributes.has(attr.name) && attr.value.startsWith("/") && !attr.value.startsWith("//") &&
          attr.value !== ingressPath && !attr.value.startsWith(ingressPath + "/")) {
        attr.value = ingressPath + attr.value
        changed = true
      }
    }
    if (changed) rewriter.emitStartTag(tag)
    else rewriter.emitRaw(raw)

    if (tag.tagName === "head") rewriter.emitRaw(script)
  })

  async function* readBody() {
    try {
      yield* buffered.splice(0)
      while (true) {
        const next = await reader.read()
        if (next.done) return
        yield next.value
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  let outputBatch: Buffer[] = []
  let outputSize = 0
  const output = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      outputBatch.push(chunk)
      outputSize += chunk.byteLength
      if (outputSize < outputBatchSize) return done()
      const batch = Buffer.concat(outputBatch, outputSize)
      outputBatch = []
      outputSize = 0
      done(null, batch)
    },
    flush(done) {
      done(null, Buffer.concat(outputBatch, outputSize))
    },
  })
  const body = Readable.from(readBody(), { encoding: "utf8", objectMode: false })
  pipeline(body, rewriter, output, () => { /* Stream failures propagate to the response consumer. */ })
  return result(Readable.toWeb(output) as ReadableStream<Uint8Array>)
}
