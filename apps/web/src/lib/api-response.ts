/**
 * Shared API response helpers for consistent JSON error/success responses.
 *
 * All error responses use RFC 9457 Problem Details (application/problem+json)
 * for machine-readable, self-correcting agent payloads.
 *
 * @domain api
 * @bounded-context http-responses
 * @see https://www.rfc-editor.org/rfc/rfc9457
 */

// ─── RFC 9457 Types ──────────────────────────────────────────────────────────

/** RFC 9457 Problem Details object. */
export interface ProblemDetail {
  /** URI identifying the problem type — should resolve to human docs */
  type: string
  /** Short human-readable summary of the problem type */
  title: string
  /** HTTP status code */
  status: number
  /** Human-readable explanation for this specific occurrence */
  detail?: string
  /** URI reference identifying the specific occurrence */
  instance?: string
  /** Trace ID for correlation with structured logs */
  traceId?: string
  /** Legacy alias — set to `detail` for backward compatibility */
  error?: string
  /** Validation errors for self-correcting agents */
  invalidParams?: InvalidParam[]
}

/** A single invalid parameter from Zod validation. */
export interface InvalidParam {
  /** JSON path to the field (e.g., "body.title" or "query.limit") */
  name: string
  /** Human-readable reason the field is invalid */
  reason: string
}

// ─── Problem Type URIs ───────────────────────────────────────────────────────

const PROBLEM_BASE = "https://meitheal.local/problems"

/** Well-known problem types for consistent agent parsing. */
export const ProblemTypes = {
  VALIDATION: `${PROBLEM_BASE}/validation-error`,
  NOT_FOUND: `${PROBLEM_BASE}/not-found`,
  RATE_LIMITED: `${PROBLEM_BASE}/rate-limited`,
  UNAUTHORIZED: `${PROBLEM_BASE}/unauthorized`,
  FORBIDDEN: `${PROBLEM_BASE}/forbidden`,
  INTERNAL: `${PROBLEM_BASE}/internal-error`,
  CONFLICT: `${PROBLEM_BASE}/conflict`,
} as const

// ─── Status → Default Problem Mapping ────────────────────────────────────────

const STATUS_DEFAULTS: Record<number, { type: string; title: string }> = {
  400: { type: ProblemTypes.VALIDATION, title: "Validation Error" },
  401: { type: ProblemTypes.UNAUTHORIZED, title: "Unauthorized" },
  403: { type: ProblemTypes.FORBIDDEN, title: "Forbidden" },
  404: { type: ProblemTypes.NOT_FOUND, title: "Not Found" },
  409: { type: ProblemTypes.CONFLICT, title: "Conflict" },
  429: { type: ProblemTypes.RATE_LIMITED, title: "Rate Limited" },
  500: { type: ProblemTypes.INTERNAL, title: "Internal Server Error" },
}

// ─── Core Helpers ────────────────────────────────────────────────────────────

/**
 * Return an RFC 9457 `application/problem+json` response.
 *
 * This is the primary error helper — all other error functions delegate here.
 */
export function apiProblem(opts: {
  status: number
  detail?: string | undefined
  type?: string | undefined
  title?: string | undefined
  instance?: string | undefined
  traceId?: string | undefined
  invalidParams?: InvalidParam[] | undefined
  extraHeaders?: Record<string, string> | undefined
}): Response {
  const defaults = STATUS_DEFAULTS[opts.status] ?? {
    type: `${PROBLEM_BASE}/error`,
    title: "Error",
  }

  const body: ProblemDetail = {
    type: opts.type ?? defaults.type,
    title: opts.title ?? defaults.title,
    status: opts.status,
    ...(opts.detail ? { detail: opts.detail, error: opts.detail } : {}),
    ...(opts.instance ? { instance: opts.instance } : {}),
    ...(opts.traceId ? { traceId: opts.traceId } : {}),
    ...(opts.invalidParams?.length ? { invalidParams: opts.invalidParams } : {}),
  }

  return new Response(JSON.stringify(body), {
    status: opts.status,
    headers: {
      "content-type": "application/problem+json",
      ...opts.extraHeaders,
    },
  })
}

/**
 * Return a JSON error response with consistent shape.
 *
 * Backward-compatible wrapper around `apiProblem()`. Existing call sites
 * (`apiError("msg", 400)`) continue to work without changes and now
 * return RFC 9457 problem+json.
 *
 * @example apiError("name is required", 400)
 */
export function apiError(error: string, status: number = 500): Response {
  return apiProblem({ status, detail: error })
}

/**
 * Return a Zod validation error as RFC 9457 with `invalidParams[]`.
 *
 * LLMs/agents can read invalidParams to autonomously rewrite their payload
 * and retry the request.
 *
 * @example
 * const result = schema.safeParse(body)
 * if (!result.success) return apiValidationError(result.error, "/api/tasks/create")
 */
export function apiValidationError(
  zodError: { issues: Array<{ path: (string | number)[]; message: string }> },
  instance?: string,
  traceId?: string,
): Response {
  const invalidParams: InvalidParam[] = zodError.issues.map((issue) => ({
    name: issue.path.length > 0 ? issue.path.join(".") : "body",
    reason: issue.message,
  }))

  return apiProblem({
    status: 400,
    type: ProblemTypes.VALIDATION,
    title: "Validation Error",
    detail: `${invalidParams.length} field${invalidParams.length === 1 ? "" : "s"} failed validation`,
    instance,
    traceId,
    invalidParams,
  })
}

/**
 * Return a rate-limited 429 as RFC 9457 problem+json.
 *
 * @param retryAfter Seconds until the rate limit resets
 * @param detail Optional detail message
 * @param extraHeaders Additional headers (e.g., RateLimit, RateLimit-Policy)
 */
export function apiRateLimited(
  retryAfter: number,
  detail?: string,
  extraHeaders?: Record<string, string>,
): Response {
  return apiProblem({
    status: 429,
    detail: detail ?? "Rate limit exceeded. Retry after the period specified in Retry-After header.",
    extraHeaders: {
      "retry-after": String(retryAfter),
      ...extraHeaders,
    },
  })
}

// ─── Success Helper ──────────────────────────────────────────────────────────

/** Return a JSON success response. */
export function apiJson(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}
