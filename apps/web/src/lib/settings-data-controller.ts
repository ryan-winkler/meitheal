/**
 * Data & export settings controller.
 *
 * Handles JSON export, SQLite download, settings import,
 * custom fields CRUD, and framework mapping.
 */
import { exportLocalDataAsJson } from "@domains/offline/export-service"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import { settingsStore } from "@lib/settings-store"
import { exportFilename } from "@lib/export-filename"
import { showToast } from "@lib/toast"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { normalizeCustomFieldDefs, type CustomFieldDef } from "@lib/custom-field-defs"
import { flushRulesSave, withConfigurationMutation, withRulesReplacement } from "@lib/settings-rules-controller"
import { log } from "@lib/settings-utils"

type CustomField = CustomFieldDef
let pendingCustomFields = Promise.resolve()

async function fetchBoardCustomFields(signal: AbortSignal): Promise<CustomField[]> {
  const ctx = currentTaskApiContext()
  const response = await fetch("/api/custom-fields", {
    cache: "no-store",
    signal,
    ...(ctx ? { headers: taskApiHeaders(ctx) } : {}),
  })
  if (!response.ok) throw new Error(`Custom fields could not load: ${response.status}`)
  const data = await response.json() as { fields?: unknown }
  return normalizeCustomFieldDefs(data.fields)
}

function updateCustomFields(update: (fields: CustomField[]) => CustomField[]): Promise<void> {
  const signal = pageLifecycle.signal
  const save = pendingCustomFields.then(async () => {
    const ctx = currentTaskApiContext()
    const current = await fetchBoardCustomFields(signal)
    signal.throwIfAborted()
    const fields = update(current)
    const headers = new Headers(ctx ? taskApiHeaders(ctx) : undefined)
    headers.set("content-type", "application/json")
    const response = await fetch("/api/custom-fields", {
      method: "PUT",
      signal,
      headers,
      body: JSON.stringify({ fields }),
    })
    if (!response.ok) throw new Error(`Custom fields could not save: ${response.status}`)
  })
  pendingCustomFields = save.catch(() => {})
  return save
}

function renderCustomFieldRows(fields: CustomField[]): void {
  const list = document.getElementById("custom-fields-list")
  if (!list) return
  list.querySelectorAll('[data-cf-saved-row="true"]').forEach(el => el.remove())
  for (const field of fields) {
    const row = document.createElement("div")
    row.className = "custom-field-row"
    row.dataset.cfSavedRow = "true"

    const nameInput = document.createElement("input")
    nameInput.type = "text"
    nameInput.className = "form-input"
    nameInput.setAttribute("aria-label", "Field name")
    nameInput.value = field.name
    nameInput.disabled = true

    const typeSelect = document.createElement("select")
    typeSelect.className = "form-select"
    typeSelect.setAttribute("aria-label", `${field.name} field type`)
    typeSelect.disabled = true
    const opt = document.createElement("option")
    opt.value = field.type
    opt.selected = true
    opt.textContent = field.type.charAt(0).toUpperCase() + field.type.slice(1)
    typeSelect.appendChild(opt)

    const savedSpan = document.createElement("span")
    savedSpan.style.color = "var(--text-muted)"
    savedSpan.style.fontSize = "12px"
    savedSpan.textContent = "Saved"

    const removeBtn = document.createElement("button")
    removeBtn.type = "button"
    removeBtn.className = "btn btn-ghost"
    removeBtn.style.padding = "4px 8px"
    removeBtn.style.color = "var(--danger)"
    removeBtn.title = "Remove field definition (data on existing tasks is preserved)"
    removeBtn.setAttribute("aria-label", `Remove ${field.name}`)
    removeBtn.textContent = "×"

    row.append(nameInput, typeSelect, savedSpan, removeBtn)
    pageLifecycle.on(removeBtn, "click", async () => {
      removeBtn.disabled = true
      try {
        await updateCustomFields((existing) => existing.filter((item) => item.name !== field.name))
        row.remove()
        showToast("settings.field_removed")
      } catch {
        showToast("common.failed_delete", "error")
        removeBtn.disabled = false
      }
    })
    list.appendChild(row)
  }
}

