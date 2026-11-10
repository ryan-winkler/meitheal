import type { CleanupLabel } from "@domains/labels"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import type { LabelChangeDetail } from "@lib/settings-labels-controller"

class CleanupError extends Error {
  constructor(readonly code: string) { super("Label cleanup request failed") }
}

interface FocusOwnership {
  owned: boolean
  generation: number
  confirmation: HTMLElement | null
}

function isLabel(value: unknown): value is CleanupLabel {
  if (!value || typeof value !== "object") return false
  const label = value as CleanupLabel
  return Number.isSafeInteger(label.id) && label.id > 0 && typeof label.title === "string" &&
    /^#[a-f0-9]{6}$/i.test(label.hexColor) && /^[a-f0-9]{64}$/.test(label.revision)
}

export function initSettingsLabelCleanup() {
  const candidate = document.querySelector<HTMLElement>("[data-label-cleanup]")
  if (!candidate || candidate.dataset.cleanupBooted === "true") return
  const root = candidate
  root.dataset.cleanupBooted = "true"
  const copy = JSON.parse(root.dataset.copy ?? "{}") as Record<string, string>
  const review = root.querySelector<HTMLButtonElement>("[data-cleanup-review]")!
  const previous = root.querySelector<HTMLButtonElement>("[data-cleanup-previous]")!
  const next = root.querySelector<HTMLButtonElement>("[data-cleanup-next]")!
  const remove = root.querySelector<HTMLButtonElement>("[data-cleanup-remove]")!
  const status = root.querySelector<HTMLElement>("[data-cleanup-status]")!
  const results = root.querySelector<HTMLElement>("[data-cleanup-results]")!
  const heading = root.querySelector<HTMLElement>("[data-cleanup-heading]")!
  const list = root.querySelector<HTMLElement>("[data-cleanup-list]")!
  const selection = root.querySelector<HTMLElement>("[data-cleanup-selection]")!
  const signal = pageLifecycle.signal
  let focusAway = 0
  document.addEventListener("focusin", event => {
    if (event.target instanceof Node && event.target !== document.body && !root.contains(event.target)) focusAway++
  }, { signal })
  let requests = new AbortController()
  let generation = 0
  let open = false
  let busy = false
  let confirming = false
  let removalFocus: FocusOwnership | undefined
  let labels: CleanupLabel[] = []
  let selected = new Set<number>()
  let cursors: Array<number | null> = [null]
  let page = 0
  let nextAfter: number | null = null

  function text(key: string, count = 0) {
    return (typeof copy[key] === "string" ? copy[key] : "").replaceAll("{count}", String(count))
  }

  function controls() {
    const disabled = busy || confirming || !navigator.onLine
    review.disabled = disabled
    previous.disabled = disabled || page === 0
    next.disabled = disabled || nextAfter === null
    remove.disabled = disabled || selected.size === 0
    list.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = disabled })
    selection.textContent = text("selection", selected.size)
  }

  function clear(message = "") {
    generation++
    requests.abort()
    requests = new AbortController()
    labels = []
    selected.clear()
    list.replaceChildren()
    results.hidden = true
    nextAfter = null
    busy = false
    status.textContent = message
    controls()
  }

  async function request(body: object, lifetime: AbortSignal) {
    const response = await fetch("/api/labels/cleanup", {
      method: "POST", mode: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, lifetime, AbortSignal.timeout(15000)]),
    })
    const data = await response.json()
    if (!response.ok || data?.ok !== true) throw new CleanupError(data?.errorCode ?? "unavailable")
    if (!response.headers.get("cache-control")?.includes("no-store")) throw new CleanupError("unavailable")
    return data
  }

  function render() {
    list.replaceChildren()
    for (const label of labels) {
      const row = document.createElement("li")
      const choice = document.createElement("label")
      choice.className = "label-cleanup-choice"
      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      checkbox.value = String(label.id)
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(label.id)
        else selected.delete(label.id)
        controls()
      }, { signal })
      const swatch = document.createElement("span")
      swatch.className = "label-cleanup-swatch"
      swatch.setAttribute("aria-hidden", "true")
      swatch.style.backgroundColor = label.hexColor
      const name = document.createElement("span")
      name.className = "label-cleanup-name"
      name.textContent = label.title || text("untitled")
      choice.append(checkbox, swatch, name)
      row.append(choice)
      list.append(row)
    }
    results.hidden = false
    controls()
  }

  async function load(focus = true, notice = "", ownership?: FocusOwnership) {
    const inCleanup = root.contains(document.activeElement)
    const inConfirmation = confirming && document.getElementById("meitheal-confirm-overlay")?.contains(document.activeElement)
    const ownedFocus = inCleanup || inConfirmation || document.activeElement === document.body
    const restoreFocus = ownership ? ownership.owned : ownedFocus && (focus || inCleanup || inConfirmation)
    clear(text(navigator.onLine ? "loading" : "offline"))
    const focusGeneration = ownership?.generation ?? focusAway
    const mayRestoreFocus = () => restoreFocus && focusGeneration === focusAway &&
      (root.contains(document.activeElement) || document.activeElement === document.body ||
        Boolean(ownership?.confirmation?.contains(document.activeElement)))
    if (!navigator.onLine || signal.aborted) return
    open = true
    busy = true
    controls()
    const current = generation
    try {
      const data = await request({ action: "preview", afterId: cursors[page] }, requests.signal)
      if (signal.aborted || current !== generation) return
      if (!Array.isArray(data.labels) || data.labels.length > 25 || !data.labels.every(isLabel) ||
          !(data.nextAfter === null || (Number.isSafeInteger(data.nextAfter) && data.nextAfter > 0))) {
        throw new CleanupError("unavailable")
      }
      labels = data.labels
      nextAfter = data.nextAfter
      busy = false
      render()
      status.textContent = notice || (labels.length ? "" : text("empty"))
      if (mayRestoreFocus()) heading.focus()
    } catch (error) {
      if (signal.aborted || current !== generation) return
      const code = error instanceof CleanupError ? error.code : "unavailable"
      clear(text(Object.hasOwn(copy, code) ? code : "unavailable"))
      if (code === "denied") open = false
      if (mayRestoreFocus()) review.focus()
    }
  }

  async function removeSelected() {
    if (busy || confirming || !selected.size) return
    const chosen = labels.filter(label => selected.has(label.id))
    const current = generation
    confirming = true
    controls()
    const names = chosen.map(label => escapeHtml(label.title || text("untitled"))).join("<br>")
    const accepted = await confirmDialog({
      title: escapeHtml(text("confirm_title")),
      message: escapeHtml(text(chosen.length === 1 ? "confirm_one" : "confirm_many", chosen.length)) +
        '<span style="display:block;margin-block-start:.75rem;max-block-size:40vh;overflow:auto;overflow-wrap:anywhere">' + names + "</span>",
      confirmText: escapeHtml(text("remove")), cancelText: escapeHtml(text("cancel")), variant: "danger",
      signal: AbortSignal.any([signal, requests.signal]),
    })
    confirming = false
    controls()
    if (!accepted || signal.aborted || current !== generation) {
      if (!signal.aborted && current === generation && navigator.onLine) remove.focus()
      return
    }
    busy = true
    const confirmation = document.getElementById("meitheal-confirm-overlay")
    const ownership: FocusOwnership = {
      owned: root.contains(document.activeElement) || Boolean(confirmation?.contains(document.activeElement)) || document.activeElement === document.body,
      generation: focusAway,
      confirmation,
    }
    removalFocus = ownership
    status.textContent = text("removing")
    controls()
    try {
      const data = await request({ action: "remove", labels: chosen.map(({ id, revision }) => ({ id, revision })) }, requests.signal)
      if (signal.aborted || current !== generation) return
      const expected = new Set(chosen.map(label => label.id))
      if (!Array.isArray(data.removed) || data.removed.length !== expected.size ||
          new Set(data.removed).size !== expected.size || !data.removed.every((id: number) => expected.has(id))) {
        throw new CleanupError("unavailable")
      }
      busy = false
      document.dispatchEvent(new CustomEvent<LabelChangeDetail>("meitheal:labels-changed", {
        detail: { source: "cleanup", removed: chosen.length, removedIds: data.removed },
      }))
    } catch (error) {
      if (signal.aborted || current !== generation) return
      const code = error instanceof CleanupError ? error.code : "unavailable"
      clear(text(Object.hasOwn(copy, code) ? code : "unavailable"))
      if (code === "denied") open = false
      if (ownership.owned && ownership.generation === focusAway &&
          (root.contains(document.activeElement) || document.activeElement === document.body ||
            ownership.confirmation?.contains(document.activeElement))) review.focus()
    } finally { removalFocus = undefined }
  }

  review.addEventListener("click", () => {
    cursors = [null]
    page = 0
    void load()
  }, { signal })
  previous.addEventListener("click", () => { page--; void load() }, { signal })
  next.addEventListener("click", () => {
    cursors = cursors.slice(0, page + 1)
    cursors.push(nextAfter)
    page++
    void load()
  }, { signal })
  remove.addEventListener("click", () => { void removeSelected() }, { signal })
  document.addEventListener("meitheal:labels-changed", event => {
    if (!open) return
    const detail = (event as CustomEvent<LabelChangeDetail>).detail
    const count = detail?.removed ?? 0
    cursors = [null]
    page = 0
    void load(detail?.source !== "editor", count ? text(count === 1 ? "removed_one" : "removed_many", count) : "",
      detail?.source === "cleanup" ? removalFocus : undefined)
  }, { signal })
  function foreground() {
    if (open && document.visibilityState === "visible") void load(false)
  }
  function hide() {
    cursors = [null]
    page = 0
    clear(text(navigator.onLine ? "" : "offline"))
  }
  window.addEventListener("pagehide", hide, { signal })
  window.addEventListener("offline", hide, { signal })
  window.addEventListener("online", foreground, { signal })
  window.addEventListener("focus", foreground, { signal })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hide()
    else foreground()
  }, { signal })
  signal.addEventListener("abort", () => clear(), { once: true })
  controls()
}
