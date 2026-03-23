/**
 * Calendar & Todo sync integration settings controller.
 *
 * Handles: Calendar entity hydration, toggle cards, save, sync,
 * CalDAV test, manual entity add, Todo hydration, save, sync.
 * All HA-ingress-aware via window.__ingress_path.
 */
import { withAsyncButton } from "@lib/async-button"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import { showToast } from "@lib/toast"
import { saveSetting, log } from "@lib/settings-utils"

export function initCalendarTodoSettings(): void {
  // Calendar hydration runs on init
  hydrateCalendarStatus()
  // Todo hydration runs on init
  hydrateTodoStatus()

  // ───── Calendar manual add ─────
  const calManualBtn = document.getElementById("cal-add-manual")
  if (calManualBtn) {
    pageLifecycle.on(calManualBtn, "click", () => {
    const input = document.getElementById("cal-entity-manual") as HTMLInputElement | null
    const container = document.getElementById("cal-entities-container")
    const entitiesList = document.getElementById("cal-entities-list")
    if (!input || !container) return
    const entityId = input.value.trim()
    if (!entityId || !entityId.startsWith("calendar.")) {
      input.style.borderColor = "var(--red-500, #ef4444)"
      setTimeout(() => { input.style.borderColor = "" }, 1500)
      return
    }
    if (container.querySelector(`[data-entity="${CSS.escape(entityId)}"]`)) { input.value = ""; return }
    if (entitiesList) entitiesList.style.display = "block"
    const card = document.createElement("div")
    card.className = "cal-toggle-card cal-toggle-card--active"
    card.dataset.entity = entityId
    card.style.cursor = "pointer"
    card.innerHTML = `<div class="cal-toggle-card__info"><span class="cal-toggle-card__name"></span><span class="cal-toggle-card__entity"></span><div class="cal-toggle-card__direction"><select class="cal-direction-select"><option value="bidirectional" selected>↔ Bidirectional</option><option value="import">↓ Import only</option><option value="export">↑ Export only</option></select></div><span class="cal-toggle-card__state">manually added</span></div><label class="toggle-label"><input type="checkbox" class="cal-entity-toggle" checked /><span class="toggle-slider"></span></label>`
    const cardName = card.querySelector<HTMLElement>(".cal-toggle-card__name")
    if (cardName) cardName.textContent = entityId
    const cardEntity = card.querySelector<HTMLElement>(".cal-toggle-card__entity")
    if (cardEntity) cardEntity.textContent = entityId
    const dirSelect = card.querySelector<HTMLSelectElement>(".cal-direction-select")
    if (dirSelect) { dirSelect.dataset.entityDir = entityId; dirSelect.setAttribute("aria-label", `Sync direction for ${entityId}`) }
    const entityToggle = card.querySelector<HTMLInputElement>(".cal-entity-toggle")
    if (entityToggle) entityToggle.value = entityId
    card.querySelector<HTMLInputElement>(".cal-entity-toggle")?.addEventListener("change", function () {
      card.classList.toggle("cal-toggle-card--active", this.checked)
      updateCalCountBadge()
    })
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".toggle-label")) return
      const cb = card.querySelector<HTMLInputElement>(".cal-entity-toggle")
      if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })) }
    })
    container.appendChild(card)
    const emptyState = document.getElementById("cal-no-entities")
    if (emptyState) emptyState.style.display = "none"
    updateCalCountBadge()
    input.value = ""
    })
  }

  // ───── CalDAV Test ─────
  const caldavTestBtn = document.getElementById("caldav-test-btn") as HTMLButtonElement
  if (caldavTestBtn) {
    pageLifecycle.on(caldavTestBtn, "click", withAsyncButton(caldavTestBtn, async () => {
    const url = (document.getElementById("caldav-url") as HTMLInputElement).value
    const username = (document.getElementById("caldav-username") as HTMLInputElement).value
    const password = (document.getElementById("caldav-password") as HTMLInputElement).value
    const resultEl = document.getElementById("caldav-test-result")
    if (!url || !username || !password) {
      if (resultEl) { resultEl.textContent = "URL, username, and password required"; resultEl.style.color = "var(--color-error)" }
      return
    }
    if (resultEl) { resultEl.textContent = ""; resultEl.style.color = "" }
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/calendar/caldav-credentials", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test", url, username, password }),
        signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (resultEl) {
        resultEl.textContent = data.ok ? data.message : `❌ ${data.message || data.error}`
        resultEl.style.color = data.ok ? "var(--color-success)" : "var(--color-error)"
      }
    } catch {
      if (resultEl) { resultEl.textContent = "❌ Request failed"; resultEl.style.color = "var(--color-error)" }
    }
    }, { loadingText: "Testing…" }))
  }

  const saveCalBtn = document.getElementById("save-cal") as HTMLButtonElement
  if (saveCalBtn) {
    pageLifecycle.on(saveCalBtn, "click", withAsyncButton(saveCalBtn, async () => {
    const enabledEntities: string[] = []
    document.querySelectorAll<HTMLInputElement>(".cal-entity-toggle:checked").forEach((cb) => enabledEntities.push(cb.value))
    const syncModes: Record<string, string> = {}
    document.querySelectorAll<HTMLSelectElement>(".cal-direction-select").forEach((sel) => {
      const entityId = sel.dataset.entityDir
      if (entityId && enabledEntities.includes(entityId)) syncModes[entityId] = sel.value
    })
    const globalMode = (document.getElementById("cal-sync-direction") as HTMLSelectElement)?.value ?? "bidirectional"
    const caldavUrl = (document.getElementById("caldav-url") as HTMLInputElement).value
    const caldavUsername = (document.getElementById("caldav-username") as HTMLInputElement).value
    const caldavPassword = (document.getElementById("caldav-password") as HTMLInputElement).value
    const writeBack = (document.getElementById("cal-write-back") as HTMLInputElement)?.checked ?? false
    const intervalMs = Number((document.getElementById("cal-sync-interval") as HTMLSelectElement)?.value ?? "300000")
    await saveSetting("calendar_entities", enabledEntities)
    await saveSetting("calendar_entity", enabledEntities[0] ?? "")
    await saveSetting("calendar_sync_enabled", enabledEntities.length > 0 ? "true" : "false")
    await saveSetting("calendar_write_back", writeBack)
    await saveSetting("calendar_sync_interval_ms", String(intervalMs))
    await saveSetting("calendar_sync_mode", globalMode)
    await saveSetting("calendar_sync_modes", syncModes)
    if (caldavUrl && caldavUsername && caldavPassword) {
      try { await fetch((window.__ingress_path || "") + "/api/integrations/calendar/caldav-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save", url: caldavUrl, username: caldavUsername, password: caldavPassword }), signal: pageLifecycle.signal }) }
      catch (err) { log.error("Failed to save CalDAV credentials", err) }
    } else if (caldavUrl && !caldavUsername && !caldavPassword) {
      await saveSetting("caldav_url", caldavUrl)
    }
    if (enabledEntities.length > 0) {
      try { await fetch((window.__ingress_path || "") + "/api/integrations/calendar/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "enable", entity_id: enabledEntities[0], entities: enabledEntities, write_back: writeBack, interval_ms: intervalMs, sync_mode: globalMode, sync_modes: syncModes }), signal: pageLifecycle.signal }) }
      catch { /* logged server-side */ }
    } else {
      try { await fetch((window.__ingress_path || "") + "/api/integrations/calendar/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disable" }), signal: pageLifecycle.signal }) }
      catch { /* logged server-side */ }
    }
    const statusEl = document.getElementById("cal-status")
    if (statusEl) {
      statusEl.textContent = enabledEntities.length > 0 ? `${enabledEntities.length} syncing` : "Disabled"
      statusEl.className = enabledEntities.length > 0 ? "badge badge-active" : "badge badge-pending"
    }
    showToast("settings.calendar_saved")
    updateCalCountBadge()
    }, { loadingText: "Saving…" }))
  }

  // ───── Calendar Sync Now ─────
  const testCalBtn = document.getElementById("test-cal") as HTMLButtonElement
  if (testCalBtn) {
    pageLifecycle.on(testCalBtn, "click", withAsyncButton(testCalBtn, async () => {
    const resultEl = document.getElementById("cal-sync-result")
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/calendar/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
        signal: pageLifecycle.signal,
      })
      const data = (await res.json()) as { ok: boolean; message?: string; created?: number; updated?: number; total?: number }
      if (resultEl) resultEl.textContent = data.message ?? "Sync triggered"
      showToast(data.ok ? `✅ ${data.message ?? "Calendar sync triggered"}` : "❌ Calendar sync failed", data.ok ? "success" : "error")
      if (data.ok) {
        const lastSynced = document.getElementById("cal-last-synced")
        if (lastSynced) {
          const evtCount = data.total ?? 0
          lastSynced.textContent = `Last synced: ${new Date().toLocaleTimeString()} — ${evtCount} event${evtCount !== 1 ? "s" : ""}`
          lastSynced.style.color = "var(--text-muted)"
        }
      }
    } catch {
      if (resultEl) resultEl.textContent = "Sync failed"
      showToast("❌ Calendar sync failed", "error")
    }
    setTimeout(() => { if (resultEl) resultEl.textContent = "" }, 5000)
    }, { loadingText: "Syncing…" }))
  }

  // ───── Todo Enable/Disable All ─────
  const todoEnableAllBtn = document.getElementById("todo-enable-all")
  if (todoEnableAllBtn) {
    pageLifecycle.on(todoEnableAllBtn, "click", () => {
    document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle").forEach((cb) => {
      if (!cb.checked) { cb.checked = true; cb.closest(".cal-toggle-card")?.classList.add("cal-toggle-card--active") }
    })
    updateTodoCount()
    })
  }
  const todoDisableAllBtn = document.getElementById("todo-disable-all")
  if (todoDisableAllBtn) {
    pageLifecycle.on(todoDisableAllBtn, "click", () => {
    document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle").forEach((cb) => {
      if (cb.checked) { cb.checked = false; cb.closest(".cal-toggle-card")?.classList.remove("cal-toggle-card--active") }
    })
    updateTodoCount()
    })
  }

  // ───── Todo manual add ─────
  const todoManualBtn = document.getElementById("todo-add-manual")
  if (todoManualBtn) {
    pageLifecycle.on(todoManualBtn, "click", () => {
    const input = document.getElementById("todo-entity-manual") as HTMLInputElement
    const entityId = input?.value?.trim()
    if (!entityId || !entityId.startsWith("todo.")) { showToast("Enter a valid entity ID (e.g. todo.shopping_list)", "error"); return }
    const container = document.getElementById("todo-entities-container")
    if (!container) return
    if (container.querySelector(`[data-entity="${CSS.escape(entityId)}"]`)) { showToast("Entity already in the list", "error"); return }
    const card = document.createElement("div")
    card.className = "cal-toggle-card cal-toggle-card--active"
    card.dataset.entity = entityId
    card.innerHTML = `<div class="cal-toggle-card__info"><span class="cal-toggle-card__name"></span><span class="cal-toggle-card__entity"></span><span class="cal-toggle-card__state">manually added</span></div><label class="toggle-label"><input type="checkbox" class="todo-entity-toggle" checked /><span class="toggle-slider"></span></label>`
    const todoName = card.querySelector<HTMLElement>(".cal-toggle-card__name")
    if (todoName) todoName.textContent = entityId
    const todoEntity = card.querySelector<HTMLElement>(".cal-toggle-card__entity")
    if (todoEntity) todoEntity.textContent = entityId
    const todoToggle = card.querySelector<HTMLInputElement>(".todo-entity-toggle")
    if (todoToggle) todoToggle.value = entityId
    card.querySelector<HTMLInputElement>(".todo-entity-toggle")?.addEventListener("change", function () {
      card.classList.toggle("cal-toggle-card--active", this.checked)
      updateTodoCount()
    })
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".toggle-label")) return
      const cb = card.querySelector<HTMLInputElement>(".todo-entity-toggle")
      if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })) }
    })
    container.appendChild(card)
    const noEntities = document.getElementById("todo-no-entities")
    if (noEntities) noEntities.style.display = "none"
    updateTodoCount()
    input.value = ""
    })
  }

  // ───── Todo toggle label ─────
  const todoEnabledCb = document.getElementById("todo-enabled")
  if (todoEnabledCb) {
    pageLifecycle.on(todoEnabledCb, "change", () => {
    const cb = todoEnabledCb as HTMLInputElement
    const label = document.getElementById("todo-enabled-label")
    if (label) label.textContent = cb.checked ? "On — syncing with HA" : "Off — sync disabled to save power"
    })
  }

  const saveTodoBtn = document.getElementById("save-todo") as HTMLButtonElement
  if (saveTodoBtn) {
    pageLifecycle.on(saveTodoBtn, "click", withAsyncButton(saveTodoBtn, async () => {
    const enabled = (document.getElementById("todo-enabled") as HTMLInputElement).checked
    const enabledEntities = Array.from(document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle:checked")).map((cb) => cb.value)
    const direction = (document.getElementById("todo-sync-direction") as HTMLSelectElement).value
    if (enabled && enabledEntities.length === 0) { showToast("Enable at least one todo list, or disable sync", "error"); return }
    await saveSetting("todo_sync_enabled", enabled)
    await saveSetting("todo_entities", enabledEntities)
    await saveSetting("todo_entity", enabledEntities[0] || "")
    await saveSetting("todo_sync_direction", direction)
    if (enabled && enabledEntities.length > 0) {
      try { await fetch((window.__ingress_path || "") + "/api/todo/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "enable", entity_id: enabledEntities[0], entities: enabledEntities, direction }), signal: pageLifecycle.signal }) }
      catch { /* logged server-side */ }
    } else {
      try { await fetch((window.__ingress_path || "") + "/api/todo/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disable" }), signal: pageLifecycle.signal }) }
      catch { /* logged server-side */ }
    }
    const statusEl = document.getElementById("todo-status")
    if (statusEl) {
      statusEl.textContent = enabled ? `${enabledEntities.length} syncing` : "Disabled"
      statusEl.className = enabled ? "badge badge-active" : "badge badge-pending"
    }
    showToast("settings.todo_saved")
    }, { loadingText: "Saving…" }))
  }

  const syncTodoBtn = document.getElementById("sync-todo") as HTMLButtonElement
  if (syncTodoBtn) {
    pageLifecycle.on(syncTodoBtn, "click", withAsyncButton(syncTodoBtn, async () => {
    const resultEl = document.getElementById("todo-sync-result")
    try {
      const enabledTodos = Array.from(document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle:checked")).map((cb) => cb.value)
      const entity = enabledTodos[0] || undefined
      const res = await fetch((window.__ingress_path || "") + "/api/todo/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync", entity_id: entity || undefined }),
        signal: pageLifecycle.signal,
      })
      const data = (await res.json()) as { ok: boolean; synced?: number; errors?: number; message?: string; ha_connected?: boolean }
      const msg = data.message ?? (data.ok ? "Sync triggered" : "Sync failed")
      if (resultEl) resultEl.textContent = msg
      const isOk = data.ok && data.ha_connected !== false
      showToast(isOk ? `✅ ${msg}` : `⚠️ ${msg}`, isOk ? "success" : "error")
      if (data.ok) {
        const lastSynced = document.getElementById("todo-last-synced")
        if (lastSynced) lastSynced.textContent = `Last synced: ${new Date().toLocaleTimeString()}${data.synced ? ` — ${data.synced} item(s)` : ""}`
      }
    } catch {
      if (resultEl) resultEl.textContent = "Sync failed"
      showToast("❌ Todo sync failed", "error")
    }
    setTimeout(() => { if (resultEl) resultEl.textContent = "" }, 5000)
    }, { loadingText: "Syncing…" }))
  }
}