export function initDataSettings(): void {
  // JSON export
  const exportJsonBtn = document.getElementById("export-json-btn")
  if (exportJsonBtn) {
    pageLifecycle.on(exportJsonBtn, "click", async (e) => {
    e.preventDefault()
    try {
      await exportLocalDataAsJson()
      showToast("settings.export_success")
    } catch (err) {
      log.error("Failed to export JSON", err)
      showToast("settings.export_failed", "error")
    }
    })
  }

  const exportSettings = document.getElementById("export-settings-btn")
  if (exportSettings) pageLifecycle.on(exportSettings, "click", async event => {
    event.preventDefault()
    if (exportSettings.getAttribute("aria-busy") === "true") return
    exportSettings.setAttribute("aria-busy", "true")
    const signal = pageLifecycle.signal
    try {
      await flushRulesSave()
      await withConfigurationMutation(async () => {
        const response = await fetch("/api/export/settings.json", { signal, cache: "no-store" })
        const payload = await response.json()
        if (!response.ok || !payload || payload._version !== 2 || !Array.isArray(payload.rules) || !Array.isArray(payload.frameworkOverrides)) throw new Error("Settings export failed")
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }))
        const link = document.createElement("a")
        link.href = url
        link.download = exportFilename("Settings", "json")
        document.body.append(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
      })
      showToast("settings.export_success")
    } catch { showToast("settings.export_failed", "error") }
    finally { exportSettings.removeAttribute("aria-busy") }
  })

  // Raw DB download with confirmation dialog
  const exportDbBtn = document.getElementById("export-db-btn")
  const exportDbForm = document.querySelector<HTMLFormElement>("#export-db-form")
  if (exportDbBtn && exportDbForm) {
    pageLifecycle.on(exportDbBtn, "click", async () => {
      const signal = pageLifecycle.signal
      const confirmed = await confirmDialog({
        message: "This database file contains private household data and local feedback. Store it privately.",
        title: "Download Database",
        confirmText: "Download",
        variant: "warning",
        signal,
      })
      if (confirmed && !signal.aborted) exportDbForm.submit()
    })
  }

  // Import Config Binding
  const importInput = document.getElementById("import-settings-input") as HTMLInputElement
  if (importInput) {
    pageLifecycle.on(importInput, "change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      const signal = pageLifecycle.signal
      try {
        if (file.size > 204800) throw new Error("Settings import exceeds 200 KiB")
        const text = await file.text()
        const payload = JSON.parse(text)
        await withRulesReplacement(async () => {
        const response = await fetch(
          "/api/import/settings",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: pageLifecycle.signal,
          },
        )
        const result = await response.json()
        if (!response.ok || result.success !== true) {
          throw new Error(result.error || "Settings import failed")
        }
        showToast("settings.import_success")
        settingsStore.invalidate()
        // Full reload required — imported settings replace everything (theme, locale, integrations)
        setTimeout(() => {
          if (signal.aborted) return
          window.location.reload()
        }, 1500)
        })
      } catch (error) {
        log.error("Failed to import settings", error)
        showToast("settings.import_failed", "error")
      }
    })
  }

  // Restore custom fields via board-scoped API, falling back to loaded settings payload
  const cfList = document.getElementById("custom-fields-list")
  if (cfList) {
    void fetchBoardCustomFields(pageLifecycle.signal)
      .then((fields) => {
        if (!pageLifecycle.signal.aborted) renderCustomFieldRows(fields)
      })
      .catch(() => { /* fallback handled by restoreDataSettings */ })
  }

  // Add custom field
  const addFieldBtn = document.getElementById("add-custom-field")
  if (addFieldBtn) {
    pageLifecycle.on(addFieldBtn, "click", () => {
    const list = document.getElementById("custom-fields-list")
    if (!list) return
    const row = document.createElement("div")
    row.className = "custom-field-row"
    const nameInput = document.createElement("input")
    nameInput.type = "text"
    nameInput.className = "form-input"
    nameInput.setAttribute("aria-label", "Field name")
    nameInput.placeholder = "Field name"

    const typeSelect = document.createElement("select")
    typeSelect.className = "form-select cf-type-select"
    typeSelect.setAttribute("aria-label", "Field type")
    for (const [val, label] of [["text", "Text"], ["number", "Number"], ["url", "URL"], ["select", "Select"], ["date", "Date"], ["checkbox", "Checkbox"]]) {
      typeSelect.add(new Option(label, val))
    }

    const optionsInput = document.createElement("input")
    optionsInput.type = "text"
    optionsInput.className = "form-input cf-options-input"
    optionsInput.setAttribute("aria-label", "Field options")
    optionsInput.placeholder = "Options (comma-separated)"
    optionsInput.style.cssText = "display:none;flex:2;"

    const saveBtnEl = document.createElement("button")
    saveBtnEl.type = "button"
    saveBtnEl.className = "btn btn-primary custom-field-save"
    saveBtnEl.style.cssText = "padding:4px 12px;font-size:12px;"
    saveBtnEl.textContent = "Save"

    const discardBtn = document.createElement("button")
    discardBtn.type = "button"
    discardBtn.className = "btn btn-ghost"
    discardBtn.setAttribute("aria-label", "Discard new field")
    discardBtn.style.cssText = "padding:4px 8px;color:var(--danger);"
    discardBtn.textContent = "×"
    pageLifecycle.on(discardBtn, "click", () => row.remove())

    row.append(nameInput, typeSelect, optionsInput, saveBtnEl, discardBtn)
    list.appendChild(row)

    pageLifecycle.on(typeSelect, "change", () => {
      optionsInput.style.display = typeSelect.value === "select" ? "block" : "none"
    })

    nameInput.focus()

    const saveButton = row.querySelector<HTMLButtonElement>(".custom-field-save")
    if (!saveButton) return
    pageLifecycle.on(saveButton, "click", async () => {
      if (saveButton.disabled) return
      const nameInput = row.querySelector("input") as HTMLInputElement
      const typeSelect = row.querySelector(".cf-type-select") as HTMLSelectElement
      const optionsInput = row.querySelector(".cf-options-input") as HTMLInputElement
      const name = nameInput?.value?.trim()
      const type = typeSelect?.value || "text"
      if (!name) {
        nameInput?.focus()
        return
      }

      const fieldDef: { name: string; type: string; options?: string[] } = { name, type }
      if (type === "select" && optionsInput?.value?.trim()) {
        fieldDef.options = optionsInput.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i)
      }

      saveButton.disabled = true
      try {
        await updateCustomFields((fields) => [...fields, fieldDef])

        nameInput.disabled = true
        typeSelect.disabled = true
        if (optionsInput) optionsInput.disabled = true
        const saveBtn = row.querySelector(".custom-field-save") as HTMLButtonElement
        if (saveBtn) {
          saveBtn.textContent = "✓ Saved"
          saveBtn.disabled = true
          saveBtn.style.color = "var(--success)"
        }
        showToast("settings.custom_field_saved")
      } catch {
        saveButton.disabled = false
        showToast("settings.failed_save_field", "error")
      }
    })
    })
  }
}


/** Restore data/export-related settings from loaded settings object */
export function restoreDataSettings(settings: Record<string, unknown>): void {
  try {
    const list = document.getElementById("custom-fields-list")
    if (list && settings.custom_fields && list.querySelector('[data-cf-saved-row="true"]') === null) {
      const fields = normalizeCustomFieldDefs(settings.custom_fields)
      if (fields.length > 0) renderCustomFieldRows(fields)
    }
  } catch {
    /* skip */
  }
}
