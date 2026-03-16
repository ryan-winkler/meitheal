/**
 * waitForFn — Utility for cross-component window function coordination
 *
 * Domain: Cross-cutting / Script Coordination
 * Purpose: Safely call window functions that may not be registered yet
 * (e.g., module scripts register functions that is:inline scripts need).
 *
 * Usage:
 *   import { waitForFn } from '@lib/wait-for-fn';
 *
 *   // Wait for a function to be available, then call it
 *   waitForFn('openTaskDetail', (fn) => fn('task-123'));
 *
 *   // With timeout (default: 500ms)
 *   waitForFn('openNewTaskModal', (fn) => fn(), 1000);
 *
 * KCS: Standardizes the retry-loop pattern already used in kanban.astro
 * lines 939-948. Replaces ad-hoc setTimeout chains with a clean utility.
 * Documented in .planning/persona-loops/click-reliability-audit.md (P4-2).
 */

import { createClientLogger } from "@lib/client-logger";

const log = createClientLogger("utils", "wait-for-fn");

/**
 * Wait for a function to appear on the window object, then execute a callback with it.
 *
 * @param fnName - Name of the function on `window` to wait for
 * @param callback - Called with the function once it's available
 * @param timeoutMs - Maximum time to wait before giving up (default: 500ms)
 */
export function waitForFn<T extends (...args: any[]) => any>(
  fnName: string,
  callback: (fn: T) => void,
  timeoutMs = 500,
): void {
  const fn = (window as unknown as Record<string, unknown>)[fnName];
  if (typeof fn === "function") {
    callback(fn as T);
    return;
  }

  const interval = 25; // ms between checks
  let elapsed = 0;

  const timer = setInterval(() => {
    elapsed += interval;
    const fn = (window as unknown as Record<string, unknown>)[fnName];
    if (typeof fn === "function") {
      clearInterval(timer);
      callback(fn as T);
    } else if (elapsed >= timeoutMs) {
      clearInterval(timer);
      log.warn(
        `Timed out waiting for window.${fnName} after ${timeoutMs}ms`,
      );
    }
  }, interval);
}
