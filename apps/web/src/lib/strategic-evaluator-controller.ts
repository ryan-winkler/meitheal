import { evaluateFrameworkFormulaDecimal, isFrameworkFieldOptions, validateFrameworkScoring, type FrameworkConfig } from "@meitheal/domain-strategy"
import { pageLifecycle } from "@lib/page-lifecycle"
import {
  detectLegacyConfidenceFraction,
  formatRiceFormulaBreakdown,
  frameworkPayloadObject as asFrameworkPayload,
  parseRiceInputs,
  RICE_FIELDS,
  readRiceAssessment,
  riceLensScore,
} from "@lib/rice-lens"
import { resolveEnabledFrameworksForTask, type ScoringRuleSummary } from "@lib/scoring-rules-filter"
import { clampSliderTrackValue, getScoringSliderConfig } from "@lib/rice-slider-config"

export interface StrategicLensSession {
  signal: AbortSignal
  save(payload: string, updatedAt: number): Promise<boolean>
}

interface Field {
  key: string
  label: string
  type: string
  ui_type?: string | undefined
  min?: number | undefined
  max?: number | undefined
  help_text?: string | undefined
  description?: string | undefined
  options?: Array<{ value: string | number; label: string }> | undefined
}
interface Framework {
  id: string
  data: {
    name: string
    version: string
    archetype: string
    formula?: string | undefined
    badge_thresholds?: Array<{ min: number; label: string; color: string }> | undefined
    fields: Field[]
  }
}

function isCheckbox(field: Field): boolean {
  return field.type === "boolean" || field.ui_type === "checkbox"
}

function minimum(field: Field, _frameworkId: string): number | undefined {
  return field.min
}

function suggestedValue(field: Field, value: unknown, frameworkId: string): string | number | boolean | undefined {
  if (isCheckbox(field)) return typeof value === "boolean" ? value : undefined
  if (isFrameworkFieldOptions(field.options) && field.options.length) {
    if (typeof value !== "string" && typeof value !== "number") return
    return field.options.some(option => String(option.value) === String(value)) ? String(value) : undefined
  }
  if (field.type !== "number") return typeof value === "string" ? value : undefined
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return
  const number = Number(value)
  const min = minimum(field, frameworkId)
  return Number.isFinite(number) && (min === undefined || number >= min) &&
    (field.max === undefined || number <= field.max) ? number : undefined
}