// ───── Shared helpers ─────
function updateCalCountBadge() {
  const badge = document.getElementById("cal-count-badge")
  const toggles = document.querySelectorAll<HTMLInputElement>(".cal-entity-toggle")
  const total = toggles.length
  const enabled = Array.from(toggles).filter((t) => t.checked).length
  if (badge) {
    badge.textContent = `${enabled} of ${total} enabled`
    badge.style.color = enabled > 0 ? "var(--accent)" : "var(--text-muted)"
    badge.style.borderColor = enabled > 0 ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "var(--border)"
  }
}
(window as unknown as Record<string, unknown>).__updateCalCount = updateCalCountBadge

function updateTodoCount() {
  const badge = document.getElementById("todo-count-badge")
  if (!badge) return
  const all = document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle")
  const enabled = Array.from(all).filter((cb) => cb.checked).length
  badge.textContent = `${enabled} of ${all.length} enabled`
}
(window as unknown as Record<string, unknown>).__updateTodoCount = updateTodoCount

// ───── Calendar hydration (complete function) ─────
async function hydrateCalendarStatus() {
  const statusEl = document.getElementById("cal-status")
  const autoInfo = document.getElementById("cal-auto-info")
  const autoEntity = document.getElementById("cal-auto-entity")
  const entitiesList = document.getElementById("cal-entities-list")
  const entitiesContainer = document.getElementById("cal-entities-container")
  const lastSynced = document.getElementById("cal-last-synced")

  try {
    const res = await fetch((window.__ingress_path || "") + "/api/integrations/calendar/status", { signal: pageLifecycle.signal })
    if (!res.ok) throw new Error("API error")
    const data = (await res.json()) as { ok: boolean; calendars?: { entity_id: string; friendly_name: string; state: string }[]; sync: { active: boolean; entityId: string; lastSyncAt: number | null; eventCount: number } }

    const calendars = data.calendars ?? []
    const sync = data.sync ?? { active: false, entityId: "", lastSyncAt: null, eventCount: 0 }

    if (statusEl) {
      if (sync.active) {
        statusEl.textContent = `${calendars.length} syncing`
        statusEl.className = "badge badge-active"
      } else if (calendars.length > 0) {
        statusEl.textContent = `${calendars.length} found`
        statusEl.className = "badge badge-active"
      } else {
        statusEl.textContent = "No calendars"
        statusEl.className = "badge badge-pending"
      }
    }

    if (sync.lastSyncAt && lastSynced) {
      const ts = new Date(sync.lastSyncAt).toLocaleTimeString()
      const evtCount = sync.eventCount || 0
      lastSynced.textContent = `Last synced: ${ts} — ${evtCount} event${evtCount !== 1 ? "s" : ""}`
      lastSynced.style.color = "var(--text-muted)"
    }

    if (sync.active && autoInfo) {
      autoInfo.style.display = "block"
      if (autoEntity && sync.entityId) autoEntity.textContent = sync.entityId
    }

    if (calendars.length > 0 && entitiesList && entitiesContainer) {
      entitiesList.style.display = "block"
      let savedEntities: string[] = []
      let savedSyncModes: Record<string, string> = {}
      let savedGlobalMode = "bidirectional"
      try {
        const settingsRes = await fetch((window.__ingress_path || "") + "/api/settings", { signal: pageLifecycle.signal })
        const s = (await settingsRes.json()) as Record<string, unknown>
        const raw = s.calendar_entities ?? s.calendar_entity ?? s.cal_entity
        if (Array.isArray(raw)) savedEntities = raw as string[]
        else if (typeof raw === "string") { try { const parsed = JSON.parse(raw); savedEntities = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [] } catch { savedEntities = raw ? [raw] : [] } }
        if (s.calendar_sync_modes) { try { const parsed = typeof s.calendar_sync_modes === "string" ? JSON.parse(s.calendar_sync_modes as string) : s.calendar_sync_modes; if (parsed && typeof parsed === "object") savedSyncModes = parsed as Record<string, string> } catch { /* invalid */ } }
        if (typeof s.calendar_sync_mode === "string") savedGlobalMode = s.calendar_sync_mode
      } catch { /* ignore */ }

      const dirSelect = document.getElementById("cal-sync-direction") as HTMLSelectElement | null
      if (dirSelect && savedGlobalMode) dirSelect.value = savedGlobalMode

      entitiesContainer.innerHTML = calendars.map((c) => {
        const isEnabled = savedEntities.includes(c.entity_id)
        const stateLabel = c.state === "off" ? "no active event" : c.state
        const entityMode = savedSyncModes[c.entity_id] ?? savedGlobalMode
        return `<div class="cal-toggle-card${isEnabled ? " cal-toggle-card--active" : ""}" data-entity="${escapeHtml(c.entity_id)}"><div class="cal-toggle-card__info"><span class="cal-toggle-card__name">${escapeHtml(c.friendly_name)}</span><span class="cal-toggle-card__entity">${escapeHtml(c.entity_id)}</span><div class="cal-toggle-card__direction"${!isEnabled ? ' style="display:none"' : ""}><select class="cal-direction-select" data-entity-dir="${escapeHtml(c.entity_id)}" aria-label="Sync direction for ${escapeHtml(c.friendly_name)}"><option value="bidirectional"${entityMode === "bidirectional" ? " selected" : ""}>↔ Bidirectional</option><option value="import"${entityMode === "import" ? " selected" : ""}>↓ Import only</option><option value="export"${entityMode === "export" ? " selected" : ""}>↑ Export only</option></select></div><span class="cal-toggle-card__state">${escapeHtml(stateLabel)}</span></div><label class="toggle-label"><input type="checkbox" class="cal-entity-toggle" value="${escapeHtml(c.entity_id)}" ${isEnabled ? "checked" : ""} /><span class="toggle-slider"></span></label></div>`
      }).join("")

      // Wire toggle cards
      entitiesContainer.querySelectorAll<HTMLInputElement>(".cal-entity-toggle").forEach((cb) => {
        cb.addEventListener("change", () => {
          const card = cb.closest(".cal-toggle-card")
          if (card) {
            card.classList.toggle("cal-toggle-card--active", cb.checked)
            const dirDiv = card.querySelector<HTMLElement>(".cal-toggle-card__direction")
            if (dirDiv) dirDiv.style.display = cb.checked ? "" : "none"
          }
          updateCalCountBadge()
        })
      })
      entitiesContainer.querySelectorAll<HTMLSelectElement>(".cal-direction-select").forEach((sel) => {
        sel.addEventListener("click", (e) => e.stopPropagation())
        sel.addEventListener("mousedown", (e) => e.stopPropagation())
      })
      entitiesContainer.querySelectorAll<HTMLElement>(".cal-toggle-card").forEach((card) => {
        card.addEventListener("click", (e) => {
          const target = e.target as HTMLElement
          if (target.closest(".toggle-label") || target.closest(".cal-direction-select")) return
          const cb = card.querySelector<HTMLInputElement>(".cal-entity-toggle")
          if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })) }
        })
        card.style.cursor = "pointer"
      })

      // Enable/Disable All
      document.getElementById("cal-enable-all")?.addEventListener("click", () => {
        entitiesContainer.querySelectorAll<HTMLInputElement>(".cal-entity-toggle").forEach((cb) => {
          cb.checked = true
          const card = cb.closest(".cal-toggle-card")
          card?.classList.add("cal-toggle-card--active")
          const dirDiv = card?.querySelector<HTMLElement>(".cal-toggle-card__direction")
          if (dirDiv) dirDiv.style.display = ""
        })
        updateCalCountBadge()
      })
      document.getElementById("cal-disable-all")?.addEventListener("click", () => {
        entitiesContainer.querySelectorAll<HTMLInputElement>(".cal-entity-toggle").forEach((cb) => {
          cb.checked = false
          const card = cb.closest(".cal-toggle-card")
          card?.classList.remove("cal-toggle-card--active")
          const dirDiv = card?.querySelector<HTMLElement>(".cal-toggle-card__direction")
          if (dirDiv) dirDiv.style.display = "none"
        })
        updateCalCountBadge()
      })

      // Global direction cascade
      const globalDirSel = document.getElementById("cal-sync-direction") as HTMLSelectElement | null
      if (globalDirSel) {
        let previousGlobal = globalDirSel.value
        globalDirSel.addEventListener("change", () => {
          const newGlobal = globalDirSel.value
          entitiesContainer.querySelectorAll<HTMLSelectElement>(".cal-direction-select").forEach((sel) => {
            if (sel.value === previousGlobal) sel.value = newGlobal
          })
          previousGlobal = newGlobal
        })
      }

      if (savedEntities.length === 0 && calendars.length === 1) {
        const firstToggle = entitiesContainer.querySelector<HTMLInputElement>(".cal-entity-toggle")
        if (firstToggle) { firstToggle.checked = true; firstToggle.closest(".cal-toggle-card")?.classList.add("cal-toggle-card--active") }
      }
      updateCalCountBadge()
    } else {
      if (entitiesList) {
        entitiesList.style.display = "block"
        const emptyState = document.getElementById("cal-no-entities")
        if (emptyState) emptyState.style.display = "flex"
      }
    }
  } catch {
    if (statusEl) { statusEl.textContent = "Unavailable"; statusEl.className = "badge badge-pending" }
  }
}

