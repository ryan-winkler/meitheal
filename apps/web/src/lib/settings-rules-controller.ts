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
import { showToast } from "@lib/toast"
import { exportFilename } from "@lib/export-filename"

interface RuleApiResponse {
  ok: boolean
  data?: unknown
  errorCode?: string
  message?: string
}

/** Preset definitions — mirrors the 3 built-in presets from domain-strategy */
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
    ],
  },
  "ux-focused": {
    label: "UX-Focused",
    description: "HEART + DDD for epics, HEART + KCS for stories",
    rules: [
      { name: "Epic Default", taskTypes: ["epic"], lensIds: ["heart", "ddd"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true } },
      { name: "Story Default", taskTypes: ["story"], lensIds: ["heart", "kcs"], aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: true, canSuggestLabels: true } },
      { name: "Task Default", taskTypes: ["task"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
    ],
  },
  simple: {
    label: "Simple",
    description: "No frameworks — lightweight task management",
    rules: [
      { name: "Epic Default", taskTypes: ["epic"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Story Default", taskTypes: ["story"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
      { name: "Task Default", taskTypes: ["task"], lensIds: [], aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false } },
    ],
  },
}

/**
 * Fetch helper — wraps native fetch with pageLifecycle signal
 * and graceful error handling (catches network errors, non-JSON responses).
 * Returns { ok: false } on any failure instead of throwing.
 */
async function apiFetch(path: string, options?: RequestInit): Promise<RuleApiResponse> {
  try {
    const res = await fetch(path, {
      ...options,
      signal: pageLifecycle.signal,
    })
    // Guard: if response is not JSON (e.g. HA login page redirect, HTML error),
    // don't let it bubble up as "session expired" via the 403 handler in Layout.astro
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) {
      return { ok: false, errorCode: "NON_JSON_RESPONSE", message: `Status ${res.status}` }
    }
    return res.json() as Promise<RuleApiResponse>
  } catch {
    return { ok: false, errorCode: "NETWORK_ERROR", message: "Failed to reach API" }
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
 * If no rules exist (first load), auto-seeds the "Strategic" preset.
 */
async function loadRulesIntoUI(): Promise<void> {
  try {
    const result = await apiFetch("/api/rules")
    if (!result.ok || !Array.isArray(result.data)) return

    const rules = result.data as Array<{
      id: string
      name: string
      taskTypes: string[]
      lensIds: string[]
      aiScope: Record<string, boolean | string>
    }>

    // Auto-seed: if no rules exist on first load, apply the Strategic preset
    if (rules.length === 0) {
      await applyPresetDirect("strategic")
      return // applyPresetDirect calls loadRulesIntoUI recursively
    }

    // Clear all checkboxes first
    document.querySelectorAll<HTMLInputElement>(".rules-fw-check").forEach((cb) => { cb.checked = false })
    document.querySelectorAll<HTMLInputElement>(".rules-ai-check").forEach((cb) => { cb.checked = false })
    document.querySelectorAll<HTMLTextAreaElement>(".rules-ai-textarea").forEach((ta) => { ta.value = "" })

    // Apply rules to the UI
    for (const rule of rules) {
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
    // Silently fail — rules may not exist yet
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
        for (const fw of ["rice", "drice", "heart", "ddd", "kcs"]) {
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

/** Save current UI state as rules to the API */
async function saveRulesFromUI(): Promise<void> {
  try {
    // Delete all existing rules first (full replace)
    const existing = await apiFetch("/api/rules")
    if (existing.ok && Array.isArray(existing.data)) {
      for (const rule of existing.data as Array<{ id: string }>) {
        await apiFetch(`/api/rules/${rule.id}`, { method: "DELETE" })
      }
    }

    // Collect state from UI
    const taskTypes = ["epic", "story", "task"]
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

      await apiFetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${taskType.charAt(0).toUpperCase() + taskType.slice(1)} Default`,
          taskTypes: [taskType],
          lensIds,
          aiScope,
          ruleType: "strategic-lens",
        }),
      })
    }

    showToast("settings.rules_saved")
  } catch {
    showToast("settings.rules_save_failed", "error")
  }
}

/**
 * Apply a preset — clears and replaces all rules.
 * This is the internal version that doesn't show confirmation.
 */
async function applyPresetDirect(presetId: string): Promise<void> {
  const preset = PRESET_DEFINITIONS[presetId]
  if (!preset) return

  // Clear existing
  const existing = await apiFetch("/api/rules")
  if (existing.ok && Array.isArray(existing.data)) {
    for (const rule of existing.data as Array<{ id: string }>) {
      await apiFetch(`/api/rules/${rule.id}`, { method: "DELETE" })
    }
  }

  // Create new rules from preset
  for (const rule of preset.rules) {
    await apiFetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: rule.name,
        taskTypes: rule.taskTypes,
        lensIds: rule.lensIds,
        aiScope: rule.aiScope,
        ruleType: "strategic-lens",
      }),
    })
  }

  await loadRulesIntoUI()
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
  const hasExisting = existing.ok && Array.isArray(existing.data) && existing.data.length > 0

  if (hasExisting) {
    const confirmed = await confirmDialog({
      message: `Switch to the "${preset.label}" preset? This will replace your current rule configuration.`,
      title: "Switch Preset",
      confirmText: `Apply ${preset.label}`,
      variant: "info",
    })
    if (!confirmed) return
  }

  await applyPresetDirect(presetId)
  showToast("settings.preset_applied")
}

/** Load framework configs into the config editor */
async function loadFrameworkConfigs(): Promise<void> {
  try {
    const result = await apiFetch("/api/frameworks")
    if (!result.ok || !Array.isArray(result.data)) return

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
        const fieldInfo = field.options
          ? `<span class="fw-field-type" title="${field.helpText}">
               ${field.options.map((o) => o.label).join(" · ")}
             </span>`
          : field.min !== undefined && field.max !== undefined
            ? `<span class="fw-field-range">${field.min}–${field.max}</span>`
            : ""

        return `
          <div class="rules-fw-field">
            <div class="rules-fw-field-header">
              <label title="${field.helpText}">${field.label}</label>
              ${fieldInfo}
            </div>
            <div class="rules-fw-field-controls">
              <input
                type="range"
                class="form-input rules-fw-weight"
                data-framework="${fw.id}"
                data-field="${field.key}"
                min="0" max="3" step="0.1"
                value="${field.weight}"
                aria-label="${field.label} weight"
              />
              <span class="weight-display">${field.weight.toFixed(1)}×</span>
            </div>
            <p class="fw-field-help">${field.helpText}</p>
          </div>
        `
      }).join("")

      // Wire up weight sliders
      container.querySelectorAll<HTMLInputElement>(".rules-fw-weight").forEach((slider) => {
        pageLifecycle.on(slider, "input", () => {
          const display = slider.parentElement?.querySelector(".weight-display")
          if (display) display.textContent = `${Number(slider.value).toFixed(1)}×`
        })
        pageLifecycle.on(slider, "change", async () => {
          const frameworkId = slider.dataset.framework
          const fieldKey = slider.dataset.field
          if (!frameworkId || !fieldKey) return

          await apiFetch(`/api/frameworks/${frameworkId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fields: { [fieldKey]: { weight: Number(slider.value) } },
            }),
          })
          showToast("settings.framework_updated")
        })
      })
    }
  } catch {
    // Silently fail
  }
}

