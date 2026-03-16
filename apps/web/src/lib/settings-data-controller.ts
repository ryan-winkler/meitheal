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
import { showToast } from "@lib/toast"
import { saveSetting, log } from "@lib/settings-utils"

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

  // Raw DB download with confirmation dialog
  const exportDbBtn = document.getElementById("export-db-btn")
  if (exportDbBtn) {
    pageLifecycle.on(exportDbBtn, "click", async () => {
    const confirmed = await confirmDialog({
      message: "This will download the entire raw SQLite database file. Continue?",
      title: "Download Database",
      confirmText: "Download",
      variant: "warning",
    })
    if (!confirmed) return
    const a = document.createElement("a")
    a.href = "/api/export/database.sqlite"
    a.download = ""
    document.body.appendChild(a)
    a.click()
    a.remove()
    })
  }

  // Import Config Binding
  const importInput = document.getElementById("import-settings-input") as HTMLInputElement
  if (importInput) {
    pageLifecycle.on(importInput, "change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      try {
        const text = await file.text()
        const payload = JSON.parse(text)
        const response = await fetch(
          (window.__ingress_path || "") + "/api/import/settings",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        )
        if (!response.ok) {
          throw new Error(await response.text())
        }
        showToast("settings.import_success")
        settingsStore.invalidate()
        // Full reload required — imported settings replace everything (theme, locale, integrations)
        setTimeout(() => {
          if (pageLifecycle.signal.aborted) return
          window.location.reload()
        }, 1500)
      } catch (error) {
        log.error("Failed to import settings", error)
        showToast("settings.import_failed", "error")
      }
    })
  }

  // Add custom field
  const addFieldBtn = document.getElementById("add-custom-field")
  if (addFieldBtn) {
    pageLifecycle.on(addFieldBtn, "click", () => {
    const list = document.getElementById("custom-fields-list")
    if (!list) return
    const row = document.createElement("div")
    row.className = "custom-field-row"
    row.innerHTML = `
      <input type="text" class="form-input" placeholder="Field name" />
      <select class="form-select cf-type-select">
        <option value="text">Text</option>
        <option value="number">Number</option>
        <option value="url">URL</option>
        <option value="select">Select</option>
        <option value="date">Date</option>
        <option value="checkbox">Checkbox</option>
      </select>
      <input type="text" class="form-input cf-options-input" placeholder="Options (comma-separated)" style="display:none; flex:2;" />
      <button type="button" class="btn btn-primary custom-field-save" style="padding: 4px 12px; font-size: 12px;">Save</button>
      <button type="button" class="btn btn-ghost" style="padding: 4px 8px; color: var(--danger);" onclick="this.closest('.custom-field-row')?.remove()">×</button>
    `
    list.appendChild(row)

    const typeSelect = row.querySelector(".cf-type-select") as HTMLSelectElement
    const optionsInput = row.querySelector(".cf-options-input") as HTMLInputElement
    typeSelect?.addEventListener("change", () => {
      optionsInput.style.display = typeSelect.value === "select" ? "block" : "none"
    })

    row.querySelector("input")?.focus()

    row.querySelector(".custom-field-save")?.addEventListener("click", async function () {
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

      try {
        const settingsRes = await fetch((window.__ingress_path || "") + "/api/settings", { signal: pageLifecycle.signal })
        const settings = settingsRes.ok ? await settingsRes.json() : {}
        const existing = settings.custom_fields ? JSON.parse(settings.custom_fields) : []
        existing.push(fieldDef)

        await fetch((window.__ingress_path || "") + "/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "custom_fields", value: JSON.stringify(existing) }),
          signal: pageLifecycle.signal,
        })

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
        showToast("settings.failed_save_field", "error")
      }
    })
    })
  }

  // Framework mapping change
  document.querySelectorAll(".framework-mapping-select").forEach((sel) => {
    pageLifecycle.on(sel, "change", () => {
      const mapping: Record<string, string[]> = {}
      document.querySelectorAll(".framework-mapping-select").forEach((s) => {
        const select = s as HTMLSelectElement
        const taskType = select.dataset.taskType
        if (taskType) {
          mapping[taskType] = Array.from(select.selectedOptions).map((o) => o.value)
        }
      })
      saveSetting("framework_mapping", mapping)
      showToast("settings.frameworks_updated")
    })
  })
}

/** Restore data/export-related settings from loaded settings object */
export function restoreDataSettings(settings: Record<string, unknown>): void {
  // Framework mapping
  try {
    if (settings.framework_mapping) {
      const mapping = settings.framework_mapping as Record<string, string[]>
      document.querySelectorAll(".framework-mapping-select").forEach((sel) => {
        const select = sel as HTMLSelectElement
        const taskType = select.dataset.taskType
        if (taskType && mapping[taskType] && Array.isArray(mapping[taskType])) {
          const selectedVals = mapping[taskType]
          Array.from(select.options).forEach((opt) => {
            opt.selected = selectedVals.includes(opt.value)
          })
        }
      })
    }
  } catch (e) {
    log.error("Framework mapping error", e)
  }

  // Restore custom fields
  try {
    if (settings.custom_fields) {
      const fields = JSON.parse(settings.custom_fields as string) as { name: string; type: string }[]
      const list = document.getElementById("custom-fields-list")
      if (list && fields.length > 0) {
        for (const field of fields) {
          const row = document.createElement("div")
          row.className = "custom-field-row"
          row.innerHTML = `
            <input type="text" class="form-input" value="${escapeHtml(field.name)}" disabled />
            <select class="form-select" disabled>
              <option value="${escapeHtml(field.type)}" selected>${escapeHtml(field.type.charAt(0).toUpperCase() + field.type.slice(1))}</option>
            </select>
            <span style="color: var(--text-muted); font-size: 12px;">Saved</span>
            <button type="button" class="btn btn-ghost" style="padding: 4px 8px; color: var(--danger);" title="Remove field definition (data on existing tasks is preserved)">×</button>
          `
          row.querySelector("button")?.addEventListener("click", async () => {
            try {
              const curRes = await fetch((window.__ingress_path || "") + "/api/settings", { signal: pageLifecycle.signal })
              const curSettings = curRes.ok ? await curRes.json() : {}
              const curFields = curSettings.custom_fields ? JSON.parse(curSettings.custom_fields) : []
              const updated = curFields.filter((f: { name: string }) => f.name !== field.name)
              await fetch((window.__ingress_path || "") + "/api/settings", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ key: "custom_fields", value: JSON.stringify(updated) }),
                signal: pageLifecycle.signal,
              })
              row.remove()
              showToast("settings.field_removed")
            } catch {
              showToast("common.failed_delete", "error")
            }
          })
          list.appendChild(row)
        }
      }
    }
  } catch {
    /* skip */
  }
}