// ───── Todo hydration ─────
async function hydrateTodoStatus() {
  const statusEl = document.getElementById("todo-status")
  const autoInfo = document.getElementById("todo-auto-info")
  const autoEntities = document.getElementById("todo-auto-entities")
  const entitiesList = document.getElementById("todo-entities-list")
  const entitiesContainer = document.getElementById("todo-entities-container")
  const noEntities = document.getElementById("todo-no-entities")
  const enabledCb = document.getElementById("todo-enabled") as HTMLInputElement | null
  const enabledLabel = document.getElementById("todo-enabled-label")

  try {
    const res = await fetch((window.__ingress_path || "") + "/api/todo", { signal: pageLifecycle.signal })
    if (!res.ok) throw new Error("API error")
    const data = (await res.json()) as { ok: boolean; entities?: { entity_id: string; friendly_name: string; state: string; sync: { active: boolean; direction: string; lastSyncAt: number | null; itemCount: number } | null }[] }
    const entities = data.entities ?? []
    let savedEnabled: string[] = []
    try {
      const settingsRes = await fetch((window.__ingress_path || "") + "/api/settings", { signal: pageLifecycle.signal })
      const settings = await settingsRes.json()
      if (settings.todo_entities) savedEnabled = Array.isArray(settings.todo_entities) ? settings.todo_entities : [settings.todo_entities]
      else if (settings.todo_entity) savedEnabled = [settings.todo_entity]
    } catch { /* use defaults */ }

    if (entities.length > 0 && autoInfo && autoEntities) {
      autoInfo.style.display = "block"
      autoEntities.innerHTML = entities.map((e) => `• <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">${escapeHtml(e.entity_id)}</code> (${escapeHtml(e.friendly_name)})`).join("<br>")
    }

    if (entitiesList && entitiesContainer) {
      entitiesList.style.display = "block"
      if (entities.length === 0) {
        entitiesContainer.innerHTML = ""
        if (noEntities) noEntities.style.display = "flex"
      } else {
        if (noEntities) noEntities.style.display = "none"
        const autoSelect = savedEnabled.length === 0 && entities.length > 0
        entitiesContainer.innerHTML = entities.map((e) => {
          const isEnabled = autoSelect ? e === entities[0] : savedEnabled.includes(e.entity_id)
          const stateLabel = e.sync?.active ? `${e.state} · syncing${e.sync.itemCount ? ` · ${e.sync.itemCount} items` : ""}` : e.state
          return `<div class="cal-toggle-card${isEnabled ? " cal-toggle-card--active" : ""}" data-entity="${escapeHtml(e.entity_id)}"><div class="cal-toggle-card__info"><span class="cal-toggle-card__name">${escapeHtml(e.friendly_name)}</span><span class="cal-toggle-card__entity">${escapeHtml(e.entity_id)}</span><span class="cal-toggle-card__state">${escapeHtml(stateLabel)}</span></div><label class="toggle-label"><input type="checkbox" class="todo-entity-toggle" value="${escapeHtml(e.entity_id)}" ${isEnabled ? "checked" : ""} /><span class="toggle-slider"></span></label></div>`
        }).join("")

        entitiesContainer.querySelectorAll<HTMLInputElement>(".todo-entity-toggle").forEach((cb) => {
          cb.addEventListener("change", () => { cb.closest(".cal-toggle-card")?.classList.toggle("cal-toggle-card--active", cb.checked); updateTodoCount() })
        })
        entitiesContainer.querySelectorAll<HTMLElement>(".cal-toggle-card").forEach((card) => {
          card.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".toggle-label")) return
            const cb = card.querySelector<HTMLInputElement>(".todo-entity-toggle")
            if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })) }
          })
        })
        if (autoSelect && enabledCb && !enabledCb.checked) {
          enabledCb.checked = true
          if (enabledLabel) enabledLabel.textContent = "On — syncing with HA"
        }
      }
      updateTodoCount()
    }
    const anyActive = entities.some((e) => e.sync?.active)
    if (statusEl) {
      if (anyActive) { statusEl.textContent = "Active"; statusEl.className = "badge badge-active" }
      else if (entities.length > 0) { statusEl.textContent = `${entities.length} found`; statusEl.className = "badge badge-active" }
      else { statusEl.textContent = "No lists"; statusEl.className = "badge badge-pending" }
    }
  } catch {
    if (statusEl) { statusEl.textContent = "Unavailable"; statusEl.className = "badge badge-pending" }
  }
}

