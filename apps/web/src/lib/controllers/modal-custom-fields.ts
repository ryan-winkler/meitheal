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
    if (fieldType === "checkbox") {
      const isChecked =
        value === "true" || value === "1" || value === "yes"
      valueHtml = `<label class="td-cf-val-wrap" style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" class="form-checkbox td-cf-val h-5 w-5 accent-accent rounded" style="cursor:pointer;" ${isChecked ? "checked" : ""} />
              <span class="text-xs text-text-muted">${isChecked ? "Yes" : "No"}</span>
            </label>`
    } else if (fieldType === "select" && options && options.length > 0) {
      valueHtml = `<select class="form-input td-cf-val text-sm py-1" style="flex:1;">
              <option value=""${!value ? " selected" : ""}>Select…</option>
              ${options.map((o) => `<option value="${o.replace(/"/g, "&quot;")}"${o === value ? " selected" : ""}>${o}</option>`).join("")}
            </select>`
    } else if (fieldType === "number") {
      valueHtml = `<input type="number" class="form-input td-cf-val text-sm py-1" placeholder="Value" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`
    } else if (fieldType === "date") {
      valueHtml = `<input type="date" class="form-input td-cf-val text-sm py-1" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`
    } else if (fieldType === "url") {
      valueHtml = `<input type="url" class="form-input td-cf-val text-sm py-1" placeholder="https://…" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`
    } else {
      valueHtml = `<input type="text" class="form-input td-cf-val text-sm py-1" placeholder="Value" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`
    }

    row.innerHTML = `
          <input type="text" class="form-input td-cf-key text-sm py-1" placeholder="Field name" value="${key.replace(/"/g, "&quot;")}" style="flex:1;opacity:0.7;" readonly />
          ${valueHtml}
          <button type="button" class="td-cf-remove" style="color:var(--danger);font-size:16px;cursor:pointer;background:none;border:none;padding:0 4px;">&times;</button>
        `

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
    let html = ""
    let totalCount = 0
    for (const cat of categories) {
      const filtered = cat.fields.filter((f) =>
        f.toLowerCase().includes(lowerFilter),
      )
      if (filtered.length === 0) continue
      totalCount += filtered.length
      html += `<div class="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wide font-semibold border-t border-border first:border-t-0">${cat.label}</div>`
      html += filtered
        .map((f) => {
          const sfDef = _settingsFields.find((sf) => sf.name === f)
          const typeBadge: Record<string, string> = {
            text: "📝",
            checkbox: "☑️",
            select: "📊",
            date: "📅",
            number: "🔢",
            url: "🔗",
          }
          const badge = typeBadge[sfDef?.type || "text"] || "📝"
          return `<div class="td-cf-option px-3 py-1.5 text-sm cursor-pointer hover:bg-bg-hover" data-field="${f.replace(/"/g, "&quot;")}">${badge} ${f}</div>`
        })
        .join("")
    }
    optionsDiv.innerHTML =
      totalCount > 0
        ? html
        : `<div class="px-3 py-1.5 text-xs text-text-muted italic">Type a custom name and press Enter</div>`
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
