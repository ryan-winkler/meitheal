/**
 * HTTP transport performance helpers for the standalone Meitheal server.
 *
 * Provides safe, streaming Brotli/gzip compression and immutable caching
 * headers for content-hashed static assets while keeping private/SSR HTML
 * and SSE/export streams uncached and unbuffered.
 */
import zlib from "node:zlib"

const MIN_COMPRESS_BYTES = 1024
const COMPRESSIBLE_CONTENT_TYPE =
  /^(?:text\/|application\/(?:javascript|x-javascript|json|manifest\+json|xml|xhtml\+xml|problem\+json)|image\/svg\+xml)/i

const IMMUTABLE_ASTRO_PREFIX = "/_astro/"
const STATIC_PUBLIC_EXACT = new Set([
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
])
const STATIC_PUBLIC_PREFIXES = ["/vendor/hugerte/", "/pwa/screenshots/"]

/**
 * Parse Accept-Encoding and pick the best supported encoding ("br", "gzip", or null).
 * Respects explicit q=0 rejections and client quality preferences.
 */
export function selectResponseEncoding(acceptEncodingHeader) {
  if (typeof acceptEncodingHeader !== "string" || !acceptEncodingHeader.trim()) {
    return null
  }
  let brQ = -1
  let gzipQ = -1
  let starQ = -1
  for (const rawPart of acceptEncodingHeader.split(",")) {
    const part = rawPart.trim()
    if (!part) continue
    const [rawName, ...params] = part.split(";")
    const name = rawName.trim().toLowerCase()
    let q = 1
    for (const param of params) {
      const [k, v] = param.split("=")
      if (k?.trim().toLowerCase() === "q" && v !== undefined) {
        const parsed = Number.parseFloat(v.trim())
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) q = parsed
      }
    }
    if (name === "br") brQ = q
    else if (name === "gzip" || name === "x-gzip") gzipQ = Math.max(gzipQ, q)
    else if (name === "*") starQ = q
  }
  const effectiveBr = brQ >= 0 ? brQ : starQ > 0 ? starQ : 0
  const effectiveGzip = gzipQ >= 0 ? gzipQ : starQ > 0 ? starQ : 0
  if (effectiveBr <= 0 && effectiveGzip <= 0) return null
  return effectiveBr >= effectiveGzip ? "br" : "gzip"
}

/**
 * Resolve safe public Cache-Control header for static build/public assets.
 * Returns null for dynamic routes, HTML, service worker, version.json, and manifests.
 */
export function resolveStaticCacheControl(pathname) {
  if (typeof pathname !== "string" || !pathname) return null
  if (pathname.startsWith(IMMUTABLE_ASTRO_PREFIX)) {
    return "public, max-age=31536000, immutable"
  }
  if (STATIC_PUBLIC_EXACT.has(pathname)) {
    return "public, max-age=86400"
  }
  for (const prefix of STATIC_PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return "public, max-age=86400"
    }
  }
  return null
}

/**
 * Determine whether a response is eligible for streaming HTTP compression.
 */
export function shouldCompressResponse({
  method,
  statusCode,
  pathname,
  contentType,
  contentEncoding,
  contentLength,
}) {
  if (method === "HEAD") return false
  if (statusCode < 200 || statusCode === 204 || statusCode === 205 || statusCode === 304) {
    return false
  }
  if (pathname === "/api/sse" || pathname === "/api/export/database.sqlite") {
    return false
  }
  if (contentEncoding) return false
  if (typeof contentType !== "string" || !COMPRESSIBLE_CONTENT_TYPE.test(contentType)) {
    return false
  }
  if (/text\/event-stream/i.test(contentType)) return false
  if (contentLength !== undefined && contentLength !== null) {
    const parsedLength = Number(contentLength)
    if (Number.isFinite(parsedLength) && parsedLength < MIN_COMPRESS_BYTES) {
      return false
    }
  }
  return true
}

function appendVaryHeader(res, value) {
  const existing = res.getHeader("vary")
  if (!existing) {
    res.setHeader("vary", value)
    return
  }
  const list = Array.isArray(existing) ? existing.join(", ") : String(existing)
  if (!list.toLowerCase().split(",").map(item => item.trim()).includes(value.toLowerCase())) {
    res.setHeader("vary", `${list}, ${value}`)
  }
}

