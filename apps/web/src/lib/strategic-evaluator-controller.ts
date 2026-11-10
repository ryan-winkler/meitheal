import type { FrameworkConfig } from "@meitheal/domain-strategy"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import { frameworkPayloadObject as asFrameworkPayload, riceLensScore, readRiceInputs } from "@lib/rice-lens"
import { evaluateFrameworkFormula, isFrameworkFormulaSupported } from "@lib/framework-score"

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

/** Render the existing YAML field types in the ticket's main editing pane. */
function renderField(field: Field, value: unknown, frameworkId: string): string {
  const id = `se-${frameworkId}-${field.key}`
  const val = value ?? field.min ?? ""
  const label = `<label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>`
  const help = `<small id="${escapeHtml(id)}-help">${escapeHtml(field.help_text ?? field.description ?? "")}</small>`
  const attrs = `id="${escapeHtml(id)}" name="${escapeHtml(field.key)}" aria-describedby="${escapeHtml(id)}-help" class="form-input se-input"`
  let control: string
  if (field.type === "boolean" || field.ui_type === "checkbox") {
    control = `<input type="checkbox" ${attrs} ${[true, 1, "true", "1"].includes(val as string | number | boolean) ? "checked" : ""} />`
  } else if (field.options?.length) {
    control = `<select ${attrs}>${field.options.map(option =>
      `<option value="${escapeHtml(String(option.value))}" ${String(val) === String(option.value) ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select>`
  } else if (field.type === "number") {
    const min = frameworkId === "rice" && field.key === "effort" ? 0.01 : field.min
    control = `<input type="number" ${attrs} required step="any" ${min === undefined ? "" : `min="${escapeHtml(String(min))}"`} ${field.max === undefined ? "" : `max="${escapeHtml(String(field.max))}"`} value="${escapeHtml(String(val))}" />`
  } else {
    control = `<input type="text" ${attrs} value="${escapeHtml(String(val))}" />`
  }
  return `<div>${label}${control}${help}</div>`
}

function parsePayload(value: unknown): Record<string, unknown> {
  try { return asFrameworkPayload(typeof value === "string" ? JSON.parse(value) : value) } catch { return {} }
}

pageLifecycle.onPageLoad(signal => {
  const panel = document.querySelector<HTMLElement>("#strategic-evaluator-inline")
  const select = panel?.querySelector<HTMLSelectElement>("#se-framework")
  const form = panel?.querySelector<HTMLFormElement>("#se-form")
  const fields = panel?.querySelector<HTMLFieldSetElement>("#se-fields")
  const content = panel?.querySelector<HTMLElement>("#se-content")
  const output = panel?.querySelector<HTMLOutputElement>("#se-live-result")
  const status = panel?.querySelector<HTMLElement>("#se-status")
  const save = panel?.querySelector<HTMLButtonElement>("#se-save")
  const ask = panel?.querySelector<HTMLButtonElement>("#se-ask-ai")
  if (!panel || !select || !form || !fields || !content || !output || !status || !save || !ask) return

  let frameworks: Framework[] = JSON.parse(panel.dataset.frameworks ?? "[]")
  let taskId = ""
  let payload: Record<string, unknown> = {}
  let renderedFrameworkId = ""
  let lifetime = new AbortController()
  let taskSignal = signal
  let saveEvaluation: StrategicLensSession["save"] | undefined
  signal.addEventListener("abort", () => lifetime.abort(), { once: true })

  const framework = () => frameworks.find(item => item.id === select.value)
  function scoreFields(selected: Framework, values: Record<string, unknown>): number | null {
    if (selected.id === "rice") {
      const inputs = readRiceInputs({ rice: values })
      return inputs ? riceLensScore(inputs) : null
    }
    return selected.data.formula ? evaluateFrameworkFormula(selected.data.formula, values) : null
  }
  function readFields(): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const input of content!.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".se-input")) {
      values[input.name] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked
        : input instanceof HTMLInputElement && input.type === "number" && input.value !== "" ? Number(input.value) : input.value
    }
    return values
  }

  function preview() {
    const selected = framework()
    if (!selected) return
    if (selected.data.formula && !isFrameworkFormulaSupported(selected.data.formula, selected.data.fields.map(field => field.key))) {
      output!.textContent = "This framework formula is unsupported. Edit the framework formula before saving."
      return
    }
    const score = scoreFields(selected, readFields())
    output!.textContent = selected.data.formula ? score === null ? "Enter valid estimates to calculate a score" : `Score: ${score}`
      : "Save your framework evaluation"
  }

  function render() {
    const selected = framework()
    if (!selected) return
    const values = asFrameworkPayload(payload[selected.id])
    renderedFrameworkId = selected.id
    content!.innerHTML = selected.data.fields.map(field => renderField(field, values[field.key], selected.id)).join("")
    preview()
  }

  const attach = async (id: string, _taskType: string, raw: string, _settings: Record<string, unknown>, session?: StrategicLensSession) => {
    lifetime.abort()
    lifetime = new AbortController()
    const requestSignal = AbortSignal.any([signal, lifetime.signal, ...(session ? [session.signal] : [])])
    taskSignal = requestSignal
    saveEvaluation = session?.save
    taskId = id
    payload = parsePayload(raw)
    if (!payload.rice) {
      const legacyRice = readRiceInputs(payload)
      if (legacyRice) payload.rice = legacyRice
    }
    select.disabled = true
    fields.disabled = true
    status.textContent = "Loading scoring frameworks…"
    content.replaceChildren()
    let registryAvailable = false
    try {
      const response = await fetch("/api/frameworks", { signal: requestSignal })
      if (response.ok) {
        const result = await response.json() as { data?: FrameworkConfig[] }
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
          frameworks = [...frameworks.filter(item => item.id !== entry.id), entry]
        }
      }
    } catch {
      // Built-in YAML definitions remain available during a registry outage.
    }
    if (requestSignal.aborted) return
    select.replaceChildren(...frameworks.map(item => new Option(item.data.name, item.id)))
    const saved = frameworks.find(item => payload[item.id] && item.id !== "rice")
    select.value = payload.rice ? "rice" : saved?.id ?? (frameworks.some(item => item.id === "rice") ? "rice" : frameworks[0]?.id ?? "")
    select.disabled = false
    fields.disabled = false
    status.textContent = registryAvailable ? "" : "Built-in frameworks are available. Could not load custom frameworks."
    render()
  }
  window.attachStrategicLens = attach
  signal.addEventListener("abort", () => {
    if (window.attachStrategicLens === attach) delete window.attachStrategicLens
  }, { once: true })

  select.addEventListener("change", () => {
    if (renderedFrameworkId) payload[renderedFrameworkId] = { ...asFrameworkPayload(payload[renderedFrameworkId]), ...readFields() }
    render()
    status.textContent = ""
  }, { signal })
  content.addEventListener("input", preview, { signal })
  content.addEventListener("change", preview, { signal })
  form.addEventListener("submit", async event => {
    event.preventDefault()
    const selected = framework()
    if (!selected || !taskId || !form.reportValidity()) return
    const values = readFields()
    const score = scoreFields(selected, values)
    if (selected.data.formula && score === null) {
      status.textContent = !isFrameworkFormulaSupported(selected.data.formula, selected.data.fields.map(field => field.key))
        ? "This framework formula is unsupported. Edit the framework formula before saving." : "Enter valid estimates before saving."
      return
    }
    const id = taskId
    const requestSignal = taskSignal
    select.disabled = true
    fields.disabled = true
    status.textContent = "Saving evaluation…"
    try {
      const current = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { signal: requestSignal, cache: "no-store" })
      if (!current.ok) throw new Error("Could not read the current ticket")
      const task = await current.json()
      const latest = parsePayload(task.framework_payload)
      latest[selected.id] = { ...asFrameworkPayload(latest[selected.id]), ...values, ...(score === null ? {} : { score }), _evaluatedAt: new Date().toISOString() }
      const encoded = JSON.stringify(latest)
      const updatedAt = Number(task.task_version ?? task.updated_at)
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error("The ticket version is unavailable")
      const saved = saveEvaluation ? await saveEvaluation(encoded, updatedAt)
        : (await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "content-type": "application/json" }, signal: requestSignal,
          body: JSON.stringify({ framework_payload: encoded, updated_at: updatedAt }),
        })).ok
      if (!saved) throw new Error("Could not save the evaluation")
      if (requestSignal.aborted) return
      payload = latest
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
    if (!selected || !taskId) return
    const requestSignal = taskSignal
    const selectedId = selected.id
    payload[renderedFrameworkId] = { ...asFrameworkPayload(payload[renderedFrameworkId]), ...readFields() }
    ask.disabled = true
    status.textContent = "Asking Assist to suggest scores…"
    try {
      const { autoScoreTask } = await import("@domains/ai/ai-context-service")
      const result = await autoScoreTask(taskId, [{ id: selected.id, name: selected.data.name, archetype: selected.data.archetype, fields: selected.data.fields }])
      if (requestSignal.aborted) return
      const values = result.scores[selected.id]
      if (values) {
        if (renderedFrameworkId) payload[renderedFrameworkId] = { ...asFrameworkPayload(payload[renderedFrameworkId]), ...readFields() }
        payload[selectedId] = { ...asFrameworkPayload(payload[selectedId]), ...Object.fromEntries(Object.entries(asFrameworkPayload(values)).filter(([key, value]) =>
          selected.data.fields.some(field => field.key === key) && (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))))) }
        if (select.value === selectedId) render()
      }
      status.textContent = result.justification
    } catch {
      if (!requestSignal.aborted) status.textContent = "Assist could not score this ticket. You can enter estimates manually."
    } finally {
      if (!requestSignal.aborted) ask.disabled = false
    }
  }, { signal })
})
