/**
 * Shared API Logger — Structured JSON logging for all server-side API endpoints
 *
 * Uses the @meitheal/domain-observability structured logger.
 * Replaces raw console.error calls with domain-aware, structured log entries.
 *
 * Bounded Context: Infrastructure (observability)
 */

import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

export const apiLogger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["api"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});

export function logApiError(
  component: string,
  message: string,
  error: unknown,
  requestId?: string,
) {
  const errDetail = error instanceof Error ? error.stack || error.message : String(error);
  apiLogger.log("error", {
    event: `api.${component}.error`,
    domain: "api",
    component,
    request_id: requestId ?? "unknown",
    message: `${message}: ${errDetail}`,
  });
  try {
    (async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const logPath = path.join(process.cwd(), ".data", "api_error.log");
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${component} (${requestId}): ${message}\n${errDetail}\n\n`);
    })();
  } catch (e) {
    // ignore
  }
}

export function logApiWarn(
  component: string,
  message: string,
  requestId?: string,
) {
  apiLogger.log("warn", {
    event: `api.${component}.warn`,
    domain: "api",
    component,
    request_id: requestId ?? "unknown",
    message,
  });
}
