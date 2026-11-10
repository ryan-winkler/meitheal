/**
 * Safe Fetch — AbortController-wrapped fetch with configurable timeout
 *
 * Prevents zombie HTTP requests from accumulating when:
 * - The server is slow/unresponsive
 * - The user navigates away mid-request
 * - HA ingress proxy hangs
 *
 * Every client-side fetch should use this instead of raw fetch().
 *
 * Bounded context: lib (shared utility)
 *
 * @example
 * const data = await safeFetch('/api/tasks', { timeoutMs: 5000 });
 * const json = await data.json();
 */

/** Default timeout for all fetches (8 seconds) */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Maximum concurrent fetches per endpoint to prevent flooding */
const MAX_CONCURRENT_PER_ENDPOINT = 6;

// Track in-flight requests per endpoint for flood protection
const inflight = new Map<string, number>();

export interface SafeFetchOptions extends RequestInit {
  /** Request timeout in milliseconds (default: 8000) */
  timeoutMs?: number;
}

/**
 * Fetch with automatic timeout via AbortController.
 * Rejects with an AbortError if the request exceeds timeoutMs.
 * Automatically tracks concurrent requests per endpoint.
 */
export async function safeFetch(
  url: string | URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const endpoint = typeof url === "string" ? (url.split("?")[0] ?? url) : url.pathname;

  // Flood protection — reject if too many concurrent requests to same endpoint
  const current = inflight.get(endpoint) ?? 0;
  if (current >= MAX_CONCURRENT_PER_ENDPOINT) {
    throw new Error(`safeFetch: too many concurrent requests to ${endpoint} (${current}/${MAX_CONCURRENT_PER_ENDPOINT})`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  inflight.set(endpoint, current + 1);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`safeFetch: request to ${endpoint} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    const remaining = (inflight.get(endpoint) ?? 1) - 1;
    if (remaining <= 0) {
      inflight.delete(endpoint);
    } else {
      inflight.set(endpoint, remaining);
    }
  }
}

/**
 * Debounce utility — delays execution until quiet period.
 * Returns a cleanup function to cancel pending calls.
 *
 * @example
 * const [debouncedSearch, cleanup] = debounce((query: string) => {
 *   fetch(`/api/tasks?q=${query}`);
 * }, 300);
 * // In cleanup: cleanup();
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number,
): [T, () => void] {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  }) as T;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return [debounced, cleanup];
}

/**
 * Throttle utility — limits execution to at most once per interval.
 * Always executes the first call immediately.
 *
 * @example
 * const [throttledScroll, cleanup] = throttle(() => updatePosition(), 100);
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  intervalMs: number,
): [T, () => void] {
  let lastCall = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const throttled = ((...args: unknown[]) => {
    const now = Date.now();
    const remaining = intervalMs - (now - lastCall);

    if (remaining <= 0) {
      lastCall = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  }) as T;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return [throttled, cleanup];
}