/** Render the existing YAML field types in the ticket's main editing pane. */
function renderField(field: Field, value: unknown, frameworkId: string): HTMLElement {
  const id = `se-${frameworkId}-${field.key}`
  const helpId = `${id}-help`
  const val = value ?? field.min ?? ""

  const wrapper = document.createElement("div")
  wrapper.className = "se-field"
  const label = document.createElement("label")
  label.htmlFor = id
  label.textContent = field.label

  const help = document.createElement("small")
  help.id = helpId
  help.textContent = field.help_text ?? field.description ?? ""

  if (field.type === "number" && !(isFrameworkFieldOptions(field.options) && field.options.length)) {
    const sliderCfg = getScoringSliderConfig(frameworkId, field.key, minimum(field, frameworkId), field.max)
    const input = document.createElement("input")
    input.type = "number"
    input.required = true
    input.step = "any"
    input.inputMode = "decimal"
    const min = minimum(field, frameworkId)
    if (typeof min === "number" && Number.isFinite(min)) input.min = String(min)
    if (typeof field.max === "number" && Number.isFinite(field.max)) input.max = String(field.max)
    input.value = String(val)
    input.id = id
    input.name = field.key
    input.setAttribute("aria-describedby", helpId)
    input.className = sliderCfg ? "form-input se-input se-number-input" : "form-input se-input"

    if (sliderCfg) {
      wrapper.classList.add("se-field--slider")
      const head = document.createElement("div")
      head.className = "se-field__head"

      const numWrap = document.createElement("div")
      numWrap.className = "se-field__num-wrap"
      numWrap.appendChild(input)
      if (sliderCfg.suffix) {
        const suffix = document.createElement("span")
        suffix.className = "se-field__suffix"
        suffix.setAttribute("aria-hidden", "true")
        suffix.textContent = sliderCfg.suffix
        numWrap.appendChild(suffix)
      }
      head.append(label, numWrap)

      const range = document.createElement("input")
      range.type = "range"
      range.className = "form-range se-range"
      range.min = String(sliderCfg.min)
      range.max = String(sliderCfg.max)
      range.step = String(sliderCfg.step)
      range.value = String(clampSliderTrackValue(typeof val === "number" || typeof val === "string" ? val : "", sliderCfg.min, sliderCfg.max))
      range.setAttribute("aria-label", `${field.label} slider`)
      range.dataset.seRangeFor = field.key

      range.addEventListener("input", () => {
        input.value = range.value
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      input.addEventListener("input", () => {
        const parsed = Number(input.value)
        if (Number.isFinite(parsed)) {
          range.value = String(clampSliderTrackValue(parsed, sliderCfg.min, sliderCfg.max))
        }
      })

      wrapper.append(head, range)
      if (sliderCfg.ticks) {
        const ticks = document.createElement("div")
        ticks.className = "se-field__ticks"
        ticks.setAttribute("aria-hidden", "true")
        const t0 = document.createElement("span")
        t0.textContent = sliderCfg.ticks[0]
        const t1 = document.createElement("span")
        t1.textContent = sliderCfg.ticks[1]
        ticks.append(t0, t1)
        wrapper.appendChild(ticks)
      }
      if (help.textContent) wrapper.appendChild(help)
      return wrapper
    }

    wrapper.append(label, input, help)
    return wrapper
  }

  let control: HTMLInputElement | HTMLSelectElement
  if (isCheckbox(field)) {
    const input = document.createElement("input")
    input.type = "checkbox"
    input.checked = [true, 1, "true", "1"].includes(val as string | number | boolean)
    control = input
  } else if (isFrameworkFieldOptions(field.options) && field.options.length) {
    const select = document.createElement("select")
    for (const option of field.options) {
      const opt = document.createElement("option")
      opt.value = String(option.value)
      opt.textContent = option.label
      opt.selected = String(val) === String(option.value)
      select.appendChild(opt)
    }
    control = select
  } else {
    const input = document.createElement("input")
    input.type = "text"
    input.value = String(val)
    control = input
  }
  control.id = id
  control.name = field.key
  control.setAttribute("aria-describedby", helpId)
  control.className = "form-input se-input"

  wrapper.append(label, control, help)
  return wrapper
}

function parsePayload(value: unknown): Record<string, unknown> {
  try { return asFrameworkPayload(typeof value === "string" ? JSON.parse(value) : value) } catch { return {} }
}

/** Compare one saved evaluation, including the old flat RICE estimates. */
function savedEvaluation(payload: Record<string, unknown>, id: string): string | undefined {
  const value = Object.hasOwn(payload, id) ? payload[id] : id === "rice"
    ? Object.fromEntries(RICE_FIELDS.filter(field => Object.hasOwn(payload, field)).map(field => [field, payload[field]]))
    : undefined
  return JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
    ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]]))
    : part)
}

