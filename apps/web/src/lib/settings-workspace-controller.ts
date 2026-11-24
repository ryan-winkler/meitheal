import { createClientLogger } from "./client-logger"
import { settingsWriteHeaders } from "./settings-store"
import { readWorkspacePreferences, saveWorkspacePreferences } from "./workspace-preferences"
import { byId, domEl, setAttr } from "@lib/dom-helpers"

const log = createClientLogger("settings", "workspace")

interface FeatureItem {
  name: string
  category: "productivity" | "integrations" | "visual" | string
  label: string
  description: string
  enabled?: boolean
}

interface WorkspaceUser {
  id: string
  name?: string
  display_name?: string
  source?: string
  kind?: string
}

function formatWorkspaceUserLabel(u: WorkspaceUser): string {
  const baseName = u.display_name || u.name || u.id
  if (u.kind === "agent") return `${baseName} (AI agent)`
  return `${baseName}${u.source === "home_assistant" ? " (HA)" : " (Custom)"}`
}

interface NotificationPrefs {
  enabled?: boolean
  disabled_users?: string[]
  channels?: { sidebar?: boolean; mobile_push?: boolean }
  mobile_targets?: string[]
  due_date_reminders?: boolean
  reminder_window_minutes?: number
}

function initTaskCaptureMode(signal: AbortSignal): void {
  const select = byId<HTMLSelectElement>("task-capture-mode-select")
  const saveBtn = byId("save-task-capture-mode")
  const helpEl = byId("task-capture-mode-help")
  if (!select) return

  const updateHelp = (): void => {
    if (!helpEl) return
    helpEl.textContent = select.value === "quick"
      ? (helpEl.dataset.modeQuick ?? "")
      : (helpEl.dataset.modeForm ?? "")
  }

  const prefs = readWorkspacePreferences()
  select.value = prefs.capture === "quick" ? "quick" : "form"
  updateHelp()

  select.addEventListener("change", updateHelp, { signal })
  saveBtn?.addEventListener(
    "click",
    () => {
      const capture = select.value === "quick" ? "quick" : "form"
      void saveWorkspacePreferences({ capture }).then((ok) => {
        if (signal.aborted) return
        if (ok) {
          window.showToast?.(
            capture === "quick"
              ? "New task now opens Quick add on this browser"
              : "New task now opens the full Task form on this browser",
            "success",
          )
        } else {
          window.showToast?.("settings.save_error", "error")
        }
      })
    },
    { signal },
  )
}

function initBacklogMode(signal: AbortSignal): void {
  const select = byId<HTMLSelectElement>("backlog-mode-select")
  const saveBtn = byId("save-backlog-mode")
  const helpDiv = byId("backlog-mode-help")
  if (!select) return

  const helpTexts: Record<string, string | undefined> = {
    visible: helpDiv?.dataset.modeVisible,
    hidden: helpDiv?.dataset.modeHidden,
    disabled: helpDiv?.dataset.modeDisabled,
  }

  const updateHelp = (): void => {
    if (helpDiv) helpDiv.textContent = helpTexts[select.value] ?? ""
  }
  select.addEventListener("change", updateHelp, { signal })

  fetch("/api/settings?key=backlog_mode", { signal })
    .then((r) => (r.ok ? r.json() : {}))
    .then((data: { value?: unknown }) => {
      if (signal.aborted) return
      if (data.value !== null && data.value !== undefined) {
        select.value = String(data.value)
        updateHelp()
      }
      window.__backlog_mode = select.value
    })
    .catch(() => {
      /* use default */
    })

  saveBtn?.addEventListener(
    "click",
    () => {
      const val = select.value
      fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "backlog_mode", value: val }),
        signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Settings save failed: ${response.status}`)
          window.__backlog_mode = val
          window.showToast?.("Backlog mode saved — reload Kanban to apply")
        })
        .catch((err) => {
          if (signal.aborted) return
          log.error("Save backlog mode error:", err)
          window.showToast?.("settings.save_error", "error")
        })
    },
    { signal },
  )
}

function initCompletedRetention(signal: AbortSignal): void {
  const select = byId<HTMLSelectElement>("completed-retention-select")
  const saveBtn = byId("save-completed-retention")
  if (!select) return

  fetch("/api/settings?key=completed_auto_hide_days", { signal })
    .then((r) => (r.ok ? r.json() : {}))
    .then((data: { value?: unknown }) => {
      if (signal.aborted) return
      if (data.value !== null && data.value !== undefined) {
        select.value = String(data.value)
      }
    })
    .catch(() => {
      /* use default */
    })

  saveBtn?.addEventListener(
    "click",
    () => {
      const val = Number(select.value)
      fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "completed_auto_hide_days", value: val }),
        signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Settings save failed: ${response.status}`)
          window.showToast?.("Retention setting saved — reload Kanban to apply")
        })
        .catch((err) => {
          if (signal.aborted) return
          log.error("Save retention error:", err)
          window.showToast?.("settings.save_error", "error")
        })
    },
    { signal },
  )
}

