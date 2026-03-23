import { pageLifecycle } from "@lib/page-lifecycle"
import { initSettingsController } from "@lib/settings-controller"
import { initSettingsShell } from "@lib/settings-shell-controller"

function bootSettingsPage(): void {
  const shell = document.getElementById("settings-shell")
  if (!shell) return
  if (shell.dataset.settingsBooted === "true") return

  shell.dataset.settingsBooted = "true"

  initSettingsShell()
  initSettingsController()
}

bootSettingsPage()

pageLifecycle.onPageLoad(() => {
  try { bootSettingsPage() } catch (e) { console.error("[Meitheal][settings] Boot failed", e) }
})
