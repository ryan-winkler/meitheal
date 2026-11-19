/**
 * Kanban Touch Drag Polyfill
 *
 * @domain kanban
 * @bounded-context kanban (view-layer controller)
 *
 * HTML5 Drag API doesn't fire on touch devices. This polyfill implements:
 * - Long-press (300ms) to enter drag mode
 * - Haptic vibrate feedback on supported devices
 * - Ghost card following finger position
 * - Column highlighting under touch point
 * - Drop via synthetic handleDrop event
 * - Scroll vs drag disambiguation (8px threshold)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Types ─────────────────────────────────────────────────────────────────

type HandleDropFn = (e: any) => void

// ── Public API ────────────────────────────────────────────────────────────

export function initTouchDrag(handleDrop: HandleDropFn, signal?: AbortSignal): void {
  const board = document.querySelector<HTMLElement>(".kanban-board")
  if (!board) return
  const sigOpt = signal ? { signal } : {}

  let dragCard: HTMLElement | null = null
  let ghost: HTMLElement | null = null
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  let touchId: number | null = null
  let highlightedLane: Element | null = null

  function cancelHold() {
    if (holdTimer) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
  }

  function activateDrag(card: HTMLElement) {
    const rect = card.getBoundingClientRect()
    dragCard = card
    card.classList.add("dragging")
    card.style.opacity = "0.3"
    ghost = card.cloneNode(true) as HTMLElement
    ghost.classList.remove("dragging")
    ghost.inert = true
    ghost.setAttribute("aria-hidden", "true")
    ghost.style.cssText = `position:fixed;pointer-events:none;opacity:0.85;z-index:9999;width:${rect.width}px;left:${rect.left}px;top:${rect.top}px;transition:none;transform:none;will-change:transform`
    document.body.appendChild(ghost)
    // Haptic feedback on supported devices
    if (navigator.vibrate) navigator.vibrate(30)
  }

  const cleanup = () => {
    cancelHold()
    board.removeEventListener("touchmove", moveDrag)
    if (dragCard) {
      dragCard.classList.remove("dragging")
      dragCard.style.opacity = ""
    }
    if (ghost) {
      ghost.remove()
      ghost = null
    }
    highlightedLane?.classList.remove("drag-over")
    highlightedLane = null
    dragCard = null
    touchId = null
  }

  function moveDrag(e: TouchEvent) {
    const t = e.touches[0]
    if (!t || t.identifier !== touchId || e.touches.length !== 1) {
      cleanup()
      return
    }

    if (e.cancelable) e.preventDefault()
    if (ghost) ghost.style.transform = `translate3d(${t.clientX - startX}px, ${t.clientY - startY}px, 0)`
    const lane = document.elementFromPoint(t.clientX, t.clientY)?.closest(".kanban-column") ?? null
    if (lane !== highlightedLane) {
      highlightedLane?.classList.remove("drag-over")
      lane?.classList.add("drag-over")
      highlightedLane = lane
    }
  }

  // Watch the page so a second finger outside the board can cancel the drag.
  document.addEventListener(
    "touchstart",
    function (e) {
      if (e.touches.length !== 1) {
        if (touchId !== null) cleanup()
        return
      }
      const target = e.target
      if (!(target instanceof Element) || !board.contains(target)) return
      const card = target.closest<HTMLElement>('.kanban-card[draggable="true"]')
      if (!card || card.getAttribute("aria-busy") === "true") return
      // Don't interfere with action button taps
      if (target.closest("button, a, .card-action-btn")) return

      const t = e.touches[0]
      if (!t) return
      touchId = t.identifier
      startX = t.clientX
      startY = t.clientY

      // Start 300ms hold timer
      cancelHold()
      holdTimer = setTimeout(function () {
        holdTimer = null
        if (!board.contains(card) || !card.draggable || card.getAttribute("aria-busy") === "true") {
          cleanup()
          return
        }
        activateDrag(card)
        board.addEventListener("touchmove", moveDrag, { passive: false, ...sigOpt })
      }, 300)
    },
    { capture: true, passive: true, ...sigOpt },
  )

  board.addEventListener(
    "touchmove",
    function (e) {
      if (holdTimer === null) return
      const t = e.touches[0]
      if (!t || t.identifier !== touchId || e.touches.length !== 1 ||
          Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) {
        cleanup()
      }
    },
    { passive: true, ...sigOpt },
  )

  board.addEventListener(
    "touchend",
    function (e) {
      if (!dragCard) {
        cleanup()
        return
      }

      e.preventDefault()
      const t = Array.from(e.changedTouches).find(touch => touch.identifier === touchId)
      if (!t) {
        cleanup()
        return
      }

      const el = document.elementFromPoint(t.clientX, t.clientY)

      const targetCol = el ? el.closest(".kanban-column") : null
      const cardId = dragCard.dataset.id

      cleanup() // reset visual state first

      if (targetCol && cardId) {
        const fakeEvent = {
          preventDefault: function () {},
          currentTarget: targetCol,
          target: el,
          dataTransfer: {
            getData: function () {
              return cardId
            },
          },
        }
        handleDrop(fakeEvent)
      }
    },
    { passive: false, ...sigOpt },
  )

  signal?.addEventListener("abort", cleanup, { once: true })

  // Cancel when the browser takes over the gesture
  board.addEventListener(
    "touchcancel",
    function () {
      cleanup()
    },
    { passive: true, ...sigOpt },
  )
}