pageLifecycle.onPageLoad(signal => {
  const panel = document.querySelector<HTMLElement>("#strategic-evaluator-inline")
  const select = panel?.querySelector<HTMLSelectElement>("#se-framework")
  const form = panel?.querySelector<HTMLFormElement>("#se-form")
  const legacyBanner = panel?.querySelector<HTMLElement>("#se-legacy-banner")
  const formulaPreview = panel?.querySelector<HTMLElement>("#se-formula-preview")
  const fields = panel?.querySelector<HTMLFieldSetElement>("#se-fields")
  const content = panel?.querySelector<HTMLElement>("#se-content")
  const output = panel?.querySelector<HTMLOutputElement>("#se-live-result")
  const status = panel?.querySelector<HTMLElement>("#se-status")
  const save = panel?.querySelector<HTMLButtonElement>("#se-save")
  const ask = panel?.querySelector<HTMLButtonElement>("#se-ask-ai")
  if (!panel || panel.dataset.scoringController === "ready" || !select || !form || !fields || !content || !output || !status || !save || !ask) return
  panel.dataset.scoringController = "ready"

  let allFrameworks: Framework[] = JSON.parse(panel.dataset.frameworks ?? "[]")
  let frameworks: Framework[] = [...allFrameworks]
  let cachedRules: ScoringRuleSummary[] | null = null
  let taskId = ""
  let currentTaskType = "task"
  let persisted: Record<string, unknown> = {}
  let payload: Record<string, unknown> = {}
  let renderedFrameworkId = ""
  const resolvedLegacyScale = new Set<string>()
  let lifetime = new AbortController()
  let taskSignal = signal
  let saveEvaluation: StrategicLensSession["save"] | undefined
  let pendingAssist: { frameworkId: string; edited: Set<string>; controller: AbortController } | undefined
  signal.addEventListener("abort", () => lifetime.abort(), { once: true })

  const framework = () => frameworks.find(item => item.id === select.value)

  function setScoringSectionVisible(visible: boolean) {
    const section = panel!.closest<HTMLElement>(".td-section")
    section?.classList.toggle("td-section--rules-hidden", !visible)
    panel!.hidden = !visible
  }

  function applyFrameworkSelection(registryAvailable: boolean) {
    frameworks = resolveEnabledFrameworksForTask(cachedRules, currentTaskType, allFrameworks)
    if (frameworks.length === 0) {
      setScoringSectionVisible(false)
      select!.replaceChildren()
      content!.replaceChildren()
      if (legacyBanner) {
        legacyBanner.replaceChildren()
        legacyBanner.hidden = true
      }
      output!.textContent = ""
      if (formulaPreview) formulaPreview.textContent = ""
      status!.textContent = ""
      renderedFrameworkId = ""
      select!.disabled = true
      fields!.disabled = true
      return
    }
    setScoringSectionVisible(true)
    select!.replaceChildren(...frameworks.map(item => new Option(item.data.name, item.id)))
    const saved = frameworks.find(item => payload[item.id])
    select!.value = saved?.id ?? frameworks[0]!.id
    select!.disabled = false
    fields!.disabled = false
    status!.textContent = registryAvailable ? "" : "Built-in frameworks are available. Could not load custom frameworks."
    render()
  }
  function scoreFields(selected: Framework, values: Record<string, unknown>): number | null {
    if (selected.id === "rice") {
      const inputs = parseRiceInputs(values)
      return inputs ? riceLensScore(inputs) : null
    }
    if (selected.id === "drice") {
      const effort = Number(values.effort)
      const deps = Number(values.dependencies)
      const conf = Number(values.confidence)
      if (!Number.isFinite(effort) || effort <= 0 || !Number.isFinite(deps) || deps <= 0 || !Number.isFinite(conf) || conf < 0 || conf > 100) {
        return null
      }
    }
    return selected.data.formula ? evaluateFrameworkFormulaDecimal(selected.data.formula, values) : null
  }
  function readFields(): Record<string, unknown> {
    const values: Record<string, unknown> = Object.create(null)
    for (const input of content!.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".se-input")) {
      values[input.name] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked
        : input instanceof HTMLInputElement && input.type === "number" && input.value !== "" ? Number(input.value) : input.value
    }
    return values
  }

  function unsupportedScoring(selected: Framework): string | undefined {
    const formula = selected.data.formula
    return validateFrameworkScoring(selected.data.fields, formula)[0]
  }
  const scoringError = "This framework has unsupported scoring settings. Ask an administrator to correct its formula, bounds, or options in the Rules & Lenses export."

  function updateLegacyBanner(selected: Framework, values: Record<string, unknown>): void {
    if (!legacyBanner) return
    legacyBanner.replaceChildren()
    legacyBanner.hidden = true
    if ((selected.id !== "rice" && selected.id !== "drice") || resolvedLegacyScale.has(selected.id)) return
    const legacy = detectLegacyConfidenceFraction(values)
    if (!legacy) return
    const { legacyConfidence: rawConf, suggestedPercent: suggested } = legacy
    const msg = document.createElement("div")
    msg.textContent = `Legacy Confidence value (${rawConf}) detected. Confirm whether this means ${suggested}% or ${rawConf}%:`
    const actions = document.createElement("div")
    actions.className = "d-flex gap-2 mt-2"
    const convBtn = document.createElement("button")
    convBtn.type = "button"
    convBtn.className = "btn btn-sm btn-warning"
    convBtn.textContent = `Convert to ${suggested}%`
    convBtn.addEventListener("click", () => {
      const confInput = content!.querySelector<HTMLInputElement>('input[name="confidence"]')
      if (confInput) confInput.value = String(suggested)
      resolvedLegacyScale.add(selected.id)
      legacyBanner.hidden = true
      preview()
    }, { signal })
    const keepBtn = document.createElement("button")
    keepBtn.type = "button"
    keepBtn.className = "btn btn-sm btn-outline"
    keepBtn.textContent = `Keep as ${rawConf}%`
    keepBtn.addEventListener("click", () => {
      resolvedLegacyScale.add(selected.id)
      legacyBanner.hidden = true
      preview()
    }, { signal })
    actions.append(convBtn, keepBtn)
    legacyBanner.append(msg, actions)
    legacyBanner.hidden = false
  }

  function preview() {
    const selected = framework()
    if (!selected) return
    if (unsupportedScoring(selected)) {
      output!.textContent = scoringError
      if (formulaPreview) formulaPreview.textContent = ""
      return
    }
    const vals = readFields()
    const score = scoreFields(selected, vals)
    output!.textContent = selected.data.formula ? score === null ? "Enter valid estimates to calculate a score" : `Score: ${score}`
      : "Save your framework evaluation"
    if (formulaPreview) {
      if (selected.id === "rice" && score !== null) {
        const parsed = parseRiceInputs(vals)
        formulaPreview.textContent = parsed ? `Formula: ${formatRiceFormulaBreakdown(parsed, score)}` : ""
      } else if (selected.id === "drice" && score !== null) {
        formulaPreview.textContent = `Formula: (${vals.reach} × ${vals.impact} × ${vals.confidence}%) ÷ (${vals.effort} × ${vals.dependencies}) = ${score}`
      } else if (selected.data.formula) {
        formulaPreview.textContent = `Formula: ${selected.data.formula}`
      } else {
        formulaPreview.textContent = ""
      }
    }
  }

  function render() {
    const selected = framework()
    if (!selected) return
    const values = asFrameworkPayload(payload[selected.id])
    renderedFrameworkId = selected.id
    content!.replaceChildren(...selected.data.fields.map(field => renderField(field, values[field.key], selected.id)))
    updateLegacyBanner(selected, values)
    preview()
  }

  const attach = async (id: string, taskType: string, raw: string, _settings: Record<string, unknown>, session?: StrategicLensSession) => {
    if (signal.aborted || session?.signal.aborted) return
    lifetime.abort()
    lifetime = new AbortController()
    const requestSignal = AbortSignal.any([signal, lifetime.signal, ...(session ? [session.signal] : [])])
    taskSignal = requestSignal
    saveEvaluation = session?.save
    pendingAssist = undefined
    ask.disabled = false
    taskId = id
    currentTaskType = taskType || "task"
    renderedFrameworkId = ""
    persisted = parsePayload(raw)
    payload = { ...persisted }
    resolvedLegacyScale.clear()
    if (!payload.rice) {
      const legacyAssessment = readRiceAssessment(payload)
      if (legacyAssessment.status !== "unscored") payload.rice = legacyAssessment.inputs
    }
    select.disabled = true
    fields.disabled = true
    status.textContent = "Loading scoring frameworks…"
    content.replaceChildren()
    let registryAvailable = false
    const [fwRes, rulesRes] = await Promise.allSettled([
      fetch("/api/frameworks", { signal: requestSignal, cache: "no-store" }),
      fetch("/api/rules", { signal: requestSignal, cache: "no-store" }),
    ])
    if (requestSignal.aborted) return
    try {
      if (fwRes.status === "fulfilled" && fwRes.value.ok) {
        const result = await fwRes.value.json() as { data?: FrameworkConfig[] }
        if (requestSignal.aborted) return
        registryAvailable = Array.isArray(result.data)
        for (const config of Array.isArray(result.data) ? result.data : []) {
          if (!Array.isArray(config.fields) || config.fields.length === 0) continue
          const entry: Framework = {
            id: config.id,
            data: {
              name: config.name, version: config.version, archetype: config.archetype,
              formula: config.formula, badge_thresholds: config.badgeThresholds,
              fields: config.fields.map(field => ({
                ...field, ui_type: field.uiType, help_text: field.helpText,
              })),
            },
          }
          allFrameworks = [...allFrameworks.filter(item => item.id !== entry.id), entry]
        }
      }
    } catch {
      // Built-in YAML definitions remain available during a registry outage.
    }
    try {
      if (rulesRes.status === "fulfilled" && rulesRes.value.ok) {
        const result = await rulesRes.value.json() as { ok?: boolean; data?: ScoringRuleSummary[] }
        if (!requestSignal.aborted && Array.isArray(result.data)) {
          cachedRules = result.data
        }
      }
    } catch {
      // Keep last known rules if rules endpoint is temporarily unavailable.
    }
    if (requestSignal.aborted) return
    applyFrameworkSelection(registryAvailable)
  }
  window.attachStrategicLens = attach
  window.addEventListener("meitheal:rules-changed", () => {
    cachedRules = null
    if (!taskId) return
    void fetch("/api/rules", { signal: taskSignal, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((result: { data?: ScoringRuleSummary[] } | null) => {
        if (taskSignal.aborted || !Array.isArray(result?.data)) return
        cachedRules = result.data
        applyFrameworkSelection(true)
      })
      .catch(() => {})
  }, { signal })
  window.addEventListener("meitheal:task-type-changed", (rawEvent) => {
    const detail = (rawEvent as CustomEvent<{ taskId?: string; taskType?: string }>).detail
    if (!detail || !taskId || detail.taskId !== taskId) return
    currentTaskType = detail.taskType || "task"
    applyFrameworkSelection(true)
  }, { signal })
  signal.addEventListener("abort", () => {
    delete panel.dataset.scoringController
    if (window.attachStrategicLens === attach) delete window.attachStrategicLens
  }, { once: true })

  select.addEventListener("change", () => {
    if (renderedFrameworkId) payload[renderedFrameworkId] = { ...asFrameworkPayload(payload[renderedFrameworkId]), ...readFields() }
    render()
    status.textContent = ""
  }, { signal })
  function fieldChanged(event: Event) {
    const input = event.target
    if (pendingAssist?.frameworkId === renderedFrameworkId &&
      (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) && input.classList.contains("se-input")) {
      pendingAssist.edited.add(input.name)
    }
    preview()
  }
  content.addEventListener("input", fieldChanged, { signal })
  content.addEventListener("change", fieldChanged, { signal })
  form.addEventListener("submit", async event => {
    event.preventDefault()
    const selected = framework()
    if (!selected || !taskId || fields.disabled) return
    if (unsupportedScoring(selected)) {
      status.textContent = scoringError
      return
    }
    if (!form.reportValidity()) return
    const values = readFields()
    const score = scoreFields(selected, values)
    if (selected.data.formula && score === null) {
      status.textContent = "Enter valid estimates before saving."
      return
    }
    const id = taskId
    const requestSignal = taskSignal
    const saveForTask = saveEvaluation
    const expectedEvaluation = savedEvaluation(persisted, selected.id)
    if (pendingAssist?.frameworkId === selected.id) {
      pendingAssist.controller.abort()
      pendingAssist = undefined
      ask.disabled = false
    }
    select.disabled = true
    fields.disabled = true
    status.textContent = "Saving evaluation…"
    try {
      const current = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { signal: requestSignal, cache: "no-store" })
      if (!current.ok) throw new Error("Could not read the current ticket")
      const task = await current.json()
      if (requestSignal.aborted) return
      const latest = parsePayload(task.framework_payload)
      if (savedEvaluation(latest, selected.id) !== expectedEvaluation) {
        status.textContent = "This framework's saved evaluation changed. Your estimates are still here. Reopen the ticket to review the latest values."
        return
      }
      latest[selected.id] = {
        ...asFrameworkPayload(latest[selected.id]),
        ...values,
        ...(selected.id === "rice" || selected.id === "drice" ? { confidence_unit: "percent" } : {}),
        ...(score === null ? {} : { score }),
        _evaluatedAt: new Date().toISOString(),
      }
      const encoded = JSON.stringify(latest)
      const updatedAt = task.task_version
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error("Missing task version")
      const saved = saveForTask ? await saveForTask(encoded, updatedAt)
        : (await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "content-type": "application/json" }, signal: requestSignal,
          body: JSON.stringify({ framework_payload: encoded, updated_at: updatedAt }),
        })).ok
      if (!saved) throw new Error("Could not save the evaluation")
      if (requestSignal.aborted) return
      persisted[selected.id] = latest[selected.id]
      payload[selected.id] = latest[selected.id]
      status.textContent = "Evaluation saved."
      window.dispatchEvent(new CustomEvent("meitheal-sync", { detail: { type: "framework-saved" } }))
    } catch {
      if (!requestSignal.aborted) status.textContent = "Could not save the evaluation. Your estimates are still here. Try again."
    } finally {
      if (!requestSignal.aborted) {
        select.disabled = false
        fields.disabled = false
      }
    }
  }, { signal })
  ask.addEventListener("click", async () => {
    const selected = framework()
    if (!selected || !taskId || fields.disabled) return
    if (unsupportedScoring(selected)) {
      status.textContent = scoringError
      return
    }
    const id = taskId
    const original = readFields()
    const suggestion = { frameworkId: selected.id, edited: new Set<string>(), controller: new AbortController() }
    const requestSignal = AbortSignal.any([taskSignal, suggestion.controller.signal])
    pendingAssist = suggestion
    payload[selected.id] = { ...asFrameworkPayload(payload[selected.id]), ...original }
    ask.disabled = true
    status.textContent = "Asking Assist to suggest scores…"
    try {
      const { autoScoreTask } = await import("@domains/ai/ai-context-service")
      if (requestSignal.aborted) return
      const result = await autoScoreTask(id, [{
        id: selected.id, name: selected.data.name, archetype: selected.data.archetype, fields: selected.data.fields,
      }], requestSignal)
      if (requestSignal.aborted) return
      const values = asFrameworkPayload(result.scores[selected.id])
      const current = { ...asFrameworkPayload(payload[selected.id]) }
      const visible = renderedFrameworkId === selected.id
      const controls = new Map<string, HTMLInputElement | HTMLSelectElement>(visible
        ? [...content.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".se-input")].map(input => [input.name, input])
        : [])
      if (visible) Object.assign(current, readFields())
      let applied = false
      for (const field of selected.data.fields) {
        const input = controls.get(field.key)
        if (suggestion.edited.has(field.key) || current[field.key] !== original[field.key] || input?.validity.badInput) continue
        const value = suggestedValue(field, values[field.key], selected.id)
        if (value === undefined) continue
        current[field.key] = value
        applied = true
        if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value)
        else if (input) input.value = String(value)
      }
      payload[selected.id] = current
      if (visible) preview()
      status.textContent = applied ? result.justification : "Assist returned no usable estimates. Your edits are still here."
    } catch {
      if (!requestSignal.aborted) status.textContent = "Assist could not score this ticket. You can enter estimates manually."
    } finally {
      if (pendingAssist === suggestion) {
        pendingAssist = undefined
        if (!requestSignal.aborted) ask.disabled = false
      }
    }
  }, { signal })
})
