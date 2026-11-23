/**
 * modal-custom-fields.ts — Custom fields CRUD (RICE, Agile, Settings-defined fields)
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Manages custom field rows, categorised dropdown, field type rendering,
 *      and debounced save. Depends on saveTD + settingsFields from parent.
 */

export interface CustomFieldsDeps {
  saveTD: (field: string, value: unknown) => Promise<void>
  getSettingsFields: () => Array<{ name: string; type: string; options?: string[] }>
  getCurrentTaskId?: () => string | null
  signal?: AbortSignal
}

const STRUCTURED_CF_KEYS = new Set(["items", "quantity", "category", "location", "fields"])
const isRetainedCustomFieldKey = (key: string) =>
  STRUCTURED_CF_KEYS.has(key) || key.startsWith("grocy_") || key.startsWith("external_")

export function initCustomFields({ saveTD, getSettingsFields, getCurrentTaskId, signal }: CustomFieldsDeps) {
  const opts = signal ? { signal } : undefined
  let activeTaskId: string | null = null
  let retainedStructuredFields: Record<string, unknown> = {}

  function parseRawCustomFields(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) }
    if (typeof raw !== "string") return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  function getCFFromUI(): Record<string, string> {
    const result: Record<string, string> = {}
    document.querySelectorAll<HTMLElement>(".td-cf-row").forEach((row) => {
      if (row.dataset.cfPristine === "1") return
      const key = (row.querySelector(".td-cf-key") as HTMLInputElement)?.value.trim()
      if (!key) return
      const cbInput = row.querySelector("input[type=checkbox].td-cf-val") as HTMLInputElement | null
      const otherInput = row.querySelector("select.td-cf-val, input:not([type=checkbox]).td-cf-val") as HTMLInputElement | HTMLSelectElement | null
      result[key] = cbInput ? (cbInput.checked ? "true" : "false") : (otherInput?.value.trim() ?? "")
    })
    return result
  }

  const buildMergedPayload = () => ({ ...retainedStructuredFields, ...getCFFromUI() })
  const getMergedJson = () => JSON.stringify(buildMergedPayload())
  let _saveCFTimer: ReturnType<typeof setTimeout> | null = null

  function cancelPendingSave(): void {
    if (_saveCFTimer) {
      clearTimeout(_saveCFTimer)
      _saveCFTimer = null
    }
  }

  signal?.addEventListener("abort", cancelPendingSave, { once: true })

  function saveCF() {
    cancelPendingSave()
    const scheduledTaskId = getCurrentTaskId?.() ?? activeTaskId
    _saveCFTimer = setTimeout(() => {
      _saveCFTimer = null
      if (!signal?.aborted && (getCurrentTaskId?.() ?? activeTaskId) === scheduledTaskId) {
        void saveTD("custom_fields", getMergedJson())
      }
    }, 400)
  }

  function loadTaskCustomFields(
    taskId: string,
    rawCustomFields: unknown,
    renderedKeys: Set<string>,
    settingsFields: Array<{ name: string; type: string; options?: string[] }>,
  ): void {
    cancelPendingSave()
    activeTaskId = taskId
    retainedStructuredFields = {}
    document.getElementById("td-custom-fields")?.replaceChildren()
    for (const [k, v] of Object.entries(parseRawCustomFields(rawCustomFields))) {
      if (v === null || v === undefined) continue
      renderedKeys.add(k)
      if (typeof v === "object" || isRetainedCustomFieldKey(k)) {
        retainedStructuredFields[k] = v
      } else {
        const sfDef = settingsFields.find((sf) => sf.name === k)
        addCFRow(k, String(v), sfDef?.type || "text", sfDef?.options)
      }
    }
  }

  function setStructuredField(key: string, value: unknown, persistNow = true): void {
    const currentId = getCurrentTaskId?.() ?? activeTaskId
    if (!currentId || currentId !== activeTaskId) return
    if (value === undefined) delete retainedStructuredFields[key]
    else retainedStructuredFields[key] = value
    if (persistNow) {
      cancelPendingSave()
      void saveTD("custom_fields", getMergedJson())
    }
  }

  const getStructuredField = (key: string): unknown => retainedStructuredFields[key]

  function addCFRow(
    key: string,
    value: string,
    fieldType: string = "text",
    options?: string[],
    pristine = false,
  ) {
    const cfDiv = document.getElementById(
      "td-custom-fields",
    ) as HTMLElement
    const row = document.createElement("div")
    row.className = "td-cf-row"
    if (pristine) row.dataset.cfPristine = "1"
    row.style.cssText = "display:flex;gap:6px;align-items:center;"

    // Key label (always a readonly text input for consistency)
    let valueEl: HTMLElement
    let bindSave: () => void
    if (fieldType === "checkbox") {
      const isChecked =
        value === "true" || value === "1" || value === "yes"
      const label = document.createElement("label")
      label.className = "td-cf-val-wrap"
      label.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;"
      const cb = document.createElement("input")
      cb.type = "checkbox"
      cb.className = "form-checkbox td-cf-val h-5 w-5 accent-accent rounded"
      cb.style.cursor = "pointer"
      cb.checked = isChecked
      const span = document.createElement("span")
      span.className = "text-xs text-text-muted"
      span.textContent = isChecked ? "Yes" : "No"
      label.append(cb, span)
      valueEl = label
      bindSave = () => cb.addEventListener("change", () => {
        delete row.dataset.cfPristine
        span.textContent = cb.checked ? "Yes" : "No"
        saveCF()
      }, opts)
    } else if (fieldType === "select" && options && options.length > 0) {
      const select = document.createElement("select")
      select.className = "form-input td-cf-val text-sm py-1"
      select.style.flex = "1"
      select.append(
        new Option("Select…", "", !value, !value),
        ...options.map((o) => new Option(o, o, o === value, o === value)),
      )
      valueEl = select
      const markDirty = () => { delete row.dataset.cfPristine; saveCF() }
      bindSave = () => {
        select.addEventListener("blur", markDirty, opts)
        select.addEventListener("input", markDirty, opts)
      }
    } else {
      const input = document.createElement("input")
      input.type = fieldType === "number" || fieldType === "date" || fieldType === "url" ? fieldType : "text"
      input.className = "form-input td-cf-val text-sm py-1"
      input.style.flex = "1"
      if (fieldType === "url") input.placeholder = "https://…"
      else if (fieldType !== "date") input.placeholder = "Value"
      input.value = value
      valueEl = input
      const markDirty = () => { delete row.dataset.cfPristine; saveCF() }
      bindSave = () => {
        input.addEventListener("blur", markDirty, opts)
        input.addEventListener("input", markDirty, opts)
      }
    }

    const keyInput = document.createElement("input")
    keyInput.type = "text"
    keyInput.className = "form-input td-cf-key text-sm py-1"
    keyInput.placeholder = "Field name"
    keyInput.value = key
    keyInput.style.cssText = "flex:1;opacity:0.7;"
    keyInput.readOnly = true

    const removeBtn = document.createElement("button")
    removeBtn.type = "button"
    removeBtn.className = "td-cf-remove"
    removeBtn.style.cssText = "color:var(--danger);font-size:16px;cursor:pointer;background:none;border:none;padding:0 4px;"
    removeBtn.textContent = "×"

    row.replaceChildren(keyInput, valueEl, removeBtn)
    bindSave()
    removeBtn.addEventListener("click", () => {
      row.remove()
      saveCF()
    }, opts)
    cfDiv.appendChild(row)
  }

  // Categorized field groups for the dropdown
  const fieldCategories: { label: string; fields: string[] }[] = [
    {
      label: "RICE Framework",
      fields: ["Reach", "Impact", "Confidence", "Effort"],
    },
    {
      label: "Agile & Planning",
      fields: [
        "Estimate",
        "Sprint",
        "Team",
        "Component",
        "Environment",
        "Version",
        "Story Points",
        "Acceptance Criteria",
      ],
    },
    {
      label: "Sizing & Value",
      fields: ["Complexity", "T-Shirt Size", "Business Value"],
    },
  ]

  function getAvailableFields(): { label: string; fields: string[] }[] {
    const currentKeys = new Set([
      ...Object.keys(getCFFromUI()),
      ...Object.keys(retainedStructuredFields),
    ])
    const _settingsFields = getSettingsFields()
    // Build categorized list filtered by what's already on the task
    const result = fieldCategories
      .map((cat) => ({
        label: cat.label,
        fields: cat.fields.filter((f) => !currentKeys.has(f)),
      }))
      .filter((cat) => cat.fields.length > 0)
    // Inject settings-defined fields not already present
    if (_settingsFields.length > 0) {
      const allPredefinedNames = new Set(
        fieldCategories.flatMap((c) => c.fields),
      )
      const settingsOnly = _settingsFields
        .map((sf) => sf.name)
        .filter((n) => !currentKeys.has(n) && !allPredefinedNames.has(n))
      if (settingsOnly.length > 0) {
        result.unshift({
          label: "Settings Fields",
          fields: settingsOnly,
        })
      }
    }
    // Add any custom keys from existing rows not in our predefined lists
    const allPredefined = new Set(
      fieldCategories.flatMap((c) => c.fields),
    )
    const existingCustom: string[] = []
    document.querySelectorAll(".td-cf-key").forEach((el) => {
      const val = (el as HTMLInputElement).value.trim()
      if (val && !allPredefined.has(val) && !currentKeys.has(val))
        existingCustom.push(val)
    })
    if (existingCustom.length > 0) {
      result.push({
        label: "Custom",
        fields: [...new Set(existingCustom)].sort(),
      })
    }
    return result
  }

  const dropdownEl = () => document.getElementById("td-add-cf-dropdown")
  const searchEl = () => document.getElementById("td-add-cf-search") as HTMLInputElement | null
  const addFieldByName = (fieldName: string) => {
    if (isRetainedCustomFieldKey(fieldName) || Object.hasOwn(retainedStructuredFields, fieldName)) return
    const sfDef = getSettingsFields().find((sf) => sf.name === fieldName)
    addCFRow(fieldName, sfDef?.type === "checkbox" ? "false" : "", sfDef?.type || "text", sfDef?.options)
    const dd = dropdownEl()
    if (dd) dd.style.display = "none"
    const s = searchEl()
    if (s) s.value = ""
  }

  document.getElementById("td-add-cf-options")?.addEventListener("click", (e) => {
    const opt = (e.target as Element)?.closest<HTMLElement>(".td-cf-option")
    if (opt?.dataset.field) addFieldByName(opt.dataset.field)
  }, opts)

  function renderFieldDropdown(filter = "") {
    const optionsDiv = document.getElementById("td-add-cf-options")!
    const lowerFilter = filter.toLowerCase()
    const categories = getAvailableFields()
    const settingsFields = getSettingsFields()
    const nodes: HTMLElement[] = []
    const typeBadge: Record<string, string> = {
      text: "Aa",
      checkbox: "Yes/No",
      select: "List",
      date: "Date",
      number: "#",
      url: "URL",
    }
    for (const cat of categories) {
      const filtered = cat.fields.filter((f) => f.toLowerCase().includes(lowerFilter))
      if (filtered.length === 0) continue
      const header = document.createElement("div")
      header.className = "px-3 py-1 text-[10px] text-text-muted uppercase tracking-wide font-semibold border-t border-border first:border-t-0"
      header.textContent = cat.label
      nodes.push(header)
      for (const f of filtered) {
        const sfDef = settingsFields.find((sf) => sf.name === f)
        const opt = document.createElement("div")
        opt.className = "td-cf-option px-3 py-1.5 text-sm cursor-pointer hover:bg-bg-hover"
        opt.dataset.field = f
        opt.textContent = `${f} (${typeBadge[sfDef?.type || "text"] || "Aa"})`
        nodes.push(opt)
      }
    }
    if (nodes.length === 0) {
      const empty = document.createElement("div")
      empty.className = "px-3 py-1.5 text-xs text-text-muted italic"
      empty.textContent = "Type a custom name and press Enter"
      optionsDiv.replaceChildren(empty)
    } else {
      optionsDiv.replaceChildren(...nodes)
    }
  }

  document.getElementById("td-add-cf")?.addEventListener("click", (e) => {
    e.stopPropagation()
    const dd = dropdownEl()!
    const isVisible = dd.style.display !== "none"
    dd.style.display = isVisible ? "none" : "block"
    if (!isVisible) {
      renderFieldDropdown()
      searchEl()?.focus()
    }
  }, opts)

  document
    .getElementById("td-add-cf-search")
    ?.addEventListener("input", (e) => {
      renderFieldDropdown((e.target as HTMLInputElement).value)
    }, opts)

  document
    .getElementById("td-add-cf-search")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        const val = (e.target as HTMLInputElement).value.trim()
        if (val) addFieldByName(val)
      }
      const dd = dropdownEl()
      if (e.key === "Escape" && dd?.style.display === "block") {
        e.preventDefault()
        dd.style.display = "none"
        document.getElementById("td-add-cf")?.focus()
      }
    }, opts)

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    if (
      !(e.target as Element)?.closest("#td-add-cf-dropdown") &&
      !(e.target as Element)?.closest("#td-add-cf")
    ) {
      const dd = document.getElementById("td-add-cf-dropdown")
      if (dd) dd.style.display = "none"
    }
    // Also close parent search results
    if (
      !(e.target as Element)?.closest("#td-link-parent-search") &&
      !(e.target as Element)?.closest("#td-link-parent-results")
    ) {
      const pr = document.getElementById("td-link-parent-results")
      if (pr) pr.style.display = "none"
    }
  }, opts)

  return {
    addCFRow,
    loadTaskCustomFields,
    setStructuredField,
    getStructuredField,
    getMergedJson,
    cancelPendingSave,
  }
}
