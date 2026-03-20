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

  function cancelHold() {
    if (holdTimer) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
  }

  function createGhost(card: HTMLElement, x: number, y: number) {
    ghost = card.cloneNode(true) as HTMLElement
    const w = card.offsetWidth
    ghost.style.cssText =
      "position:fixed;pointer-events:none;opacity:0.85;z-index:9999;" +
      "width:" +
      w +
      "px;transform:rotate(2deg) scale(1.05);" +
      "box-shadow:0 12px 40px rgba(0,0,0,0.5);border-radius:12px;" +
      "left:" +
      (x - w / 2) +
      "px;top:" +
      (y - 30) +
      "px;transition:none;"
    document.body.appendChild(ghost)
  }

  function activateDrag(card: HTMLElement, x: number, y: number) {
    isDragging = true
    dragCard = card
    card.classList.add("dragging")
    card.style.opacity = "0.3"
    card.style.touchAction = "none"
    createGhost(card, x, y)
    // Haptic feedback on supported devices
    if (navigator.vibrate) navigator.vibrate(30)
  }

  function cleanup() {
    cancelHold()
    if (dragCard) {
      dragCard.classList.remove("dragging")
      dragCard.style.opacity = ""
      dragCard.style.touchAction = ""
    }
    if (ghost) {
      ghost.remove()
      ghost = null
    }
    document
      .querySelectorAll(".kanban-column.drag-over")
      .forEach(function (c) {
        c.classList.remove("drag-over")
      })
    dragCard = null
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
      const card = (te.target as HTMLElement).closest('.kanban-card[draggable="true"]') as HTMLElement | null
      if (!card) return
      // Don't interfere with action button taps
      if ((te.target as HTMLElement).closest("button, a, .card-action-btn")) return

      const t = te.touches[0]
      if (!t) return
      startX = t.clientX
      startY = t.clientY

      // Start 300ms hold timer
      cancelHold()
      holdTimer = setTimeout(function () {
        holdTimer = null
        activateDrag(card, startX, startY)
      }, 300)
    },
    { passive: true, ...sigOpt },
  )

  board.addEventListener(
    "touchmove",
    function (e) {
      const te = e as TouchEvent
      const t = te.touches[0]
      if (!t) return

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

      // Move ghost to follow finger
      if (ghost) {
        ghost.style.left = t.clientX - ghost.offsetWidth / 2 + "px"
        ghost.style.top = t.clientY - 30 + "px"
      }

      // Highlight column under touch (hide ghost briefly for elementFromPoint)
      if (ghost) ghost.style.display = "none"
      const el = document.elementFromPoint(t.clientX, t.clientY)
      if (ghost) ghost.style.display = ""

      document.querySelectorAll(".kanban-column").forEach(function (col) {
        col.classList.remove("drag-over")
      })
      const col = el ? el.closest(".kanban-column") : null
      if (col) col.classList.add("drag-over")
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

      const te = e as TouchEvent
      const t = te.changedTouches[0]
      if (!t) {
        cleanup()
        return
      }

      // Hide ghost for accurate elementFromPoint
      if (ghost) ghost.style.display = "none"
      const el = document.elementFromPoint(t.clientX, t.clientY)
      if (ghost) ghost.style.display = ""

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
    { passive: true, ...sigOpt },
  )

  // Cancel drag on context menu / multi-touch
  board.addEventListener(
    "touchcancel",
    function () {
      cleanup()
    },
    { passive: true, ...sigOpt },
  )
}
