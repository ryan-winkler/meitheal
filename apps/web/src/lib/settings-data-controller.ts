/**
 * Data & export settings controller.
 *
 * Handles JSON export, SQLite download, settings import,
 * custom fields CRUD, and framework mapping.
 */
import { exportLocalDataAsJson } from "@domains/offline/export-service"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { settingsStore } from "@lib/settings-store"
import { exportFilename } from "@lib/export-filename"
import { showToast } from "@lib/toast"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import {
  CUSTOM_FIELD_TYPE_LABELS,
  VALID_CUSTOM_FIELD_TYPES,
  fetchBoardCustomFieldDefs,
  normalizeCustomFieldDefs,
  updateBoardCustomFieldDefs,
  type CustomFieldDef,
  type CustomFieldType,
} from "@lib/custom-field-defs"
import { flushRulesSave, withConfigurationMutation, withRulesReplacement } from "@lib/settings-rules-controller"
import { downloadBlob, log } from "@lib/settings-utils"
import { byId, domEl, qs, setAttr } from "@lib/dom-helpers"

type CustomField = CustomFieldDef

async function fetchBoardCustomFields(signal: AbortSignal): Promise<CustomField[]> {
  const ctx = currentTaskApiContext()
  return fetchBoardCustomFieldDefs({
    signal,
    ...(ctx ? { headers: taskApiHeaders(ctx) } : {}),
  })
}

function updateCustomFields(update: (fields: CustomField[]) => CustomField[]): Promise<void> {
  const signal = pageLifecycle.signal
  const ctx = currentTaskApiContext()
  return updateBoardCustomFieldDefs(update, {
    signal,
    ...(ctx ? { headers: taskApiHeaders(ctx) } : {}),
  }).then(() => undefined)
}

