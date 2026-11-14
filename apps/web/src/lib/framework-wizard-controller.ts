/**
 * Framework Wizard Controller — manages the 5-step creation wizard
 *
 * Controls step navigation, field builder, formula preview,
 * badge threshold editing, YAML preview generation, and API submission.
 *
 * @domain strategy
 * @kcs Framework extensibility — wizard-guided custom framework creation
 */

import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"

/** State for the wizard */
interface WizardField {
  key: string
  label: string
  type: "number" | "select"
  uiType: "slider" | "radio" | "select"
  min: number
  max: number
  weight: number
  helpText: string
}

interface WizardBadge {
  min: number
  label: string
  color: string
}

interface WizardState {
  step: number
  name: string
  id: string
  description: string
  archetype: string
  fields: WizardField[]
  formula: string
  badges: WizardBadge[]
}

const TOTAL_STEPS = 5

let state: WizardState = createDefaultState()

function createDefaultState(): WizardState {
  return {
    step: 1,
    name: "",
    id: "",
    description: "",
    archetype: "formula",
    fields: [],
    formula: "",
    badges: [
      { min: 80, label: "High", color: "danger" },
      { min: 40, label: "Medium", color: "accent" },
      { min: 0, label: "Low", color: "bg-secondary" },
    ],
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 30)
}

// ------------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------------

function $(selector: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(selector)
}

function $$(selector: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(selector))
}

// ------------------------------------------------------------------
// Step Navigation
// ------------------------------------------------------------------