/** Restore calendar/todo related settings */
export function restoreCalendarTodoSettings(s: Record<string, unknown>): void {
  // CalDAV credentials
  if (s.caldav_url) {
    (document.getElementById("caldav-url") as HTMLInputElement).value = String(s.caldav_url)
    ;(async () => {
      try {
        const credRes = await fetch((window.__ingress_path || "") + "/api/integrations/calendar/caldav-credentials", { signal: pageLifecycle.signal })
        if (credRes.ok) {
          const credData = await credRes.json()
          if (credData.configured) {
            const indicator = document.getElementById("caldav-active-indicator")
            if (indicator) indicator.style.display = "block"
            if (credData.username) (document.getElementById("caldav-username") as HTMLInputElement).value = credData.username
          }
        }
      } catch { /* optional */ }
    })()
  }
  if (s.calendar_write_back) {
    const wb = document.getElementById("cal-write-back") as HTMLInputElement | null
    if (wb) wb.checked = s.calendar_write_back === true || s.calendar_write_back === "true"
  }
  if (s.calendar_sync_interval_ms) {
    const intervalSel = document.getElementById("cal-sync-interval") as HTMLSelectElement | null
    if (intervalSel) intervalSel.value = String(s.calendar_sync_interval_ms)
  }

  // Todo entity restore
  if (s.todo_entity) {
    const todoSelect = document.getElementById("todo-entity") as HTMLSelectElement | null
    const todoManual = document.getElementById("todo-entity-manual") as HTMLInputElement | null
    if (todoSelect) todoSelect.value = String(s.todo_entity)
    if (todoManual) todoManual.value = String(s.todo_entity)
  }
  if (s.todo_sync_direction) (document.getElementById("todo-sync-direction") as HTMLSelectElement).value = String(s.todo_sync_direction)
  if (s.todo_sync_enabled) {
    (document.getElementById("todo-enabled") as HTMLInputElement).checked = true
    const label = document.getElementById("todo-enabled-label")
    if (label) label.textContent = "On — syncing with HA"
    const el = document.getElementById("todo-status")
    if (el) { el.textContent = "Active"; el.className = "badge badge-active" }
    window.expandIntegrationCard?.("integration-todo-body")
  }
}
