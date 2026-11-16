import {
  TASK_NAV_PREFS_EVENT,
  TASK_NAV_PREFS_KEY,
  TASK_NAV_TYPES,
  isTaskNavTypeVisible,
  readTaskNavPrefs,
  setTaskNavMode,
  toggleTaskNavChild,
  toggleTaskNavPin,
  type TaskNavDisplayMode,
  type TaskNavPrefs,
  type TaskNavTypeId,
} from "./task-nav-types"

function syncTaskNavUi(root: HTMLElement, prefs: TaskNavPrefs): void {
  root.querySelectorAll<HTMLButtonElement>("[data-task-nav-mode]").forEach((btn) => {
    const active = btn.dataset.taskNavMode === prefs.mode
    btn.setAttribute("aria-pressed", String(active))
    btn.classList.toggle("btn-primary", active)
    btn.classList.toggle("btn-secondary", !active)
  })

  for (const entry of TASK_NAV_TYPES) {
    const checkbox = root.querySelector<HTMLInputElement>(`[data-task-nav-visible="${entry.id}"]`)
    if (checkbox) checkbox.checked = isTaskNavTypeVisible(prefs, entry.id)

    const pinBtn = root.querySelector<HTMLButtonElement>(`[data-task-nav-pin="${entry.id}"]`)
    if (pinBtn) {
      const pinned = prefs.pinned.includes(entry.id)
      pinBtn.setAttribute("aria-pressed", String(pinned))
      pinBtn.classList.toggle("btn-primary", pinned)
      pinBtn.classList.toggle("btn-ghost", !pinned)
      pinBtn.textContent = pinned
        ? (window.mI18n?.get("settings.task_nav_pinned") ?? "Pinned")
        : (window.mI18n?.get("settings.task_nav_pin") ?? "Pin to nav")
    }
  }
}

/** Initialize task navigation visibility and pinning controls in Settings once per lifecycle. */
export function initSettingsTaskNav(signal: AbortSignal): void {
  const root = document.getElementById("task-nav-prefs-card")
  if (!root || root.dataset.taskNavBooted === "true") return

  root.dataset.taskNavBooted = "true"
  signal.addEventListener("abort", () => {
    delete root.dataset.taskNavBooted
  }, { once: true })

  syncTaskNavUi(root, readTaskNavPrefs())

  root.addEventListener("click", (event) => {
    const target = event.target as Element | null
    const modeBtn = target?.closest<HTMLButtonElement>("[data-task-nav-mode]")
    if (modeBtn) {
      event.stopPropagation()
      const mode = modeBtn.dataset.taskNavMode as TaskNavDisplayMode | undefined
      if (mode === "all" || mode === "custom" || mode === "none") {
        syncTaskNavUi(root, setTaskNavMode(readTaskNavPrefs(), mode))
      }
      return
    }

    const pinBtn = target?.closest<HTMLButtonElement>("[data-task-nav-pin]")
    if (pinBtn) {
      event.stopPropagation()
      const id = pinBtn.dataset.taskNavPin as TaskNavTypeId | undefined
      if (id) syncTaskNavUi(root, toggleTaskNavPin(readTaskNavPrefs(), id))
    }
  }, { signal })

  root.addEventListener("change", (event) => {
    const input = (event.target as Element | null)?.closest<HTMLInputElement>("[data-task-nav-visible]")
    if (!input) return
    const id = input.dataset.taskNavVisible as TaskNavTypeId | undefined
    if (id) syncTaskNavUi(root, toggleTaskNavChild(readTaskNavPrefs(), id))
  }, { signal })

  window.addEventListener(TASK_NAV_PREFS_EVENT, (event) => {
    const detail = (event as CustomEvent<TaskNavPrefs>).detail ?? readTaskNavPrefs()
    syncTaskNavUi(root, detail)
  }, { signal })

  window.addEventListener("storage", (event) => {
    if (event.key === TASK_NAV_PREFS_KEY || event.key === null) {
      syncTaskNavUi(root, readTaskNavPrefs())
    }
  }, { signal })
}
