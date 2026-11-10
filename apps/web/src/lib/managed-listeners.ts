/**
 * Managed Listeners — Memory-safe event listener lifecycle
 *
 * @domain tasks (presentation infrastructure)
 * @bounded-context shared-lib
 *
 * Prevents memory leaks from orphaned event listeners during
 * Astro page transitions. Every controller should use this
 * instead of raw addEventListener.
 *
 * Usage:
 *   const lm = createListenerManager()
 *   lm.on(button, "click", handler)
 *   lm.onInterval(fn, 30000)
 *   // on page nav:
 *   lm.cleanup()
 *
 * @kcs Controllers must call lm.cleanup() on astro:before-preparation
 */

export interface ListenerManager {
  /** Add an event listener (tracked for cleanup) */
  on<K extends keyof HTMLElementEventMap>(
    el: EventTarget,
    event: K | string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions
  ): void

  /** Add a delegated listener on a container */
  delegate(
    container: EventTarget,
    event: string,
    selector: string,
    handler: (e: Event, target: Element) => void
  ): void

  /** Create a tracked setInterval */
  onInterval(fn: () => void, ms: number): number

  /** Create a tracked setTimeout */
  onTimeout(fn: () => void, ms: number): number

  /** Create a tracked AbortController (aborted on cleanup) */
  createAbortController(): AbortController

  /** Get shared abort signal for fetch calls */
  get signal(): AbortSignal

  /** Remove all listeners, clear intervals/timeouts, abort controllers */
  cleanup(): void

  /** True if cleanup() has been called */
  readonly disposed: boolean
}

export function createListenerManager(): ListenerManager {
  const listeners: Array<{
    el: EventTarget
    event: string
    handler: EventListenerOrEventListenerObject
    options?: AddEventListenerOptions | undefined
  }> = []
  const intervals: number[] = []
  const timeouts: number[] = []
  const abortControllers: AbortController[] = []
  let _disposed = false

  // Shared abort controller for all fetch calls
  const sharedAC = new AbortController()
  abortControllers.push(sharedAC)

  return {
    on(el, event, handler, options) {
      if (_disposed) return
      el.addEventListener(event as string, handler, options)
      listeners.push({ el, event: event as string, handler, options })
    },

    delegate(container, event, selector, handler) {
      if (_disposed) return
      const delegateHandler = (e: Event) => {
        const target = (e.target as Element)?.closest?.(selector)
        if (target) handler(e, target)
      }
      container.addEventListener(event, delegateHandler)
      listeners.push({ el: container, event, handler: delegateHandler })
    },

    onInterval(fn, ms) {
      if (_disposed) return 0
      const id = window.setInterval(fn, ms)
      intervals.push(id)
      return id
    },

    onTimeout(fn, ms) {
      if (_disposed) return 0
      const id = window.setTimeout(fn, ms)
      timeouts.push(id)
      return id
    },

    createAbortController() {
      const ac = new AbortController()
      if (_disposed) {
        ac.abort()
        return ac
      }
      abortControllers.push(ac)
      return ac
    },

    get signal() {
      return sharedAC.signal
    },

    cleanup() {
      if (_disposed) return
      _disposed = true

      // Remove all listeners
      for (const { el, event, handler, options } of listeners) {
        try {
          el.removeEventListener(event, handler, options)
        } catch {
          // Element may have been removed from DOM
        }
      }
      listeners.length = 0

      // Clear intervals
      for (const id of intervals) {
        window.clearInterval(id)
      }
      intervals.length = 0

      // Clear timeouts
      for (const id of timeouts) {
        window.clearTimeout(id)
      }
      timeouts.length = 0

      // Abort all controllers
      for (const ac of abortControllers) {
        try {
          if (!ac.signal.aborted) ac.abort()
        } catch {
          // Already aborted
        }
      }
      abortControllers.length = 0
    },

    get disposed() {
      return _disposed
    }
  }
}

/**
 * Install page-lifecycle cleanup for a listener manager.
 * Automatically calls cleanup() on Astro page transitions.
 */
export function installPageCleanup(lm: ListenerManager): void {
  const cleanupHandler = () => {
    lm.cleanup()
    document.removeEventListener("astro:before-preparation", cleanupHandler)
  }
  document.addEventListener("astro:before-preparation", cleanupHandler)
}
