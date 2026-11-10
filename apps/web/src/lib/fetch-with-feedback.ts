/**
 * fetchWithFeedback — Standardized API calls with toast feedback
 *
 * Wraps fetch with:
 * 1. Automatic toast on success (optional)
 * 2. Automatic toast on error with user-friendly message
 * 3. Typed JSON response parsing
 * 4. Ingress-aware URL prefixing
 *
 * @domain ui
 * @phase 25 — Client-Side Resilience
 *
 * @example
 * ```ts
 * import { fetchWithFeedback } from "@lib/fetch-with-feedback"
 *
 * const result = await fetchWithFeedback<{ id: string }>("/api/tasks", {
 *   method: "POST",
 *   body: JSON.stringify({ title: "New task" }),
 *   successMessage: "Task created",
 *   errorMessage: "Failed to create task",
 * })
 * if (result.ok) console.log(result.data.id)
 * ```
 */

import { showToast } from "@lib/toast"

export interface FetchFeedbackOptions extends RequestInit {
  /** Toast message on success (omit to skip success toast) */
  successMessage?: string
  /** Toast message on error */
  errorMessage?: string
  /** Whether to suppress the default error toast (default: false) */
  suppressErrorToast?: boolean
}

export type FetchResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number }

/**
 * Performs a fetch with automatic toast feedback.
 *
 * Uses the Layout.astro monkey-patched fetch for ingress compatibility.
 * DO NOT use apiUrl() — fetch is already patched in Layout.astro.
 */
export async function fetchWithFeedback<T = unknown>(
  url: string,
  options: FetchFeedbackOptions = {},
): Promise<FetchResult<T>> {
  const {
    successMessage,
    errorMessage = "Something went wrong",
    suppressErrorToast = false,
    ...fetchOptions
  } = options

  // Default content-type for JSON bodies
  if (fetchOptions.body && typeof fetchOptions.body === "string") {
    fetchOptions.headers = {
      "content-type": "application/json",
      ...fetchOptions.headers,
    }
  }

  try {
    const res = await fetch(url, fetchOptions)

    if (res.ok) {
      let data: T = {} as T
      const contentType = res.headers.get("content-type")
      if (contentType?.includes("application/json")) {
        try {
          data = await res.json()
        } catch { /* non-JSON response body — use empty object */ }
      }
      if (successMessage) showToast(successMessage, "success")
      return { ok: true, data, status: res.status }
    }

    // Error response — try to extract server error message
    let serverMessage = errorMessage
    try {
      const errData = await res.json()
      if (errData.detail) serverMessage = errData.detail
      else if (errData.message) serverMessage = errData.message
      else if (errData.error) serverMessage = errData.error
    } catch { /* non-JSON error response */ }

    if (!suppressErrorToast) showToast(serverMessage, "error")
    return { ok: false, error: serverMessage, status: res.status }
  } catch (err) {
    const networkMessage = navigator.onLine
      ? errorMessage
      : "You appear to be offline"
    if (!suppressErrorToast) showToast(networkMessage, "error")
    return { ok: false, error: String(err), status: 0 }
  }
}