function initFeatureToggles(signal: AbortSignal): void {
  const container = byId("feature-toggles-container")
  if (!container) return

  const categories: Record<string, { label: string }> = {
    productivity: { label: "Productivity" },
    integrations: { label: "Integrations" },
    visual: { label: "Visual" },
  }

  fetch("/api/features", { signal })
    .then((r) => {
      if (!r.ok) throw new Error(`Features load failed: ${r.status}`)
      return r.json()
    })
    .then((data: { features?: FeatureItem[] }) => {
      if (signal.aborted || !data.features) return
      container.replaceChildren()

      const grouped: Record<string, FeatureItem[]> = {}
      for (const f of data.features) {
        ;(grouped[f.category] ??= []).push(f)
      }

      for (const cat of Object.keys(categories)) {
        const features = grouped[cat]
        if (!features || features.length === 0) continue

        const catInfo = categories[cat]
        const section = domEl("div")
        section.style.cssText = "margin-bottom: 8px;"

        const heading = domEl("div")
        heading.style.cssText =
          "font-weight: 600; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; padding-top: 4px;"
        heading.textContent = catInfo?.label ?? cat
        section.appendChild(heading)

        for (const f of features) {
          const row = domEl("div")
          row.style.cssText =
            "display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;"

          const toggleLabel = domEl("label", "toggle-switch")
          toggleLabel.style.flexShrink = "0"

          const checkbox = domEl("input")
          checkbox.type = "checkbox"
          checkbox.id = `feature-toggle-${f.name}`
          checkbox.dataset.feature = f.name
          checkbox.checked = Boolean(f.enabled)
          setAttr(checkbox, "aria-label", f.label)

          const slider = domEl("span")
          slider.className = "toggle-slider"
          toggleLabel.append(checkbox, slider)

          const body = domEl("div")
          body.style.flex = "1"

          const titleEl = domEl("div")
          titleEl.style.cssText = "font-weight: 500; font-size: 13px;"
          titleEl.textContent = f.label

          const descEl = domEl("div")
          descEl.style.cssText = "font-size: 12px; color: var(--text-secondary);"
          descEl.textContent = f.description

          const status = domEl("span", "text-danger settings-text-xs")
          setAttr(status, "role", "status")
          body.append(titleEl, descEl, status)
          row.append(toggleLabel, body)

          checkbox.addEventListener(
            "change",
            () => {
              const enabled = checkbox.checked
              checkbox.disabled = true
              status.textContent = ""

              fetch("/api/features", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ feature: f.name, enabled }),
                signal,
              })
                .then((response) => {
                  if (!response.ok) throw new Error(`Feature save failed: ${response.status}`)
                  return response.json()
                })
                .then((result: { feature?: string; enabled?: boolean }) => {
                  if (result.feature !== f.name || result.enabled !== enabled) {
                    throw new Error("Feature save was not confirmed")
                  }
                  if (signal.aborted) return
                  window.showToast?.(`${enabled ? "Enabled" : "Disabled"}: ${f.label}`)
                  if (window.__featureFlags) window.__featureFlags[f.name] = enabled
                })
                .catch(() => {
                  if (!signal.aborted) {
                    checkbox.checked = !enabled
                    status.textContent = container.dataset.saveError ?? ""
                  }
                })
                .finally(() => {
                  checkbox.disabled = false
                })
            },
            { signal },
          )

          section.appendChild(row)
        }

        container.appendChild(section)
      }

      const hint = domEl("div")
      hint.style.cssText =
        "font-size: 12px; color: var(--text-secondary); margin-top: 4px; padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px; border: 1px dashed var(--border);"
      const noteStrong = domEl("strong")
      noteStrong.textContent = "Note:"
      hint.append(noteStrong, document.createTextNode(" Some changes take effect on the next page load."))
      container.appendChild(hint)
    })
    .catch(() => {
      if (signal.aborted) return
      const errorSpan = domEl("span")
      errorSpan.style.cssText = "color: var(--danger); font-size: 12px;"
      errorSpan.textContent = "Failed to load features"
      container.replaceChildren(errorSpan)
    })
}