function showStep(step: number): void {
  state.step = Math.max(1, Math.min(TOTAL_STEPS, step))

  // Update panels
  $$(".fw-wizard-panel").forEach((panel) => {
    const panelStep = Number(panel.dataset.panel)
    if (panelStep === state.step) {
      panel.removeAttribute("hidden")
    } else {
      panel.setAttribute("hidden", "")
    }
  })

  // Update step indicators
  $$(".fw-wizard-step").forEach((stepEl) => {
    const s = Number(stepEl.dataset.step)
    stepEl.classList.toggle("is-active", s === state.step)
    stepEl.classList.toggle("is-complete", s < state.step)
  })

  // Update nav buttons
  const prevBtn = $("#fw-prev-btn") as HTMLButtonElement | null
  const nextBtn = $("#fw-next-btn") as HTMLButtonElement | null
  const saveBtn = $("#fw-save-btn") as HTMLButtonElement | null

  if (prevBtn) prevBtn.disabled = state.step === 1
  if (nextBtn) nextBtn.hidden = state.step === TOTAL_STEPS
  if (saveBtn) saveBtn.hidden = state.step !== TOTAL_STEPS

  // Hide formula step for non-formula archetypes
  const formulaPanel = $("[data-panel='3']")
  if (formulaPanel && state.archetype !== "formula") {
    if (state.step === 3) {
      // Skip ahead or back
      showStep(state.step === 3 ? 4 : 2)
      return
    }
  }

  // Before showing, update step-specific content
  if (state.step === 3) renderFormulaVars()
  if (state.step === 4) renderBadges()
  if (state.step === 5) renderPreview()

  hideErrors()
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

function validateStep(step: number): string[] {
  const errors: string[] = []

  switch (step) {
    case 1:
      if (!state.name.trim()) errors.push("Framework name is required")
      if (!state.id) errors.push("Framework ID is required")
      break
    case 2:
      if (state.fields.length === 0) errors.push("At least one field is required")
      for (const f of state.fields) {
        if (!f.key) errors.push("All fields must have a key")
        if (!f.label) errors.push("All fields must have a label")
      }
      break
    case 3:
      if (state.archetype === "formula" && !state.formula.trim()) {
        errors.push("Formula is required for formula archetypes")
      }
      break
  }

  return errors
}

function showErrors(errors: string[]): void {
  const errEl = $("#fw-wizard-errors")
  if (errEl) {
    errEl.textContent = errors.join(". ")
    errEl.hidden = false
  }
}

function hideErrors(): void {
  const errEl = $("#fw-wizard-errors")
  if (errEl) errEl.hidden = true
}

// ------------------------------------------------------------------
// Step 1: Basics — read from DOM
// ------------------------------------------------------------------

function readBasics(): void {
  const nameInput = $("#fw-name") as HTMLInputElement | null
  const descInput = $("#fw-description") as HTMLInputElement | null
  const archetype = document.querySelector<HTMLInputElement>("input[name='fw-archetype']:checked")

  state.name = nameInput?.value.trim() ?? ""
  state.id = slugify(state.name)
  state.description = descInput?.value.trim() ?? ""
  state.archetype = archetype?.value ?? "formula"

  const idInput = $("#fw-id") as HTMLInputElement | null
  if (idInput) idInput.value = state.id
}

// ------------------------------------------------------------------
// Step 2: Fields
// ------------------------------------------------------------------

function addField(): void {
  const index = state.fields.length
  state.fields.push({
    key: `field_${index + 1}`,
    label: `Field ${index + 1}`,
    type: "number",
    uiType: "slider",
    min: 0,
    max: 10,
    weight: 1,
    helpText: "",
  })
  renderFields()
}

function removeField(index: number): void {
  state.fields.splice(index, 1)
  renderFields()
}

function readFieldsFromDOM(): void {
  const editors = $$(".fw-field-editor")
  state.fields = editors.map((editor) => ({
    key: (editor.querySelector(".fw-field-key") as HTMLInputElement)?.value || "",
    label: (editor.querySelector(".fw-field-label") as HTMLInputElement)?.value || "",
    type: (editor.querySelector(".fw-field-type") as HTMLSelectElement)?.value as "number" | "select" || "number",
    uiType: (editor.querySelector(".fw-field-uitype") as HTMLSelectElement)?.value as "slider" | "radio" | "select" || "slider",
    min: Number((editor.querySelector(".fw-field-min") as HTMLInputElement)?.value) || 0,
    max: Number((editor.querySelector(".fw-field-max") as HTMLInputElement)?.value) || 10,
    weight: Number((editor.querySelector(".fw-field-weight") as HTMLInputElement)?.value) || 1,
    helpText: (editor.querySelector(".fw-field-help") as HTMLInputElement)?.value || "",
  }))
}

function renderFields(): void {
  const list = $("#fw-fields-list")
  const template = document.getElementById("fw-field-template") as HTMLTemplateElement | null
  if (!list || !template) return

  list.replaceChildren()

  state.fields.forEach((field, index) => {
    const clone = template.content.cloneNode(true) as DocumentFragment
    const editor = clone.querySelector(".fw-field-editor") as HTMLElement
    if (!editor) return

    editor.dataset.fieldIndex = String(index)

    const keyInput = editor.querySelector(".fw-field-key") as HTMLInputElement
    const labelInput = editor.querySelector(".fw-field-label") as HTMLInputElement
    const typeSelect = editor.querySelector(".fw-field-type") as HTMLSelectElement
    const uiTypeSelect = editor.querySelector(".fw-field-uitype") as HTMLSelectElement
    const minInput = editor.querySelector(".fw-field-min") as HTMLInputElement
    const maxInput = editor.querySelector(".fw-field-max") as HTMLInputElement
    const weightInput = editor.querySelector(".fw-field-weight") as HTMLInputElement
    const helpInput = editor.querySelector(".fw-field-help") as HTMLInputElement
    const removeBtn = editor.querySelector(".fw-field-remove") as HTMLButtonElement

    if (keyInput) keyInput.value = field.key
    if (labelInput) labelInput.value = field.label
    if (typeSelect) typeSelect.value = field.type
    if (uiTypeSelect) uiTypeSelect.value = field.uiType
    if (minInput) minInput.value = String(field.min)
    if (maxInput) maxInput.value = String(field.max)
    if (weightInput) weightInput.value = String(field.weight)
    if (helpInput) helpInput.value = field.helpText
    if (removeBtn) {
      pageLifecycle.on(removeBtn, "click", () => removeField(index))
    }

    // Auto-generate key from label
    if (labelInput && keyInput) {
      pageLifecycle.on(labelInput, "input", () => {
        keyInput.value = slugify(labelInput.value).replace(/-/g, "_")
      })
    }

    list.appendChild(clone)
  })
}

// ------------------------------------------------------------------
// Step 3: Formula
// ------------------------------------------------------------------

function readFormula(): void {
  const formulaInput = $("#fw-formula") as HTMLInputElement | null
  state.formula = formulaInput?.value.trim() ?? ""
}

function renderFormulaVars(): void {
  const varsEl = $("#fw-formula-vars")
  if (!varsEl) return

  const keys = state.fields.map((f) => f.key).filter(Boolean)
  if (keys.length === 0) {
    const emptyP = document.createElement("p")
    emptyP.className = "fw-field-hint"
    emptyP.textContent = "No fields defined yet. Go back to Step 2 to add fields."
    varsEl.replaceChildren(emptyP)
    return
  }

  const hintP = document.createElement("p")
  hintP.className = "fw-field-hint"
  const strong = document.createElement("strong")
  strong.textContent = "Available field keys:"
  hintP.appendChild(strong)

  const chips = document.createElement("div")
  chips.style.display = "flex"
  chips.style.flexWrap = "wrap"
  chips.style.gap = "4px"
  chips.style.marginTop = "4px"
  for (const k of keys) {
    const code = document.createElement("code")
    code.style.padding = "2px 6px"
    code.style.background = "var(--bg-secondary)"
    code.style.borderRadius = "4px"
    code.style.fontSize = "12px"
    code.textContent = k
    chips.appendChild(code)
  }
  varsEl.replaceChildren(hintP, chips)
}

// ------------------------------------------------------------------
// Step 4: Badges
// ------------------------------------------------------------------

function addBadge(): void {
  state.badges.push({ min: 0, label: "New Tier", color: "bg-secondary" })
  renderBadges()
}

function removeBadge(index: number): void {
  state.badges.splice(index, 1)
  renderBadges()
}

function readBadgesFromDOM(): void {
  const editors = $$(".fw-badge-editor")
  state.badges = editors.map((editor) => ({
    min: Number((editor.querySelector(".fw-badge-min") as HTMLInputElement)?.value) || 0,
    label: (editor.querySelector(".fw-badge-label") as HTMLInputElement)?.value || "",
    color: (editor.querySelector(".fw-badge-color") as HTMLSelectElement)?.value || "bg-secondary",
  }))
}

function renderBadges(): void {
  const list = $("#fw-badges-list")
  const template = document.getElementById("fw-badge-template") as HTMLTemplateElement | null
  if (!list || !template) return

  list.replaceChildren()

  state.badges.forEach((badge, index) => {
    const clone = template.content.cloneNode(true) as DocumentFragment
    const editor = clone.querySelector(".fw-badge-editor") as HTMLElement

    if (!editor) return
    editor.dataset.badgeIndex = String(index)

    const minInput = editor.querySelector(".fw-badge-min") as HTMLInputElement
    const labelInput = editor.querySelector(".fw-badge-label") as HTMLInputElement
    const colorSelect = editor.querySelector(".fw-badge-color") as HTMLSelectElement
    const removeBtn = editor.querySelector(".fw-badge-remove") as HTMLButtonElement

    if (minInput) minInput.value = String(badge.min)
    if (labelInput) labelInput.value = badge.label
    if (colorSelect) colorSelect.value = badge.color
    if (removeBtn) pageLifecycle.on(removeBtn, "click", () => removeBadge(index))

    list.appendChild(clone)
  })
}

// ------------------------------------------------------------------
// Step 5: Preview
// ------------------------------------------------------------------

function renderPreview(): void {
  const previewEl = $("#fw-preview-card")
  const yamlEl = $("#fw-yaml-output")
  if (!previewEl) return

  const nodes: HTMLElement[] = []

  const header = document.createElement("div")
  header.style.display = "flex"
  header.style.alignItems = "center"
  header.style.gap = "8px"
  header.style.marginBottom = "10px"
  const title = document.createElement("strong")
  title.style.fontSize = "16px"
  title.textContent = state.name || "Untitled"
  const archBadge = document.createElement("span")
  archBadge.style.cssText = "font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--bg-primary); border: 1px solid var(--border);"
  archBadge.textContent = state.archetype
  const customBadge = document.createElement("span")
  customBadge.style.cssText = "font-size: 11px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);"
  customBadge.textContent = "custom"
  header.append(title, archBadge, customBadge)
  nodes.push(header)

  if (state.description) {
    const descP = document.createElement("p")
    descP.style.cssText = "font-size: 12px; color: var(--text-muted); margin: 0 0 10px;"
    descP.textContent = state.description
    nodes.push(descP)
  }

  if (state.formula) {
    const formulaP = document.createElement("p")
    formulaP.style.cssText = "font-size: 12px; font-family: monospace; margin: 0 0 10px;"
    const fLabel = document.createElement("strong")
    fLabel.textContent = "Formula:"
    formulaP.append(fLabel, document.createTextNode(` ${state.formula}`))
    nodes.push(formulaP)
  }

  const fieldsSection = document.createElement("div")
  fieldsSection.style.marginBottom = "8px"
  const fieldsHeading = document.createElement("strong")
  fieldsHeading.style.fontSize = "12px"
  fieldsHeading.textContent = `Fields (${state.fields.length})`
  fieldsSection.appendChild(fieldsHeading)
  for (const f of state.fields) {
    const row = document.createElement("div")
    row.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px;"
    const left = document.createElement("span")
    const leftStrong = document.createElement("strong")
    leftStrong.textContent = f.label
    left.appendChild(leftStrong)
    const right = document.createElement("span")
    right.style.color = "var(--text-muted)"
    right.textContent = `${f.type} (${f.uiType})${f.type === "number" ? ` [${f.min}–${f.max}]` : ""}`
    row.append(left, right)
    fieldsSection.appendChild(row)
  }
  nodes.push(fieldsSection)

  const badgesSection = document.createElement("div")
  const badgesHeading = document.createElement("strong")
  badgesHeading.style.fontSize = "12px"
  badgesHeading.textContent = "Badges"
  const badgesWrap = document.createElement("div")
  badgesWrap.style.cssText = "margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;"
  if (state.badges.length === 0) {
    const none = document.createElement("span")
    none.style.cssText = "color: var(--text-muted); font-size: 12px;"
    none.textContent = "No badges defined"
    badgesWrap.appendChild(none)
  } else {
    for (const b of state.badges) {
      const chip = document.createElement("span")
      chip.style.cssText = "display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; color: var(--bg-primary);"
      chip.style.background = `var(--${b.color.replace(/[^a-zA-Z0-9_-]/g, "")})`
      chip.textContent = `${b.label} (≥${b.min})`
      badgesWrap.appendChild(chip)
    }
  }
  badgesSection.append(badgesHeading, badgesWrap)
  nodes.push(badgesSection)

  previewEl.replaceChildren(...nodes)

  // YAML preview
  if (yamlEl) {
    const yaml = generateYaml()
    yamlEl.textContent = yaml
  }
}

function generateYaml(): string {
  const lines: string[] = [
    `name: ${state.name}`,
    `version: 1.0.0`,
    `archetype: ${state.archetype}`,
  ]

  if (state.description) {
    lines.push(`description: "${state.description}"`)
  }

  if (state.formula) {
    lines.push(`formula: "${state.formula}"`)
  }

  lines.push("badge_thresholds:")
  for (const b of state.badges) {
    lines.push(`  - min: ${b.min}`)
    lines.push(`    label: "${b.label}"`)
    lines.push(`    color: "${b.color}"`)
  }

  lines.push("fields:")
  for (const f of state.fields) {
    lines.push(`  - key: ${f.key}`)
    lines.push(`    label: ${f.label}`)
    lines.push(`    type: ${f.type}`)
    lines.push(`    ui_type: ${f.uiType}`)
    if (f.type === "number") {
      lines.push(`    min: ${f.min}`)
      lines.push(`    max: ${f.max}`)
    }
    lines.push(`    weight: ${f.weight}`)
    if (f.helpText) {
      lines.push(`    help_text: "${f.helpText}"`)
    }
  }

  return lines.join("\n")
}

// ------------------------------------------------------------------
// API Submission
// ------------------------------------------------------------------

async function saveFramework(): Promise<boolean> {
  readFieldsFromDOM()
  readBadgesFromDOM()

  const payload = {
    id: state.id,
    name: state.name,
    version: "1.0.0",
    archetype: state.archetype,
    source: "user",
    description: state.description || undefined,
    formula: state.formula || undefined,
    fields: state.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      uiType: f.uiType,
      weight: f.weight,
      min: f.type === "number" ? f.min : undefined,
      max: f.type === "number" ? f.max : undefined,
      helpText: f.helpText || "",
    })),
    badgeThresholds: state.badges.map((b) => ({
      min: b.min,
      label: b.label,
      color: b.color,
    })),
  }

  try {
    const signal = pageLifecycle.signal
    const res = await fetch("/api/frameworks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })

    const data = await res.json()

    signal.throwIfAborted()
    if (!res.ok || data?.ok !== true) {
      const msg = data.errors?.join(". ") || data.message || "Failed to create framework"
      showErrors([msg])
      return false
    }

    return true
  } catch (err) {
    showErrors([`Network error: ${err}`])
    return false
  }
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export function openWizard(): void {
  state = createDefaultState()
  const dialog = document.getElementById("framework-wizard-dialog") as HTMLDialogElement | null
  if (!dialog) return

  // Reset form fields
  const nameInput = $("#fw-name") as HTMLInputElement | null
  const idInput = $("#fw-id") as HTMLInputElement | null
  const descInput = $("#fw-description") as HTMLInputElement | null
  const formulaInput = $("#fw-formula") as HTMLInputElement | null

  if (nameInput) nameInput.value = ""
  if (idInput) idInput.value = ""
  if (descInput) descInput.value = ""
  if (formulaInput) formulaInput.value = ""

  // Reset archetype
  const formulaRadio = document.querySelector<HTMLInputElement>("input[name='fw-archetype'][value='formula']")
  if (formulaRadio) formulaRadio.checked = true

  renderFields()
  showStep(1)
  dialog.showModal()
}

export function closeWizard(): void {
  const dialog = document.getElementById("framework-wizard-dialog") as HTMLDialogElement | null
  dialog?.close()
}

export function initFrameworkWizard(
  onCreated?: () => void,
  mutate: (action: () => Promise<boolean>) => Promise<boolean> = (action) => action(),
): void {
  const dialog = document.getElementById("framework-wizard-dialog") as HTMLDialogElement | null
  if (!dialog) return

  // Close buttons
  $$("[data-action='close']", dialog).forEach((el) => {
    pageLifecycle.on(el, "click", closeWizard)
  })

  // Step nav buttons
  $$(".fw-wizard-step", dialog).forEach((stepBtn) => {
    pageLifecycle.on(stepBtn, "click", () => {
      const targetStep = Number(stepBtn.dataset.step)
      if (targetStep < state.step) {
        // Allow going back
        syncCurrentStep()
        showStep(targetStep)
      }
    })
  })

  // Name → ID auto-generation
  const nameInput = $("#fw-name") as HTMLInputElement | null
  const idInput = $("#fw-id") as HTMLInputElement | null
  if (nameInput && idInput) {
    pageLifecycle.on(nameInput, "input", () => {
      state.name = nameInput.value.trim()
      state.id = slugify(state.name)
      idInput.value = state.id
    })
  }

  // Archetype change
  $$("input[name='fw-archetype']").forEach((radio) => {
    pageLifecycle.on(radio, "change", () => {
      state.archetype = (radio as HTMLInputElement).value
    })
  })

  // Add field
  const addFieldBtn = $("#fw-add-field")
  if (addFieldBtn) pageLifecycle.on(addFieldBtn, "click", addField)

  // Add badge
  const addBadgeBtn = $("#fw-add-badge")
  if (addBadgeBtn) pageLifecycle.on(addBadgeBtn, "click", addBadge)

  // Next
  const nextBtn = $("#fw-next-btn")
  if (nextBtn) {
    pageLifecycle.on(nextBtn, "click", () => {
      syncCurrentStep()
      const errors = validateStep(state.step)
      if (errors.length > 0) {
        showErrors(errors)
        return
      }
      let nextStep = state.step + 1
      // Skip formula step for non-formula archetypes
      if (nextStep === 3 && state.archetype !== "formula") {
        nextStep = 4
      }
      showStep(nextStep)
    })
  }

  // Previous
  const prevBtn = $("#fw-prev-btn")
  if (prevBtn) {
    pageLifecycle.on(prevBtn, "click", () => {
      syncCurrentStep()
      let prevStep = state.step - 1
      // Skip formula step for non-formula archetypes
      if (prevStep === 3 && state.archetype !== "formula") {
        prevStep = 2
      }
      showStep(prevStep)
    })
  }

  // Save
  const saveBtn = $("#fw-save-btn")
  if (saveBtn) {
    pageLifecycle.on(saveBtn, "click", async () => {
      saveBtn.setAttribute("disabled", "")
      saveBtn.textContent = "Saving…"

      let success = false
      try { success = await mutate(saveFramework) } catch (error) { showErrors([`Could not save framework: ${error}`]) }
      if (success) {
        closeWizard()
        onCreated?.()
      }

      saveBtn.removeAttribute("disabled")
      saveBtn.textContent = "Save Framework"
    })
  }

  // Close on escape
  pageLifecycle.on(dialog, "cancel", (e) => {
    e.preventDefault()
    closeWizard()
  })
}

/** Sync current step's DOM values into state */
function syncCurrentStep(): void {
  switch (state.step) {
    case 1:
      readBasics()
      break
    case 2:
      readFieldsFromDOM()
      break
    case 3:
      readFormula()
      break
    case 4:
      readBadgesFromDOM()
      break
  }
}
