import { createClientLogger } from "./client-logger"

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
}

interface NotificationPrefs {
  enabled?: boolean
  disabled_users?: string[]
  channels?: { sidebar?: boolean; mobile_push?: boolean }
  mobile_targets?: string[]
  due_date_reminders?: boolean
  reminder_window_minutes?: number
}

function initBacklogMode(signal: AbortSignal): void {
  const select = document.getElementById("backlog-mode-select") as HTMLSelectElement | null
  const saveBtn = document.getElementById("save-backlog-mode")
  const helpDiv = document.getElementById("backlog-mode-help")
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
  const select = document.getElementById("completed-retention-select") as HTMLSelectElement | null
  const saveBtn = document.getElementById("save-completed-retention")
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
  const container = document.getElementById("feature-toggles-container")
  if (!container) return

  const categories: Record<string, { label: string }> = {
    productivity: { label: "Productivity" },
    integrations: { label: "Integrations" },
    visual: { label: "Visual" },
  }

  fetch("/api/features", { signal })
    .then((r) => r.json())
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
        const section = document.createElement("div")
        section.style.cssText = "margin-bottom: 8px;"

        const heading = document.createElement("div")
        heading.style.cssText =
          "font-weight: 600; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; padding-top: 4px;"
        heading.textContent = catInfo.label
        section.appendChild(heading)

        for (const f of features) {
          const row = document.createElement("div")
          row.style.cssText =
            "display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;"

          const toggleLabel = document.createElement("label")
          toggleLabel.className = "toggle-switch"
          toggleLabel.style.flexShrink = "0"

          const checkbox = document.createElement("input")
          checkbox.type = "checkbox"
          checkbox.id = `feature-toggle-${f.name}`
          checkbox.dataset.feature = f.name
          checkbox.checked = Boolean(f.enabled)
          checkbox.setAttribute("aria-label", f.label)

          const slider = document.createElement("span")
          slider.className = "toggle-slider"
          toggleLabel.append(checkbox, slider)

          const body = document.createElement("div")
          body.style.flex = "1"

          const titleEl = document.createElement("div")
          titleEl.style.cssText = "font-weight: 500; font-size: 13px;"
          titleEl.textContent = f.label

          const descEl = document.createElement("div")
          descEl.style.cssText = "font-size: 12px; color: var(--text-secondary);"
          descEl.textContent = f.description

          body.append(titleEl, descEl)
          row.append(toggleLabel, body)

          checkbox.addEventListener(
            "change",
            () => {
              const featureName = checkbox.dataset.feature ?? ""
              const enabled = checkbox.checked

              fetch("/api/features", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ feature: featureName, enabled }),
                signal,
              })
                .then((r) => r.json())
                .then(() => {
                  window.showToast?.(`${enabled ? "Enabled" : "Disabled"}: ${f.label}`)
                  if (window.__featureFlags && featureName) {
                    window.__featureFlags[featureName] = enabled
                  }
                })
                .catch(() => {
                  if (!signal.aborted) {
                    window.showToast?.("Failed to update feature", "error")
                  }
                })
            },
            { signal },
          )

          section.appendChild(row)
        }

        container.appendChild(section)
      }

      const hint = document.createElement("div")
      hint.style.cssText =
        "font-size: 12px; color: var(--text-secondary); margin-top: 4px; padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px; border: 1px dashed var(--border);"
      const noteStrong = document.createElement("strong")
      noteStrong.textContent = "Note:"
      hint.append(noteStrong, document.createTextNode(" Some changes take effect on the next page load."))
      container.appendChild(hint)
    })
    .catch(() => {
      if (signal.aborted) return
      const errorSpan = document.createElement("span")
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

function initNotificationsPanel(signal: AbortSignal): ((users: WorkspaceUser[]) => Promise<void>) | undefined {
  const globalToggle = document.getElementById("notif-global-toggle") as HTMLInputElement | null
  const sidebarCb = document.getElementById("notif-channel-sidebar") as HTMLInputElement | null
  const mobileCb = document.getElementById("notif-channel-mobile") as HTMLInputElement | null
  const remindersCb = document.getElementById("notif-channel-reminders") as HTMLInputElement | null
  const reminderMinutesInput = document.getElementById("notif-reminder-minutes") as HTMLInputElement | null
  const reminderWindowConfig = document.getElementById("reminder-window-config")
  const mobileTargetsPanel = document.getElementById("notif-mobile-targets")
  const mobileTargetList = document.getElementById("notif-mobile-target-list")
  const userTogglesContainer = document.getElementById("notif-user-toggles")
  const saveBtn = document.getElementById("save-notif-prefs") as HTMLButtonElement | null
  if (!globalToggle || !userTogglesContainer) return undefined

  let prefs: NotificationPrefs = {
    enabled: true,
    disabled_users: [],
    channels: { sidebar: true, mobile_push: false },
    mobile_targets: [],
    due_date_reminders: true,
    reminder_window_minutes: 60,
  }

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

  function discoverMobileTargets(savedTargets: string[]): void {
    if (!mobileTargetList) return
    fetch("/api/ha/services", { signal })
      .then((r) => (r.ok ? r.json() : { services: [] }))
      .catch(() => ({ services: [] }))
      .then((data: { services?: Array<{ domain?: string; services?: Record<string, unknown> }> }) => {
        if (signal.aborted) return
        const services = data.services ?? (Array.isArray(data) ? data : [])
        const mobileServices: Array<{ service: string; name: string }> = []
        if (Array.isArray(services)) {
          for (const domainObj of services) {
            if (domainObj?.domain === "notify") {
              for (const name of Object.keys(domainObj.services ?? {})) {
                if (name.startsWith("mobile_app_")) {
                  mobileServices.push({
                    service: `notify.${name}`,
                    name: name.replace("mobile_app_", "").replace(/_/g, " "),
                  })
                }
              }
            }
          }
        }

        mobileTargetList.replaceChildren()
        if (mobileServices.length === 0) {
          const empty = document.createElement("span")
          empty.style.cssText = "color: var(--text-secondary); font-size: 12px; font-style: italic;"
          empty.textContent =
            "No HA Companion App devices found. Install the HA Companion App on your phone to enable mobile push."
          mobileTargetList.appendChild(empty)
          return
        }

        const savedSet = new Set(savedTargets)
        for (const svc of mobileServices) {
          const row = document.createElement("div")
          row.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 4px 0;"

          const cb = document.createElement("input")
          cb.type = "checkbox"
          cb.checked = savedTargets.length === 0 || savedSet.has(svc.service)
          cb.dataset.mobileTarget = svc.service
          cb.style.cssText = "accent-color: var(--accent);"
          row.appendChild(cb)

          const label = document.createElement("span")
          label.style.cssText = "font-size: 13px;"
          label.textContent = svc.name
          row.appendChild(label)

          const svcLabel = document.createElement("span")
          svcLabel.style.cssText =
            "font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono);"
          svcLabel.textContent = svc.service
          row.appendChild(svcLabel)

          mobileTargetList.appendChild(row)
        }
      })
  }

  function restorePrefs(savedPrefs: { value?: NotificationPrefs }): void {
    if (savedPrefs.value && typeof savedPrefs.value === "object") {
      prefs = savedPrefs.value
    }

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

    discoverMobileTargets(prefs.mobile_targets ?? [])
  }

  const prefsReady = fetch("/api/settings?key=notification_preferences", { signal })
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}))
    .then(restorePrefs)

  function renderUsers(users: WorkspaceUser[]): void {
    if (!userTogglesContainer || signal.aborted) return
    const current = new Map(
      Array.from(userTogglesContainer.querySelectorAll<HTMLInputElement>("input[data-user-id]"), (input) => [
        input.dataset.userId,
        input.checked,
      ]),
    )
    const disabledSet = new Set(prefs.disabled_users ?? [])

    userTogglesContainer.replaceChildren()
    const heading = document.createElement("div")
    heading.style.cssText = "font-weight: 600; font-size: 13px; margin-bottom: 4px;"
    heading.textContent = "Per-user overrides"
    userTogglesContainer.appendChild(heading)

    if (users.length === 0) {
      const empty = document.createElement("span")
      empty.style.cssText = "color: var(--text-secondary); font-size: 12px; font-style: italic;"
      empty.textContent = "No users found — notifications will apply globally."
      userTogglesContainer.appendChild(empty)
      return
    }

    for (const u of users) {
      const row = document.createElement("div")
      row.style.cssText =
        "display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px;"

      const avatar = document.createElement("span")
      avatar.style.cssText = `display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; background: ${u.source === "home_assistant" ? "var(--accent)" : "var(--warning, #f59e0b)"}`
      avatar.textContent = (u.display_name || u.name || "?").slice(0, 2).toUpperCase()
      row.appendChild(avatar)

      const nameEl = document.createElement("span")
      nameEl.style.cssText = "font-size: 13px; font-weight: 500; flex: 1;"
      nameEl.textContent = `${u.display_name || u.name || u.id}${u.source === "home_assistant" ? " (HA)" : " (Custom)"}`
      row.appendChild(nameEl)

      const label = document.createElement("label")
      label.className = "toggle-switch"
      label.style.cssText = "flex-shrink: 0;"

      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      checkbox.checked = current.get(u.id) ?? !disabledSet.has(u.id)
      checkbox.dataset.userId = u.id

      const slider = document.createElement("span")
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
      const disabled: string[] = []
      userTogglesContainer.querySelectorAll<HTMLInputElement>("input[data-user-id]").forEach((cb) => {
        if (!cb.checked && cb.dataset.userId) disabled.push(cb.dataset.userId)
      })
      const mobileTargets: string[] = []
      mobileTargetList?.querySelectorAll<HTMLInputElement>("input[data-mobile-target]").forEach((cb) => {
        if (cb.checked && cb.dataset.mobileTarget) mobileTargets.push(cb.dataset.mobileTarget)
      })
      const payload = {
        enabled: globalToggle.checked,
        disabled_users: disabled,
        channels: {
          sidebar: sidebarCb ? sidebarCb.checked : true,
          mobile_push: mobileCb ? mobileCb.checked : false,
        },
        mobile_targets: mobileTargets,
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "notification_preferences", value: payload }),
        signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Settings save failed: ${response.status}`)
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

  return (users: WorkspaceUser[]) => prefsReady.then(() => renderUsers(users))
}

function initPeopleAndNotifications(signal: AbortSignal): void {
  const select = document.getElementById("default-assignee-select") as HTMLSelectElement | null
  const discoveredList = document.getElementById("discovered-users-list")
  const customList = document.getElementById("custom-users-list")
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

      const delBtn = document.createElement("button")
      delBtn.type = "button"
      delBtn.className = "btn-icon text-danger"
      delBtn.style.cssText = "font-size: 16px; cursor: pointer;"
      delBtn.textContent = "×"
      delBtn.title = "Remove user"
      delBtn.setAttribute("aria-label", `Remove ${u.display_name || u.name || "user"}`)
      delBtn.setAttribute("data-user-id", u.id)
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
    const noneOpt = document.createElement("option")
    noneOpt.value = ""
    noneOpt.textContent = "None (unassigned)"
    select.appendChild(noneOpt)

    for (const u of allUsers) {
      const opt = document.createElement("option")
      opt.value = u.id
      opt.textContent = `${u.display_name || u.name || u.id}${u.source === "home_assistant" ? " (HA)" : " (Custom)"}`
      select.appendChild(opt)
    }
    if (defaultAssignee) {
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
    await renderNotificationUsers?.(users ?? customUsersData)
  }

  document.getElementById("save-default-assignee")?.addEventListener(
    "click",
    () => {
      if (!select) return
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

  document.getElementById("add-custom-user-btn")?.addEventListener(
    "click",
    () => {
      const input = document.getElementById("new-custom-user-name") as HTMLInputElement | null
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
  initBacklogMode(signal)
  initCompletedRetention(signal)
  initFeatureToggles(signal)
  initPeopleAndNotifications(signal)
}
