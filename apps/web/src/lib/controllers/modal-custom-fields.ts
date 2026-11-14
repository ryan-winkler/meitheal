/**
 * modal-custom-fields.ts — Custom fields CRUD (RICE, Agile, Settings-defined fields)
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Manages custom field rows, categorised dropdown, field type rendering,
 *      and debounced save. Depends on saveTD + settingsFields from parent.
 */
import { escapeHtml } from "@lib/safe-html"

export interface CustomFieldsDeps {
  saveTD: (field: string, value: unknown) => Promise<void>
  getSettingsFields: () => Array<{ name: string; type: string; options?: string[] }>
  signal?: AbortSignal
}

/**
 * Initialise custom fields panel with CRUD and categorised dropdown.
 */
export function initCustomFields({ saveTD, getSettingsFields, signal }: CustomFieldsDeps): {
  addCFRow: (key: string, value: string, fieldType?: string, options?: string[]) => void
} {
  const opts = signal ? { signal } : undefined
  
  function getCFFromUI(): Record<string, string> {
    const result: Record<string, string> = {}
    document.querySelectorAll(".td-cf-row").forEach((row) => {
      const key = (
        row.querySelector(".td-cf-key") as HTMLInputElement
      )?.value.trim()
      // Handle checkbox vs other input types
      const cbInput = row.querySelector(
        "input[type=checkbox].td-cf-val",
      ) as HTMLInputElement | null
      const otherInput = row.querySelector(
        "select.td-cf-val, input:not([type=checkbox]).td-cf-val",
      ) as HTMLInputElement | HTMLSelectElement | null
      let val = ""
      if (cbInput) {
        val = cbInput.checked ? "true" : "false"
      } else if (otherInput) {
        val = otherInput.value.trim()
      }
      if (key) result[key] = val
    })
    return result
  }

  let _saveCFTimer: ReturnType<typeof setTimeout> | null = null

  function saveCF() {
    // Debounce the actual API save
    if (_saveCFTimer) clearTimeout(_saveCFTimer)
    _saveCFTimer = setTimeout(() => {
      const all = getCFFromUI()
      saveTD("custom_fields", JSON.stringify(all))
    }, 400)
  }

  function addCFRow(
    key: string,
    value: string,
    fieldType: string = "text",
    options?: string[],
  ) {
    const cfDiv = document.getElementById(
      "td-custom-fields",
    ) as HTMLElement
    const row = document.createElement("div")
    row.className = "td-cf-row"
    row.style.cssText = "display:flex;gap:6px;align-items:center;"

    // Key label (always a readonly text input for consistency)
    let valueHtml = ""
    let valueEl: HTMLElement
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
    } else if (fieldType === "select" && options && options.length > 0) {
      const select = document.createElement("select")
      select.className = "form-input td-cf-val text-sm py-1"
      select.style.flex = "1"
      const emptyOpt = document.createElement("option")
      emptyOpt.value = ""
      emptyOpt.textContent = "Select…"
      emptyOpt.selected = !value
      select.appendChild(emptyOpt)
      for (const o of options) {
        const opt = document.createElement("option")
        opt.value = o
        opt.textContent = o
        opt.selected = o === value
        select.appendChild(opt)
      }
      valueEl = select
    } else {
      const input = document.createElement("input")
      input.type = fieldType === "number" || fieldType === "date" || fieldType === "url" ? fieldType : "text"
      input.className = "form-input td-cf-val text-sm py-1"
      input.style.flex = "1"
      if (fieldType === "url") input.placeholder = "https://…"
      else if (fieldType !== "date") input.placeholder = "Value"
      input.value = value
      valueEl = input
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

    // Bind save handlers based on field type
    if (fieldType === "checkbox") {
      const cb = row.querySelector(
        "input[type=checkbox]",
      ) as HTMLInputElement
      const cbLabel = row.querySelector(
        ".td-cf-val-wrap span",
      ) as HTMLElement
      cb?.addEventListener("change", () => {
        if (cbLabel) cbLabel.textContent = cb.checked ? "Yes" : "No"
        saveCF()
      }, opts)
    } else {
      const valInput = row.querySelector(".td-cf-val")!
      valInput.addEventListener("blur", saveCF, opts)
      valInput.addEventListener("input", saveCF, opts)
    }

    row.querySelector(".td-cf-remove")!.addEventListener("click", () => {
      row.remove()
      saveCF()
    }, opts)
    cfDiv.appendChild(row)
  }

  // Categorized field groups for the dropdown
  const fieldCategories: { label: string; fields: string[] }[] = [
    {
      label: "🎯 RICE Framework",
      fields: ["Reach", "Impact", "Confidence", "Effort"],
    },
    {
      label: "📋 Agile & Planning",
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
      label: "📊 Sizing & Value",
      fields: ["Complexity", "T-Shirt Size", "Business Value"],
    },
  ]

  function getAvailableFields(): { label: string; fields: string[] }[] {
    const currentKeys = new Set(Object.keys(getCFFromUI()))
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
          label: "📋 Settings Fields",
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
        label: "🔧 Custom",
        fields: [...new Set(existingCustom)].sort(),
      })
    }
    return result
  }

  function renderFieldDropdown(filter = "") {
    const optionsDiv = document.getElementById("td-add-cf-options")!
    const lowerFilter = filter.toLowerCase()
    const categories = getAvailableFields()
    const _settingsFields = getSettingsFields()
    const nodes: HTMLElement[] = []
    let totalCount = 0
    const typeBadge: Record<string, string> = {
      text: "📝",
      checkbox: "☑️",
      select: "📊",
      date: "📅",
      number: "🔢",
      url: "🔗",
    }
    for (const cat of categories) {
      const filtered = cat.fields.filter((f) =>
        f.toLowerCase().includes(lowerFilter),
      )
      if (filtered.length === 0) continue
      totalCount += filtered.length
      const header = document.createElement("div")
      header.className = "px-3 py-1 text-[10px] text-text-muted uppercase tracking-wide font-semibold border-t border-border first:border-t-0"
      header.textContent = cat.label
      nodes.push(header)
      for (const f of filtered) {
        const sfDef = _settingsFields.find((sf) => sf.name === f)
        const badge = typeBadge[sfDef?.type || "text"] || "📝"
        const opt = document.createElement("div")
        opt.className = "td-cf-option px-3 py-1.5 text-sm cursor-pointer hover:bg-bg-hover"
        opt.dataset.field = f
        opt.textContent = `${badge} ${f}`
        nodes.push(opt)
      }
    }
    if (totalCount === 0) {
      const empty = document.createElement("div")
      empty.className = "px-3 py-1.5 text-xs text-text-muted italic"
      empty.textContent = "Type a custom name and press Enter"
      optionsDiv.replaceChildren(empty)
    } else {
      optionsDiv.replaceChildren(...nodes)
    }
    // Click handlers
    optionsDiv.querySelectorAll(".td-cf-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const fieldName = (opt as HTMLElement).dataset.field || ""
        const _settingsFields = getSettingsFields()
        const sfDef = _settingsFields.find(
          (sf: { name: string }) => sf.name === fieldName,
        )
        addCFRow(
          fieldName,
          sfDef?.type === "checkbox" ? "false" : "",
          sfDef?.type || "text",
          sfDef?.options,
        )
        document.getElementById("td-add-cf-dropdown")!.style.display =
          "none"
        ;(
          document.getElementById("td-add-cf-search") as HTMLInputElement
        ).value = ""
      }, opts)
    })
  }

  document.getElementById("td-add-cf")?.addEventListener("click", (e) => {
    e.stopPropagation()
    const dropdown = document.getElementById("td-add-cf-dropdown")!
    const isVisible = dropdown.style.display !== "none"
    dropdown.style.display = isVisible ? "none" : "block"
    if (!isVisible) {
      renderFieldDropdown()
      ;(
        document.getElementById("td-add-cf-search") as HTMLInputElement
      ).focus()
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
        const input = e.target as HTMLInputElement
        const val = input.value.trim()
        if (val) {
          const _settingsFields = getSettingsFields()
          const sfDef = _settingsFields.find(
            (sf: { name: string }) => sf.name === val,
          )
          addCFRow(
            val,
            sfDef?.type === "checkbox" ? "false" : "",
            sfDef?.type || "text",
            sfDef?.options,
          )
          document.getElementById("td-add-cf-dropdown")!.style.display =
            "none"
          input.value = ""
        }
      }
      if (e.key === "Escape") {
        document.getElementById("td-add-cf-dropdown")!.style.display =
          "none"
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

  return { addCFRow }
}
