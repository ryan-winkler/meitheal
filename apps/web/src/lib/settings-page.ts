import { requestNotificationPermission, showTaskNotification } from "@domains/offline/notifications"
import { isPwaSupported } from "@domains/offline/sw-register"
import { initTaskDetailLayoutEditor } from "@lib/task-detail-layout-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import { initSettingsFeedback } from "@lib/settings-feedback-controller"
import { initSettingsController } from "@lib/settings-controller"
import { initSettingsShell } from "@lib/settings-shell-controller"
import { initSettingsLabels } from "@lib/settings-labels-controller"
import { initSettingsLabelCleanup } from "@lib/settings-label-cleanup-controller"
import { initSettingsTaskNav } from "@lib/settings-task-nav-controller"
import { initOrganizationLabels } from "@lib/settings-organization-labels"
import { initSettingsHomeAssistantArea } from "@lib/settings-home-assistant-area"
import { initSettingsWorkspace } from "@lib/settings-workspace-controller"
import { initSettingsShoppingCategories } from "@lib/settings-shopping-categories-controller"
import { initNotificationPrefsSettings } from "@lib/settings-notification-prefs-controller"

function initPwaNotificationTest(): void {
  const button = document.querySelector<HTMLButtonElement>("#pwa-test-notification")
  const result = document.getElementById("pwa-notification-result")
  if (!button || !result) return

  const copy = result.dataset
  const signal = pageLifecycle.signal
  pageLifecycle.on(button, "click", async () => {
    if (button.getAttribute("aria-disabled") === "true") return
    button.setAttribute("aria-disabled", "true")
    button.setAttribute("aria-busy", "true")
    result.textContent = copy.sending ?? ""
    try {
      const permission = isPwaSupported() ? await requestNotificationPermission() : "unsupported"
      if (signal.aborted) return
      if (permission !== "granted") {
        const status = permission === "default" ? "declined" : permission
        result.textContent = copy[status] ?? ""
        return
      }
      const sent = await showTaskNotification({
        title: "Meitheal",
        body: copy.body ?? "",
        tag: "meitheal-notification-test",
        url: "/settings#app-pwa-settings",
      })
      if (!signal.aborted) result.textContent = copy[sent ? "sent" : "unavailable"] ?? ""
    } catch {
      if (!signal.aborted) result.textContent = copy.unavailable ?? ""
    } finally {
      button.removeAttribute("aria-disabled")
      button.removeAttribute("aria-busy")
    }
  })
}


function bootSettingsPage(): void {
  const shell = document.getElementById("settings-shell")
  if (!shell) return
  if (shell.dataset.settingsBooted === "true") return

  shell.dataset.settingsBooted = "true"

  initSettingsController()
  initSettingsShell()
  initSettingsFeedback()
  initSettingsLabels(pageLifecycle.signal)
  initSettingsLabelCleanup()
  initSettingsTaskNav(pageLifecycle.signal)
  initSettingsWorkspace(pageLifecycle.signal)
  initOrganizationLabels(pageLifecycle.signal)
  initSettingsHomeAssistantArea(pageLifecycle.signal)
  initSettingsShoppingCategories(pageLifecycle.signal)
  initNotificationPrefsSettings(pageLifecycle.signal)
  const taskLayout = document.querySelector<HTMLElement>("#settings-task-detail-layout [data-task-layout-editor]")
  if (taskLayout) initTaskDetailLayoutEditor(taskLayout, pageLifecycle.signal)
  initPwaNotificationTest()
}

bootSettingsPage()

pageLifecycle.onPageLoad(() => {
  try { bootSettingsPage() } catch (e) { console.error("[Meitheal][settings] Boot failed", e) }
})
