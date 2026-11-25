import { createSpriteIconElement } from "../generated/icon-registry"
import { dismissHelper } from "./helper-system"
import { showToast } from "./toast"
import {
  CORE_TOUR_STEPS,
  TOUR_STORAGE_KEY,
  clampTourIndex,
  filterReachableSteps,
  transitionTourState,
  type TourStep,
} from "./tour-steps"

const TOUR_HELPER_ID = "meitheal-function-tour"
let activeCleanup: (() => void) | null = null

const save = (action: "dismiss" | "complete") => {
  try { localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(transitionTourState(action))) } catch { /* ignore */ }
}

const hidePrompt = () => {
  dismissHelper(TOUR_HELPER_ID)
  for (const el of document.querySelectorAll<HTMLElement>(`[data-helper-id="${TOUR_HELPER_ID}"]`)) el.style.display = "none"
}

const visibleTarget = (selector: string): HTMLElement | null => {
  for (const s of selector.split(",")) {
    const el = document.querySelector<HTMLElement>(s.trim())
    if (!el) continue
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0" && r.width > 0 && r.height > 0) return el
  }
  return null
}

const place = (target: HTMLElement, step: TourStep, spot: HTMLElement, pop: HTMLElement) => {
  const pad = 6, gap = 14, m = 12, r = target.getBoundingClientRect(), vw = innerWidth, vh = innerHeight
  const sl = Math.max(4, r.left - pad), st = Math.max(4, r.top - pad)
  spot.style.left = `${Math.round(sl)}px`
  spot.style.top = `${Math.round(st)}px`
  spot.style.width = `${Math.round(Math.max(24, Math.min(vw - sl - 4, r.width + pad * 2)))}px`
  spot.style.height = `${Math.round(Math.max(24, Math.min(vh - st - 4, r.height + pad * 2)))}px`
  if (vw <= 640) { pop.style.left = pop.style.top = ""; return }
  const pr = pop.getBoundingClientRect(), pw = pr.width || 320, ph = pr.height || 200
  let left = r.left, top = r.bottom + gap
  if (step.placement === "right" && r.right + gap + pw <= vw - m) { left = r.right + gap; top = r.top }
  else if (r.bottom + gap + ph > vh - m && r.top - gap - ph >= m) { top = r.top - gap - ph }
  else if (r.bottom + gap + ph > vh - m && r.right + gap + pw <= vw - m) { left = r.right + gap; top = m }
  pop.style.left = `${Math.round(Math.max(m, Math.min(left, vw - pw - m)))}px`
  pop.style.top = `${Math.round(Math.max(m, Math.min(top, vh - ph - m)))}px`
}

const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function startFunctionTour(): void {
  activeCleanup?.()
  const steps = filterReachableSteps(CORE_TOUR_STEPS, visibleTarget)
  if (!steps.length) {
    showToast("Open Dashboard or Boards to start the interactive tour", "info")
    return
  }

  const ctrl = new AbortController()
  const { signal } = ctrl
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const initialScroll = { left: scrollX, top: scrollY, behavior: "instant" } as const

  const root = mk("div", "tabler-tour-root")
  root.dataset.tablerTourRoot = "true"
  const shield = mk("div", "tabler-tour-shield")
  const spot = mk("div", "tabler-tour-spotlight")
  spot.setAttribute("aria-hidden", "true")

  const pop = mk("section", "tabler-tour-popover")
  pop.setAttribute("role", "dialog")
  pop.setAttribute("aria-modal", "false")
  pop.setAttribute("aria-labelledby", "tabler-tour-title")
  pop.setAttribute("aria-describedby", "tabler-tour-desc")

  const header = mk("div", "tabler-tour-header")
  const prog = mk("span", "tabler-tour-step")
  const close = mk("button", "tabler-tour-close")
  close.append(createSpriteIconElement("x", { size: 16 }))
  close.type = "button"
  close.setAttribute("aria-label", "Close tour")
  header.append(prog, close)

  const title = mk("h3", "tabler-tour-title")
  title.id = "tabler-tour-title"
  const desc = mk("p", "tabler-tour-desc")
  desc.id = "tabler-tour-desc"
  const footer = mk("div", "tabler-tour-footer")
  const skip = mk("button", "btn btn-ghost btn-sm", "Skip tour")
  skip.type = "button"
  const nav = mk("div", "tabler-tour-nav")
  const back = mk("button", "btn btn-secondary btn-sm", "Back")
  back.type = "button"
  const next = mk("button", "btn btn-primary btn-sm", "Next")
  next.type = "button"
  nav.append(back, next)
  footer.append(skip, nav)
  pop.append(header, title, desc, footer)
  root.append(shield, spot, pop)
  document.body.appendChild(root)

  let index = 0
  const cleanup = () => {
    ctrl.abort()
    root.remove()
    if (activeCleanup === cleanup) activeCleanup = null
    if (prevFocus?.isConnected && prevFocus.getClientRects().length) prevFocus.focus({ preventScroll: true })
    else document.getElementById("nav-utility-trigger")?.focus({ preventScroll: true })
  }
  const finish = (outcome: "dismiss" | "complete") => {
    save(outcome)
    hidePrompt()
    cleanup()
    scrollTo(initialScroll)
    showToast(outcome === "complete" ? "Tour complete" : "Tour dismissed", "info")
  }
  const render = () => {
    index = clampTourIndex(index, steps.length)
    const cur = steps[index]
    if (!cur) { cleanup(); return }
    const targetRect = cur.target.getBoundingClientRect()
    if (targetRect.bottom <= 0 || targetRect.top >= innerHeight || targetRect.right <= 0 || targetRect.left >= innerWidth) {
      cur.target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest", inline: "nearest" })
    }
    prog.textContent = `Step ${index + 1} of ${steps.length}`
    title.textContent = cur.step.title
    desc.textContent = cur.step.description
    back.hidden = index === 0
    next.textContent = index === steps.length - 1 ? "Finish" : "Next"
    place(cur.target, cur.step, spot, pop)
    requestAnimationFrame(() => { if (!signal.aborted && cur.target.isConnected) place(cur.target, cur.step, spot, pop) })
    next.focus({ preventScroll: true })
  }
  const sync = () => { const cur = steps[index]; if (cur?.target.isConnected) place(cur.target, cur.step, spot, pop) }

  for (const b of [close, skip, shield]) b.addEventListener("click", () => finish("dismiss"), { signal })
  back.addEventListener("click", () => { index = clampTourIndex(index - 1, steps.length); render() }, { signal })
  next.addEventListener("click", () => {
    if (index >= steps.length - 1) finish("complete")
    else { index = clampTourIndex(index + 1, steps.length); render() }
  }, { signal })
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish("dismiss") }
    else if (e.key === "ArrowRight") { e.preventDefault(); next.click() }
    else if (e.key === "ArrowLeft" && index > 0) { e.preventDefault(); back.click() }
  }, { signal })
  addEventListener("resize", sync, { signal })
  addEventListener("scroll", sync, { capture: true, passive: true, signal })
  document.addEventListener("astro:before-swap", cleanup, { signal })
  addEventListener("pagehide", cleanup, { signal })

  activeCleanup = cleanup
  render()
}
