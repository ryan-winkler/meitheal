/** Optional, process-wide best-effort transport. Stdout remains authoritative. */
type Entry = { service: string; env: string; timestamp: string; line: string }
const queue: Entry[] = []
const MAX_QUEUE = 200
const BATCH_SIZE = 50
const MAX_LINE_BYTES = 16_384
const FLUSH_MS = 250
const TIMEOUT_MS = 1_000
let configured: string | undefined
let destination: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let sending = false
let lastWarning = 0

function warn(): void {
  if (Date.now() - lastWarning < 60_000) return
  lastWarning = Date.now()
  // Do not recurse through the logger or expose URLs, responses or credentials.
  process.stderr.write('{"level":"warn","event":"logging.loki.delivery_failed","message":"Optional Loki forwarding failed or dropped logs; redacted stdout remains available"}\n')
}

function schedule(): void {
  if (timer || sending || !queue.length) return
  timer = setTimeout(() => {
    timer = undefined
    void flush()
  }, FLUSH_MS)
  timer.unref()
}

async function flush(): Promise<void> {
  if (!destination || sending) return
  const endpoint = destination
  const entries = queue.splice(0, BATCH_SIZE)
  const streams = new Map<string, { stream: { service: string; env: string }; values: string[][] }>()
  for (const entry of entries) {
    const key = JSON.stringify([entry.service, entry.env])
    if (!streams.has(key)) streams.set(key, { stream: { service: entry.service, env: entry.env }, values: [] })
    streams.get(key)!.values.push([entry.timestamp, entry.line])
  }
  sending = true
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streams: [...streams.values()] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    })
    await response.body?.cancel()
    if (!response.ok) warn()
  } catch { warn() } finally {
    sending = false
    schedule()
  }
}

/** Only pre-redacted log lines and static redacted service/env labels enter here. */
export function enqueueLokiLog(line: string, service: string, env: string, timestamp: number): void {
  const option = process.env.LOKI_URL?.trim() ?? ""
  if (option !== configured) {
    configured = option
    destination = null
    queue.length = 0
    if (option) {
      try {
        const url = new URL(option)
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Loki endpoint")
        destination = url.toString()
      } catch { warn() }
    }
  }
  if (!destination) return
  if (queue.length >= MAX_QUEUE || Buffer.byteLength(line) > MAX_LINE_BYTES) { warn(); return }
  queue.push({ line, service, env, timestamp: (BigInt(timestamp) * 1_000_000n).toString() })
  schedule()
}
