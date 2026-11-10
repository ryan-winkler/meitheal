/**
 * Supervisor Fetch — timeout-protected Supervisor proxy calls
 *
 * All calls to the HA Supervisor internal proxy (http://supervisor/*)
 * must use this helper to prevent indefinite hangs when Supervisor
 * is slow or unresponsive.
 *
 * @domain ha
 * @bounded-context integration
 */

/** Default timeout for Supervisor API calls (8 seconds) */
const SUPERVISOR_TIMEOUT_MS = 8_000;

/**
 * Fetch wrapper for HA Supervisor internal proxy with automatic timeout.
 *
 * - Injects SUPERVISOR_TOKEN authorization header
 * - AbortController with 8s timeout
 * - Returns null if no SUPERVISOR_TOKEN available
 *
 * @param path — Supervisor API path (e.g. "/addons/self/info")
 * @param options — Optional fetch overrides (method, body, etc.)
 * @param timeoutMs — Optional timeout override (default 8000ms)
 */
export async function supervisorFetch(
  path: string,
  options: RequestInit = {},
  timeoutMs = SUPERVISOR_TIMEOUT_MS,
): Promise<Response | null> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`http://supervisor${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Supervisor API timeout after ${timeoutMs}ms: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
