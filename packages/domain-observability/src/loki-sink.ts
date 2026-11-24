/** Optional, process-wide best-effort transport. Stdout remains authoritative. */
type LokiStreamLabels = {
  addon: "meitheal"
  service: string
  env: string
  level: string
  domain: string
}
type Entry = {
  service: string
  env: string
  level: string
  domain: string
  timestamp: string
  line: string
}
const queue: Entry[] = []
const MAX_QUEUE = 200
const BATCH_SIZE = 50
const MAX_LINE_BYTES = 16_384
const FLUSH_MS = 250
const TIMEOUT_MS = 1_000
const INITIAL_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000
let configured: string | undefined
let destination: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let sending = false
let lastWarning = -Infinity
let configEpoch = 0
let consecutiveFailures = 0
let nextAttemptAt = 0

/** Return exponential backoff in milliseconds (2s to 60s) for consecutive delivery failures. */
export function computeLokiBackoffMs(failures: number): number {
  const count = Math.floor(failures)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(count - 1, 10))
}

function warn(): void {
  const now = performance.now()
  if (now - lastWarning < 60_000) return
  lastWarning = now
  // Do not recurse through the logger or expose URLs, responses or credentials.
  process.stderr.write('{"level":"warn","event":"logging.loki.delivery_failed","message":"Optional Loki forwarding failed or dropped logs; redacted stdout remains available"}\n')
}

function schedule(): void {
  if (timer || sending || !queue.length) return
  const delay = consecutiveFailures > 0
    ? Math.min(MAX_BACKOFF_MS, Math.max(FLUSH_MS, nextAttemptAt - performance.now()))
    : FLUSH_MS
  timer = setTimeout(() => {
    timer = undefined
    void flush()
  }, delay)
  timer.unref()
}

async function flush(): Promise<void> {
  if (!destination || sending) return
  const endpoint = destination
  const epoch = configEpoch
  const entries = queue.splice(0, BATCH_SIZE)
  if (!entries.length) return
  const streams = new Map<string, { stream: LokiStreamLabels; values: string[][] }>()
  for (const entry of entries) {
    const key = JSON.stringify([entry.service, entry.env, entry.level, entry.domain])
    if (!streams.has(key)) {
      streams.set(key, {
        stream: {
          addon: "meitheal",
          service: entry.service,
          env: entry.env,
          level: entry.level,
          domain: entry.domain,
        },
        values: [],
      })
    }
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
    if (epoch === configEpoch) {
      if (response.ok) {
        consecutiveFailures = 0
        nextAttemptAt = 0
      } else {
        consecutiveFailures += 1
        nextAttemptAt = performance.now() + computeLokiBackoffMs(consecutiveFailures)
        warn()
      }
    }
  } catch {
    if (epoch === configEpoch) {
      consecutiveFailures += 1
      nextAttemptAt = performance.now() + computeLokiBackoffMs(consecutiveFailures)
      warn()
    }
  } finally {
    sending = false
    schedule()
  }
}

/** Only pre-redacted log lines and static bounded labels enter here. */
export function enqueueLokiLog(
  line: string,
  service: string,
  env: string,
  timestamp: number,
  level = "info",
  domain = "system",
): void {
  const option = process.env.LOKI_URL?.trim() ?? ""
  if (option !== configured) {
    configured = option
    configEpoch += 1
    destination = null
    queue.length = 0
    consecutiveFailures = 0
    nextAttemptAt = 0
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
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
  queue.push({
    line,
    service,
    env,
    level,
    domain,
    timestamp: (BigInt(timestamp) * 1_000_000n).toString(),
  })
  schedule()
}