function createCompressor(encoding) {
  if (encoding === "br") {
    // Quality 4 balances strong compression (~80% on HTML/JS/CSS) with low ARM CPU cost on HA Green.
    return zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
      },
    })
  }
  return zlib.createGzip({ level: 6 })
}

/**
 * Attach static asset caching and transparent streaming compression to an HTTP response.
 */
export function attachResponsePerformanceHooks(req, res, pathname) {
  const staticCacheControl = resolveStaticCacheControl(pathname)
  const encoding = selectResponseEncoding(req.headers["accept-encoding"])

  // Fast path: neither static caching nor compression applies.
  if (!staticCacheControl && !encoding) return

  const rawWriteHead = res.writeHead.bind(res)
  const rawWrite = res.write.bind(res)
  const rawEnd = res.end.bind(res)

  let decided = false
  let compressor = null

  function ensureInitialized(statusCode, reasonOrHeaders, maybeHeaders) {
    if (decided) return
    decided = true

    const headerMap =
      reasonOrHeaders && typeof reasonOrHeaders === "object"
        ? reasonOrHeaders
        : maybeHeaders && typeof maybeHeaders === "object"
          ? maybeHeaders
          : null

    if (headerMap) {
      for (const [key, val] of Object.entries(headerMap)) {
        if (val !== undefined) res.setHeader(key, val)
      }
    }

    const code = typeof statusCode === "number" ? statusCode : res.statusCode || 200
    if (staticCacheControl && code >= 200 && code < 300 && !res.hasHeader("cache-control")) {
      res.setHeader("cache-control", staticCacheControl)
    }

    if (!encoding) return

    const contentType = res.getHeader("content-type")
    const contentEncoding = res.getHeader("content-encoding")
    const contentLength = res.getHeader("content-length")

    if (
      !shouldCompressResponse({
        method: req.method,
        statusCode: code,
        pathname,
        contentType: Array.isArray(contentType) ? contentType[0] : contentType,
        contentEncoding,
        contentLength,
      })
    ) {
      return
    }

    appendVaryHeader(res, "Accept-Encoding")
    res.setHeader("content-encoding", encoding)
    res.removeHeader("content-length")

    compressor = createCompressor(encoding)
    compressor.on("data", chunk => {
      if (!rawWrite(chunk)) {
        compressor.pause()
      }
    })
    res.on("drain", () => {
      compressor?.resume()
    })
    compressor.on("end", () => {
      rawEnd()
    })
    compressor.on("error", () => {
      if (!res.writableEnded) rawEnd()
    })
    res.once("close", () => {
      if (compressor && !compressor.destroyed) {
        compressor.destroy()
      }
    })
  }

  res.writeHead = function patchedWriteHead(statusCode, reasonOrHeaders, maybeHeaders) {
    ensureInitialized(statusCode, reasonOrHeaders, maybeHeaders)
    if (typeof reasonOrHeaders === "string") {
      return rawWriteHead(statusCode, reasonOrHeaders)
    }
    return rawWriteHead(statusCode)
  }

  res.write = function patchedWrite(chunk, encodingArg, callback) {
    if (!decided) {
      ensureInitialized(res.statusCode || 200)
    }
    if (compressor) {
      return compressor.write(chunk, encodingArg, callback)
    }
    return rawWrite(chunk, encodingArg, callback)
  }

  res.end = function patchedEnd(chunk, encodingArg, callback) {
    if (!decided) {
      ensureInitialized(res.statusCode || 200)
    }
    if (compressor) {
      if (typeof chunk === "function") {
        compressor.end()
        res.once("finish", chunk)
        return res
      }
      if (typeof encodingArg === "function") {
        compressor.end(chunk)
        res.once("finish", encodingArg)
        return res
      }
      if (typeof callback === "function") {
        compressor.end(chunk, encodingArg)
        res.once("finish", callback)
        return res
      }
      compressor.end(chunk, encodingArg)
      return res
    }
    return rawEnd(chunk, encodingArg, callback)
  }
}