/**
 * Initialize the rules settings controller.
 * Called by settings-page.ts on the appropriate lifecycle event.
 */
export function initRulesSettings(): void {
  // Load current state
  loadRulesIntoUI()
  loadFrameworkConfigs()

  // Preset buttons
  document.querySelectorAll<HTMLButtonElement>(".rules-preset-btn").forEach((btn) => {
    pageLifecycle.on(btn, "click", async () => {
      const presetId = btn.dataset.preset
      if (!presetId) return
      await applyPreset(presetId)
    })
  })

  // Framework assignment checkboxes — auto-save on change
  document.querySelectorAll<HTMLInputElement>(".rules-fw-check").forEach((cb) => {
    pageLifecycle.on(cb, "change", async () => {
      await saveRulesFromUI()
      highlightActivePreset()
    })
  })

  // AI scope toggles — auto-save on change
  document.querySelectorAll<HTMLInputElement>(".rules-ai-check").forEach((cb) => {
    pageLifecycle.on(cb, "change", async () => {
      await saveRulesFromUI()
    })
  })

  // AI instruction textareas — save on blur
  document.querySelectorAll<HTMLTextAreaElement>(".rules-ai-textarea").forEach((ta) => {
    pageLifecycle.on(ta, "blur", async () => {
      await saveRulesFromUI()
    })
  })

  // Restore defaults
  const restoreBtn = document.getElementById("rules-restore-defaults")
  if (restoreBtn) {
    pageLifecycle.on(restoreBtn, "click", async () => {
      const confirmed = await confirmDialog({
        message: "This will delete all custom rules and restore the default Strategic preset. All framework weight overrides will also be reset. This cannot be undone.",
        title: "Restore Default Rules",
        confirmText: "Restore Defaults",
        variant: "warning",
      })
      if (!confirmed) return

      // Use server-side defaults endpoint — also accessible by HA LLM API and agents
      await apiFetch("/api/rules/defaults", { method: "POST" })
      await loadRulesIntoUI()
      await loadFrameworkConfigs()
      showToast("settings.defaults_restored")
    })
  }

  // Per-framework reset buttons
  document.querySelectorAll<HTMLButtonElement>(".rules-fw-reset").forEach((btn) => {
    pageLifecycle.on(btn, "click", async () => {
      const frameworkId = btn.dataset.framework
      if (!frameworkId) return

      const confirmed = await confirmDialog({
        message: `Reset ${frameworkId.toUpperCase()} to default weights and configuration? Custom overrides will be lost.`,
        title: `Reset ${frameworkId.toUpperCase()}`,
        confirmText: "Reset",
        variant: "warning",
      })
      if (!confirmed) return

      await apiFetch(`/api/frameworks/${frameworkId}`, { method: "DELETE" })
      await loadFrameworkConfigs()
      showToast("settings.framework_reset")
    })
  })

  // Export rules
  const exportBtn = document.getElementById("rules-export-btn")
  if (exportBtn) {
    pageLifecycle.on(exportBtn, "click", async () => {
      try {
        const [rulesRes, frameworksRes] = await Promise.all([
          apiFetch("/api/rules"),
          apiFetch("/api/frameworks"),
        ])
        downloadJson({
          _version: 1,
          _exportedAt: new Date().toISOString(),
          rules: rulesRes.data ?? [],
          frameworks: frameworksRes.data ?? [],
        }, "Rules")
        showToast("settings.rules_exported")
      } catch {
        showToast("settings.export_failed", "error")
      }
    })
  }

  // Import rules
  const importInput = document.getElementById("rules-import-input") as HTMLInputElement | null
  if (importInput) {
    pageLifecycle.on(importInput, "change", async () => {
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

      try {
        const text = await file.text()
        const payload = JSON.parse(text) as {
          _version?: number
          rules?: Array<Record<string, unknown>>
          frameworks?: Array<Record<string, unknown>>
        }

        if (!payload.rules || !Array.isArray(payload.rules)) {
          showToast("settings.import_invalid", "error")
          return
        }

        // Delete existing rules
        const existing = await apiFetch("/api/rules")
        if (existing.ok && Array.isArray(existing.data)) {
          for (const rule of existing.data as Array<{ id: string }>) {
            await apiFetch(`/api/rules/${rule.id}`, { method: "DELETE" })
          }
        }

        // Import rules
        for (const rule of payload.rules) {
          await apiFetch("/api/rules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rule),
          })
        }

        // Import framework overrides if present
        if (Array.isArray(payload.frameworks)) {
          for (const fw of payload.frameworks as Array<{ id?: string; fields?: Record<string, unknown> }>) {
            if (fw.id && fw.fields) {
              await apiFetch(`/api/frameworks/${fw.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fields: fw.fields }),
              })
            }
          }
        }

        await loadRulesIntoUI()
        await loadFrameworkConfigs()
        showToast("settings.rules_imported")
      } catch {
        showToast("settings.import_failed", "error")
      } finally {
        importInput.value = ""
      }
    })
  }
}