function renderCustomFieldRows(fields: CustomField[]): void {
  const list = byId("custom-fields-list")
  if (!list) return
  list.querySelectorAll('[data-cf-saved-row="true"]').forEach(el => el.remove())
  for (const field of fields) {
    const row = domEl("div")
    row.className = "custom-field-row"
    row.dataset.cfSavedRow = "true"

    const nameInput = domEl("input")
    nameInput.type = "text"
    nameInput.className = "form-input"
    setAttr(nameInput, "aria-label", "Field name")
    nameInput.value = field.name
    nameInput.disabled = true

    const typeSelect = domEl("select", "form-select")
    setAttr(typeSelect, "aria-label", `${field.name} field type`)
    typeSelect.disabled = true
    const opt = domEl("option")
    opt.value = field.type
    opt.selected = true
    opt.textContent = field.type.charAt(0).toUpperCase() + field.type.slice(1)
    typeSelect.appendChild(opt)

    const savedSpan = domEl("span")
    savedSpan.style.color = "var(--text-muted)"
    savedSpan.style.fontSize = "12px"
    savedSpan.textContent = "Saved"

    const removeBtn = domEl("button")
    removeBtn.type = "button"
    removeBtn.className = "btn btn-ghost"
    removeBtn.style.padding = "4px 8px"
    removeBtn.style.color = "var(--danger)"
    removeBtn.title = "Remove field definition (data on existing tasks is preserved)"
    setAttr(removeBtn, "aria-label", `Remove ${field.name}`)
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
  const exportJsonBtn = byId("export-json-btn")
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

  const exportSettings = byId("export-settings-btn")
  if (exportSettings) pageLifecycle.on(exportSettings, "click", async event => {
    event.preventDefault()
    if (exportSettings.getAttribute("aria-busy") === "true") return
    setAttr(exportSettings, "aria-busy", "true")
    const signal = pageLifecycle.signal
    try {
      await flushRulesSave()
      await withConfigurationMutation(async () => {
        const response = await fetch("/api/export/settings.json", { signal, cache: "no-store" })
        const payload = await response.json()
        if (!response.ok || !payload || payload._version !== 2 || !Array.isArray(payload.rules) || !Array.isArray(payload.frameworkOverrides)) throw new Error("Settings export failed")
        downloadBlob(JSON.stringify(payload, null, 2), "application/json", exportFilename("Settings", "json"), true)
      })
      showToast("settings.export_success")
    } catch { showToast("settings.export_failed", "error") }
    finally { exportSettings.removeAttribute("aria-busy") }
  })

  // Raw DB download with confirmation dialog
  const exportDbBtn = byId("export-db-btn")
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
  const importInput = byId("import-settings-input") as HTMLInputElement
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
  const cfList = byId("custom-fields-list")
  if (cfList) {
    void fetchBoardCustomFields(pageLifecycle.signal)
      .then((fields) => {
        if (!pageLifecycle.signal.aborted) renderCustomFieldRows(fields)
      })
      .catch(() => { /* fallback handled by restoreDataSettings */ })
  }

  // Add custom field
  const addFieldBtn = byId("add-custom-field")
  if (addFieldBtn) {
    pageLifecycle.on(addFieldBtn, "click", () => {
    const list = byId("custom-fields-list")
    if (!list) return
    const row = domEl("div")
    row.className = "custom-field-row"
    const nameInput = domEl("input")
    nameInput.type = "text"
    nameInput.className = "form-input"
    setAttr(nameInput, "aria-label", "Field name")
    nameInput.placeholder = "Field name"

    const typeSelect = domEl("select", "form-select cf-type-select")
    setAttr(typeSelect, "aria-label", "Field type")
    for (const val of VALID_CUSTOM_FIELD_TYPES) {
      typeSelect.add(new Option(CUSTOM_FIELD_TYPE_LABELS[val as CustomFieldType] ?? val, val))
    }

    const optionsInput = domEl("input")
    optionsInput.type = "text"
    optionsInput.className = "form-input cf-options-input"
    setAttr(optionsInput, "aria-label", "Field options")
    optionsInput.placeholder = "Options (comma-separated)"
    optionsInput.style.cssText = "display:none;flex:2;"

    const saveBtnEl = domEl("button")
    saveBtnEl.type = "button"
    saveBtnEl.className = "btn btn-primary custom-field-save"
    saveBtnEl.style.cssText = "padding:4px 12px;font-size:12px;"
    saveBtnEl.textContent = "Save"

    const discardBtn = domEl("button")
    discardBtn.type = "button"
    discardBtn.className = "btn btn-ghost"
    setAttr(discardBtn, "aria-label", "Discard new field")
    discardBtn.style.cssText = "padding:4px 8px;color:var(--danger);"
    discardBtn.textContent = "×"
    pageLifecycle.on(discardBtn, "click", () => row.remove())

    row.append(nameInput, typeSelect, optionsInput, saveBtnEl, discardBtn)
    list.appendChild(row)

    pageLifecycle.on(typeSelect, "change", () => {
      optionsInput.style.display = typeSelect.value === "select" ? "block" : "none"
    })

    nameInput.focus()

    const saveButton = qs<HTMLButtonElement>(row, ".custom-field-save")
    if (!saveButton) return
    pageLifecycle.on(saveButton, "click", async () => {
      if (saveButton.disabled) return
      const nameInput = row.querySelector("input") as HTMLInputElement
      const typeSelect = qs(row, ".cf-type-select") as HTMLSelectElement
      const optionsInput = qs(row, ".cf-options-input") as HTMLInputElement
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
        const saveBtn = qs(row, ".custom-field-save") as HTMLButtonElement
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
    const list = byId("custom-fields-list")
    if (list && settings.custom_fields && qs(list, '[data-cf-saved-row="true"]') === null) {
      const fields = normalizeCustomFieldDefs(settings.custom_fields)
      if (fields.length > 0) renderCustomFieldRows(fields)
    }
  } catch {
    /* skip */
  }
}
