/**
 * Lazy Load — Intersection Observer for deferred rendering
 *
 * Provides a simple wrapper around IntersectionObserver for
 * lazy-loading task cards and heavy list items.
 *
 * Bounded context: lib (cross-domain utility)
 */

// --- Public API ---

interface LazyLoadOptions {
  root?: Element | null
  rootMargin?: string
  threshold?: number
}

/**
 * Observe elements and call onVisible when they enter the viewport.
 * Returns a cleanup function.
 */
export function observeVisibility(
  elements: Element[],
  onVisible: (el: Element) => void,
  options: LazyLoadOptions = {},
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    // Fallback: show everything immediately
    elements.forEach(onVisible)
    return () => {}
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          onVisible(entry.target)
          observer.unobserve(entry.target)
        }
      }
    },
    {
      root: options.root ?? null,
      rootMargin: options.rootMargin ?? "100px",
      threshold: options.threshold ?? 0,
    },
  )

  for (const el of elements) {
    observer.observe(el)
  }

  return () => observer.disconnect()
}

/**
 * Observe a sentinel element for infinite scroll.
 * Calls onReach each time the sentinel enters the viewport.
 */
export function observeInfiniteScroll(
  sentinel: Element,
  onReach: () => void,
  rootMargin = "200px",
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {}

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) onReach()
    },
    { rootMargin },
  )

  observer.observe(sentinel)
  return () => observer.disconnect()
}
