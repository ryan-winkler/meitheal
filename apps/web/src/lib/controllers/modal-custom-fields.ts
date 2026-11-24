/**
 * modal-custom-fields.ts — Custom fields CRUD (RICE, Agile, Settings-defined fields)
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Manages custom field rows, categorised dropdown, field type rendering,
 *      and debounced save. Depends on saveTD + settingsFields from parent.
 */
import { byId, domEl, qs, setAttr } from "@lib/dom-helpers"

export interface CustomFieldsDeps {
  saveTD: (field: string, value: unknown) => Promise<unknown>
  getSettingsFields: () => Array<{ name: string; type: string; options?: string[] }>
  getCurrentTaskId?: () => string | null
  signal?: AbortSignal
}

const STRUCTURED_CF_KEYS = new Set(["items", "quantity", "category", "location", "fields"])
const RICE_CF_KEYS = new Set(["Reach", "Impact", "Confidence", "Effort"])
const isRetainedCustomFieldKey = (key: string) =>
  STRUCTURED_CF_KEYS.has(key) || key.startsWith("grocy_") || key.startsWith("external_")

/**
 * Initialise custom fields panel with CRUD and categorised dropdown.
 */
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

  function getCustomFieldsContainer(): HTMLElement | null {
    return byId("td-custom-fields")
  }

  function getCFFromUI(): Record<string, string> {
    const result: Record<string, string> = {}
    getCustomFieldsContainer()?.querySelectorAll<HTMLElement>(".td-cf-row").forEach((row) => {
      if (row.dataset.cfPristine === "1") return
      const key = (qs(row, ".td-cf-key") as HTMLInputElement)?.value.trim()
      if (!key) return
      const cbInput = qs(row, "input[type=checkbox].td-cf-val") as HTMLInputElement | null
      const otherInput = qs(row, "select.td-cf-val, input:not([type=checkbox]).td-cf-val") as HTMLInputElement | HTMLSelectElement | null
      result[key] = cbInput ? (cbInput.checked ? "true" : "false") : (otherInput?.value.trim() ?? "")
    })
    return result
  }

  const buildMergedPayload = () => ({ ...retainedStructuredFields, ...getCFFromUI() })
  const getMergedJson = () => JSON.stringify(buildMergedPayload())
  let _saveCFTimer: ReturnType<typeof setTimeout> | null = null
  let cfDirty = false

  function cancelPendingSave(): void {
    if (_saveCFTimer) {
      clearTimeout(_saveCFTimer)
      _saveCFTimer = null
    }
    cfDirty = false
  }

  signal?.addEventListener("abort", cancelPendingSave, { once: true })

  async function flushPendingCustomFieldsSave(): Promise<void> {
    if (_saveCFTimer) {
      clearTimeout(_saveCFTimer)
      _saveCFTimer = null
    }
    if (!cfDirty || signal?.aborted) return
    cfDirty = false
    await saveTD("custom_fields", getMergedJson())
  }

  function saveCF(immediate = false) {
    cfDirty = true
    if (immediate) {
      void flushPendingCustomFieldsSave()
      return
    }
    if (_saveCFTimer) clearTimeout(_saveCFTimer)
    const scheduledTaskId = getCurrentTaskId?.() ?? activeTaskId
    _saveCFTimer = setTimeout(() => {
      _saveCFTimer = null
      if (!signal?.aborted && (getCurrentTaskId?.() ?? activeTaskId) === scheduledTaskId) {
        void flushPendingCustomFieldsSave()
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
    getCustomFieldsContainer()?.replaceChildren()
    for (const [k, v] of Object.entries(parseRawCustomFields(rawCustomFields))) {
      if (v === null || v === undefined || RICE_CF_KEYS.has(k)) continue
      renderedKeys.add(k)
      if (typeof v === "object" || isRetainedCustomFieldKey(k)) {
        retainedStructuredFields[k] = v
      } else {
        const sfDef = settingsFields.find((sf) => sf.name.toLowerCase() === k.toLowerCase())
        addCFRow(k, String(v), sfDef?.type || "text", sfDef?.options)
        if (sfDef) renderedKeys.add(sfDef.name)
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
    const cfDiv = getCustomFieldsContainer() as HTMLElement
    const row = domEl("div")
    row.className = "td-cf-row"
    if (pristine) row.dataset.cfPristine = "1"
    row.style.cssText = "display:flex;gap:6px;align-items:center;"

    // Key label (always a readonly text input for consistency)
    let valueEl: HTMLElement
    let bindSave: () => void
    if (fieldType === "checkbox") {
      const isChecked =
        value === "true" || value === "1" || value === "yes"
      const label = domEl("label", "td-cf-val-wrap")
      label.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;"
      const cb = domEl("input")
      cb.type = "checkbox"
      cb.className = "form-checkbox td-cf-val h-5 w-5 accent-accent rounded"
      cb.style.cursor = "pointer"
      cb.checked = isChecked
      const span = domEl("span", "text-xs text-text-muted", isChecked ? "Yes" : "No")
      label.append(cb, span)
      valueEl = label
      bindSave = () => cb.addEventListener("change", () => {
        delete row.dataset.cfPristine
        span.textContent = cb.checked ? "Yes" : "No"
        saveCF()
      }, opts)
    } else if (fieldType === "select" && options && options.length > 0) {
      const select = domEl("select", "form-input td-cf-val text-sm py-1")
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
      const input = domEl("input")
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

    const keyInput = domEl("input")
    keyInput.type = "text"
    keyInput.className = "form-input td-cf-key text-sm py-1"
    keyInput.placeholder = "Field name"
    keyInput.value = key
    keyInput.style.cssText = "flex:1;opacity:0.7;"
    keyInput.readOnly = true

    const removeBtn = domEl("button")
    removeBtn.type = "button"
    removeBtn.className = "td-cf-remove"
    removeBtn.style.cssText = "color:var(--danger);font-size:16px;cursor:pointer;background:none;border:none;padding:0 4px;"
    removeBtn.textContent = "×"

    row.replaceChildren(keyInput, valueEl, removeBtn)
    bindSave()
    removeBtn.addEventListener("click", () => {
      row.remove()
      saveCF(true)
    }, opts)
    cfDiv.appendChild(row)
  }

  // Categorized field groups for the dropdown
  const fieldCategories: { label: string; fields: string[] }[] = [
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

  const dropdownEl = () => byId("td-add-cf-dropdown")
  const searchEl = () => byId<HTMLInputElement>("td-add-cf-search")
  const addFieldByName = (fieldName: string) => {
    if (isRetainedCustomFieldKey(fieldName) || Object.hasOwn(retainedStructuredFields, fieldName)) return
    const sfDef = getSettingsFields().find((sf) => sf.name.toLowerCase() === fieldName.toLowerCase())
    addCFRow(fieldName, sfDef?.type === "checkbox" ? "false" : "", sfDef?.type || "text", sfDef?.options)
    const dd = dropdownEl()
    if (dd) dd.style.display = "none"
    const s = searchEl()
    if (s) s.value = ""
  }

  const optionsEl = byId("td-add-cf-options")
  optionsEl?.addEventListener("click", (e) => {
    const opt = (e.target as Element)?.closest<HTMLElement>(".td-cf-option")
    if (opt?.dataset.field) addFieldByName(opt.dataset.field)
  }, opts)
  optionsEl?.addEventListener("keydown", (e) => {
    const opt = (e.target as Element)?.closest<HTMLButtonElement>(".td-cf-option")
    if (!opt) return
    const btns = Array.from(optionsEl.querySelectorAll<HTMLButtonElement>(".td-cf-option"))
    const idx = btns.indexOf(opt)
    if (e.key === "ArrowDown") {
      e.preventDefault()
      btns[(idx + 1) % btns.length]?.focus()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      btns[(idx - 1 + btns.length) % btns.length]?.focus()
    } else if (e.key === "Escape") {
      e.preventDefault()
      const dd = dropdownEl()
      if (dd) dd.style.display = "none"
      byId("td-add-cf")?.focus()
    }
  }, opts)

  function renderFieldDropdown(filter = "") {
    const optionsDiv = byId("td-add-cf-options")!
    setAttr(optionsDiv, "role", "listbox")
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
      const header = domEl("div", "px-3 py-1 text-[10px] text-text-muted uppercase tracking-wide font-semibold border-t border-border first:border-t-0", cat.label)
      nodes.push(header)
      for (const f of filtered) {
        const sfDef = settingsFields.find((sf) => sf.name.toLowerCase() === f.toLowerCase())
        const opt = domEl("button")
        opt.type = "button"
        opt.className = "td-cf-option w-full text-left px-3 py-1.5 text-sm cursor-pointer hover:bg-bg-hover border-0 bg-transparent"
        setAttr(opt, "role", "option")
        opt.dataset.field = f
        opt.textContent = `${f} (${typeBadge[sfDef?.type || "text"] || "Aa"})`
        nodes.push(opt)
      }
    }
    if (nodes.length === 0) {
      const empty = domEl("div", "px-3 py-1.5 text-xs text-text-muted italic", "Type a custom name and press Enter")
      optionsDiv.replaceChildren(empty)
    } else {
      optionsDiv.replaceChildren(...nodes)
    }
  }

  byId("td-add-cf")?.addEventListener("click", (e) => {
    e.stopPropagation()
    const dd = dropdownEl()!
    const isVisible = dd.style.display !== "none"
    dd.style.display = isVisible ? "none" : "block"
    if (!isVisible) {
      renderFieldDropdown()
      searchEl()?.focus()
    }
  }, opts)

  byId("td-add-cf-search")
    ?.addEventListener("input", (e) => {
      renderFieldDropdown((e.target as HTMLInputElement).value)
    }, opts)

  byId("td-add-cf-search")
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
        byId("td-add-cf")?.focus()
      }
    }, opts)

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    if (
      !(e.target as Element)?.closest("#td-add-cf-dropdown") &&
      !(e.target as Element)?.closest("#td-add-cf")
    ) {
      const dd = byId("td-add-cf-dropdown")
      if (dd) dd.style.display = "none"
    }
    // Also close parent search results
    if (
      !(e.target as Element)?.closest("#td-link-parent-search") &&
      !(e.target as Element)?.closest("#td-link-parent-results")
    ) {
      const pr = byId("td-link-parent-results")
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
    flushPendingCustomFieldsSave,
  }
}
