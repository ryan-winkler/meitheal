import { settingsAction } from "@lib/settings-utils"
import { navigate } from "astro:transitions/client"
/**
 * Settings Rules Controller
 *
 * Client-side controller for the Rules & Lenses settings section.
 * Wires up presets, per-type lens assignment, AI scope toggles,
 * framework config editing, restore defaults, and export/import.
 *
 * @domain strategy / settings
 */

import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import { showToast } from "@lib/toast"
import { frameworkImportBytesMax } from "@lib/framework-import-limit"
import { exportFilename } from "@lib/export-filename"
import { isFrameworkFieldOptions, validateFrameworkOverrides, type FrameworkConfig, type FrameworkOverrides } from "@meitheal/domain-strategy"
import { initFrameworkWizard, openWizard } from "@lib/framework-wizard-controller"

interface RuleApiResponse {
  ok: boolean
  status?: number
  data?: unknown
  errorCode?: string
  message?: string
}

/** Preset definitions — mirrors the 5 built-in presets from domain-strategy */
const PRESET_DEFINITIONS: Record<string, {
  label: string
  description: string
  rules: Array<{
    name: string
    taskTypes: string[]
    lensIds: string[]
    aiScope: Record<string, boolean | string>
  }>
}> = {
  strategic: {
    label: "Strategic",
    description: "RICE + DDD for epics, RICE + KCS for stories",
    rules: [
      { name: "Epic Default", taskTypes: ["epic"], lensIds: ["rice", "ddd"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
      { name: "Story Default", taskTypes: ["story"], lensIds: ["rice", "kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
      { name: "Task Default", taskTypes: ["task"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Doc Default", taskTypes: ["documentation"], lensIds: ["kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
    ],
  },
  "ux-focused": {
    label: "UX-Focused",
    description: "HEART + DDD for epics, HEART + KCS for stories",
    rules: [
      { name: "Epic Default", taskTypes: ["epic"], lensIds: ["heart", "ddd"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
      { name: "Story Default", taskTypes: ["story"], lensIds: ["heart", "kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: true, canSuggestLabels: true } },
      { name: "Task Default", taskTypes: ["task"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Doc Default", taskTypes: ["documentation"], lensIds: ["kcs", "heart"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
    ],
  },
  simple: {
    label: "Simple",
    description: "No frameworks — lightweight task management",
    rules: [
      { name: "Epic Default", taskTypes: ["epic"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Story Default", taskTypes: ["story"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Task Default", taskTypes: ["task"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Doc Default", taskTypes: ["documentation"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
    ],
  },
  "agile-delivery": {
    label: "Agile Delivery",
    description: "WSJF for epics, ICE for stories — SAFe-inspired",
    rules: [
      { name: "Epic WSJF", taskTypes: ["epic"], lensIds: ["wsjf", "ddd"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: true, canSuggestLabels: true } },
      { name: "Story ICE", taskTypes: ["story"], lensIds: ["ice", "kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
      { name: "Task Default", taskTypes: ["task"], lensIds: ["kcs"], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Doc Default", taskTypes: ["documentation"], lensIds: ["kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
    ],
  },
  balanced: {
    label: "Balanced",
    description: "MoSCoW for epics, RICE for stories — strategic + tactical",
    rules: [
      { name: "Epic MoSCoW", taskTypes: ["epic"], lensIds: ["moscow", "ddd"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
      { name: "Story RICE", taskTypes: ["story"], lensIds: ["rice", "kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
      { name: "Task Default", taskTypes: ["task"], lensIds: ["rice"], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Doc Default", taskTypes: ["documentation"], lensIds: ["kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
    ],
  },
}

/**
 * Fetch helper — wraps native fetch with pageLifecycle signal
 * and checked transport/application outcomes.
 * Mutations reject on transport or application failure; reads return a checked result.
 */
async function apiFetch(path: string, options?: RequestInit): Promise<RuleApiResponse> {
  try {
    const res = await fetch(path, { cache: "no-store", ...options, signal: pageLifecycle.signal })
    const payload = await res.json() as RuleApiResponse
    if (!res.ok || payload.ok !== true) {
      if (!options?.method || options.method === "GET") {
        return { ...payload, ok: false, status: res.status, errorCode: payload.errorCode ?? "REQUEST_FAILED" }
      }
      throw new Error(payload.message || `Request failed: ${res.status}`)
    }
    return payload
  } catch (error) {
    if (options?.method && options.method !== "GET") throw error
    return { ok: false, errorCode: "REQUEST_FAILED", message: "Could not load configuration" }
  }
}

let defaultRuleIds: string[] = []
let ruleWriteUncertain = false
let rulesLoaded = false
let loadGeneration = 0
const DEFAULT_NAMES = new Set(["Epic Default", "Story Default", "Task Default", "Doc Default", "Documentation Default", "Epic WSJF", "Story ICE", "Epic MoSCoW", "Story RICE"])

async function replaceRuleSet(rules: unknown[], replaceIds?: string[]): Promise<void> {
  if (replaceIds !== undefined && ruleWriteUncertain) {
    const current = await apiFetch("/api/rules")
    if (!current.ok || !Array.isArray(current.data)) throw new Error("Could not reconcile the previous rule save")
    replaceIds = (current.data as Array<{ id: string; name: string; ruleType: string; tags: string[]; taskTypes: string[] }>)
      .filter(rule => rule.ruleType === "strategic-lens" && Array.isArray(rule.tags) && rule.tags.length === 0 && rule.taskTypes.length === 1 && DEFAULT_NAMES.has(rule.name)).map(rule => rule.id)
  }
  try {
    const result = await apiFetch("/api/rules", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules, ...(replaceIds === undefined ? {} : { replaceIds }) }),
    })
    if (!Array.isArray(result.data) || result.data.some(rule => !rule || typeof rule.id !== "string" || !rule.id)) throw new Error("Rule save returned no confirmed IDs")
    if (replaceIds !== undefined) defaultRuleIds = (result.data as Array<{ id: string }>).map(rule => rule.id)
    ruleWriteUncertain = false
  } catch (error) {
    ruleWriteUncertain = true
    throw error
  }
}


/** Download a JSON file in the browser */
function downloadJson(data: unknown, label: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = exportFilename(label, "json")
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * Load current rules from the API and reflect them in the UI.
 * An empty configuration remains empty until the user explicitly applies a preset.
 */
async function loadRulesIntoUI(): Promise<void> {
  const generation = ++loadGeneration
  try {
    const result = await apiFetch("/api/rules")
    if (generation !== loadGeneration) return
    if (!result.ok || !Array.isArray(result.data)) throw new Error("Could not load rules")

    const rules = result.data as Array<{
      id: string
      name: string
      taskTypes: string[]
      lensIds: string[]
      aiScope: Record<string, boolean | string>
      tags: string[]
      ruleType: string
    }>

    // This editor owns per-type defaults; tagged and custom rules remain untouched.
    const defaults = rules.filter((rule) => rule.ruleType === "strategic-lens" && rule.tags.length === 0 && rule.taskTypes.length === 1 && DEFAULT_NAMES.has(rule.name))
    defaultRuleIds = defaults.map((rule) => rule.id)
    rulesLoaded = true
    ruleWriteUncertain = false

    // Clear all checkboxes first
    document.querySelectorAll<HTMLInputElement>(".rules-fw-check").forEach((cb) => { cb.checked = false })
    document.querySelectorAll<HTMLInputElement>(".rules-ai-check").forEach((cb) => { cb.checked = false })
    document.querySelectorAll<HTMLTextAreaElement>(".rules-ai-textarea").forEach((ta) => { ta.value = "" })

    // Apply rules to the UI
    for (const rule of defaults) {
      for (const taskType of rule.taskTypes) {
        // Framework assignment checkboxes
        for (const lensId of rule.lensIds) {
          const cb = document.querySelector<HTMLInputElement>(
            `.rules-fw-check[data-task-type="${taskType}"][data-framework="${lensId}"]`
          )
          if (cb) cb.checked = true
        }

        // AI scope toggles
        if (rule.aiScope) {
          for (const [key, value] of Object.entries(rule.aiScope)) {
            if (key === "customInstructions" && typeof value === "string") {
              const ta = document.querySelector<HTMLTextAreaElement>(
                `.rules-ai-textarea[data-task-type="${taskType}"]`
              )
              if (ta) ta.value = value
            } else {
              const cb = document.querySelector<HTMLInputElement>(
                `.rules-ai-check[data-task-type="${taskType}"][data-capability="${key}"]`
              )
              if (cb) cb.checked = !!value
            }
          }
        }
      }
    }

    // Highlight active preset
    highlightActivePreset()
  } catch {
    rulesLoaded = false
    showToast("Could not load rules. Reload before editing them.", "error")
  }
}

/** Check which preset matches current state and highlight it */
function highlightActivePreset(): void {
  document.querySelectorAll<HTMLButtonElement>(".rules-preset-btn").forEach((btn) => {
    btn.classList.remove("is-active")
    // Update aria
    btn.setAttribute("aria-pressed", "false")
  })

  // Simple heuristic: check if any preset matches the current checkbox state
  for (const [presetId, preset] of Object.entries(PRESET_DEFINITIONS)) {
    let matches = true
    for (const rule of preset.rules) {
      for (const taskType of rule.taskTypes) {
        for (const fw of ["rice", "drice", "heart", "ddd", "kcs", "wsjf", "moscow", "ice"]) {
          const cb = document.querySelector<HTMLInputElement>(
            `.rules-fw-check[data-task-type="${taskType}"][data-framework="${fw}"]`
          )
          const shouldBeChecked = rule.lensIds.includes(fw)
          if (cb && cb.checked !== shouldBeChecked) {
            matches = false
            break
          }
        }
        if (!matches) break
      }
      if (!matches) break
    }
    if (matches) {
      const btn = document.querySelector<HTMLButtonElement>(`.rules-preset-btn[data-preset="${presetId}"]`)
      if (btn) {
        btn.classList.add("is-active")
        btn.setAttribute("aria-pressed", "true")
      }
    }
  }
}

/** Debounce timer and saving guard for saveRulesFromUI */
let _saveTimer: ReturnType<typeof setTimeout> | null = null
let _isSaving = false
let _saveAgain = false
let savePromise: Promise<void> | null = null
let saveFailed = false
let replacing = false
let configurationMutation: Promise<unknown> = Promise.resolve()
let frameworkLoadGeneration = 0

interface FrameworkDraft {
  frameworkId: string
  fieldKey: string
  weight: number
  failed: boolean
  pending: Promise<void> | null
}
const frameworkDrafts = new Map<string, FrameworkDraft>()
const draftKey = (frameworkId: string, fieldKey: string) => `${frameworkId}:${fieldKey}`
const settingsCopy = (key: string, fallback: string) => window.mI18n?.get(key) || fallback

function renderFrameworkDraft(slider: HTMLInputElement): void {
  const draft = frameworkDrafts.get(draftKey(slider.dataset.framework!, slider.dataset.field!))
  const status = slider.closest(".rules-fw-field")?.querySelector<HTMLElement>(".rules-fw-save-status")
  if (!status) return
  status.replaceChildren()
  if (!draft) {
    delete slider.dataset.saveState
    slider.removeAttribute("aria-invalid")
    return
  }
  slider.value = String(draft.weight)
  const display = slider.parentElement?.querySelector(".weight-display")
  if (display) display.textContent = `${draft.weight.toFixed(1)}×`
  slider.dataset.saveState = draft.pending ? "saving" : draft.failed ? "error" : "dirty"
  if (draft.failed) slider.setAttribute("aria-invalid", "true")
  else slider.removeAttribute("aria-invalid")
  status.textContent = draft.pending ? settingsCopy("settings.framework_saving", "Saving…")
    : settingsCopy(draft.failed ? "settings.framework_save_failed" : "settings.framework_unsaved", "Framework changes are not saved.")
  if (draft.failed && !draft.pending) {
    const retry = document.createElement("button")
    retry.type = "button"
    retry.className = "btn btn-ghost btn-sm rules-fw-retry"
    retry.textContent = settingsCopy("settings.framework_retry", "Retry save")
    pageLifecycle.on(retry, "click", settingsAction(() => persistFrameworkDraft(draft)))
    status.append(" ", retry)
  }
}

function renderDraftFor(draft: FrameworkDraft): void {
  document.querySelectorAll<HTMLInputElement>(".rules-fw-weight").forEach(slider => {
    if (slider.dataset.framework === draft.frameworkId && slider.dataset.field === draft.fieldKey) renderFrameworkDraft(slider)
  })
}

function rememberFrameworkDraft(slider: HTMLInputElement): FrameworkDraft {
  const frameworkId = slider.dataset.framework!
  const fieldKey = slider.dataset.field!
  const key = draftKey(frameworkId, fieldKey)
  const previous = frameworkDrafts.get(key)
  if (previous?.weight === Number(slider.value)) return previous
  const draft: FrameworkDraft = { frameworkId, fieldKey, weight: Number(slider.value), failed: previous?.failed ?? false, pending: null }
  frameworkDrafts.set(key, draft)
  ++frameworkLoadGeneration
  renderFrameworkDraft(slider)
  return draft
}

function persistFrameworkDraft(draft: FrameworkDraft): Promise<void> {
  if (draft.pending) return draft.pending
  const key = draftKey(draft.frameworkId, draft.fieldKey)
  draft.pending = withConfigurationMutation(() => apiFetch(`/api/frameworks/${encodeURIComponent(draft.frameworkId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [draft.fieldKey]: { weight: draft.weight } } }),
  })).then(() => {
    if (frameworkDrafts.get(key) === draft) {
      frameworkDrafts.delete(key)
      showToast("settings.framework_updated")
    }
  }, error => {
    draft.failed = true
    throw error
  }).finally(() => { draft.pending = null; renderDraftFor(draft) })
  renderDraftFor(draft)
  return draft.pending
}

async function flushFrameworkDrafts(): Promise<void> {
  for (;;) {
    for (const draft of frameworkDrafts.values()) {
      if (!draft.pending && !draft.failed) void persistFrameworkDraft(draft).catch(() => {})
    }
    const tail = configurationMutation
    await Promise.allSettled([tail, ...[...frameworkDrafts.values()].map(draft => draft.pending)])
    if (tail !== configurationMutation || [...frameworkDrafts.values()].some(draft => draft.pending || !draft.failed)) continue
    if (frameworkDrafts.size) throw new Error("Framework changes have not been saved")
    return
  }
}

/** All rule/framework writes share one ordering, including destructive resets. */
export function withConfigurationMutation<T>(action: () => Promise<T>): Promise<T> {
  const signal = pageLifecycle.signal
  const result = configurationMutation.then(() => {
    if (signal.aborted) throw new DOMException("Page changed", "AbortError")
    return action()
  })
  configurationMutation = result.catch(() => {})
  return result
}

/** Full replacements wait for autosave and prevent edits against deleted IDs. */
export async function withRulesReplacement(action: () => Promise<void>, _preserveRuleEdits = false): Promise<void> {
  if (replacing) return
  replacing = true
  const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>("#rules-lenses-settings input, #rules-lenses-settings button, #rules-lenses-settings textarea, #rules-lenses-settings select"))
  const previous = controls.map((control) => control.disabled)
  controls.forEach((control) => { control.disabled = true })
  try {
    await flushRulesSave()
    await withConfigurationMutation(action)
  } catch (error) {
    ruleWriteUncertain = true
    throw error
  } finally {
    controls.forEach((control, index) => { control.disabled = previous[index]! })
    replacing = false
  }
}

function saveRulesFromUI(allowReplacement = false): Promise<void> {
  if (replacing && !allowReplacement) return Promise.resolve()
  if (savePromise) { _saveAgain = true; return savePromise }
  savePromise = performRulesSave().finally(() => { savePromise = null })
  return savePromise
}

/** Debounced save — coalesces rapid changes into a single API call */
function debouncedSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    saveRulesFromUI()
  }, 400)
}

/** Export/navigation must include edits still waiting in the debounce window. */
export async function flushRulesSave(): Promise<void> {
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer)
    _saveTimer = null
    await saveRulesFromUI(true)
  } else {
    await savePromise
  }
  if (saveFailed) throw new Error("Rule changes have not been saved")
  await flushFrameworkDrafts()
}

/** Save current UI state as rules to the API */
async function performRulesSave(): Promise<void> {
  if (!document.getElementById("rules-lenses-settings")) return
  if (_isSaving) { _saveAgain = true; return }
  if (!rulesLoaded) { saveFailed = true; showToast("Rules have not loaded. Reload before saving.", "error"); return }
  _isSaving = true
  saveFailed = false
  _saveAgain = false
  try {
    // Collect state from UI
    const rules: unknown[] = []
    const taskTypes = ["epic", "story", "task", "documentation"]
    for (const taskType of taskTypes) {
      const lensIds: string[] = []
      document.querySelectorAll<HTMLInputElement>(`.rules-fw-check[data-task-type="${taskType}"]:checked`).forEach((cb) => {
        const fw = cb.dataset.framework
        if (fw) lensIds.push(fw)
      })

      const aiScope: Record<string, boolean | string> = {}
      document.querySelectorAll<HTMLInputElement>(`.rules-ai-check[data-task-type="${taskType}"]`).forEach((cb) => {
        const cap = cb.dataset.capability
        if (cap) aiScope[cap] = cb.checked
      })

      const textarea = document.querySelector<HTMLTextAreaElement>(
        `.rules-ai-textarea[data-task-type="${taskType}"]`
      )
      if (textarea?.value?.trim()) {
        aiScope.customInstructions = textarea.value.trim()
      }

      rules.push({
        name: `${taskType.charAt(0).toUpperCase() + taskType.slice(1)} Default`,
        taskTypes: [taskType], lensIds, aiScope, ruleType: "strategic-lens",
      })
    }
    await withConfigurationMutation(() => replaceRuleSet(rules, defaultRuleIds))

    showToast("settings.rules_saved")
  } catch {
    saveFailed = true
    showToast("settings.rules_save_failed", "error")
  } finally {
    _isSaving = false
    if (_saveAgain) await performRulesSave()
  }
}

/**
 * Apply a preset — clears and replaces all rules.
 * This is the internal version that doesn't show confirmation.
 */
async function applyPresetDirect(presetId: string): Promise<void> {
  const preset = PRESET_DEFINITIONS[presetId]
  if (!preset) return

  await withRulesReplacement(async () => {
    await replaceRuleSet(preset.rules.map((rule) => ({ ...rule, ruleType: "strategic-lens" })))
    await loadRulesIntoUI()
  })
}

/** Apply a preset with user confirmation when changing from an existing config */
async function applyPreset(presetId: string): Promise<void> {
  const preset = PRESET_DEFINITIONS[presetId]
  if (!preset) return

  // Check if this preset is already active — noop
  const activeBtn = document.querySelector<HTMLButtonElement>(`.rules-preset-btn[data-preset="${presetId}"].is-active`)
  if (activeBtn) {
    showToast("settings.preset_already_active")
    return
  }

  // Confirm when switching presets (existing rules will be replaced)
  const existing = await apiFetch("/api/rules")
  if (!existing.ok || !Array.isArray(existing.data)) throw new Error("Could not load existing rules")
  const hasExisting = existing.data.length > 0

  if (hasExisting) {
    const confirmed = await confirmDialog({
      message: `Switch to the "${preset.label}" preset? This will replace your current rule configuration.`,
      title: "Switch Preset",
      confirmText: `Apply ${preset.label}`,
      variant: "default",
    })
    if (!confirmed) return
  }

  await applyPresetDirect(presetId)
  showToast("settings.preset_applied")
}

/** Load framework configs into the config editor */
async function loadFrameworkConfigs(): Promise<void> {
  const generation = ++frameworkLoadGeneration
  try {
    const result = await apiFetch("/api/frameworks")
    if (generation !== frameworkLoadGeneration) return
    if (!result.ok || !Array.isArray(result.data)) throw new Error("Could not load frameworks")

    for (const fw of result.data as Array<{
      id: string
      fields: Array<{ key: string; label: string; type: string; uiType: string; weight: number; helpText: string; min?: number; max?: number; options?: Array<{ value: string | number; label: string }> }>
    }>) {
      const container = document.querySelector<HTMLElement>(
        `.rules-fw-config-fields[data-framework="${fw.id}"]`
      )
      if (!container) continue

      if (fw.fields.length === 0) {
        container.innerHTML = '<p class="text-muted" style="font-size: 12px; margin: 4px 0;">No configurable fields for this framework.</p>'
        continue
      }

      container.innerHTML = fw.fields.map((field) => {
        // Render weight slider for all field types, plus field-specific info
        const safeLabel = escapeHtml(field.label)
        const safeHelp = escapeHtml(field.helpText)
        const safeKey = escapeHtml(field.key)
        const fieldInfo = isFrameworkFieldOptions(field.options)
          ? `<span class="fw-field-type" title="${safeHelp}">
               ${field.options.map((o) => escapeHtml(String(o.label))).join(" · ")}
             </span>`
          : Number.isFinite(field.min) && Number.isFinite(field.max)
            ? `<span class="fw-field-range">${field.min}–${field.max}</span>`
            : ""

        const weight = frameworkDrafts.get(draftKey(fw.id, field.key))?.weight ?? field.weight
        return `
          <div class="rules-fw-field">
            <div class="rules-fw-field-header">
              <label title="${safeHelp}">${safeLabel}</label>
              ${fieldInfo}
            </div>
            <div class="rules-fw-field-controls">
              <input
                type="range"
                class="form-input rules-fw-weight"
                data-framework="${escapeHtml(fw.id)}"
                data-field="${safeKey}"
                min="0" max="3" step="0.1"
                value="${Number.isFinite(weight) ? weight : 1}"
                aria-label="${safeLabel} weight"
              />
              <span class="weight-display">${field.weight.toFixed(1)}×</span>
            </div>
            <p class="fw-field-help">${safeHelp}</p>
            <div class="rules-fw-save-status text-xs" role="status"></div>
          </div>
        `
      }).join("")

      // Wire up weight sliders
      container.querySelectorAll<HTMLInputElement>(".rules-fw-weight").forEach((slider) => {
        renderFrameworkDraft(slider)
        pageLifecycle.on(slider, "input", () => {
          if (!replacing) rememberFrameworkDraft(slider)
        })
        pageLifecycle.on(slider, "change", settingsAction(async () => {
          if (replacing) return
          await persistFrameworkDraft(rememberFrameworkDraft(slider))
        }))
      })
    }
  } catch (error) {
    if (generation !== frameworkLoadGeneration) return
    document.querySelectorAll<HTMLElement>(".rules-fw-config-fields").forEach((container) => {
      const message = document.createElement("p")
      message.className = "text-muted text-xs rules-fw-load-error"
      message.setAttribute("role", "status")
      message.textContent = "Framework settings could not load. Reload this page to retry."
      if ([...frameworkDrafts.values()].some(draft => draft.frameworkId === container.dataset.framework)) {
        container.querySelector(".rules-fw-load-error")?.remove()
        container.append(message)
      } else container.replaceChildren(message)
    })
    throw error
  }
}

/**
 * Initialize the rules settings controller.
 * Called by settings-page.ts on the appropriate lifecycle event.
 */
export function initRulesSettings(): void {
  const signal = pageLifecycle.signal
  signal.addEventListener("abort", () => {
    if (_saveTimer !== null) clearTimeout(_saveTimer)
    _saveTimer = null
    _saveAgain = false
    rulesLoaded = false
    frameworkDrafts.clear()
    ++loadGeneration
    ++frameworkLoadGeneration
  }, { once: true })
  rulesLoaded = false
  saveFailed = false
  // Astro waits for the preparation loader before replacing this page's DOM.
  pageLifecycle.on(document, "astro:before-preparation", (rawEvent) => {
    const event = rawEvent as Event & { loader: () => Promise<void>; from: URL }
    const load = event.loader
    event.loader = async () => {
      try {
        await flushRulesSave()
        await configurationMutation
      } catch {
        // Astro treats preventDefault alone as a full-page fallback. Supersede
        // that navigation with a same-page hash move, preserving this editor.
        const stay = new URL(event.from)
        if (!stay.hash) stay.hash = "rules-lenses-settings"
        await navigate(stay.href, { history: "replace" })
        event.preventDefault()
        return
      }
      await load()
    }
  })
  pageLifecycle.on(document, "click", (rawEvent) => {
    if (!window.__ingress_path || !(rawEvent instanceof MouseEvent) || rawEvent.button !== 0 || rawEvent.metaKey || rawEvent.ctrlKey || rawEvent.shiftKey || rawEvent.altKey) return
    const link = (rawEvent.target as Element | null)?.closest<HTMLAnchorElement>("a[href]")
    if (!link || link.target || link.hasAttribute("download")) return
    const destination = new URL(link.href)
    if (destination.origin !== location.origin || destination.pathname === location.pathname) return
    rawEvent.preventDefault()
    void (async () => {
      try { await flushRulesSave(); await configurationMutation; if (!signal.aborted) location.assign(destination.href) }
      catch { showToast("settings.rules_save_failed", "error") }
    })()
  })
  // Load current state
  loadRulesIntoUI()
  void loadFrameworkConfigs().catch(() => {})

  // Preset buttons
  document.querySelectorAll<HTMLButtonElement>(".rules-preset-btn").forEach((btn) => {
    pageLifecycle.on(btn, "click", settingsAction(async () => {
      const presetId = btn.dataset.preset
      if (!presetId) return
      await applyPreset(presetId)
    }))
  })

  // Framework assignment checkboxes — auto-save on change (debounced)
  document.querySelectorAll<HTMLInputElement>(".rules-fw-check").forEach((cb) => {
    pageLifecycle.on(cb, "change", () => {
      debouncedSave()
      highlightActivePreset()
    })
  })

  // AI scope toggles — auto-save on change (debounced)
  document.querySelectorAll<HTMLInputElement>(".rules-ai-check").forEach((cb) => {
    pageLifecycle.on(cb, "change", () => {
      debouncedSave()
    })
  })

  // AI instruction textareas — save on blur
  document.querySelectorAll<HTMLTextAreaElement>(".rules-ai-textarea").forEach((ta) => {
    pageLifecycle.on(ta, "blur", settingsAction(async () => {
      await saveRulesFromUI()
    }))
  })

  // Restore defaults
  const restoreBtn = document.getElementById("rules-restore-defaults")
  if (restoreBtn) {
    pageLifecycle.on(restoreBtn, "click", settingsAction(async () => {
      const confirmed = await confirmDialog({
        message: "This will delete all custom rules and restore the default Strategic preset. All framework weight overrides will also be reset. This cannot be undone.",
        title: "Restore Default Rules",
        confirmText: "Restore Defaults",
        variant: "warning",
      })
      if (!confirmed) return

      // Use server-side defaults endpoint — also accessible by HA LLM API and agents
      await withRulesReplacement(async () => {
        await apiFetch("/api/rules/defaults", { method: "POST" })
        await loadRulesIntoUI()
        await loadFrameworkConfigs()
        showToast("settings.defaults_restored")
      })
    }))
  }

  // Per-framework reset buttons
  document.querySelectorAll<HTMLButtonElement>(".rules-fw-reset").forEach((btn) => {
    pageLifecycle.on(btn, "click", settingsAction(async () => {
      const frameworkId = btn.dataset.framework
      if (!frameworkId) return

      const confirmed = await confirmDialog({
        message: `Reset ${frameworkId.toUpperCase()} to default weights and configuration? Custom overrides will be lost.`,
        title: `Reset ${frameworkId.toUpperCase()}`,
        confirmText: "Reset",
        variant: "warning",
      })
      if (!confirmed) return

      await withRulesReplacement(async () => {
        await apiFetch(`/api/frameworks/${frameworkId}`, { method: "DELETE" })
        await loadFrameworkConfigs()
        showToast("settings.framework_reset")
      }, true)
    }))
  })

  // Export rules (v3 format — includes custom framework definitions)
  const exportBtn = document.getElementById("rules-export-btn")
  if (exportBtn) {
    pageLifecycle.on(exportBtn, "click", settingsAction(async () => {
      try {
        await flushRulesSave()
        await configurationMutation
        const [rulesRes, frameworksRes] = await Promise.all([
          apiFetch("/api/rules"),
          apiFetch("/api/frameworks"),
        ])
        if (!rulesRes.ok || !frameworksRes.ok) throw new Error("Could not export configuration")
        const frameworks = (frameworksRes.data ?? []) as Array<{ id: string, source?: string, [key: string]: unknown }>
        const customFrameworks = frameworks.filter(f => f.source === "user" || f.source === "imported")
        const builtInOverrides = frameworks.filter(f => f.source === "built-in" || !f.source)

        downloadJson({
          _version: 3,
          _exportedAt: new Date().toISOString(),
          rules: rulesRes.data ?? [],
          frameworks: builtInOverrides,
          customFrameworks,
        }, "Rules")
        showToast("settings.rules_exported")
      } catch {
        showToast("settings.export_failed", "error")
      }
    }))
  }

  // Import rules
  const importInput = document.getElementById("rules-import-input") as HTMLInputElement | null
  if (importInput) {
    pageLifecycle.on(importInput, "change", settingsAction(async () => {
      const file = importInput.files?.[0]
      if (!file) return

      const confirmed = await confirmDialog({
        message: "Importing rules will replace ALL existing rules and framework overrides. Make sure you have a backup. Continue?",
        title: "Import Rules",
        confirmText: "Import",
        variant: "warning",
      })
      if (!confirmed) {
        importInput.value = ""
        return
      }

      let configurationImported = false
      try {
        if (file.size > 204800) throw new Error("Rules import exceeds 200 KiB")
        const payload = JSON.parse(await file.text()) as Record<string, unknown>
        if (!payload || !Array.isArray(payload.rules)) throw new Error("The import must contain a rules array")
        const custom = payload.customFrameworks ?? []
        if (!Array.isArray(custom) || custom.length > 1000) throw new Error("Invalid custom framework list")
        const catalog = await apiFetch("/api/frameworks")
        if (!catalog.ok || !Array.isArray(catalog.data)) throw new Error("Could not load frameworks")
        const builtIns = new Map((catalog.data as FrameworkConfig[]).filter(fw => fw.source === "built-in").map(fw => [fw.id, fw]))
        const frameworks = payload.frameworks ?? []
        if (!Array.isArray(frameworks)) throw new Error("Invalid framework list")
        const frameworkOverrides = frameworks.map((value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid framework override")
          const fw = value as Record<string, unknown>
          const base = typeof fw.id === "string" ? builtIns.get(fw.id) : undefined
          if (!base) throw new Error("Unknown built-in framework")
          const fields = Array.isArray(fw.fields) ? Object.fromEntries(fw.fields.map(field => [field.key, {
            ...(field.weight !== undefined ? { weight: field.weight } : {}),
            ...(field.label !== undefined ? { label: field.label } : {}),
            ...(field.helpText !== undefined ? { helpText: field.helpText } : {}),
          }])) : fw.fields
          const overrides = { ...(fields !== undefined ? { fields } : {}), ...(fw.formula !== undefined ? { formula: fw.formula } : {}), ...(fw.badgeThresholds !== undefined ? { badgeThresholds: fw.badgeThresholds } : {}) }
          const errors = validateFrameworkOverrides(overrides, base.fields.map(field => field.key), { preserveLegacyFormula: true })
          if (errors) throw new Error(errors.join(". "))
          return { frameworkId: base.id, overrides: overrides as FrameworkOverrides }
        })
        await withRulesReplacement(async () => {
          const response = await fetch("/api/import/settings", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _version: 2, settings: {}, rules: payload.rules, customFrameworks: custom,
              ...(payload.frameworks === undefined ? {} : { frameworkOverrides }) }), signal: pageLifecycle.signal })
          const outcome = await response.json()
          if (!response.ok || outcome.success !== true) throw new Error("Configuration import was rejected")
          configurationImported = true
          await loadRulesIntoUI()
          await loadFrameworkConfigs()
          showToast("settings.rules_imported")
          importInput.value = ""
        })
      } catch {
        showToast(configurationImported ? "settings.rules_import_refresh_failed" : "settings.import_failed", "error")
      }
    }))
  }

  // ── Framework Creation Wizard ──
  initFrameworkWizard(() => {
    // Refresh framework configs after wizard creates a new framework
    void loadFrameworkConfigs().catch(() => {})
    showToast("settings.framework_created")
  }, withConfigurationMutation)

  const createBtn = document.getElementById("fw-create-btn")
  if (createBtn) {
    pageLifecycle.on(createBtn, "click", () => openWizard())
  }

  // ── YAML Import Dialog ──
  const yamlImportBtn = document.getElementById("fw-import-btn")
  const yamlImportDialog = document.getElementById("fw-import-dialog") as HTMLDialogElement | null
  const yamlImportClose = document.getElementById("fw-import-close")
  const yamlImportCancel = document.getElementById("fw-import-cancel")
  const yamlImportSubmit = document.getElementById("fw-import-submit")
  const yamlImportTextarea = document.getElementById("fw-import-yaml") as HTMLTextAreaElement | null
  const yamlImportErrors = document.getElementById("fw-import-errors")

  if (yamlImportBtn && yamlImportDialog) {
    pageLifecycle.on(yamlImportBtn, "click", () => {
      if (yamlImportTextarea) yamlImportTextarea.value = ""
      if (yamlImportErrors) yamlImportErrors.hidden = true
      yamlImportDialog.showModal()
    })
  }

  if (yamlImportClose) {
    pageLifecycle.on(yamlImportClose, "click", () => yamlImportDialog?.close())
  }
  if (yamlImportCancel) {
    pageLifecycle.on(yamlImportCancel, "click", () => yamlImportDialog?.close())
  }

  if (yamlImportSubmit && yamlImportTextarea && yamlImportDialog) {
    pageLifecycle.on(yamlImportSubmit, "click", async () => {
      const yamlText = yamlImportTextarea.value.trim()
      if (!yamlText) {
        if (yamlImportErrors) {
          yamlImportErrors.textContent = "Please paste a YAML framework definition"
          yamlImportErrors.hidden = false
        }
        return
      }

      if (yamlText.length > frameworkImportBytesMax || new Blob([yamlText]).size > frameworkImportBytesMax) {
        if (yamlImportErrors) {
          yamlImportErrors.textContent = "Framework YAML must be 64 KiB or smaller."
          yamlImportErrors.hidden = false
        }
        return
      }

      try {
        const result = await withConfigurationMutation(() => apiFetch("/api/frameworks", {
          method: "POST",
          headers: { "Content-Type": "application/yaml" },
          body: yamlText,
        }))

        if (!result.ok) {
          const msg = (result as unknown as { errors?: string[] }).errors?.join(". ") || result.message || "Import failed"
          if (yamlImportErrors) {
            yamlImportErrors.textContent = msg
            yamlImportErrors.hidden = false
          }
          return
        }

        await loadFrameworkConfigs()
        yamlImportDialog.close()
        showToast("settings.framework_imported")
      } catch (err) {
        if (yamlImportErrors) {
          yamlImportErrors.textContent = err instanceof Error ? err.message : "Framework import failed"
          yamlImportErrors.hidden = false
        }
      }
    })
  }
}
