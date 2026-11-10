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
  let dragCard: HTMLElement | null = null
  let ghost: HTMLElement | null = null
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let isDragging = false
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
    isDragging = true
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

  function cleanup() {
    cancelHold()
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
    isDragging = false
  }

  // Use event delegation on the board container
  const board = document.querySelector(".kanban-board")
  if (!board) return
  const sigOpt = signal ? { signal } : {}

  board.addEventListener(
    "touchstart",
    function (e) {
      const te = e as TouchEvent
      if (te.touches.length !== 1) {
        cleanup()
        return
      }
      const card = (te.target as HTMLElement).closest('.kanban-card[draggable="true"]') as HTMLElement | null
      if (!card || card.getAttribute("aria-busy") === "true") return
      // Don't interfere with action button taps
      if ((te.target as HTMLElement).closest("button, a, .card-action-btn")) return

      const t = te.touches[0]
      if (!t) return
      touchId = t.identifier
      startX = t.clientX
      startY = t.clientY

      // Start 300ms hold timer
      cancelHold()
      holdTimer = setTimeout(function () {
        holdTimer = null
        activateDrag(card)
      }, 300)
    },
    { passive: true, ...sigOpt },
  )

  board.addEventListener(
    "touchmove",
    function (e) {
      const te = e as TouchEvent
      const t = te.touches[0]
      if (!t || t.identifier !== touchId || te.touches.length !== 1) {
        cleanup()
        return
      }

      // If hold timer is still active, cancel if finger moves too much (scrolling)
      if (holdTimer) {
        const dx = Math.abs(t.clientX - startX)
        const dy = Math.abs(t.clientY - startY)
        if (dx > 8 || dy > 8) {
          cancelHold() // user is scrolling, not holding
        }
        return
      }

      if (!isDragging || !dragCard) return
      e.preventDefault() // prevent scroll during drag

      if (ghost) ghost.style.transform = `translate3d(${t.clientX - startX}px, ${t.clientY - startY}px, 0)`
      const lane = document.elementFromPoint(t.clientX, t.clientY)?.closest(".kanban-column") ?? null
      if (lane !== highlightedLane) {
        highlightedLane?.classList.remove("drag-over")
        lane?.classList.add("drag-over")
        highlightedLane = lane
      }
    },
    { passive: false, ...sigOpt },
  )

  board.addEventListener(
    "touchend",
    function (e) {
      cancelHold()
      if (!isDragging || !dragCard) {
        cleanup()
        return
      }

      e.preventDefault()
      const te = e as TouchEvent
      const t = Array.from(te.changedTouches).find(touch => touch.identifier === touchId)
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
