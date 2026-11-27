import { formatRiceFormulaBreakdown, frameworkPayloadObject, parseRiceInputs, riceLensScore } from "@lib/rice-lens"

const editors = new WeakMap<HTMLFormElement, AbortController>()

function markStale(form: HTMLFormElement): void {
  if (form.hasAttribute("data-rice-stale")) return
  form.dataset.riceStale = ""
  const message = form.querySelector<HTMLElement>("[data-rice-message]")
  const save = form.querySelector<HTMLButtonElement>("[type=submit]")
  const reload = form.querySelector<HTMLButtonElement>("[data-rice-reload]")
  if (message) message.textContent = form.dataset.conflict ?? ""
  if (save) save.disabled = true
  if (reload) reload.hidden = false
}

export function bindRiceScoreEditor(
  form: HTMLFormElement, lifetime: AbortSignal, focusHeading = true,
): void {
  if (editors.has(form)) return
  const output = form.querySelector("output")
  const message = form.querySelector<HTMLElement>("[data-rice-message]")
  const save = form.querySelector<HTMLButtonElement>("[type=submit]")
  const reload = form.querySelector<HTMLButtonElement>("[data-rice-reload]")
  const saved = form.querySelector<HTMLAnchorElement>("[data-rice-saved-href]")
  const id = form.dataset.riceEditor
  if (!output || !message || !save || !reload || !saved || !id) return

  const payload = frameworkPayloadObject(JSON.parse(form.dataset.ricePayload ?? "{}"))
  const legacyBanner = form.querySelector<HTMLElement>("[data-rice-legacy-banner]")
  const breakdown = form.querySelector<HTMLElement>("[data-rice-breakdown]")
  const confidenceInput = form.querySelector<HTMLInputElement>('input[name="confidence"]')
  const inputs = () => parseRiceInputs(Object.fromEntries(new FormData(form)))
  const updatePreview = () => {
    const estimate = inputs()
    const currentScore = estimate && estimate.confidence <= 100 ? riceLensScore(estimate) : null
    output.value = String(currentScore ?? "—")
    if (breakdown) {
      breakdown.textContent = estimate && currentScore !== null
        ? `(${formatRiceFormulaBreakdown(estimate)})`
        : ""
    }
  }
  const active = () => !signal.aborted && form.isConnected
  const version = Number(form.dataset.riceVersion)
  if (!Number.isSafeInteger(version) || version < 0) return
  const binding = new AbortController()
  editors.set(form, binding)
  const signal = AbortSignal.any([lifetime, binding.signal])
  save.disabled = false
  updatePreview()
  if (focusHeading && location.hash === "#rice") requestAnimationFrame(() => {
    if (active() && location.hash === "#rice") form.querySelector<HTMLElement>("h3")?.focus()
  })

  form.querySelector<HTMLButtonElement>("[data-rice-legacy-convert]")?.addEventListener("click", event => {
    const pct = (event.currentTarget as HTMLButtonElement).dataset.riceLegacyConvert
    if (pct && confidenceInput) {
      confidenceInput.value = pct
      const confRange = form.querySelector<HTMLInputElement>('input[data-rice-range="confidence"]')
      if (confRange) confRange.value = pct
      form.dataset.riceLegacyDecided = ""
      legacyBanner?.remove()
      updatePreview()
    }
  }, { signal })

  form.querySelector<HTMLButtonElement>("[data-rice-legacy-keep]")?.addEventListener("click", () => {
    form.dataset.riceLegacyDecided = ""
    legacyBanner?.remove()
    updatePreview()
  }, { signal })

  // Keep paired Tabler range sliders and editable number inputs synchronized
  form.querySelectorAll<HTMLInputElement>("input[data-rice-range]").forEach(range => {
    const field = range.dataset.riceRange
    const num = field ? form.querySelector<HTMLInputElement>(`input[name="${field}"]`) : null
    if (!num) return
    const min = Number(range.min)
    const max = Number(range.max)
    range.addEventListener("input", () => {
      num.value = range.value
      updatePreview()
    }, { signal })
    num.addEventListener("input", () => {
      const parsed = Number(num.value)
      if (Number.isFinite(parsed)) {
        range.value = String(Math.min(max, Math.max(min, parsed)))
      }
      updatePreview()
    }, { signal })
  })

  form.addEventListener("input", updatePreview, { signal })

  reload.addEventListener("click", () => location.reload(), { signal })
  form.addEventListener("submit", async event => {
    event.preventDefault()
    if (save.disabled) return
    const estimates = inputs()
    const score = estimates && estimates.confidence <= 100 ? riceLensScore(estimates) : null
    if (!estimates || score === null) {
      message.textContent = form.dataset.invalid ?? ""
      return
    }

    save.disabled = true
    form.setAttribute("aria-busy", "true")
    message.textContent = ""
    const frameworkPayload = JSON.stringify({
      ...payload,
      rice: { ...frameworkPayloadObject(payload.rice), ...estimates, confidence_unit: "percent", score, _evaluatedAt: new Date().toISOString() },
    })
    try {
      const result = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "X-Meitheal-Local-Conflict": "1" },
        body: JSON.stringify({ updated_at: version, framework_payload: frameworkPayload }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })
      if (!active()) return
      if (result.status === 409) {
        markStale(form)
        reload.focus()
        return
      }
      if (!result.ok) throw new Error("Score write failed")
      const confirmed = await result.json()
      if (confirmed?.id !== id || confirmed.framework_payload !== frameworkPayload) throw new Error("Score write unconfirmed")
      if (!active()) return
      form.dataset.riceStale = ""
      if (location.hash === "#rice") location.replace(saved.href)
      else {
        message.textContent = form.dataset.saved ?? ""
        reload.hidden = false
      }
    } catch {
      if (active() && !form.hasAttribute("data-rice-stale")) {
        message.textContent = form.dataset.error ?? ""
        reload.hidden = false
      }
    } finally {
      if (active()) {
        form.removeAttribute("aria-busy")
        save.disabled = form.hasAttribute("data-rice-stale")
      }
    }
  }, { signal })
}

export function refreshRiceScoreEditor(
  current: HTMLFormElement, fresh: HTMLFormElement | null, signal: AbortSignal,
): void {
  if (!fresh || fresh.dataset.riceEditor !== current.dataset.riceEditor) {
    markStale(current)
    return
  }
  if (fresh.dataset.riceVersion === current.dataset.riceVersion) return

  const hasDraft = Array.from(current.querySelectorAll<HTMLInputElement>('input[type="number"]'))
    .some(input => input.validity.badInput || input.value !== input.defaultValue)
  if (hasDraft || current.matches("[data-rice-legacy-decided], [data-rice-stale], [aria-busy]")) {
    markStale(current)
    return
  }

  const focused = document.activeElement
  const focusedId = current.contains(focused) ? focused?.id : null
  editors.get(current)?.abort()
  current.replaceWith(fresh)
  bindRiceScoreEditor(fresh, signal, false)
  if (focusedId) fresh.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`)?.focus({ preventScroll: true })
}
