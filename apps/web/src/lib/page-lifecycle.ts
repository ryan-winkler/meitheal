/**
 * PageLifecycle — AbortController-based event listener lifecycle management
 *
 * Domain: Cross-cutting / Event Management
 * Purpose: Prevent event listener accumulation across ViewTransition navigations
 *
 * Usage:
 *   import { pageLifecycle } from '@lib/page-lifecycle';
 *
 *   // Get a signal for the current page lifecycle
 *   const signal = pageLifecycle.signal;
 *
 *   // All listeners using this signal auto-abort on next navigation
 *   document.addEventListener('click', handler, { signal });
 *   element.addEventListener('keydown', handler, { signal });
 *
 *   // Or use the convenience helper
 *   pageLifecycle.on(element, 'click', handler);
 *   pageLifecycle.on(document, 'keydown', handler);
 *
 * How it works:
 *   On each `astro:before-swap` event (fired before ViewTransition DOM swap),
 *   the current AbortController is aborted — automatically removing ALL
 *   listeners registered with its signal. A new controller is created for
 *   the incoming page.
 */

let controller = new AbortController();

// Abort all listeners before ViewTransition swap, create fresh controller
// This runs in module scope — only registered once (Astro dedupes modules)
document.addEventListener("astro:before-swap", () => {
  controller.abort();
  controller = new AbortController();
});

/**
 * Page lifecycle manager for event listener cleanup.
 *
 * All listeners registered via `pageLifecycle.on()` or using
 * `pageLifecycle.signal` are automatically cleaned up on navigation.
 */
export const pageLifecycle = {
  /** Current AbortSignal — pass to addEventListener options */
  get signal(): AbortSignal {
    return controller.signal;
  },

  /**
   * Convenience: addEventListener with automatic lifecycle cleanup.
   * Equivalent to: target.addEventListener(event, handler, { signal: pageLifecycle.signal, ...options })
   */
  on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    event: K | string,
    handler: EventListenerOrEventListenerObject,
    options?: Omit<AddEventListenerOptions, "signal">,
  ): void {
    target.addEventListener(event, handler, {
      ...options,
      signal: controller.signal,
    });
  },

  /**
   * Run a callback on every page load (initial + ViewTransition navigations).
   * The callback receives the current AbortSignal for that page's lifecycle.
   * Previous listeners from the callback are auto-cleaned on next navigation.
   */
  onPageLoad(callback: (signal: AbortSignal) => void): void {
    // Some modules may load after the first astro:page-load event has already fired,
    // and Home Assistant Ingress disables ClientRouter (so astro:page-load never fires).
    // Guarantee initial setup completes by window load (and via 0ms fallback if late).
    let initialPending = true
    const runInitial = () => {
      if (!initialPending) return
      initialPending = false
      clearTimeout(fallbackId)
      window.removeEventListener("load", runInitial)
      callback(controller.signal)
    }
    const fallbackId = globalThis.setTimeout(runInitial, 0)
    if (
      document.readyState !== "complete" &&
      !document.querySelector('meta[name="astro-view-transitions-enabled"]')
    ) {
      window.addEventListener("load", runInitial, { once: true })
    }

    document.addEventListener("astro:page-load", () => {
      if (initialPending) {
        clearTimeout(fallbackId)
        window.removeEventListener("load", runInitial)
        initialPending = false
      }
      callback(controller.signal)
    })
  },

  /**
   * Clear and re-register a named interval, preventing interval accumulation.
   * Returns the interval ID for manual clearing if needed.
   */
  setInterval(
    key: string,
    handler: () => void,
    intervalMs: number,
  ): ReturnType<typeof globalThis.setInterval> {
    const windowKey = `__meitheal_interval_${key}` as const
    const existing = Reflect.get(window, windowKey) as
      | ReturnType<typeof globalThis.setInterval>
      | undefined
    if (existing !== undefined) {
      clearInterval(existing)
    }
    const id = globalThis.setInterval(handler, intervalMs)
    Reflect.set(window, windowKey, id)
    return id
  },
}