function makeStyledEl(tag: string, styles: string, text?: string): HTMLElement {
  const el = document.createElement(tag)
  if (styles) el.style.cssText = styles
  if (text !== undefined) el.textContent = text
  return el
}

function makeAvatar(name: string | undefined, bg: string): HTMLElement {
  const initials = (name || "??").slice(0, 2).toUpperCase()
  return makeStyledEl(
    "span",
    `display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; background: ${bg || "var(--accent)"}`,
    initials,
  )
}

function initNotificationsPanel(signal: AbortSignal): ((users: WorkspaceUser[]) => void) | undefined {
  const globalToggle = byId<HTMLInputElement>("notif-global-toggle")
  const sidebarCb = byId<HTMLInputElement>("notif-channel-sidebar")
  const mobileCb = byId<HTMLInputElement>("notif-channel-mobile")
  const remindersCb = byId<HTMLInputElement>("notif-channel-reminders")
  const reminderMinutesInput = byId<HTMLInputElement>("notif-reminder-minutes")
  const reminderWindowConfig = byId("reminder-window-config")
  const mobileTargetsPanel = byId("notif-mobile-targets")
  const mobileTargetList = byId("notif-mobile-target-list")
  const userTogglesContainer = byId("notif-user-toggles")
  const saveBtn = byId<HTMLButtonElement>("save-notif-prefs")
  const prefsStatus = byId("notif-prefs-status")
  const retryPrefs = byId("retry-notif-prefs")
  const retryTargets = byId("retry-notif-mobile-targets")
  if (!globalToggle || !userTogglesContainer) return undefined

  let prefs: NotificationPrefs = {}
  let prefsReady = false
  let latestUsers: WorkspaceUser[] = []
  const controls = [globalToggle, sidebarCb, mobileCb, remindersCb, reminderMinutesInput, saveBtn]

  const updateMobilePanel = (): void => {
    if (mobileTargetsPanel) {
      mobileTargetsPanel.style.display = mobileCb?.checked ? "block" : "none"
    }
  }
  mobileCb?.addEventListener("change", updateMobilePanel, { signal })

  const updateReminderPanel = (): void => {
    if (reminderWindowConfig) {
      reminderWindowConfig.style.display = remindersCb?.checked ? "block" : "none"
    }
  }
  remindersCb?.addEventListener("change", updateReminderPanel, { signal })

  async function discoverMobileTargets(): Promise<void> {
    if (!mobileTargetList) return
    if (retryTargets) retryTargets.hidden = true
    mobileTargetList.textContent = mobileTargetList.dataset.loading ?? ""
    try {
      const response = await fetch("/api/ha/services", { cache: "no-store", signal })
      if (!response.ok) throw new Error(`Device discovery failed: ${response.status}`)
      const data = await response.json() as { services?: Array<{ domain?: string; services?: Record<string, unknown> }>; error?: string }
      if (data.error || !Array.isArray(data.services)) throw new Error("Device discovery unavailable")
      if (signal.aborted) return
      const mobileServices: Array<{ service: string; name: string }> = []
      for (const domainObj of data.services) {
        if (domainObj?.domain !== "notify") continue
        for (const name of Object.keys(domainObj.services ?? {})) {
          if (!name.startsWith("mobile_app_")) continue
          mobileServices.push({
            service: `notify.${name}`,
            name: name.replace("mobile_app_", "").replace(/_/g, " "),
          })
        }
      }

      mobileTargetList.replaceChildren()
      if (mobileServices.length === 0) {
        const empty = domEl("span")
        empty.style.cssText = "color: var(--text-secondary); font-size: 12px; font-style: italic;"
        empty.textContent =
          "No HA Companion App devices found. Install the HA Companion App on your phone to enable mobile push."
        mobileTargetList.appendChild(empty)
        return
      }

      const savedSet = new Set(prefs.mobile_targets ?? [])
      for (const svc of mobileServices) {
        const row = domEl("div")
        row.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 4px 0;"

        const cb = domEl("input")
        cb.type = "checkbox"
        cb.checked = prefs.mobile_targets === undefined || savedSet.has(svc.service)
        cb.dataset.mobileTarget = svc.service
        setAttr(cb, "aria-label", svc.name)
        cb.style.cssText = "accent-color: var(--accent);"
        row.appendChild(cb)

        const label = domEl("span")
        label.style.cssText = "font-size: 13px;"
        label.textContent = svc.name
        row.appendChild(label)

        const svcLabel = domEl("span")
        svcLabel.style.cssText =
          "font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono);"
        svcLabel.textContent = svc.service
        row.appendChild(svcLabel)

        mobileTargetList.appendChild(row)
      }
    } catch {
      if (signal.aborted) return
      mobileTargetList.textContent = mobileTargetList.dataset.error ?? ""
      if (retryTargets) retryTargets.hidden = false
    }
  }

  function restorePrefs(): void {
    if (globalToggle) globalToggle.checked = prefs.enabled !== false
    const channels = prefs.channels ?? { sidebar: true, mobile_push: false }
    if (sidebarCb) sidebarCb.checked = channels.sidebar !== false
    if (mobileCb) mobileCb.checked = channels.mobile_push === true
    updateMobilePanel()

    if (remindersCb) remindersCb.checked = prefs.due_date_reminders !== false
    if (reminderMinutesInput) {
      reminderMinutesInput.value = String(prefs.reminder_window_minutes ?? 60)
    }
    updateReminderPanel()

    void discoverMobileTargets()
  }

  async function loadPrefs(): Promise<void> {
    for (const control of controls) if (control) control.disabled = true
    if (retryPrefs) retryPrefs.hidden = true
    if (prefsStatus) prefsStatus.textContent = prefsStatus.dataset.loading ?? ""
    try {
      const response = await fetch("/api/settings?key=notification_preferences", { signal })
      if (!response.ok) throw new Error(`Notification preferences load failed: ${response.status}`)
      const saved = await response.json() as { value?: NotificationPrefs | null }
      if (saved.value !== null && (!saved.value || typeof saved.value !== "object" || Array.isArray(saved.value))) {
        throw new Error("Unexpected notification preferences")
      }
      if (signal.aborted) return
      prefs = saved.value ?? {}
      for (const field of ["disabled_users", "mobile_targets"] as const) {
        const values = prefs[field]
        if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== "string"))) {
          throw new Error("Unexpected notification target preferences")
        }
      }
      prefsReady = true
      restorePrefs()
      renderUsers(latestUsers)
      for (const control of controls) if (control) control.disabled = false
      if (prefsStatus) prefsStatus.textContent = ""
    } catch {
      if (signal.aborted) return
      if (prefsStatus) prefsStatus.textContent = prefsStatus.dataset.error ?? ""
      if (retryPrefs) retryPrefs.hidden = false
    }
  }

  retryPrefs?.addEventListener("click", () => void loadPrefs(), { signal })
  retryTargets?.addEventListener("click", () => void discoverMobileTargets(), { signal })
  void loadPrefs()

  function renderUsers(users: WorkspaceUser[]): void {
    latestUsers = users
    if (!prefsReady) return
    if (!userTogglesContainer || signal.aborted) return
    const current = new Map(
      Array.from(userTogglesContainer.querySelectorAll<HTMLInputElement>("input[data-user-id]"), (input) => [
        input.dataset.userId,
        input.checked,
      ]),
    )
    const disabledSet = new Set(prefs.disabled_users ?? [])

    userTogglesContainer.replaceChildren()
    const heading = domEl("div")
    heading.style.cssText = "font-weight: 600; font-size: 13px; margin-bottom: 4px;"
    heading.textContent = "Per-user overrides"
    userTogglesContainer.appendChild(heading)

    if (users.length === 0) {
      const empty = domEl("span")
      empty.style.cssText = "color: var(--text-secondary); font-size: 12px; font-style: italic;"
      empty.textContent = "No users found — notifications will apply globally."
      userTogglesContainer.appendChild(empty)
      return
    }

    for (const u of users) {
      const row = domEl("div")
      row.style.cssText =
        "display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px;"

      const avatar = domEl("span")
      avatar.style.cssText = `display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; background: ${u.source === "home_assistant" ? "var(--accent)" : "var(--warning, #f59e0b)"}`
      avatar.textContent = (u.display_name || u.name || "?").slice(0, 2).toUpperCase()
      row.appendChild(avatar)

      const nameEl = domEl("span")
      nameEl.style.cssText = "font-size: 13px; font-weight: 500; flex: 1;"
      nameEl.textContent = formatWorkspaceUserLabel(u)
      row.appendChild(nameEl)

      const label = domEl("label", "toggle-switch")
      label.style.cssText = "flex-shrink: 0;"

      const checkbox = domEl("input")
      checkbox.type = "checkbox"
      checkbox.checked = current.get(u.id) ?? !disabledSet.has(u.id)
      checkbox.dataset.userId = u.id
      setAttr(checkbox, "aria-label", formatWorkspaceUserLabel(u))

      const slider = domEl("span")
      slider.className = "toggle-slider"

      label.appendChild(checkbox)
      label.appendChild(slider)
      row.appendChild(label)

      userTogglesContainer.appendChild(row)
    }
  }

  saveBtn?.addEventListener(
    "click",
    () => {
      if (!prefsReady || saveBtn.disabled) return
      const disabled = new Set(prefs.disabled_users ?? [])
      userTogglesContainer.querySelectorAll<HTMLInputElement>("input[data-user-id]").forEach((cb) => {
        if (!cb.dataset.userId) return
        if (cb.checked) disabled.delete(cb.dataset.userId)
        else disabled.add(cb.dataset.userId)
      })
      const mobileTargets = new Set(prefs.mobile_targets ?? [])
      mobileTargetList?.querySelectorAll<HTMLInputElement>("input[data-mobile-target]").forEach((cb) => {
        if (!cb.dataset.mobileTarget) return
        if (cb.checked) mobileTargets.add(cb.dataset.mobileTarget)
        else mobileTargets.delete(cb.dataset.mobileTarget)
      })
      const payload = {
        ...prefs,
        enabled: globalToggle.checked,
        disabled_users: [...disabled],
        channels: {
          sidebar: sidebarCb ? sidebarCb.checked : true,
          mobile_push: mobileCb ? mobileCb.checked : false,
        },
        mobile_targets: [...mobileTargets],
        due_date_reminders: remindersCb ? remindersCb.checked : true,
        reminder_window_minutes: reminderMinutesInput
          ? Math.max(5, Math.min(1440, parseInt(reminderMinutesInput.value, 10) || 60))
          : 60,
      }

      const origText = saveBtn.textContent
      saveBtn.textContent = "Saving…"
      saveBtn.disabled = true
      saveBtn.style.opacity = "0.7"

      fetch("/api/settings", {
        method: "PUT",
        headers: settingsWriteHeaders("notification_preferences"),
        body: JSON.stringify({ key: "notification_preferences", value: payload }),
        signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Settings save failed: ${response.status}`)
          prefs = payload
          saveBtn.textContent = "✓ Saved"
          window.showToast?.("Notification preferences saved")
          setTimeout(() => {
            saveBtn.textContent = origText
            saveBtn.disabled = false
            saveBtn.style.opacity = "1"
          }, 1500)
        })
        .catch((err) => {
          if (signal.aborted) return
          log.error("Save notification prefs error:", err)
          saveBtn.textContent = "✗ Failed"
          setTimeout(() => {
            saveBtn.textContent = origText
            saveBtn.disabled = false
            saveBtn.style.opacity = "1"
          }, 2000)
        })
    },
    { signal },
  )

  return renderUsers
}

function initPeopleAndNotifications(signal: AbortSignal): void {
  const select = byId<HTMLSelectElement>("default-assignee-select")
  const discoveredList = byId("discovered-users-list")
  const customList = byId("custom-users-list")
  const renderNotificationUsers = initNotificationsPanel(signal)
  if (!select && !renderNotificationUsers) return

  let usersRead = 0

  async function readUsersJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(path, { signal })
      return response.ok ? ((await response.json()) as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  function renderCustomUsers(users: WorkspaceUser[]): void {
    if (!customList) return
    customList.replaceChildren()
    if (users.length === 0) {
      customList.appendChild(
        makeStyledEl(
          "span",
          "color: var(--text-secondary); font-size: 12px; font-style: italic;",
          "No custom users added yet",
        ),
      )
      return
    }

    for (const u of users) {
      const row = makeStyledEl(
        "div",
        "display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px;",
      )
      row.appendChild(makeAvatar(u.display_name || u.name, "var(--warning, #f59e0b)"))
      row.appendChild(
        makeStyledEl("span", "font-size: 13px; font-weight: 500; flex: 1;", u.display_name || u.name || u.id),
      )
      if (u.kind === "agent") {
        row.appendChild(
          makeStyledEl(
            "span",
            "font-size: 11px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary);",
            "AI agent",
          ),
        )
      }

      const delBtn = domEl("button")
      delBtn.type = "button"
      delBtn.className = "btn-icon text-danger"
      delBtn.style.cssText = "font-size: 16px; cursor: pointer;"
      delBtn.textContent = "×"
      delBtn.title = "Remove user"
      setAttr(delBtn, "aria-label", `Remove ${u.display_name || u.name || "user"}`)
      setAttr(delBtn, "data-user-id", u.id)
      delBtn.addEventListener(
        "click",
        () => {
          fetch(`/api/users/custom?id=${encodeURIComponent(u.id)}`, { method: "DELETE", signal })
            .then((response) => {
              if (!response.ok) throw new Error(`Delete custom user failed: ${response.status}`)
              return refreshUsers()
            })
            .catch((err) => {
              if (!signal.aborted) log.error("Delete custom user error:", err)
            })
        },
        { signal },
      )
      row.appendChild(delBtn)
      customList.appendChild(row)
    }
  }

  function renderPeople(
    allUsers: WorkspaceUser[],
    defaultAssignee: string | null | undefined,
    customUsers: WorkspaceUser[],
    mergedUnavailable: boolean,
  ): void {
    if (!select) return
    select.replaceChildren()
    const noneOpt = domEl("option")
    noneOpt.value = ""
    noneOpt.textContent = "None (unassigned)"
    select.appendChild(noneOpt)

    for (const u of allUsers) {
      const opt = domEl("option")
      opt.value = u.id
      opt.textContent = formatWorkspaceUserLabel(u)
      select.appendChild(opt)
    }
    if (defaultAssignee) {
      if (!allUsers.some(user => user.id === defaultAssignee)) {
        const option = domEl("option")
        option.value = defaultAssignee
        option.textContent = select.dataset.unavailableAssignee ?? ""
        select.appendChild(option)
      }
      select.value = defaultAssignee
    }

    const haUsers = allUsers.filter((u) => u.source === "home_assistant")
    if (discoveredList) {
      discoveredList.replaceChildren()
      if (haUsers.length === 0) {
        discoveredList.appendChild(
          makeStyledEl(
            "span",
            "color: var(--text-secondary); font-size: 12px; font-style: italic;",
            mergedUnavailable ? "Could not load Home Assistant users" : "No HA users found (standalone mode?)",
          ),
        )
      } else {
        for (const u of haUsers) {
          const row = makeStyledEl(
            "div",
            "display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px;",
          )
          row.appendChild(makeAvatar(u.display_name || u.name, "var(--accent)"))
          row.appendChild(makeStyledEl("span", "font-size: 13px; font-weight: 500;", u.display_name || u.name || u.id))
          row.appendChild(
            makeStyledEl(
              "span",
              "font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono);",
              u.id,
            ),
          )
          discoveredList.appendChild(row)
        }
      }
    }

    renderCustomUsers(customUsers)
  }

  async function refreshUsers(): Promise<void> {
    const read = ++usersRead
    const merged = await readUsersJson("/api/users")
    if (signal.aborted) return
    const users = Array.isArray(merged?.users) ? (merged.users as WorkspaceUser[]) : null
    const [defaultAssigneeData, customUsersData] = await Promise.all([
      merged && Object.hasOwn(merged, "default_assignee")
        ? Promise.resolve(merged.default_assignee as string | null | undefined)
        : readUsersJson("/api/users/default").then((data) => data?.default_assignee as string | null | undefined),
      users
        ? Promise.resolve(users.filter((user) => user.source === "custom"))
        : readUsersJson("/api/users/custom").then((data) => (data?.users as WorkspaceUser[] | undefined) ?? []),
    ])

    if (signal.aborted || read !== usersRead) return
    renderPeople(users ?? customUsersData, defaultAssigneeData, customUsersData, users === null)
    renderNotificationUsers?.(users ?? customUsersData)
  }

  byId("save-default-assignee")?.addEventListener(
    "click",
    () => {
      if (!select || select.disabled) return
      fetch("/api/users/default", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: select.value || null }),
        signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Save default assignee failed: ${response.status}`)
          window.showToast?.("Default assignee saved")
        })
        .catch((err) => {
          if (!signal.aborted) log.error("Save default assignee error:", err)
        })
    },
    { signal },
  )

  byId("add-custom-user-btn")?.addEventListener(
    "click",
    () => {
      const input = byId<HTMLInputElement>("new-custom-user-name")
      const name = (input?.value || "").trim()
      if (!name) {
        input?.focus()
        return
      }
      fetch("/api/users/custom", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
        signal,
      })
        .then((res) => {
          if (res.ok && input) {
            input.value = ""
            return refreshUsers()
          }
          return undefined
        })
        .catch((err) => {
          if (!signal.aborted) log.error("Add custom user error:", err)
        })
    },
    { signal },
  )

  void refreshUsers()
}

export function initSettingsWorkspace(signal: AbortSignal): void {
  initTaskCaptureMode(signal)
  initBacklogMode(signal)
  initCompletedRetention(signal)
  initFeatureToggles(signal)
  initPeopleAndNotifications(signal)
}
